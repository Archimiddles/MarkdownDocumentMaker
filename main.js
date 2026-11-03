'use strict';
// Plan Printer — Electron main process.
// Owns the window, the application menu, native dialogs, printing and PDF export.
// The renderer runs sandboxed with context isolation; everything it needs is
// exposed through preload.js and the ipcMain handlers below.

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

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
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // The app window must never navigate away from its own page. Links inside
  // a rendered plan open in the system browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      openExternal(url);
    }
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
  const file = result.filePaths[0];
  return { name: path.basename(file), path: file, text: fs.readFileSync(file, 'utf8') };
});

ipcMain.handle('save-markdown', async (event, text, suggestedName) => {
  const win = windowFor(event);
  const result = await dialog.showSaveDialog(win, {
    title: 'Save Markdown',
    defaultPath: path.join(app.getPath('documents'), safeFileName(suggestedName) + '.md'),
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  fs.writeFileSync(result.filePath, String(text ?? ''), 'utf8');
  return { ok: true, path: result.filePath };
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
    error: null,
  };
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
      const code = `window.__planPrinterTest.apply(${JSON.stringify(s.settings || {})}, ${JSON.stringify(md)})`;
      const r = await win.webContents.executeJavaScript(code, true);
      const pdf = await win.webContents.printToPDF(pdfOptions((s.settings || {}).paper));
      const pdfName = `${s.name}.pdf`;
      fs.writeFileSync(path.join(out, pdfName), pdf);
      const image = await win.webContents.capturePage();
      const pngName = `${s.name}.png`;
      fs.writeFileSync(path.join(out, pngName), image.toPNG());
      report.scenarios.push({
        name: s.name,
        settings: s.settings,
        previewPages: r && r.pages,
        title: r && r.title,
        renderMs: r && r.renderMs,
        totalMs: Date.now() - t0,
        error: (r && r.error) || null,
        pdf: pdfName,
        screenshot: pngName,
        pdfBytes: pdf.length,
      });
    }
  } catch (err) {
    report.error = String(err && err.stack ? err.stack : err);
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  app.exit(report.error ? 1 : 0);
}

// ---- Lifecycle --------------------------------------------------------------

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
