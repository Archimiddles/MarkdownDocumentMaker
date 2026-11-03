// Plan Printer renderer.
// Markdown (marked + highlight.js, sanitised with DOMPurify) -> DOM -> Paged.js
// paginated preview. Page furniture (running header, notes box, margin column)
// is injected into every page after layout so it never affects content flow.

import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js/lib/common';
import DOMPurify from 'dompurify';
import { Previewer, Handler, registerHandlers } from 'pagedjs';

import pageCss from './page.css'; // bundled as a string, see scripts/build.js
import 'highlight.js/styles/github.css';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/source-serif-4/latin-400.css';
import '@fontsource/source-serif-4/latin-400-italic.css';
import '@fontsource/source-serif-4/latin-600.css';
import '@fontsource/source-serif-4/latin-700.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-700.css';
import './ui.css';

// ---- Configuration ----------------------------------------------------------

// All measurements in inches; they are written straight into the @page rule.
const PAPERS = {
  letter: { label: 'US Letter', w: 8.5, h: 11, size: '8.5in 11in' },
  a4: { label: 'A4', w: 8.27, h: 11.69, size: '210mm 297mm' },
};

const LAYOUTS = {
  review: {
    label: 'Review — wide margins',
    top: 0.95, left: 1.25, right: 1.25, bodyPt: 11, marginColumn: false,
  },
  margin: {
    label: 'Margin notes — wide right column',
    top: 0.95, left: 0.8, right: 2.9, bodyPt: 10.5, marginColumn: true,
  },
  dense: {
    label: 'Dense — more plan per page',
    top: 0.85, left: 0.75, right: 0.75, bodyPt: 9.5, marginColumn: false,
  },
};

const NOTES = {
  none: { label: 'None', h: 0 },
  small: { label: 'Small (1.5 in)', h: 1.5 },
  medium: { label: 'Medium (2.25 in)', h: 2.25 },
  large: { label: 'Large (3 in)', h: 3 },
};

const PATTERNS = {
  dots: { label: 'Dot grid' },
  lines: { label: 'Ruled lines' },
  blank: { label: 'Blank' },
};

const ZOOMS = {
  fit: { label: 'Fit width' },
  '0.5': { label: '50%' },
  '0.75': { label: '75%' },
  '1': { label: '100%' },
  '1.25': { label: '125%' },
};

const DEFAULTS = {
  layout: 'review',
  paper: 'letter',
  notes: 'medium',
  pattern: 'dots',
  breakH2: false,
  zoom: 'fit',
  title: '',
  date: '',
  editorVisible: true,
};

const STORAGE_SETTINGS = 'planPrinter.settings.v1';
const STORAGE_MARKDOWN = 'planPrinter.markdown.v1';

// ---- DOM handles --------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const els = {
  app: $('app'),
  editor: $('editor'),
  editorPane: document.querySelector('.editor-pane'),
  title: $('title'),
  date: $('date'),
  layout: $('layout'),
  paper: $('paper'),
  notes: $('notes'),
  pattern: $('pattern'),
  breakH2: $('breakH2'),
  zoom: $('zoom'),
  status: $('status'),
  statusRight: $('status-right'),
  pages: $('pages'),
  inner: $('preview-inner'),
  scroll: $('preview-scroll'),
  btnOpen: $('btn-open'),
  btnOpenPlans: $('btn-open-plans'),
  btnPaste: $('btn-paste'),
  btnSample: $('btn-sample'),
  btnClear: $('btn-clear'),
  btnPdf: $('btn-pdf'),
  btnPrint: $('btn-print'),
  btnToggleEditor: $('btn-toggle-editor'),
};

const api = window.planPrinter;

// ---- State --------------------------------------------------------------------

const state = {
  settings: { ...DEFAULTS },
  autoTitle: '',
  furniture: null, // what the page handler reads while decorating pages
  pageCount: 0,
  lastRenderMs: 0,
  lastError: null,
};

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_SETTINGS) || '{}');
    state.settings = { ...DEFAULTS, ...saved };
  } catch {
    state.settings = { ...DEFAULTS };
  }
  try {
    const md = localStorage.getItem(STORAGE_MARKDOWN);
    if (md) els.editor.value = md;
  } catch { /* storage unavailable */ }
}

function saveSettings() {
  try { localStorage.setItem(STORAGE_SETTINGS, JSON.stringify(state.settings)); } catch { /* ignore */ }
}

let saveMdTimer = null;
function saveMarkdownSoon() {
  clearTimeout(saveMdTimer);
  saveMdTimer = setTimeout(() => {
    try { localStorage.setItem(STORAGE_MARKDOWN, els.editor.value); } catch { /* ignore */ }
  }, 800);
}

// ---- Markdown -> DOM ----------------------------------------------------------

const marked = new Marked(
  markedHighlight({
    emptyLangClass: 'hljs',
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
      try {
        return hljs.highlight(code, { language, ignoreIllegals: true }).value;
      } catch {
        return escapeHtml(code);
      }
    },
  }),
);
marked.setOptions({ gfm: true, breaks: false });

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Paged.js loses leading whitespace when it splits a text node across pages
// (pagedjs issue #45). Wrapping every line of a code block in its own block-
// level span makes page breaks fall between whole lines and keeps indentation.
function wrapCodeLines(codeEl) {
  const openStack = [];
  let out = '<span class="code-line">';
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const parts = child.nodeValue.split('\n');
        parts.forEach((part, i) => {
          if (i > 0) {
            out += '</span>'.repeat(openStack.length);
            out += '</span><span class="code-line">';
            out += openStack.map((cls) => `<span class="${cls}">`).join('');
          }
          out += escapeHtml(part);
        });
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const cls = escapeHtml(child.getAttribute('class') || '');
        openStack.push(cls);
        out += `<span class="${cls}">`;
        walk(child);
        openStack.pop();
        out += '</span>';
      }
    }
  };
  // marked appends a trailing newline inside <code>; drop it so we do not get an empty last line.
  const last = codeEl.lastChild;
  if (last && last.nodeType === Node.TEXT_NODE && last.nodeValue.endsWith('\n')) {
    last.nodeValue = last.nodeValue.replace(/\n$/, '');
  }
  walk(codeEl);
  out += '</span>';
  codeEl.innerHTML = out;
}

function markdownToDom(markdown) {
  const root = document.createElement('div');
  root.className = 'plan';

  if (!markdown.trim()) {
    const hint = document.createElement('p');
    hint.className = 'empty-hint';
    hint.textContent = 'Paste a plan into the editor to see it here.';
    root.appendChild(hint);
    return root;
  }

  const raw = marked.parse(markdown);
  root.innerHTML = DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });

  // Task-list checkboxes -> CSS-drawn boxes that print consistently.
  root.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    const box = document.createElement('span');
    box.className = input.checked ? 'cb cb-checked' : 'cb';
    box.setAttribute('aria-hidden', 'true');
    input.replaceWith(box);
    const li = box.closest('li');
    if (li) {
      li.classList.add('task');
      if (li.parentElement) li.parentElement.classList.add('task-list');
    }
  });

  // Code blocks: language label, per-line wrapping, keep short blocks together.
  root.querySelectorAll('pre > code').forEach((code) => {
    const pre = code.parentElement;
    const match = /language-([\w+#-]+)/.exec(code.className || '');
    if (match && match[1] !== 'plaintext') pre.dataset.lang = match[1];
    const lineCount = code.textContent.replace(/\n$/, '').split('\n').length;
    if (lineCount <= 18) pre.classList.add('keep');
    wrapCodeLines(code);
  });

  // Links must not navigate the app; opened externally via click handler below.
  root.querySelectorAll('a[href]').forEach((a) => a.setAttribute('rel', 'noopener'));

  // Group runs of consecutive headings. Paged.js honours break-after: avoid one
  // level deep, so an H2 immediately followed by an H3 could otherwise be left
  // alone at the bottom of a page while the H3 moved on with its content.
  const isHeading = (el) => el && /^H[1-6]$/.test(el.tagName);
  for (let el = root.firstElementChild; el; el = el.nextElementSibling) {
    if (!isHeading(el) || !isHeading(el.nextElementSibling)) continue;
    const group = document.createElement('div');
    group.className = 'heading-group';
    if (el.tagName === 'H2') group.classList.add('starts-h2');
    el.before(group);
    while (isHeading(group.nextElementSibling)) group.appendChild(group.nextElementSibling);
    el = group;
  }

  const first = root.firstElementChild;
  if (first) first.classList.add('first-block');

  return root;
}

function detectTitle(root, markdown) {
  const h = root.querySelector('h1') || root.querySelector('h2') || root.querySelector('h3');
  if (h && h.textContent.trim()) return h.textContent.trim();
  const firstLine = markdown.split('\n').map((l) => l.trim()).find((l) => l);
  return firstLine ? firstLine.replace(/^#+\s*/, '').slice(0, 80) : 'Untitled plan';
}

function todayString() {
  return new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ---- Page geometry and CSS ------------------------------------------------------

function geometry(settings) {
  const paper = PAPERS[settings.paper] || PAPERS.letter;
  const layout = LAYOUTS[settings.layout] || LAYOUTS.review;
  const notesH = (NOTES[settings.notes] || NOTES.medium).h;
  // Notes box sits 0.35in above the sheet edge, with 0.3in between it and the text.
  const bottom = notesH > 0 ? Number((notesH + 0.35 + 0.3).toFixed(3)) : 0.8;
  return {
    paper,
    layout,
    notesH,
    top: layout.top,
    right: layout.right,
    bottom,
    left: layout.left,
    contentW: Number((paper.w - layout.left - layout.right).toFixed(2)),
    contentH: Number((paper.h - layout.top - bottom).toFixed(2)),
  };
}

function buildPageCss(settings) {
  const g = geometry(settings);
  return [
    '@page {',
    `  size: ${g.paper.size};`,
    `  margin-top: ${g.top}in;`,
    `  margin-right: ${g.right}in;`,
    `  margin-bottom: ${g.bottom}in;`,
    `  margin-left: ${g.left}in;`,
    '}',
    `:root { --notes-height: ${g.notesH}in; --body-pt: ${g.layout.bodyPt}pt; }`,
    '',
    pageCss,
  ].join('\n');
}

// ---- Page furniture handler ----------------------------------------------------

function decoratePage(pageEl, number, total, f) {
  const box = pageEl.querySelector('.pagedjs_pagebox');
  if (!box) return;

  const header = document.createElement('div');
  header.className = 'page-header';
  const title = document.createElement('span');
  title.className = 'ph-title';
  title.textContent = f.title;
  const meta = document.createElement('span');
  meta.className = 'ph-meta';
  meta.textContent = `${f.date}  ·  Page ${number} of ${total}`;
  header.append(title, meta);
  box.appendChild(header);

  if (f.notesH > 0) {
    const notes = document.createElement('div');
    notes.className = `notes-box notes-${f.pattern}`;
    const label = document.createElement('span');
    label.className = 'notes-label';
    label.textContent = 'Notes';
    notes.appendChild(label);
    box.appendChild(notes);
  }

  if (f.marginColumn) {
    const col = document.createElement('div');
    col.className = `margin-notes notes-${f.pattern}`;
    box.appendChild(col);
  }
}

class FurnitureHandler extends Handler {
  constructor(chunker, polisher, caller) {
    super(chunker, polisher, caller);
  }

  afterRendered(pages) {
    const f = state.furniture;
    if (!f) return;
    pages.forEach((page, i) => decoratePage(page.element, i + 1, pages.length, f));
  }
}
registerHandlers(FurnitureHandler); // once, at module load

// ---- Rendering --------------------------------------------------------------------

let previewer = null;
let rendering = false;
let pending = false;
let renderTimer = null;

function currentFurniture(root, markdown) {
  const s = state.settings;
  state.autoTitle = detectTitle(root, markdown);
  const g = geometry(s);
  return {
    title: s.title.trim() || state.autoTitle,
    date: s.date.trim() || todayString(),
    pattern: PATTERNS[s.pattern] ? s.pattern : 'dots',
    notesH: g.notesH,
    marginColumn: g.layout.marginColumn,
  };
}

async function render() {
  if (rendering) {
    pending = true;
    return;
  }
  rendering = true;
  state.lastError = null;
  setStatus('Rendering…');
  const t0 = performance.now();
  try {
    const markdown = els.editor.value;
    const root = markdownToDom(markdown);
    root.classList.toggle('page-break-h2', Boolean(state.settings.breakH2));
    state.furniture = currentFurniture(root, markdown);
    els.title.placeholder = state.autoTitle || 'from first heading';

    // A fresh Previewer per render: reusing one re-registers every handler hook
    // and accumulates inserted <style> elements.
    if (previewer) {
      try { if (previewer.polisher && previewer.polisher.styleEl) previewer.polisher.destroy(); } catch { /* ignore */ }
      try { if (previewer.chunker && previewer.chunker.pagesArea) previewer.chunker.destroy(); } catch { /* ignore */ }
    }
    els.pages.innerHTML = '';
    previewer = new Previewer();
    const css = buildPageCss(state.settings);
    // Paged.js treats the node it is given as the flow container (like a
    // <template>'s fragment) and never assigns it a data-ref, so the .plan
    // element must be a child of a fragment, not the root itself.
    const fragment = document.createDocumentFragment();
    fragment.appendChild(root);
    const flow = await previewer.preview(fragment, [{ [window.location.href]: css }], els.pages);
    state.pageCount = flow.total;
    state.lastRenderMs = Math.round(performance.now() - t0);
    applyZoom();
    setStatus(`${flow.total} page${flow.total === 1 ? '' : 's'} · rendered in ${state.lastRenderMs} ms`);
  } catch (err) {
    console.error(err);
    state.lastError = err;
    setStatus(`Render error: ${err && err.message ? err.message : err}`, true);
  } finally {
    rendering = false;
    updateStatusRight();
    if (pending) {
      pending = false;
      render();
    }
  }
}

function scheduleRender(delay = 350) {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, delay);
}

async function renderNow() {
  clearTimeout(renderTimer);
  await render();
  while (rendering || pending) {
    await new Promise((r) => setTimeout(r, 40));
  }
}

// Title/date changes only touch the running header, no re-layout needed.
function refreshHeaders() {
  const s = state.settings;
  const title = s.title.trim() || state.autoTitle;
  const date = s.date.trim() || todayString();
  if (state.furniture) {
    state.furniture.title = title;
    state.furniture.date = date;
  }
  const headers = els.pages.querySelectorAll('.page-header');
  headers.forEach((h, i) => {
    h.querySelector('.ph-title').textContent = title;
    h.querySelector('.ph-meta').textContent = `${date}  ·  Page ${i + 1} of ${headers.length}`;
  });
}

// ---- Zoom ---------------------------------------------------------------------------

function applyZoom() {
  const pagesEl = els.pages.querySelector('.pagedjs_pages');
  if (!pagesEl) return;
  els.pages.style.transform = '';
  els.inner.style.width = '';
  els.inner.style.height = '';
  const naturalW = pagesEl.offsetWidth;
  const naturalH = pagesEl.offsetHeight;
  if (!naturalW || !naturalH) return;
  const zoom = state.settings.zoom;
  let scale;
  if (zoom === 'fit') {
    const available = els.scroll.clientWidth - 40;
    scale = Math.max(0.2, Math.min(1.6, available / naturalW));
  } else {
    scale = Number(zoom) || 1;
  }
  els.pages.style.transform = `scale(${scale})`;
  els.inner.style.width = `${naturalW * scale}px`;
  els.inner.style.height = `${naturalH * scale}px`;
}

// ---- UI wiring ---------------------------------------------------------------------

function fillSelect(select, options) {
  select.innerHTML = '';
  for (const [value, opt] of Object.entries(options)) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = opt.label;
    select.appendChild(o);
  }
}

function syncControls() {
  const s = state.settings;
  els.layout.value = LAYOUTS[s.layout] ? s.layout : DEFAULTS.layout;
  els.paper.value = PAPERS[s.paper] ? s.paper : DEFAULTS.paper;
  els.notes.value = NOTES[s.notes] ? s.notes : DEFAULTS.notes;
  els.pattern.value = PATTERNS[s.pattern] ? s.pattern : DEFAULTS.pattern;
  els.zoom.value = ZOOMS[s.zoom] ? s.zoom : DEFAULTS.zoom;
  els.breakH2.checked = Boolean(s.breakH2);
  els.title.value = s.title || '';
  els.date.value = s.date || '';
  els.app.classList.toggle('editor-hidden', !s.editorVisible);
  els.btnToggleEditor.textContent = s.editorVisible ? 'Hide editor' : 'Show editor';
}

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
}

function updateStatusRight() {
  const g = geometry(state.settings);
  const notes = g.notesH > 0 ? `${g.notesH} in notes box` : 'no notes box';
  els.statusRight.textContent =
    `${g.layout.label.split(' — ')[0]} · ${g.paper.label} · text area ${g.contentW} × ${g.contentH} in · ${notes}`;
}

function bindSetting(el, key, { rerender = true, prop = 'value' } = {}) {
  el.addEventListener('change', () => {
    state.settings[key] = el[prop];
    saveSettings();
    if (rerender) scheduleRender(0);
    else applyZoom();
  });
}

function setMarkdown(text) {
  els.editor.value = text;
  saveMarkdownSoon();
  scheduleRender(0);
}

async function doOpen(claudePlans = false) {
  const file = await api.openMarkdown({ claudePlans });
  if (file) {
    setMarkdown(file.text);
    if (!state.settings.title) els.title.placeholder = file.name.replace(/\.(md|markdown|txt)$/i, '');
    setStatus(`Opened ${file.name}`);
  }
}

async function doSave() {
  const r = await api.saveMarkdown(els.editor.value, state.furniture ? state.furniture.title : 'plan');
  if (r && r.ok) setStatus(`Saved ${r.path}`);
}

async function doExportPdf() {
  if (rendering || pending) await renderNow();
  setStatus('Exporting PDF…');
  const r = await api.exportPdf({ paper: state.settings.paper, title: state.furniture ? state.furniture.title : 'plan' });
  if (r && r.ok) setStatus(`PDF saved: ${r.path}`);
  else if (r && r.error) setStatus(`PDF export failed: ${r.error}`, true);
  else setStatus(`${state.pageCount} pages`);
}

async function doPrint() {
  if (rendering || pending) await renderNow();
  setStatus('Opening print dialog…');
  const r = await api.print();
  if (r && r.ok) setStatus('Sent to printer');
  else setStatus(r && r.error ? `Print: ${r.error}` : `${state.pageCount} pages`, Boolean(r && r.error && r.error !== 'Print job canceled'));
}

async function doPaste() {
  const text = await api.readClipboard();
  if (text && text.trim()) {
    setMarkdown(text);
    setStatus('Pasted from clipboard');
  } else {
    setStatus('Clipboard has no text', true);
  }
}

async function doSample() {
  setMarkdown(await api.loadSample());
  setStatus('Loaded sample plan');
}

function toggleEditor() {
  state.settings.editorVisible = !state.settings.editorVisible;
  saveSettings();
  syncControls();
  applyZoom();
}

function init() {
  fillSelect(els.layout, LAYOUTS);
  fillSelect(els.paper, PAPERS);
  fillSelect(els.notes, NOTES);
  fillSelect(els.pattern, PATTERNS);
  fillSelect(els.zoom, ZOOMS);

  loadState();
  syncControls();
  updateStatusRight();

  bindSetting(els.layout, 'layout');
  bindSetting(els.paper, 'paper');
  bindSetting(els.notes, 'notes');
  bindSetting(els.pattern, 'pattern');
  bindSetting(els.breakH2, 'breakH2', { prop: 'checked' });
  bindSetting(els.zoom, 'zoom', { rerender: false });

  for (const [el, key] of [[els.title, 'title'], [els.date, 'date']]) {
    el.addEventListener('input', () => {
      state.settings[key] = el.value;
      saveSettings();
      refreshHeaders();
    });
  }

  els.editor.addEventListener('input', () => {
    saveMarkdownSoon();
    scheduleRender();
  });

  // Drop a .md file onto the editor.
  els.editorPane.addEventListener('dragover', (e) => {
    e.preventDefault();
    els.editorPane.classList.add('dragover');
  });
  els.editorPane.addEventListener('dragleave', () => els.editorPane.classList.remove('dragover'));
  els.editorPane.addEventListener('drop', async (e) => {
    e.preventDefault();
    els.editorPane.classList.remove('dragover');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    setMarkdown(await file.text());
    setStatus(`Loaded ${file.name}`);
  });

  els.btnOpen.addEventListener('click', () => doOpen(false));
  els.btnOpenPlans.addEventListener('click', () => doOpen(true));
  els.btnPaste.addEventListener('click', doPaste);
  els.btnSample.addEventListener('click', doSample);
  els.btnClear.addEventListener('click', () => { setMarkdown(''); setStatus('Cleared'); });
  els.btnPdf.addEventListener('click', doExportPdf);
  els.btnPrint.addEventListener('click', doPrint);
  els.btnToggleEditor.addEventListener('click', toggleEditor);

  // Links inside the preview open in the system browser, never in the app.
  els.pages.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(a.href)) api.openExternal(a.href);
  });

  api.onMenu((action) => {
    const actions = {
      'open': () => doOpen(false),
      'open-plans': () => doOpen(true),
      'save': doSave,
      'export-pdf': doExportPdf,
      'print': doPrint,
      'toggle-editor': toggleEditor,
      'sample': doSample,
    };
    if (actions[action]) actions[action]();
  });

  api.hasClaudePlans().then((yes) => { if (yes) els.btnOpenPlans.hidden = false; });

  let zoomFrame = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(zoomFrame);
    zoomFrame = requestAnimationFrame(applyZoom);
  }).observe(els.scroll);

  // Automated test hook used by main.js in PLAN_PRINTER_TEST_OUT mode.
  window.__planPrinterTest = {
    async apply(settings, markdown) {
      Object.assign(state.settings, settings || {});
      syncControls();
      if (typeof markdown === 'string') els.editor.value = markdown;
      await renderNow();
      return {
        pages: state.pageCount,
        title: state.furniture ? state.furniture.title : '',
        renderMs: state.lastRenderMs,
        error: state.lastError ? String(state.lastError.stack || state.lastError.message || state.lastError) : null,
      };
    },
    geometry: () => geometry(state.settings),
  };

  // First render: a fresh install shows the sample so the app is not an empty box.
  if (!els.editor.value.trim()) {
    doSample();
  } else {
    scheduleRender(0);
  }
}

init();
