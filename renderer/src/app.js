// Plan Printer renderer.
// Markdown (marked + highlight.js, sanitised with DOMPurify) -> DOM -> Paged.js
// paginated preview. Page furniture (running header, notes box, margin column)
// is injected into every page after layout so it never affects content flow.

import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js/lib/common';
import DOMPurify from 'dompurify';
import mermaid from 'mermaid';
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

// After ui.css on purpose: the annotate styles build on the app's own.
import { renderBlocks } from './annotations/blocks.js';
import { createAnnotations, readCachedAnnotations } from './annotations/index.js';
import { initAnnotateUi } from './annotations/ui.js';
import { initContents } from './annotations/contents.js';

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
    // The dotted right-hand column replaces the bottom notes box in this layout.
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
  contentsVisible: true, // the contents column in Annotate mode
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
  btnAnnotate: $('btn-annotate'),
  annoBar: $('anno-bar'),
  annoPane: $('anno-pane'),
  annoToc: $('anno-toc'),
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
  diagramStats: { rendered: 0, failed: 0 },
  // The open document. hasFile is true when main.js knows a path for it, which
  // is what lets notes be saved in a sidecar file beside it. id is main.js's
  // name for that file (never the path itself); it travels with every save so
  // notes can never be written beside a different document.
  doc: { name: '', hasFile: false, id: '' },
  // Where each block of the last render sits in the Markdown source:
  // { src, blocks: [{ start, end, type }], exact }. Used by the annotations.
  source: null,
  annotate: false, // Annotate mode on?
};

function sanitizeSettings(raw) {
  const s = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return s;
  const pick = (key, table) => { if (typeof raw[key] === 'string' && table[raw[key]]) s[key] = raw[key]; };
  pick('layout', LAYOUTS);
  pick('paper', PAPERS);
  pick('notes', NOTES);
  pick('pattern', PATTERNS);
  pick('zoom', ZOOMS);
  if (typeof raw.breakH2 === 'boolean') s.breakH2 = raw.breakH2;
  if (typeof raw.editorVisible === 'boolean') s.editorVisible = raw.editorVisible;
  if (typeof raw.contentsVisible === 'boolean') s.contentsVisible = raw.contentsVisible;
  if (typeof raw.title === 'string') s.title = raw.title.slice(0, 200);
  if (typeof raw.date === 'string') s.date = raw.date.slice(0, 60);
  return s;
}

function loadState() {
  try {
    state.settings = sanitizeSettings(JSON.parse(localStorage.getItem(STORAGE_SETTINGS) || '{}'));
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
function saveMarkdownNow() {
  clearTimeout(saveMdTimer);
  try { localStorage.setItem(STORAGE_MARKDOWN, els.editor.value); } catch { /* ignore */ }
}
function saveMarkdownSoon() {
  clearTimeout(saveMdTimer);
  saveMdTimer = setTimeout(saveMarkdownNow, 800);
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

// ---- Annotations ---------------------------------------------------------------

// Highlights, mark-up and margin notes. Everything about them lives in
// ./annotations/; this file only tells that module when the pages have been
// rebuilt and which document is open.
const anno = createAnnotations({
  marked,
  api,
  pagesEl: els.pages,
  getSource: () => state.source,
  getDocument: () => state.doc,
  getText: () => els.editor.value,
  // Notes can only be made in Annotate mode, and never while the pages are
  // being rebuilt (they are about to be replaced).
  canEdit: () => state.annotate && !renderOutstanding(),
  setStatus: (text, isError) => setStatus(text, isError),
});

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---- Mermaid diagrams ---------------------------------------------------------

mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  suppressErrorRendering: true,
  theme: 'neutral', // Mermaid's own recommendation for black-and-white printing
  fontFamily: 'Inter, system-ui, sans-serif',
  // Plain SVG text instead of HTML-in-foreignObject labels: prints as real
  // vector text, cannot be clipped by a too-narrow label box, and is not
  // affected by the page's own CSS.
  htmlLabels: false,
  flowchart: { htmlLabels: false },
  logLevel: 'fatal', // parse errors are shown on the page instead
});

// Rendering is the slow part, so diagrams are cached by their source text.
const mermaidCache = new Map();
const MERMAID_CACHE_MAX = 100;
let mermaidSeq = 0;

async function renderMermaid(source) {
  const cached = mermaidCache.get(source);
  if (cached) return cached;
  const id = `mmd-${Date.now().toString(36)}-${mermaidSeq++}`;
  const { svg } = await mermaid.render(id, source);
  if (mermaidCache.size >= MERMAID_CACHE_MAX) mermaidCache.delete(mermaidCache.keys().next().value);
  mermaidCache.set(source, svg);
  return svg;
}

// Replace every ```mermaid block with its diagram, scaled to the text column.
// On failure the source stays visible with the parser's message above it.
async function renderDiagrams(root, { maxWidthPx, maxHeightPx }) {
  const stats = { rendered: 0, failed: 0 };
  const blocks = Array.from(root.querySelectorAll('pre > code.language-mermaid'));
  for (const code of blocks) {
    const pre = code.parentElement;
    const source = code.textContent.replace(/\n$/, '');
    try {
      const svgText = await renderMermaid(source);
      const figure = document.createElement('div');
      figure.className = 'mermaid-diagram';
      // The diagram replaces the <pre>, so carry its block number across.
      if (pre.dataset.block) figure.dataset.block = pre.dataset.block;
      figure.innerHTML = svgText;
      const svg = figure.querySelector('svg');
      if (!svg) throw new Error('Mermaid returned no SVG');
      fitSvg(svg, maxWidthPx, maxHeightPx);
      pre.replaceWith(figure);
      stats.rendered++;
    } catch (err) {
      const message = String(err && err.message ? err.message : err).split('\n').slice(0, 2).join(' ');
      const note = document.createElement('div');
      note.className = 'diagram-error';
      note.textContent = `Mermaid could not render this diagram: ${message}`;
      pre.classList.add('diagram-failed');
      pre.before(note);
      stats.failed++;
    }
  }
  return stats;
}

// Mermaid emits width="100%" plus a max-width; give the SVG explicit dimensions
// from its viewBox so it prints at natural size and shrinks only when needed.
function fitSvg(svg, maxWidthPx, maxHeightPx) {
  const viewBox = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  let w = viewBox.length === 4 ? viewBox[2] : parseFloat(svg.getAttribute('width'));
  let h = viewBox.length === 4 ? viewBox[3] : parseFloat(svg.getAttribute('height'));
  if (!(w > 0) || !(h > 0)) {
    svg.style.maxWidth = '100%';
    svg.style.height = 'auto';
    return;
  }
  const scale = Math.min(1, maxWidthPx / w, maxHeightPx / h);
  svg.setAttribute('width', String(Math.round(w * scale)));
  svg.setAttribute('height', String(Math.round(h * scale)));
  svg.style.width = `${Math.round(w * scale)}px`;
  svg.style.height = `${Math.round(h * scale)}px`;
  svg.style.maxWidth = 'none';
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
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

async function markdownToDom(markdown, { codeCharsPerLine = 80, maxDiagramWidthPx = 576, maxDiagramHeightPx = 600 } = {}) {
  const root = document.createElement('div');
  root.className = 'plan';
  state.diagramStats = { rendered: 0, failed: 0 };

  if (!markdown.trim()) {
    state.source = { src: '', blocks: [], exact: true };
    const hint = document.createElement('p');
    hint.className = 'empty-hint';
    hint.textContent = 'Paste a plan into the editor to see it here.';
    root.appendChild(hint);
    return root;
  }

  // Same HTML as marked.parse(), plus a data-block="N" number on every block
  // and a record of where block N sits in the Markdown source.
  const stamp = `b${Math.random().toString(36).slice(2, 10)}-`;
  const { html, blocks, src, exact } = renderBlocks(marked, markdown, { stamp });
  state.source = { src, blocks, exact };
  // <style> would restyle the whole app; forms have no place in a printout.
  root.innerHTML = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'button', 'select', 'textarea'],
  });
  // Only our own stamps count. A block number is kept when it carries this
  // render's random stamp; anything else called data-block arrived through
  // raw HTML written inside the document and is dropped. The same goes for
  // the attributes and class names the annotation code uses on the page.
  root.querySelectorAll('[data-block]').forEach((el) => {
    const value = el.getAttribute('data-block');
    if (el.parentElement === root && value.startsWith(stamp) && /^\d+$/.test(value.slice(stamp.length))) {
      el.setAttribute('data-block', value.slice(stamp.length));
    } else {
      el.removeAttribute('data-block');
    }
  });
  root.querySelectorAll('[data-anno], [data-anno-block], [data-label], [data-anno-label], [data-n], [data-wide]').forEach((el) => {
    for (const name of ['data-anno', 'data-anno-block', 'data-label', 'data-anno-label', 'data-n', 'data-wide']) el.removeAttribute(name);
  });
  root.querySelectorAll('[class*="anno"], .margin-notes, .pagedjs_hyphen').forEach((el) => {
    for (const name of Array.from(el.classList)) {
      if (/^anno(-|$)/.test(name) || name === 'margin-notes' || name === 'pagedjs_hyphen') el.classList.remove(name);
    }
  });

  // Task-list checkboxes -> CSS-drawn boxes that print consistently.
  root.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    const box = document.createElement('span');
    box.className = input.checked ? 'cb cb-checked' : 'cb';
    box.setAttribute('aria-hidden', 'true');
    input.replaceWith(box);
    const li = box.closest('li');
    if (li) li.classList.add('task');
  });
  // Only a list made entirely of tasks drops its bullets and indentation;
  // in a mixed list the box simply takes the bullet's place.
  root.querySelectorAll('ul, ol').forEach((list) => {
    const items = Array.from(list.children).filter((c) => c.tagName === 'LI');
    if (items.length && items.every((li) => li.classList.contains('task'))) list.classList.add('task-list');
  });

  // Mermaid first, so the generic code-block pass only sees real code (and
  // diagrams that failed to render, which stay as source).
  state.diagramStats = await renderDiagrams(root, { maxWidthPx: maxDiagramWidthPx, maxHeightPx: maxDiagramHeightPx });

  // Code blocks: language label, per-line wrapping, keep short blocks together.
  root.querySelectorAll('pre > code').forEach((code) => {
    const pre = code.parentElement;
    const match = /language-([\w+#-]+)/.exec(code.className || '');
    if (match && match[1] !== 'plaintext') pre.dataset.lang = match[1];
    // Keep a block on one page only if it will stay short after wrapping;
    // Paged.js emits a blank page for an unsplittable block taller than a page.
    const lines = code.textContent.replace(/\n$/, '').split('\n');
    const wrapped = lines.reduce((n, l) => n + Math.max(1, Math.ceil(l.length / codeCharsPerLine)), 0);
    if (wrapped <= 20) pre.classList.add('keep');
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

function detectTitle(root) {
  const h = root.querySelector('h1') || root.querySelector('h2') || root.querySelector('h3');
  if (h && h.textContent.trim()) return h.textContent.trim();
  const text = (root.textContent || '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 80) : 'Untitled plan';
}

function todayString() {
  return new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ---- Page geometry and CSS ------------------------------------------------------

function geometry(settings) {
  const paper = PAPERS[settings.paper] || PAPERS.letter;
  const layout = LAYOUTS[settings.layout] || LAYOUTS.review;
  const notesH = layout.marginColumn ? 0 : (NOTES[settings.notes] || NOTES.medium).h;
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
    // One rule per annotation label, e.g.
    // [data-label="question"] { --anno-color: #cfe4ff; --anno-ink: #1a56b0; }
    anno.labelCss(),
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
    // The pages are final: this app rebuilds them from scratch on any change.
    // Paged.js would otherwise keep watching each page for size changes and
    // try to re-flow it, which fails (with an error in the console) once
    // annotation marks have split the page's text.
    pages.forEach((page) => {
      try { page.removeListeners(); } catch { /* an older or newer Paged.js */ }
    });
  }
}
registerHandlers(FurnitureHandler); // once, at module load

// ---- Page layout handler --------------------------------------------------------

// Two things Paged.js needs from this app while it fills a page.
class LayoutHandler extends Handler {
  constructor(chunker, polisher, caller) {
    super(chunker, polisher, caller);
  }

  // Paged.js is about to fill one page, and has just finished it. A page is
  // always measured at 100% zoom, whatever the preview shows: see pauseZoom().
  beforePageLayout() {
    pauseZoom();
  }

  afterPageLayout() {
    resumeZoom();
  }

  // Paged.js has looked for the first thing that does not fit on the page.
  // `overflow` is a DOM Range from that point to the end of what it put on
  // the page (`rendered`), or undefined when everything fits. Returning a
  // Range replaces the one Paged.js found.
  onOverflow(overflow, rendered) {
    return keepDiagramWhole(overflow, rendered);
  }
}
registerHandlers(LayoutHandler); // once, at module load

// A page break must never land inside a diagram. Mermaid colours a diagram
// with CSS that only matches the <svg>'s own id. When Paged.js breaks a page
// in the middle of an <svg>, it continues the rest on the next page under a
// copy of that <svg> without the id (an id may appear only once), so nothing
// there is styled any more and every shape prints solid black.
// If the page overflows from a point inside a diagram, move that point to
// just before the diagram: the whole diagram then goes to the next page.
function keepDiagramWhole(overflow, rendered) {
  if (!overflow) return undefined; // everything fits: nothing to change
  const start = overflow.startContainer;
  const el = start.nodeType === Node.ELEMENT_NODE ? start : start.parentElement;
  const figure = el && el.closest('.mermaid-diagram');
  if (!figure || !rendered.contains(figure)) return undefined;
  // Only when something comes before the diagram on this page. A diagram
  // that is first on its page and still does not fit is taller than a page
  // (fitSvg normally prevents that); sending it on would get the same page
  // again, so that case is left to Paged.js as before.
  if (!hasContentBefore(figure, rendered)) return undefined;
  overflow.setStartBefore(figure);
  return overflow;
}

// True when some text or element comes before `node` inside `root`, that is,
// when `node` is not the first thing on its page.
function hasContentBefore(node, root) {
  for (let n = node; n && n !== root; n = n.parentNode) {
    for (let prev = n.previousSibling; prev; prev = prev.previousSibling) {
      if (prev.nodeType === Node.ELEMENT_NODE || prev.textContent.trim()) return true;
    }
  }
  return false;
}

// ---- Rendering --------------------------------------------------------------------

let previewer = null;
let rendering = false;
let pending = false;
let renderTimer = null;
let renderScheduled = false;

// The annotate controls (bar, pop-up, notes list) and the contents column.
// Both are created in init(); until then there is nothing to redraw.
let annotateUi = null;
let contentsUi = null;

function currentFurniture(root) {
  const s = state.settings;
  state.autoTitle = detectTitle(root);
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
  renderScheduled = false;
  state.lastError = null;
  setStatus('Rendering…');
  const t0 = performance.now();
  try {
    // The pages are about to be thrown away: keep a note that is mid-edit.
    anno.commitEdits();
    const markdown = els.editor.value;
    const g = geometry(state.settings);
    // Approximate monospace characters per line: code is 0.8em of the body size
    // and JetBrains Mono advances about 0.6em per character.
    const codeCharsPerLine = Math.max(30, Math.floor((g.contentW * 72) / (0.8 * g.layout.bodyPt * 0.6)));
    const root = await markdownToDom(markdown, {
      codeCharsPerLine,
      maxDiagramWidthPx: g.contentW * 96,
      maxDiagramHeightPx: g.contentH * 96 * 0.8, // leave room for a caption line and the heading above
    });
    root.classList.toggle('page-break-h2', Boolean(state.settings.breakH2));
    state.furniture = currentFurniture(root);
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
    // The pages are final. Marks and note cards are painted on top; neither
    // changes where any text sits. A failure here must never cost the render.
    try {
      anno.paint();
    } catch (err) {
      console.error(err);
    }
    state.pageCount = flow.total;
    state.lastRenderMs = Math.round(performance.now() - t0);
    applyZoom();
    const rendered = `${flow.total} page${flow.total === 1 ? '' : 's'} · rendered in ${state.lastRenderMs} ms`;
    // Anything the user should know about this document's notes (the file
    // could not be read, some notes lost their text) is said here, where a
    // later "Opened ..." message cannot paint over it, and stays in the notes list.
    if (anno.notice) setStatus(`${rendered} · ${anno.notice}`, true);
    else setStatus(rendered);
  } catch (err) {
    console.error(err);
    resumeZoom(); // the render may have stopped half way through a page
    state.lastError = err;
    setStatus(`Render error: ${err && err.message ? err.message : err}`, true);
  } finally {
    rendering = false;
    updateStatusRight();
    // The headings and their page numbers are known again, and a section
    // note that was typed while the pages were being rebuilt can be saved.
    if (contentsUi) contentsUi.refresh();
    if (annotateUi) annotateUi.refresh();
    if (pending) {
      pending = false;
      render();
    }
  }
}

function scheduleRender(delay = 350) {
  clearTimeout(renderTimer);
  renderScheduled = true;
  renderTimer = setTimeout(render, delay);
}

function renderOutstanding() {
  return renderScheduled || rendering || pending;
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

// The zoom is a CSS transform on #pages. It scales the finished pages on
// screen and changes nothing about their layout. But it stays on #pages while
// the next render is laid out, and there it does harm: Paged.js measures the
// page it is filling in screen pixels (getBoundingClientRect), which a
// transform scales, and compares them with CSS lengths, which a transform
// does not scale. Zoomed out below about 91 to 95% (it depends on the page
// margins) Paged.js no longer notices where a page is full. Text then drops
// off the bottom of pages without a trace, and a diagram that should move to
// the next page whole is cut in two.
// So the zoom is set to 100% while Paged.js fills a page and put straight
// back afterwards. Both happen before the browser draws its next frame, so
// the preview does not visibly change size. (The one exception: a page that
// has to wait for a picture that is still loading shows at 100% meanwhile.)
let zoomPaused = false;
let pausedTransform = '';
let zoomChangedWhilePaused = false;
// Tests only (set through the test hook's apply): leave the zoom on during
// layout, as the app used to, to prove that keepDiagramWhole() protects a
// diagram even then.
let layoutUnderZoomForTest = false;

function pauseZoom() {
  if (zoomPaused || layoutUnderZoomForTest) return;
  zoomPaused = true;
  pausedTransform = els.pages.style.transform;
  // "scale(1)" rather than no transform at all: both measure the same, but
  // switching a transform off and on makes the browser lay every finished
  // page out again (once per page), while changing its number costs nothing.
  if (pausedTransform) els.pages.style.transform = 'scale(1)';
}

function resumeZoom() {
  if (!zoomPaused) return;
  zoomPaused = false;
  els.pages.style.transform = pausedTransform;
  // A zoom change that arrived in the meantime was held back; apply it now.
  if (zoomChangedWhilePaused) {
    zoomChangedWhilePaused = false;
    applyZoom();
  }
}

function applyZoom() {
  if (zoomPaused) {
    zoomChangedWhilePaused = true;
    return;
  }
  const pagesEl = els.pages.querySelector('.pagedjs_pages');
  if (!pagesEl) return;
  els.pages.style.transform = '';
  els.pages.style.width = '';
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
  // #pages must be exactly the pages' natural width before it is scaled,
  // otherwise its scroll box ends up naturalW * scale^2 wide.
  els.pages.style.width = `${naturalW}px`;
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
  const usesMarginColumn = Boolean((LAYOUTS[s.layout] || LAYOUTS.review).marginColumn);
  els.notes.disabled = usesMarginColumn;
  els.notes.title = usesMarginColumn ? 'The Margin notes layout uses the right-hand column instead of a bottom box.' : '';
  // Typed margin notes need the wide column, so the layout is fixed while annotating.
  els.layout.disabled = state.annotate;
  els.layout.title = state.annotate ? 'Annotate mode always uses the Margin notes layout.' : '';
  els.title.value = s.title || '';
  els.date.value = s.date || '';
  els.app.classList.toggle('editor-hidden', !s.editorVisible);
  els.btnToggleEditor.textContent = s.editorVisible ? 'Hide editor' : 'Show editor';
  // In Annotate mode the notes list takes the editor's place.
  els.btnToggleEditor.disabled = state.annotate;
  // The contents column exists in Annotate mode only, and can be switched off there.
  els.app.classList.toggle('toc-off', !s.contentsVisible);
  els.annoToc.hidden = !(state.annotate && s.contentsVisible);
}

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
}

function updateStatusRight() {
  const g = geometry(state.settings);
  const notes = g.layout.marginColumn
    ? `${(g.layout.right - 0.8).toFixed(1)} in margin column`
    : (g.notesH > 0 ? `${g.notesH} in notes box` : 'no notes box');
  // Margin cards only have room in the Margin notes layout; say so rather
  // than let typed notes silently disappear in the other layouts.
  // (A section note is never a margin card, so it is not one of these.)
  const typed = g.layout.marginColumn ? 0 : anno.items().filter((it) => it.note && it.kind !== 'section').length;
  let hiddenNotes = typed ? ` · ${typed} typed note${typed === 1 ? '' : 's'} hidden (shown in the Margin notes layout)` : '';
  // A page with more notes than its margin holds shows them shortened.
  const crowded = anno.stats().overflowPages;
  if (crowded.length) hiddenNotes += ` · notes on page ${crowded.join(', ')} shortened to fit`;
  els.statusRight.textContent =
    `${g.layout.label.split(' — ')[0]} · ${g.paper.label} · text area ${g.contentW} × ${g.contentH} in · ${notes}${hiddenNotes}`;
}

function bindSetting(el, key, { rerender = true, prop = 'value' } = {}) {
  el.addEventListener('change', () => {
    state.settings[key] = el[prop];
    saveSettings();
    syncControls();
    if (rerender) scheduleRender(0);
    else applyZoom();
  });
}

function setMarkdown(text) {
  els.editor.value = text;
  saveMarkdownSoon();
  scheduleRender(0);
}

// The one place that switches the app to a different document: its text, its
// name, and any notes saved beside it. `tracked` is true when main.js knows a
// file path for it (so notes can be saved in a sidecar file).
function adoptDocument({ name = '', text = '', annotations = null, sidecar = null, docId = '' }, tracked = false) {
  const hasFile = Boolean(tracked && docId);
  state.doc = { name, hasFile, id: hasFile ? docId : '' };
  setMarkdown(text);
  saveMarkdownNow(); // text and notes must be remembered as a pair
  anno.load(annotations, { status: sidecar ? sidecar.status : 'none' });
  // Notes from a newer version of the app are left alone: no annotating.
  if (state.annotate && anno.readOnly) setAnnotateMode(false);
}

// Opening, pasting, loading the sample or clearing replaces the document. If
// its notes are not in a file (there is no file, or it could not be written),
// ask before they are thrown away.
function okToReplaceDocument() {
  anno.flush(); // a change made a moment ago may simply not have been written yet
  if (!anno.notOnDisk()) return true;
  return window.confirm(
    'This document has notes that are not saved beside a file.\n\n'
    + 'Replace it anyway? (Cancel, then use File → Save Markdown As… to keep them.)',
  );
}

// Replace the document with text that has no file behind it.
async function adoptLooseText(text, name = '') {
  anno.flush(); // the outgoing document's last change must reach its own notes file
  await api.forgetDocument();
  adoptDocument({ name, text }, false);
}

async function doOpen(claudePlans = false) {
  anno.flush(); // finish saving the current document's notes first
  if (!okToReplaceDocument()) return;
  const file = await api.openMarkdown({ claudePlans });
  if (!file) return;
  if (file.error) {
    setStatus(`Could not open file: ${file.error}`, true);
    return;
  }
  // "All files" can open a non-Markdown file; it has nowhere to keep notes
  // (main.js then sends no docId).
  adoptDocument(file, Boolean(file.docId));
  setStatus(`Opened ${file.name}`);
}

async function doSave() {
  const r = await api.saveMarkdown(els.editor.value, state.furniture ? state.furniture.title : 'plan');
  if (r && r.ok) {
    // Notes now have a home: write them beside the file that was just saved.
    // (A document that has never been annotated gets no sidecar file.)
    state.doc = { name: r.name || state.doc.name, hasFile: Boolean(r.docId), id: r.docId || '' };
    if (anno.count() > 0) await anno.saveNow();
    setStatus(`Saved ${r.path}`);
  } else if (r && r.error) {
    setStatus(`Could not save: ${r.error}`, true);
  }
}

async function doExportAnnotatedMd() {
  if (renderOutstanding()) await renderNow();
  anno.commitEdits();
  const base = (state.doc.name || (state.furniture ? state.furniture.title : 'plan')).replace(/\.(md|markdown|txt)$/i, '');
  const r = await api.exportAnnotatedMd(anno.exportMarkdown(), base);
  if (r && r.ok) setStatus(`Annotated Markdown saved: ${r.path}`);
  else if (r && r.error) setStatus(`Export failed: ${r.error}`, true);
}

async function doCopyForLlm() {
  if (renderOutstanding()) await renderNow();
  anno.commitEdits();
  const r = await api.writeClipboard(anno.exportMarkdown());
  if (r && r.ok) setStatus('Annotated Markdown copied. Paste it into your LLM.');
  else setStatus('Could not copy to the clipboard', true);
}

// Annotate mode: the text is locked so notes cannot drift, the layout
// switches to Margin notes (typed notes need the wide column), and the notes
// list takes the editor's place.
function setAnnotateMode(on) {
  if (state.annotate === on) return;
  if (on && anno.readOnly) {
    setStatus(anno.notice || 'Annotating is off for this document.', true);
    return;
  }
  if (!on) anno.commitEdits();
  state.annotate = on;
  els.app.classList.toggle('annotating', on);
  els.editor.readOnly = on;
  els.annoBar.hidden = !on;
  els.annoPane.hidden = !on;
  if (on && state.settings.layout !== 'margin') {
    state.settings.layout = 'margin';
    saveSettings();
    scheduleRender(0);
  }
  syncControls();
  updateStatusRight();
  applyZoom(); // the preview's width just changed
  if (contentsUi) contentsUi.refresh(); // it is not kept up to date while hidden
  setStatus(on
    ? 'Annotate mode: select text to highlight it or add a note. The Markdown is locked while this is on.'
    : `${state.pageCount} page${state.pageCount === 1 ? '' : 's'}`);
}

async function doExportPdf() {
  if (renderOutstanding()) await renderNow();
  anno.commitEdits();
  setStatus('Exporting PDF…');
  const r = await api.exportPdf({ paper: state.settings.paper, title: state.furniture ? state.furniture.title : 'plan' });
  const crowded = anno.stats().overflowPages;
  if (r && r.ok && crowded.length && !anno.hidden) {
    setStatus(`PDF saved: ${r.path}. Notes on page ${crowded.join(', ')} are shortened to fit the margin; the Markdown export has them in full.`, true);
  } else if (r && r.ok) setStatus(`PDF saved: ${r.path}`);
  else if (r && r.error) setStatus(`PDF export failed: ${r.error}`, true);
  else setStatus(`${state.pageCount} pages`);
}

async function doPrint() {
  if (renderOutstanding()) await renderNow();
  anno.commitEdits();
  setStatus('Opening print dialog…');
  const r = await api.print();
  if (r && r.ok) setStatus('Sent to printer');
  else setStatus(r && r.error ? `Print: ${r.error}` : `${state.pageCount} pages`, Boolean(r && r.error && r.error !== 'Print job canceled'));
}

async function doPaste() {
  const text = await api.readClipboard();
  if (text && text.trim()) {
    if (!okToReplaceDocument()) return;
    await adoptLooseText(text);
    setStatus('Pasted from clipboard');
  } else {
    setStatus('Clipboard has no text', true);
  }
}

async function doSample() {
  if (!okToReplaceDocument()) return;
  await adoptLooseText(await api.loadSample());
  setStatus('Loaded sample plan');
}

async function doClear() {
  if (!okToReplaceDocument()) return;
  await adoptLooseText('');
  setStatus('Cleared');
}

// On start-up the editor text comes back from the last session; bring its
// notes back too. They come from the sidecar file when main.js still knows
// the document, otherwise from the copy kept inside the app.
async function restoreAnnotations() {
  let resumed = null;
  try { resumed = await api.resumeDocument(); } catch { /* no remembered file */ }
  const cached = readCachedAnnotations(); // { doc, unsynced, data } or null
  if (!resumed || !resumed.docId) {
    // No file behind the text: the copy inside the app is all there is. It is
    // kept in step with the editor text, so it belongs to what was restored.
    state.doc = { name: '', hasFile: false, id: '' };
    anno.load(cached ? cached.data : null);
    return;
  }
  state.doc = { name: resumed.name, hasFile: true, id: resumed.docId };
  const status = resumed.sidecar ? resumed.sidecar.status : 'none';
  // The file is the truth. The copy inside the app is used only when it is
  // for this very document AND holds changes that never reached the file
  // (the app closed, or the folder could not be written, before they did).
  // A file that was replaced or deleted while the app was closed wins.
  if (cached && cached.doc === resumed.docId && cached.unsynced) {
    anno.load(cached.data, { status, unsaved: true });
  } else {
    anno.load(resumed.annotations, { status });
  }
}

function toggleEditor() {
  state.settings.editorVisible = !state.settings.editorVisible;
  saveSettings();
  syncControls();
  applyZoom();
}

// Show or hide the contents column. The choice is remembered, but the column
// itself only ever appears in Annotate mode.
function setContentsVisible(on) {
  state.settings.contentsVisible = Boolean(on);
  saveSettings();
  syncControls();
  applyZoom(); // the preview's width just changed
  if (contentsUi) contentsUi.refresh();
  if (annotateUi) annotateUi.refresh(); // the Contents button in the bar
}

async function init() {
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

  // A file dropped anywhere must never navigate the window away from the app.
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());

  // Drop a .md file onto the editor.
  let dragDepth = 0;
  els.editorPane.addEventListener('dragenter', () => {
    dragDepth++;
    els.editorPane.classList.add('dragover');
  });
  els.editorPane.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) els.editorPane.classList.remove('dragover');
  });
  els.editorPane.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    els.editorPane.classList.remove('dragover');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    if (!okToReplaceDocument()) return;
    anno.flush();
    try {
      // main.js reads a Markdown file itself, so it also learns where its
      // notes belong. The page never sees the full path.
      const doc = await api.openDropped(file);
      if (doc && doc.error) {
        setStatus(`Could not read ${file.name}: ${doc.error}`, true);
      } else if (doc && typeof doc.text === 'string') {
        adoptDocument(doc, Boolean(doc.docId));
        setStatus(`Loaded ${doc.name}`);
      } else {
        // Any other kind of file still opens, as text with no file behind it.
        await adoptLooseText(await file.text(), file.name);
        setStatus(`Loaded ${file.name}`);
      }
    } catch (err) {
      setStatus(`Could not read ${file.name}: ${err.message || err}`, true);
    }
  });

  els.btnOpen.addEventListener('click', () => doOpen(false));
  els.btnOpenPlans.addEventListener('click', () => doOpen(true));
  els.btnPaste.addEventListener('click', doPaste);
  els.btnSample.addEventListener('click', doSample);
  els.btnClear.addEventListener('click', doClear);
  els.btnPdf.addEventListener('click', doExportPdf);
  els.btnPrint.addEventListener('click', doPrint);
  els.btnToggleEditor.addEventListener('click', toggleEditor);

  // Links inside the preview open in the system browser, never in the app.
  // While annotating, a plain click on a link is far more likely to be the
  // end of a text selection, so only Ctrl/Cmd+click follows it.
  els.pages.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    e.preventDefault();
    if (state.annotate && !(e.ctrlKey || e.metaKey)) return;
    if (/^https?:\/\//i.test(a.href)) api.openExternal(a.href);
  });

  // While annotating, a drag is always a text selection, never the browser
  // picking up a link or an image to drag it somewhere.
  els.pages.addEventListener('dragstart', (e) => {
    if (state.annotate) e.preventDefault();
  });

  // The annotate tool bar, pop-up menu, notes list and shortcuts.
  annotateUi = initAnnotateUi({
    anno,
    els: {
      app: els.app,
      pages: els.pages,
      scroll: els.scroll,
      inner: els.inner,
      annoBar: els.annoBar,
      annoPane: els.annoPane,
      btnAnnotate: els.btnAnnotate,
    },
    actions: {
      isAnnotating: () => state.annotate,
      setAnnotateMode: (on) => { setAnnotateMode(Boolean(on)); annotateUi.refresh(); },
      isBusy: () => renderOutstanding(),
      exportMarkdown: doExportAnnotatedMd,
      copyForLlm: doCopyForLlm,
      setStatus,
      contentsShown: () => state.settings.contentsVisible,
      toggleContents: () => setContentsVisible(!state.settings.contentsVisible),
    },
  });
  // The contents column: headings, page numbers and note counts.
  contentsUi = initContents({
    anno,
    els: { pane: els.annoToc, pages: els.pages, scroll: els.scroll },
    actions: {
      isShown: () => state.annotate && state.settings.contentsVisible,
      isBusy: () => renderOutstanding(),
      hide: () => setContentsVisible(false),
      setStatus,
    },
  });
  anno.onChange(updateStatusRight);

  // Closing or reloading the window: write any unsaved notes first, and the
  // editor text with them (it is normally saved a moment after each change;
  // quitting inside that moment must not pair old text with new notes).
  window.addEventListener('beforeunload', () => {
    saveMarkdownNow();
    anno.flush();
  });

  api.onMenu((action) => {
    const actions = {
      'open': () => doOpen(false),
      'open-plans': () => doOpen(true),
      'save': doSave,
      'export-pdf': doExportPdf,
      'export-annotated-md': doExportAnnotatedMd,
      'print': doPrint,
      'toggle-editor': () => { if (!state.annotate) toggleEditor(); },
      'toggle-annotate': () => { setAnnotateMode(!state.annotate); annotateUi.refresh(); },
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

  // Mermaid measures text while laying out and memoises the result for the
  // lifetime of the page, so the diagram font must be loaded before the first
  // render, not merely requested.
  try {
    await document.fonts.load('16px "Inter"');
    await document.fonts.load('bold 16px "Inter"');
    await document.fonts.ready;
  } catch { /* ignore */ }

  // First render: a fresh install shows the sample so the app is not an empty box.
  if (!els.editor.value.trim()) {
    await doSample();
  } else {
    await restoreAnnotations();
    scheduleRender(0);
  }

  // Automated test hook used by main.js in PLAN_PRINTER_TEST_OUT mode. Exposed
  // only after the initial load so a late sample load cannot clobber a scenario.
  window.__planPrinterTest = {
    async apply(settings, markdown) {
      // Every scenario starts clean: no file, no notes, Annotate mode off,
      // nothing hidden.
      setAnnotateMode(false);
      anno.setHidden(false);
      state.doc = { name: '', hasFile: false, id: '' };
      anno.load(null);
      // layoutUnderZoom is not a setting. It lays the pages out with the
      // zoom still on them, as the app used to (see pauseZoom), for the one
      // scenario that checks a diagram stays whole even then.
      const { layoutUnderZoom = false, ...appSettings } = settings || {};
      layoutUnderZoomForTest = Boolean(layoutUnderZoom);
      Object.assign(state.settings, appSettings);
      syncControls();
      if (typeof markdown === 'string') els.editor.value = markdown;
      await renderNow();
      return {
        pages: state.pageCount,
        title: state.furniture ? state.furniture.title : '',
        renderMs: state.lastRenderMs,
        diagrams: { ...state.diagramStats },
        error: state.lastError ? String(state.lastError.stack || state.lastError.message || state.lastError) : null,
      };
    },
    geometry: () => geometry(state.settings),
    // Load a saved annotation set, re-render, report how many notes attached.
    async annotate(sidecar) {
      anno.load(sidecar);
      await renderNow();
      return anno.stats(); // { total, placed, unplaced, cards, overflowPages }
    },
    // Make one annotation the way a user does: find the words on the page,
    // select them, and go through the same code as a mouse selection.
    async annotateQuote(quote, { kind = 'highlight', label = 'note', note = '' } = {}) {
      if (renderOutstanding()) await renderNow();
      setAnnotateMode(true);
      if (renderOutstanding()) await renderNow();
      const walker = document.createTreeWalker(els.pages, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.nodeValue.indexOf(quote);
        if (at === -1 || !node.parentElement.closest('[data-block]')) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + quote.length);
        const id = anno.create({ kind, label, note, targets: anno.targetsFromRange(range) });
        return { id, stats: anno.stats() };
      }
      return { id: null, stats: anno.stats() };
    },
    // Highlight the whole of the first block that Paged.js split across two
    // pages, so a mark that has to be painted on both pages is exercised.
    async annotateAcrossBreak() {
      if (renderOutstanding()) await renderNow();
      setAnnotateMode(true);
      if (renderOutstanding()) await renderNow();
      const seen = new Map();
      for (const el of els.pages.querySelectorAll('[data-block]')) {
        const n = el.dataset.block;
        if (!seen.has(n)) seen.set(n, []);
        seen.get(n).push(el);
      }
      for (const pieces of seen.values()) {
        const pages = new Set(pieces.map((el) => el.closest('.pagedjs_page')));
        if (pages.size < 2 || !pieces[0].textContent.trim()) continue;
        const range = document.createRange();
        range.setStartBefore(pieces[0]);
        range.setEndAfter(pieces[pieces.length - 1]);
        const id = anno.create({ kind: 'highlight', label: 'note', targets: anno.targetsFromRange(range) });
        const marked = new Set(Array.from(els.pages.querySelectorAll('mark.anno')).map((m) => m.closest('.pagedjs_page')));
        return { id, pagesWithMarks: marked.size };
      }
      return { id: null, pagesWithMarks: 0 };
    },
    async settle() {
      if (renderOutstanding()) await renderNow();
      return true;
    },
    // Change settings but keep the notes (apply() starts each scenario clean).
    async relayout(settings) {
      Object.assign(state.settings, settings || {});
      syncControls();
      await renderNow();
      return anno.stats();
    },
    async replaceMarkdown(markdown) {
      els.editor.value = markdown;
      await renderNow();
      return anno.stats();
    },
    // Behave as if this document had just been opened from disk. `doc` is
    // what main.js's loadDocument() returns.
    async adoptFile(doc) {
      adoptDocument(doc, Boolean(doc && doc.docId));
      await renderNow();
      return anno.stats();
    },
    // Write the notes through the real bridge now, instead of in half a second.
    async saveNotes() {
      await anno.saveNow();
      return true;
    },
    // What start-up does: ask main.js for the last document and its notes.
    async restore() {
      await restoreAnnotations();
      await renderNow();
      return anno.stats();
    },
    // How many marks actually show colour or a line (none while hidden).
    paintedMarks: () => Array.from(els.pages.querySelectorAll('mark.anno')).filter((m) => {
      const style = getComputedStyle(m);
      return style.backgroundColor !== 'rgba(0, 0, 0, 0)' || style.textDecorationLine !== 'none';
    }).length,
    setAnnotateMode: (on) => setAnnotateMode(Boolean(on)),
    setAnnotationsHidden: (on) => anno.setHidden(on),
    // The contents column: what it should list (rows, notes) and what is
    // really on screen (shown, drawn, counts, pages, current).
    contents() {
      const rowEls = Array.from(els.annoToc.querySelectorAll('.anno-toc-row'));
      const text = (row, cls) => { const part = row.querySelector(cls); return part ? part.textContent : ''; };
      return {
        ...anno.outline(),
        shown: !els.annoToc.hidden && els.annoToc.offsetWidth > 0,
        drawn: rowEls.map((row) => text(row, '.anno-toc-text')),
        counts: rowEls.map((row) => Number(text(row, '.anno-toc-count') || 0)),
        pages: rowEls.map((row) => Number(text(row, '.anno-toc-page') || 0)),
        current: rowEls.findIndex((row) => row.hasAttribute('aria-current')),
        summary: text(els.annoToc, '.anno-toc-sub'),
        // Which rows carry the "has a section note" tick, and whose notes are open.
        ticks: rowEls.map((row) => Boolean(row.querySelector('.anno-toc-noted'))),
        open: rowEls.findIndex((row) => row.classList.contains('anno-toc-open')),
      };
    },
    // What the notes pane shows right now, read from the screen.
    notesPane() {
      const pane = els.annoPane;
      const text = (root, cls) => { const part = root.querySelector(cls); return part ? part.textContent : ''; };
      const seen = (cls) => { const part = pane.querySelector(cls); return Boolean(part && !part.hidden); };
      const box = pane.querySelector('.anno-section-text');
      const chips = {};
      for (const chip of pane.querySelectorAll('.anno-chip')) {
        chips[chip.querySelector('span:not(.anno-dot):not(.anno-chip-count)').textContent] = Number(text(chip, '.anno-chip-count'));
      }
      return {
        title: text(pane, '.anno-pane-title'),
        section: seen('.anno-pane-section') ? text(pane, '.anno-pane-section') : null,
        allButton: seen('.anno-all'),
        box: seen('.anno-section-box'),
        boxText: box ? box.value : '',
        meta: text(pane, '.anno-section-meta'),
        chips,
        rows: Array.from(pane.querySelectorAll('.anno-item')).map((row) => ({
          label: text(row, '.anno-item-label'),
          quote: text(row, '.anno-item-quote'),
          note: text(row, '.anno-item-note'),
          sectionNote: row.classList.contains('anno-item-section'),
          unplaced: row.classList.contains('anno-item-unplaced'),
        })),
      };
    },
    // Type into the section note box the way a user does: click into it,
    // type, click away (which is what saves it).
    async typeSectionNote(text) {
      const box = els.annoPane.querySelector('.anno-section-text');
      if (!box || box.closest('[hidden]')) return null;
      if (renderOutstanding()) await renderNow();
      box.focus();
      box.value = text;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.blur();
      // The test window is shown without the keyboard focus (see main.js), and
      // a page that does not have the focus is not sent real blur events.
      box.dispatchEvent(new FocusEvent('blur'));
      return this.notesPane();
    },
    // The "All notes" button.
    showAllNotes() {
      const button = els.annoPane.querySelector('.anno-all');
      if (button && !button.hidden) button.click();
      return this.notesPane();
    },
    setContentsVisible: (on) => setContentsVisible(Boolean(on)),
    // Click row `index` of the contents list the way a user does, wait for the
    // page to stop moving, and report where that heading ended up.
    async jumpToSection(index) {
      const row = els.annoToc.querySelectorAll('.anno-toc-row')[index];
      const wanted = anno.outline().rows[index];
      if (!row || !wanted) return null;
      const heading = els.pages.querySelector(`[data-block="${wanted.block}"]`);
      // The heading flashes when the page has arrived (see contents.js), so
      // that is what to wait for. A flash left over from an earlier click on
      // the same row must not be mistaken for this one.
      if (heading) heading.classList.remove('anno-flash');
      const flashing = () => Boolean(heading && heading.classList.contains('anno-flash'));
      row.click();
      for (let waited = 0; !flashing() && waited < 3000; waited += 25) {
        await new Promise((r) => setTimeout(r, 25));
      }
      const flashed = flashing();
      const view = els.scroll.getBoundingClientRect();
      const rows = Array.from(els.annoToc.querySelectorAll('.anno-toc-row'));
      return {
        // How far below the top of the view the heading sits, in screen pixels.
        offset: heading ? Math.round(heading.getBoundingClientRect().top - view.top) : null,
        viewHeight: Math.round(view.height),
        atEnd: els.scroll.scrollTop + els.scroll.clientHeight >= els.scroll.scrollHeight - 2,
        scrollTop: els.scroll.scrollTop,
        scrollMax: els.scroll.scrollHeight - els.scroll.clientHeight,
        current: rows.findIndex((r) => r.hasAttribute('aria-current')),
        flashed,
      };
    },
    annotationStats: () => anno.stats(),
    annotationItems: () => anno.items(),
    annotatedMarkdown: () => anno.exportMarkdown(),
    sidecar: () => anno.toSidecar(),
    pageCount: () => state.pageCount,
    // Pick a zoom the way the Zoom menu does: the finished pages are scaled,
    // nothing is laid out again. Returns the scale that is now on the pages
    // (and that stays there while the next render is laid out).
    setZoom(zoom) {
      state.settings.zoom = String(zoom);
      syncControls();
      applyZoom();
      return els.pages.style.transform;
    },
    // One entry per Mermaid diagram found on the pages, for checking that a
    // page break never tears a diagram apart or costs it its colours.
    diagramsOnPages() {
      const pageEls = Array.from(els.pages.querySelectorAll('.pagedjs_page'));
      const figures = Array.from(els.pages.querySelectorAll('.mermaid-diagram')).map((figure) => {
        const page = figure.closest('.pagedjs_page');
        const svgs = figure.querySelectorAll('svg');
        const svg = svgs[0];
        const style = svg && svg.querySelector('style');
        // A box Mermaid always fills with a light colour: a flowchart, state
        // or class node, or an actor of a sequence diagram.
        const nodeBox = svg && svg.querySelector('g.node rect, rect.actor');
        // Paged.js pushes whatever does not fit on a page sideways, out of
        // sight. A diagram is really on its page only when its box lies
        // inside that page's text area.
        const area = page.querySelector('.pagedjs_page_content').getBoundingClientRect();
        const box = figure.getBoundingClientRect();
        return {
          page: pageEls.indexOf(page) + 1,
          // Paged.js gives every element of the document one ref. Two
          // figures with the same ref are two pieces of one diagram.
          ref: figure.dataset.ref || '',
          piece: figure.hasAttribute('data-split-from') || Boolean(svg && svg.hasAttribute('data-split-from')),
          svgs: svgs.length,
          id: svg ? svg.id : '',
          styles: svg ? svg.querySelectorAll('style').length : 0,
          // Mermaid writes every rule of a diagram's CSS as "#<svg id> ...".
          // The rules only apply while the <svg> still carries that id.
          cssMatchesId: Boolean(svg && svg.id && style && style.textContent.includes(`#${svg.id}`)),
          shapes: svg ? svg.querySelectorAll('rect, circle, ellipse, polygon, path, line, text').length : 0,
          // What that CSS should have painted. Without it a box falls back
          // to the SVG default, solid black: rgb(0, 0, 0).
          nodeFill: nodeBox ? getComputedStyle(nodeBox).fill : '',
          onPage: box.height > 0 && box.left >= area.left - 1 && box.right <= area.right + 1
            && box.top >= area.top - 1 && box.bottom <= area.bottom + 1,
        };
      });
      return { rendered: state.diagramStats.rendered, figures };
    },
    // Where every line of text sits on the pages (in page pixels, so zoom and
    // scrolling do not matter), for checking that annotations move nothing.
    lineBoxes() {
      const origin = els.pages.getBoundingClientRect();
      const scale = (origin.width / els.pages.offsetWidth) || 1;
      const px = (v, from) => Math.round((v - from) / scale);
      const lines = new Map(); // top -> { bottom, left, right } of that line
      const walker = document.createTreeWalker(els.pages, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        // Whitespace-only nodes are measured too: a highlight turns the space
        // after it into a node of its own, and it must count both times.
        if (!node.parentElement.closest('.pagedjs_page_content')) continue;
        range.selectNodeContents(node);
        for (const r of range.getClientRects()) {
          if (!r.width) continue;
          const top = px(r.top, origin.top);
          const line = lines.get(top) || { bottom: -Infinity, left: Infinity, right: -Infinity };
          line.bottom = Math.max(line.bottom, px(r.bottom, origin.top));
          line.left = Math.min(line.left, px(r.left, origin.left));
          line.right = Math.max(line.right, px(r.right, origin.left));
          lines.set(top, line);
        }
      }
      return Array.from(lines, ([top, l]) => `${top}:${l.bottom}:${l.left}:${l.right}`).sort();
    },
  };
}

init().catch((err) => {
  console.error(err);
  setStatus(`Startup error: ${err && err.message ? err.message : err}`, true);
});
