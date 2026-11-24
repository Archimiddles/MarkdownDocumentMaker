'use strict';
// Plan Printer — Electron main process.
// Owns the window, the application menu, native dialogs, printing and PDF export.
// The renderer runs sandboxed with context isolation; everything it needs is
// exposed through preload.js and the ipcMain handlers below.

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, clipboard, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { sidecarPath, readSidecar, writeSidecar } = require('./annotations-store');

const REPO_URL = 'https://github.com/Archimiddles/MarkdownDocumentMaker';
const SAMPLE_PATH = path.join(__dirname, 'samples', 'sample-plan.md');
const CLAUDE_PLANS_DIR = path.join(os.homedir(), '.claude', 'plans');
const TEST_OUT = process.env.PLAN_PRINTER_TEST_OUT || '';

let mainWindow = null;

function openExternal(url) {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 980,
    minWidth: 900,
    minHeight: 600,
    title: 'Plan Printer',
    backgroundColor: '#e9e9ec',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (TEST_OUT) {
    // The automated tests drive this window themselves. It must not take the
    // keyboard away from whatever the person at the computer is doing, and
    // their mouse must not scroll or click it in the middle of a check.
    win.setIgnoreMouseEvents(true);
    win.once('ready-to-show', () => win.showInactive());
  } else {
    win.once('ready-to-show', () => win.show());
  }
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // The app window must never navigate away from its own page. Links inside
  // a rendered plan open in the system browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  // Any navigation after the initial load (including a file dropped outside
  // the editor) is refused; web links go to the system browser instead.
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    openExternal(url);
  });
  return win;
}

function sendToRenderer(action) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu', action);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Markdown…', accelerator: 'CmdOrCtrl+O', click: () => sendToRenderer('open') },
        { label: 'Open from Claude plans…', click: () => sendToRenderer('open-plans') },
        { label: 'Save Markdown As…', accelerator: 'CmdOrCtrl+S', click: () => sendToRenderer('save') },
        { type: 'separator' },
        { label: 'Export PDF…', accelerator: 'CmdOrCtrl+E', click: () => sendToRenderer('export-pdf') },
        { label: 'Export Annotated Markdown…', accelerator: 'CmdOrCtrl+Shift+E', click: () => sendToRenderer('export-annotated-md') },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: () => sendToRenderer('print') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Editor', accelerator: 'CmdOrCtrl+\\', click: () => sendToRenderer('toggle-editor') },
        { label: 'Annotate Mode', accelerator: 'CmdOrCtrl+Shift+A', click: () => sendToRenderer('toggle-annotate') },
        { label: 'Load Sample Plan', click: () => sendToRenderer('sample') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      role: 'help',
      submenu: [
        { label: 'Project on GitHub', click: () => openExternal(REPO_URL) },
        { label: 'About', click: () => {
          dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'Plan Printer',
            message: `Plan Printer ${app.getVersion()}`,
            detail: `Paste a Claude Code plan, get a print-ready document with wide margins and a notes box on every page.\n\nElectron ${process.versions.electron} · Chromium ${process.versions.chrome}\n${REPO_URL}`,
          });
        } },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

// Options for webContents.printToPDF. Paged.js emits `@page { size: …; margin: 0 }`
// for print media, so we let CSS drive the page size and remove Chromium's margins.
function pdfOptions(paper) {
  return {
    printBackground: true,
    preferCSSPageSize: true,
    pageSize: paper === 'a4' ? 'A4' : 'Letter',
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    landscape: false,
  };
}

function safeFileName(name) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || 'plan';
}

function windowFor(event) {
  return BrowserWindow.fromWebContents(event.sender) || mainWindow;
}

const errorText = (err) => String(err && err.message ? err.message : err);

// ---- The open document ------------------------------------------------------

// The document this window shows. Notes are written beside this path
// and nowhere else, so the page never has to send a path.
let currentDoc = null;

// Worked out on every call, not once: test mode moves userData near the
// bottom of this file, after this line has already run.
function lastDocFile() {
  return path.join(app.getPath('userData'), 'last-document.json');
}

function setCurrentDoc(file) {
  currentDoc = file || null;
  try { // remembered so notes keep saving after a restart
    fs.writeFileSync(lastDocFile(), JSON.stringify({ path: currentDoc }), 'utf8');
  } catch { /* not fatal: only the restart memory is lost */ }
}

// stat, not lstat: a document reached through a symlink is still a document.
function isRegularFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// A path main.js is willing to remember as the open document.
function isTrackablePath(p) {
  return Boolean(p) && path.isAbsolute(p) && Boolean(sidecarPath(p)) && isRegularFile(p);
}

// A short name for a document that the page can hold without learning the
// path: the page sends it back with every save, and a save that names a
// different document than the open one is refused. '' = no trackable file.
function docIdFor(file) {
  if (!file || !sidecarPath(file)) return '';
  return crypto.createHash('sha256').update(path.resolve(file)).digest('hex').slice(0, 16);
}

// The saved notes for a document, plus why there are none when there are none.
function sidecarInfo(file) {
  const side = readSidecar(file);
  return {
    docId: docIdFor(file),
    annotations: side.status === 'ok' ? side.data : null,
    sidecar: { status: side.status, error: side.error, version: side.version },
  };
}

function loadDocument(file) {
  const name = path.basename(file);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { name, error: errorText(err) }; // currentDoc stays as it was
  }
  // A file opened through "All files" that is not Markdown has nowhere to keep
  // notes, so it is treated like pasted text: notes stay inside the app.
  setCurrentDoc(sidecarPath(file) ? file : null);
  return { name, text, ...sidecarInfo(file) };
}

// `docId` is the document the page believes it is saving. If the open
// document changed in between (the user opened another file while a save was
// on its way), the notes belong to the old one and must not be written here.
function saveAnnotations(data, docId) {
  if (!currentDoc) return { ok: false, noDocument: true };
  if (docId && docId !== docIdFor(currentDoc)) return { ok: false, stale: true };
  try {
    return { ok: true, path: writeSidecar(currentDoc, data) };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

// Two spellings of one file (a symlink, "..", a relative path) are the same file.
function samePath(a, b) {
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p); // not on disk yet
    }
  };
  return real(a) === real(b);
}

// Only the app's own top-level page may use the document handlers: a frame
// embedded in it, or one that has already gone away, is turned down.
const trusted = (event) => Boolean(event.senderFrame) && event.senderFrame === event.sender.mainFrame;
const REFUSED = { ok: false, error: 'Refused' };

// ---- IPC handlers -----------------------------------------------------------

ipcMain.handle('open-markdown', async (event, opts = {}) => {
  const win = windowFor(event);
  const defaultPath = opts.claudePlans && fs.existsSync(CLAUDE_PLANS_DIR) ? CLAUDE_PLANS_DIR : undefined;
  const result = await dialog.showOpenDialog(win, {
    title: opts.claudePlans ? 'Open a Claude Code plan' : 'Open Markdown',
    defaultPath,
    properties: ['openFile'],
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'txt'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return loadDocument(result.filePaths[0]);
});

ipcMain.handle('save-markdown', async (event, text, suggestedName) => {
  const win = windowFor(event);
  const result = await dialog.showSaveDialog(win, {
    title: 'Save Markdown',
    defaultPath: path.join(app.getPath('documents'), safeFileName(suggestedName) + '.md'),
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(result.filePath, String(text ?? ''), 'utf8');
    setCurrentDoc(result.filePath); // notes now save beside this file
    return {
      ok: true,
      path: result.filePath,
      name: path.basename(result.filePath),
      docId: docIdFor(result.filePath),
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('export-pdf', async (event, opts = {}) => {
  const win = windowFor(event);
  const result = await dialog.showSaveDialog(win, {
    title: 'Export PDF',
    defaultPath: path.join(app.getPath('documents'), safeFileName(opts.title) + '.pdf'),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  try {
    const data = await win.webContents.printToPDF(pdfOptions(opts.paper));
    fs.writeFileSync(result.filePath, data);
    return { ok: true, path: result.filePath };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('print', (event) => {
  const win = windowFor(event);
  return new Promise((resolve) => {
    win.webContents.print({ printBackground: true, silent: false }, (success, failureReason) => {
      resolve({ ok: success, error: success ? undefined : failureReason });
    });
  });
});

ipcMain.handle('read-clipboard', () => clipboard.readText());
ipcMain.handle('load-sample', () => fs.readFileSync(SAMPLE_PATH, 'utf8'));
ipcMain.handle('has-claude-plans', () => fs.existsSync(CLAUDE_PLANS_DIR));
ipcMain.handle('open-external', (event, url) => openExternal(String(url)));
ipcMain.handle('show-in-folder', (event, p) => shell.showItemInFolder(String(p)));

// A file dropped on the window. preload.js (trusted code) turns the dropped
// File into its real path, and page script cannot fake a File with a path.
// The path still arrives here as a plain string, so main.js checks it like
// any other input: absolute, a Markdown or text file, and really a file.
ipcMain.handle('open-dropped', (event, file) => {
  if (!trusted(event)) return REFUSED;
  const p = String(file || '');
  // Other file types still open, but as an untitled document: the page reads
  // the text itself and main.js remembers nothing.
  if (!isTrackablePath(p)) return { untracked: true };
  return loadDocument(p);
});

ipcMain.handle('save-annotations', (event, data, docId) => (
  trusted(event) ? saveAnnotations(data, typeof docId === 'string' ? docId : '') : REFUSED
));

// The same save, but the page waits for the answer. Used once, while the
// window is closing, when an ordinary async call would be cut off.
ipcMain.on('save-annotations-sync', (event, data, docId) => {
  let result = REFUSED;
  try {
    if (trusted(event)) result = saveAnnotations(data, typeof docId === 'string' ? docId : '');
  } catch (err) {
    result = { ok: false, error: errorText(err) };
  }
  event.returnValue = result; // always set, or the page would hang
});

ipcMain.handle('forget-document', (event) => {
  if (!trusted(event)) return REFUSED;
  setCurrentDoc(null);
  return { ok: true };
});

// On start-up: pick the last document up again so notes keep saving beside it.
// The page already has the text; it only needs the name and the saved notes.
ipcMain.handle('resume-document', (event) => {
  if (!trusted(event)) return null;
  try {
    const saved = JSON.parse(fs.readFileSync(lastDocFile(), 'utf8'));
    const p = saved && typeof saved.path === 'string' ? saved.path : '';
    if (isTrackablePath(p)) {
      currentDoc = p;
      return { name: path.basename(p), ...sidecarInfo(p) };
    }
  } catch { /* nothing remembered, or the memory file is unreadable */ }
  currentDoc = null; // the page is told "no document", so main must agree
  return null;
});

ipcMain.handle('export-annotated-md', async (event, text, suggestedName) => {
  if (!trusted(event)) return REFUSED;
  const win = windowFor(event);
  const result = await dialog.showSaveDialog(win, {
    title: 'Export Annotated Markdown',
    defaultPath: path.join(
      currentDoc ? path.dirname(currentDoc) : app.getPath('documents'),
      safeFileName(suggestedName) + '.annotated.md',
    ),
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  // An export is a copy. It must never replace the plan it was made from.
  if (currentDoc && samePath(result.filePath, currentDoc)) {
    return { ok: false, error: 'That would overwrite the open document. Choose another name.' };
  }
  try {
    fs.writeFileSync(result.filePath, String(text ?? ''), 'utf8');
    return { ok: true, path: result.filePath };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
});

ipcMain.handle('write-clipboard', (event, text) => {
  if (!trusted(event)) return REFUSED;
  clipboard.writeText(String(text ?? ''));
  return { ok: true };
});

// ---- Automated test mode ----------------------------------------------------
// `PLAN_PRINTER_TEST_OUT=<dir> electron .` renders a set of scenarios, writes a
// PDF + screenshot for each, then exits. test/run.js drives this and checks the
// results with pdfinfo. Kept in main.js so the real printToPDF path is exercised.

const DEFAULT_SCENARIOS = [
  { name: 'review-letter', settings: { layout: 'review', paper: 'letter', notes: 'medium', pattern: 'dots' } },
  { name: 'margin-letter', settings: { layout: 'margin', paper: 'letter', notes: 'small', pattern: 'dots' } },
  { name: 'dense-a4', settings: { layout: 'dense', paper: 'a4', notes: 'small', pattern: 'lines' } },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runTestMode(win) {
  const out = TEST_OUT;
  fs.mkdirSync(out, { recursive: true });
  const report = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    startedAt: new Date().toISOString(),
    scenarios: [],
    // Every request that is not for a local file. The app is meant to work
    // fully offline (no hosted services, no API keys), so this should stay empty.
    externalRequests: [],
    error: null,
  };
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (!/^(file|devtools|chrome|chrome-extension|blob|data):/i.test(details.url)) {
      report.externalRequests.push({ url: details.url, resourceType: details.resourceType });
    }
    callback({});
  });
  try {
    const defaultMd = process.env.PLAN_PRINTER_TEST_MD
      ? fs.readFileSync(process.env.PLAN_PRINTER_TEST_MD, 'utf8')
      : fs.readFileSync(SAMPLE_PATH, 'utf8');
    const scenarios = process.env.PLAN_PRINTER_TEST_SCENARIOS
      ? JSON.parse(process.env.PLAN_PRINTER_TEST_SCENARIOS)
      : DEFAULT_SCENARIOS;

    // Mirror renderer console output so test failures are visible on stderr.
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error' || event.level === 'warning') process.stderr.write(`[renderer] ${event.message}\n`);
    });
    if (win.webContents.isLoading()) {
      await new Promise((r) => win.webContents.once('did-finish-load', r));
    }
    for (let i = 0; i < 200; i++) {
      const ready = await win.webContents.executeJavaScript('Boolean(window.__planPrinterTest)');
      if (ready) break;
      await sleep(100);
    }

    for (const s of scenarios) {
      const t0 = Date.now();
      const md = s.mdFile ? fs.readFileSync(s.mdFile, 'utf8') : (s.md ?? defaultMd);
      // Run one method of the renderer's test hook and wait for its answer.
      const hook = (method, ...args) => win.webContents.executeJavaScript(
        `window.__planPrinterTest.${method}(${args.map((a) => JSON.stringify(a)).join(', ')})`, true);
      // The preview zoom is only a scale on the finished pages, and whatever
      // the last render left there is still in place while the next one is
      // laid out. So every scenario starts from a known zoom, picked the way
      // the Zoom menu does: its own "zoom" setting if it has one, otherwise
      // "Fit width".
      const zoomDuringLayout = await hook('setZoom', (s.settings || {}).zoom || 'fit');
      const r = await hook('apply', s.settings || {}, md);

      // A scenario with docFile behaves like a document opened from disk, so
      // saving and restoring notes go through the real handlers. It works on
      // a copy in the output folder: nothing is ever written beside a fixture.
      let docCopy = null;
      if (s.docFile) {
        docCopy = path.join(out, `${s.name}.md`);
        fs.copyFileSync(s.docFile, docCopy);
        fs.rmSync(`${docCopy}.annotations.json`, { force: true });
        await hook('adoptFile', loadDocument(docCopy));
      } else {
        setCurrentDoc(null);
      }

      // Optional annotation steps. A scenario can load a saved set of notes
      // (annotationsFile), make notes by selecting quotes the way a user does
      // (quotes), highlight a block that spans a page break (acrossBreak),
      // then change the layout (relayout) or the text (editedMdFile).
      let annotations = null;
      const paper = { ...(s.settings || {}), ...(s.relayout || {}) }.paper;
      if (s.annotationsFile || s.quotes || s.acrossBreak || s.docFile || s.sectionNotes) {
        annotations = { missed: [] };
        if (s.quotes || s.acrossBreak) {
          await hook('setAnnotateMode', true);
          await hook('settle');
        }
        const before = await hook('lineBoxes');
        if (s.annotationsFile) await hook('annotate', JSON.parse(fs.readFileSync(s.annotationsFile, 'utf8')));
        for (const q of s.quotes || []) {
          const made = await hook('annotateQuote', q.quote, q);
          if (!made || !made.id) annotations.missed.push(q.quote);
        }
        if (s.acrossBreak) annotations.acrossBreak = await hook('annotateAcrossBreak');
        const after = await hook('lineBoxes');
        // Painting notes must not move a single line of text.
        // Each entry is "top:bottom:left:right" of one line, in page pixels.
        // A line counts as unmoved when a line within one pixel of it on
        // every side still exists: a mark can change letter spacing at its
        // edge by a few hundredths of a pixel, which rounding can turn into 1.
        const parse = (list) => list.map((line) => line.split(':').map(Number));
        const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 1);
        const was = parse(before);
        const now = parse(after);
        const gone = was.filter((a) => !now.some((b) => near(a, b)));
        const added = now.filter((b) => !was.some((a) => near(a, b)));
        annotations.lines = before.length;
        annotations.linesMoved = Math.max(gone.length, added.length);
        if (annotations.linesMoved) {
          annotations.movedSample = { was: gone.slice(0, 6).map((l) => l.join(':')), now: added.slice(0, 6).map((l) => l.join(':')) };
        }
        // Section notes, made the way a user makes them: click the heading
        // in the contents list, type in the box that opens, click away.
        if (s.sectionNotes) {
          await hook('setAnnotateMode', true);
          await hook('settle');
          const sections = { steps: [] };
          for (const step of s.sectionNotes) {
            await hook('jumpToSection', step.row);
            const opened = await hook('notesPane');
            const typed = await hook('typeSectionNote', step.text);
            sections.steps.push({ row: step.row, opened, typed });
          }
          sections.contents = await hook('contents');
          sections.all = await hook('showAllNotes');
          sections.openAfterAll = (await hook('contents')).open;
          annotations.sections = sections;
        }
        if (s.relayout) await hook('relayout', s.relayout);
        if (s.editedMdFile) await hook('replaceMarkdown', fs.readFileSync(s.editedMdFile, 'utf8'));
        if (s.hidden) await hook('setAnnotationsHidden', true);
        if (docCopy) {
          // Saved through the bridge -> the sidecar file exists and holds the notes.
          if (s.quotes) await hook('saveNotes');
          const saved = readSidecar(docCopy);
          annotations.persist = {
            status: saved.status,
            saved: saved.status === 'ok' ? saved.data.annotations.length : -1,
          };
          // The notes file changes while "the app is closed" (a sync, a git
          // pull): here its last note is removed. At the next start the FILE
          // must win over whatever copy the app kept.
          if (saved.status === 'ok') {
            const edited = { ...saved.data, annotations: saved.data.annotations.slice(0, -1) };
            fs.writeFileSync(`${docCopy}.annotations.json`, JSON.stringify(edited));
          }
          annotations.persist.restored = (await hook('restore')).total;
          // A document that was never annotated must not grow a notes file,
          // not even an empty one, not even after "restarting" (wait out the
          // half-second autosave to be sure).
          if (!s.quotes) await sleep(800);
          annotations.persist.sidecarExists = fs.existsSync(`${docCopy}.annotations.json`);
          annotations.persist.markdownUntouched = fs.readFileSync(docCopy, 'utf8') === fs.readFileSync(s.docFile, 'utf8');
          setCurrentDoc(null);
        }
        annotations.paintedMarks = await hook('paintedMarks');
        annotations.stats = await hook('annotationStats');
        annotations.pages = await hook('pageCount');
        annotations.markdownFile = `${s.name}.annotated.md`;
        fs.writeFileSync(path.join(out, annotations.markdownFile), await hook('annotatedMarkdown'));
        annotations.sidecarFile = `${s.name}.annotations.json`;
        fs.writeFileSync(path.join(out, annotations.sidecarFile), JSON.stringify(await hook('sidecar'), null, 2));
      }

      // Optional: the contents column. It only exists in Annotate mode, so
      // that goes on first. The list is read back, a few rows are clicked the
      // way a user clicks them, and the column is switched off and on again.
      let contents = null;
      if (s.contents) {
        await hook('setAnnotateMode', true);
        await hook('settle');
        contents = { list: await hook('contents'), jumps: [] };
        for (const index of s.contents.jumpTo || []) {
          contents.jumps.push({ index, ...(await hook('jumpToSection', index)) });
        }
        await hook('setContentsVisible', false);
        contents.shownWhenSwitchedOff = (await hook('contents')).shown;
        await hook('setContentsVisible', true);
        await hook('setAnnotateMode', false);
        contents.shownOutsideAnnotate = (await hook('contents')).shown;
        await hook('setAnnotateMode', true); // so the screenshot shows the column
        await hook('settle');
      }

      // Every Mermaid diagram as it ended up on the pages: in one piece, with
      // its styles, inside its page? test/run.js judges the answers.
      const diagramsOnPages = await hook('diagramsOnPages');

      const pdf = await win.webContents.printToPDF(pdfOptions(paper));
      const pdfName = `${s.name}.pdf`;
      fs.writeFileSync(path.join(out, pdfName), pdf);
      const image = await win.webContents.capturePage();
      const pngName = `${s.name}.png`;
      fs.writeFileSync(path.join(out, pngName), image.toPNG());
      report.scenarios.push({
        name: s.name,
        settings: s.settings,
        previewPages: annotations ? annotations.pages : (r && r.pages),
        title: r && r.title,
        renderMs: r && r.renderMs,
        diagrams: r && r.diagrams,
        diagramsOnPages,
        zoomDuringLayout,
        totalMs: Date.now() - t0,
        error: (r && r.error) || null,
        pdf: pdfName,
        screenshot: pngName,
        pdfBytes: pdf.length,
        annotations,
        contents,
      });
    }
  } catch (err) {
    report.error = String(err && err.stack ? err.stack : err);
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  app.exit(report.error ? 1 : 0);
}

// ---- Lifecycle --------------------------------------------------------------

// Test mode gets a throwaway profile so a user's saved text and settings never
// leak into the test output.
if (TEST_OUT) app.setPath('userData', path.join(TEST_OUT, 'user-data'));

app.whenReady().then(() => {
  Menu.setApplicationMenu(buildMenu());
  mainWindow = createWindow();
  if (TEST_OUT) runTestMode(mainWindow);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
