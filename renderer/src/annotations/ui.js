// Annotate mode: everything you click.
//
// This file builds the on-screen controls and turns clicks, text selections
// and key presses into calls on `anno`, the annotation controller (index.js).
// It never creates or removes the marks and margin cards on the pages (the
// controller owns those) and it keeps no copy of the annotations: after every
// change the controller calls us back and we redraw from what it reports.
//
//   bar      the third toolbar row: tools, label colours, undo, hide, contents, export
//   pop-up   the small menu beside a selection or a clicked mark
//   notes    the list that takes the editor's place, for the whole document
//            or for one section with its section note box
//            (the contents list beside it is built by contents.js)
//   "+"      the button beside a block, for a note about the whole block
//   keys     1-9 (one per label; there are five by default), U, S, N, Delete, Ctrl+Z, Esc
//
// The pages are thrown away and rebuilt whenever the document is laid out
// again, so nothing here holds on to a page element between two events.

import './ui.css';
import { sectionRange } from './outline.js';
import { MAX_NOTE as SECTION_NOTE_MAX } from './model.js';

// `text` is what the button shows, `name` is what a screen reader says.
const TOOLS = [
  { id: 'select', text: 'Select', name: 'Select',
    title: 'Select: choose text, then pick what to do from the pop-up (Esc)' },
  { id: 'highlight', text: 'Highlight', name: 'Highlight',
    title: 'Highlighter: every selection is highlighted in the current label colour' },
  { id: 'underline', text: 'U', name: 'Underline',
    title: 'Underline: every selection is underlined (key U underlines the current selection)' },
  { id: 'strike', text: 'S', name: 'Strikethrough',
    title: 'Strikethrough: every selection is struck out, meaning "remove this" (key S)' },
  { id: 'note', text: 'Note', name: 'Note',
    title: 'Note: every selection gets a margin note to type in (key N)' },
];

// The three ways a piece of text can be marked, as shown in the pop-up.
const KINDS = {
  highlight: { text: 'Highlight', name: 'Highlight', key: '' },
  underline: { text: 'U', name: 'Underline', key: 'U' },
  strike: { text: 'S', name: 'Strikethrough', key: 'S' },
};

// The small grey word after the label name in the notes list.
const KIND_HINT = { underline: 'underlined', strike: 'struck out', block: 'whole block' };

const QUOTE_MAX = 90; // characters of quoted text shown per row in the notes list
const EDGE = 6; // the pop-up stays this many pixels inside the window
const POP_GAP = 8; // space between the pop-up and what it points at
const ADD_GAP = 4; // space between the text column and the "+" button
const ADD_LINGER = 350; // ms the "+" stays after the pointer leaves, so it can be reached

const EMPTY_HINT = 'Select text on the page to highlight it or add a note.';
const EMPTY_SECTION_HINT = 'No notes in this section yet. Select text on the page to highlight it or add a note.';
const NO_SECTION_NOTES = 'No section notes yet. Click a heading in Contents, then write in the Section note box.';
// Stands in for a label in the filter chips: "only my section notes". A
// Symbol can never be mistaken for a label id from a file, which is a string.
const SECTION_NOTES = Symbol('section notes');
const UNPLACED_WHY = 'The text these notes were attached to is no longer in the document. '
  + 'They are kept and included at the end of the Markdown export.';
const BUSY = 'The pages are still being laid out. Try again in a moment.';

// ---- Small helpers ----------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text; // never innerHTML: notes are user text
  return node;
}

function button(className, text, title) {
  const node = el('button', className, text);
  node.type = 'button';
  if (title) node.title = title;
  return node;
}

// Only touch the page when something really changed, so redrawing is cheap.
function setPressed(node, on) {
  const value = on ? 'true' : 'false';
  if (node.getAttribute('aria-pressed') !== value) node.setAttribute('aria-pressed', value);
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

// An event's target is not always an element (it can be the document).
function closest(target, selector) {
  return target instanceof Element ? target.closest(selector) : null;
}

// True when a key press belongs to something the user is typing into.
function isTyping(target) {
  if (!(target instanceof Element)) return false;
  return target.isContentEditable === true
    || Boolean(target.closest('input, textarea, select, [contenteditable]'));
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function shorten(text, max) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

// Hand a label's colours to CSS. The stylesheet reads them as var(--sw) and
// var(--sw-ink), which is how one rule can draw five different swatches.
function tint(node, label) {
  if (label.color) node.style.setProperty('--sw', label.color);
  if (label.ink) node.style.setProperty('--sw-ink', label.ink);
}

// Make `parent` hold exactly `nodes`, in that order, moving as little as
// possible. Rows that are already in the right place are left alone, which
// keeps the keyboard focus and the scroll position where they were.
function syncChildren(parent, nodes) {
  let cursor = parent.firstChild;
  for (const node of nodes) {
    if (node === cursor) cursor = cursor.nextSibling;
    else parent.insertBefore(node, cursor);
  }
  while (cursor) {
    const next = cursor.nextSibling;
    cursor.remove();
    cursor = next;
  }
}

function overflowWarning(pages) {
  // True for many notes and for one very long note alike.
  const which = pages.length === 1
    ? `page ${pages[0]}`
    : `pages ${pages.slice(0, -1).join(', ')} and ${pages[pages.length - 1]}`;
  return `The notes on ${which} are shortened to fit the margin. Their full text is here and in the Markdown export.`;
}

// ---- The UI -------------------------------------------------------------------

// anno     the annotation controller
// els      { app, pages, scroll, inner, annoBar, annoPane, btnAnnotate }
// actions  { isAnnotating, setAnnotateMode, isBusy, exportMarkdown, copyForLlm, setStatus,
//            contentsShown, toggleContents }
// Returns { refresh() }: call it whenever Annotate mode is switched on or off.
export function initAnnotateUi({ anno, els, actions }) {
  // ---- Labels ---------------------------------------------------------------

  const labels = () => anno.labels || [];
  // One string that changes whenever the label list does (a different file
  // can bring its own labels), so the swatches are only rebuilt when needed.
  const labelsKey = () => JSON.stringify(labels().map((l) => [l.id, l.name, l.color, l.ink, l.meaning]));
  // An annotation may carry a label that is not in the list any more. It
  // still needs a name and a colour to be shown.
  const labelById = (id) => labels().find((l) => l.id === id)
    || { id, name: String(id || 'No label'), color: '#e2e2e6', ink: '#77777f', meaning: '' };

  function makeSwatch(label, index, withKey) {
    const meaning = label.meaning ? `: ${label.meaning}` : '';
    const key = withKey && index < 9 ? ` (key ${index + 1})` : '';
    const node = button('anno-swatch', '', `${label.name}${meaning}${key}`);
    node.dataset.act = 'label';
    node.dataset.value = label.id;
    node.setAttribute('aria-label', label.name);
    node.setAttribute('aria-pressed', 'false');
    tint(node, label);
    return node;
  }

  // ---- Making annotations -----------------------------------------------------

  // The controller ignores changes while the pages are being rebuilt (they
  // are about to be replaced). Say so, rather than leave a click that does nothing.
  function ready() {
    if (!actions.isBusy()) return true;
    actions.setStatus(BUSY, false);
    return false;
  }

  // What is selected on the pages right now: { targets, rect }, or null when
  // nothing is. `targets` is empty when the selection holds nothing that can
  // be marked (a diagram, say).
  function readSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    if (!range.intersectsNode(els.pages)) return null; // selected somewhere else in the window
    return { targets: anno.targetsFromRange(range) || [], rect: range.getBoundingClientRect() };
  }

  function clearSelection() {
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
  }

  // What a key press or a bar button should act on: the selection the pop-up
  // was opened for, else whatever is selected now, else null.
  function pendingTargets() {
    if (!actions.isAnnotating() || actions.isBusy()) return null;
    if (pop.mode === 'new') return pop.targets;
    const found = readSelection();
    return found && found.targets.length ? found.targets : null;
  }

  // Every way of marking text ends up here. `kind` is 'highlight',
  // 'underline', 'strike', or 'note' (a highlight whose margin card opens for
  // typing straight away). Returns the new id, or null when nothing was made.
  function createFrom(kind, labelId, targets) {
    if (!targets || targets.length === 0 || !ready()) return null;
    if (anno.hidden) anno.setHidden(false); // otherwise the new mark would be invisible
    const id = anno.create({
      kind: kind === 'note' ? 'highlight' : kind,
      label: labelId,
      targets,
      note: '',
    });
    // No id means the controller refused. Leave the selection as it is, so
    // it is plain that nothing was made.
    if (id === null || id === undefined) return null;
    // Clear the selection before the card opens: the card puts the text
    // cursor inside itself, and clearing afterwards would take it away again.
    clearSelection();
    closePopover();
    if (kind === 'note') anno.editNote(id);
    return id;
  }

  // A label was picked in the bar or with keys 1-5: highlight the selection
  // with it, or, with nothing selected, make it the current label.
  function chooseLabel(id) {
    const targets = pendingTargets();
    if (targets) createFrom('highlight', id, targets);
    else anno.setLabel(id);
  }

  // A tool was picked in the bar. Text that is already selected is marked
  // straight away, the same as text selected from now on.
  function chooseTool(tool) {
    anno.setTool(tool);
    if (tool === 'select') return;
    const targets = pendingTargets();
    if (targets) createFrom(tool, anno.label, targets);
  }

  // Export and copy talk to the main process and can fail; report it.
  async function run(what, task) {
    try {
      await task();
    } catch (err) {
      actions.setStatus(`${what} failed: ${err && err.message ? err.message : err}`, true);
    }
  }

  // ---- The annotate bar -----------------------------------------------------

  const toolButtons = TOOLS.map((tool) => {
    const node = button(`anno-tool anno-tool-${tool.id}`, tool.text, tool.title);
    node.dataset.act = 'tool';
    node.dataset.value = tool.id;
    node.setAttribute('aria-label', tool.name);
    return node;
  });
  const toolGroup = el('div', 'group anno-tools');
  toolGroup.append(...toolButtons);

  const swatchGroup = el('div', 'group anno-swatches'); // filled by drawBar()
  let barSwatches = []; // [{ id, node }]
  let barLabelsKey = null;

  const undoBtn = button('', 'Undo', 'Undo the last annotation change (Ctrl+Z)');
  undoBtn.dataset.act = 'undo';
  const redoBtn = button('', 'Redo', 'Redo (Ctrl+Shift+Z)');
  redoBtn.dataset.act = 'redo';
  const historyGroup = el('div', 'group');
  historyGroup.append(undoBtn, redoBtn);

  const hideBtn = button('anno-hide', 'Hide', '');
  hideBtn.dataset.act = 'hide';
  const hideGroup = el('div', 'group');
  hideGroup.append(hideBtn);

  // Shows or hides the contents column. It looks pressed while the column is shown.
  const contentsBtn = button('anno-contents', 'Contents', '');
  contentsBtn.dataset.act = 'contents';
  const viewGroup = el('div', 'group');
  viewGroup.append(contentsBtn);

  const exportBtn = button('', 'Export Markdown…', 'Save a copy of the Markdown with your notes written into it');
  exportBtn.dataset.act = 'export';
  const copyBtn = button('', 'Copy for LLM', 'Copy the Markdown with your notes to the clipboard');
  copyBtn.dataset.act = 'copy';
  const exportGroup = el('div', 'group right');
  exportGroup.append(exportBtn, copyBtn);

  els.annoBar.setAttribute('role', 'toolbar');
  els.annoBar.setAttribute('aria-label', 'Annotation tools');
  els.annoBar.append(toolGroup, swatchGroup, historyGroup, hideGroup, viewGroup, exportGroup);

  // A click on a button normally moves the keyboard focus to it and can drop
  // the text selection. Cancelling mousedown stops both; the click still happens.
  els.annoBar.addEventListener('mousedown', (e) => e.preventDefault());

  els.annoBar.addEventListener('click', (e) => {
    const node = closest(e.target, 'button');
    if (!node || node.disabled) return;
    const { act, value } = node.dataset;
    if (act === 'tool') chooseTool(value);
    else if (act === 'label') chooseLabel(value);
    else if (act === 'undo') { if (anno.canUndo() && ready()) anno.undo(); }
    else if (act === 'redo') { if (anno.canRedo() && ready()) anno.redo(); }
    else if (act === 'hide') anno.setHidden(!anno.hidden);
    else if (act === 'contents') actions.toggleContents(); // app.js redraws the bar afterwards
    else if (act === 'export') run('Export', () => actions.exportMarkdown());
    else if (act === 'copy') run('Copy', () => actions.copyForLlm());
  });

  function drawBar() {
    const key = labelsKey();
    if (key !== barLabelsKey) {
      barLabelsKey = key;
      barSwatches = labels().map((label, i) => ({ id: label.id, node: makeSwatch(label, i, true) }));
      swatchGroup.replaceChildren(...barSwatches.map((s) => s.node));
    }
    for (const node of toolButtons) setPressed(node, node.dataset.value === anno.tool);
    for (const s of barSwatches) setPressed(s.node, s.id === anno.label);
    undoBtn.disabled = !anno.canUndo();
    redoBtn.disabled = !anno.canRedo();
    const hidden = Boolean(anno.hidden);
    setText(hideBtn, hidden ? 'Show' : 'Hide');
    const hideTitle = hidden
      ? 'Show the marks and notes again'
      : 'Hide every mark and note, for a clean printout';
    if (hideBtn.title !== hideTitle) hideBtn.title = hideTitle;
    setPressed(hideBtn, hidden);
    const contents = Boolean(actions.contentsShown());
    const contentsTitle = contents
      ? 'Hide the contents list, to give the pages more room'
      : 'Show the contents list: every heading, its page and how many notes it has';
    if (contentsBtn.title !== contentsTitle) contentsBtn.title = contentsTitle;
    setPressed(contentsBtn, contents);
  }

  // ---- The pop-up -------------------------------------------------------------

  const pop = {
    node: el('div', 'anno-popover'),
    mode: null, // null = closed, 'new' = a fresh selection, 'edit' = an existing annotation
    targets: null, // 'new': what the selection covered, worked out when the pop-up opened
    id: null, // 'edit': which annotation
    anchor: null, // { left, right, top, bottom } on screen: what the pop-up points at
    drawn: '', // what is on screen now, so an unchanged pop-up is not rebuilt
    scrollTop: 0, // where the preview was scrolled to when the pop-up opened
    scrollLeft: 0,
  };
  pop.node.hidden = true;
  pop.node.setAttribute('role', 'toolbar');
  pop.node.setAttribute('aria-label', 'Annotation');
  document.body.append(pop.node);

  function openPopover(mode, anchor, { targets = null, id = null } = {}) {
    pop.mode = mode;
    pop.targets = targets;
    pop.id = id;
    pop.anchor = anchor;
    pop.drawn = '';
    pop.scrollTop = els.scroll.scrollTop;
    pop.scrollLeft = els.scroll.scrollLeft;
    drawPopover();
  }

  function closePopover() {
    if (!pop.mode) return;
    pop.mode = null;
    pop.targets = null;
    pop.id = null;
    pop.anchor = null;
    pop.drawn = '';
    pop.node.hidden = true;
    pop.node.replaceChildren();
  }

  function kindButton(kind, withKey) {
    const k = KINDS[kind];
    const node = button(`anno-tool-${kind}`, k.text, withKey && k.key ? `${k.name} (${k.key})` : k.name);
    node.dataset.act = 'kind';
    node.dataset.value = kind;
    node.setAttribute('aria-label', k.name);
    return node;
  }

  function actionButton(act, text, title, className = '') {
    const node = button(className, text, title);
    node.dataset.act = act;
    return node;
  }

  function drawPopover() {
    if (!pop.mode) return;
    const item = pop.mode === 'edit' ? anno.get(pop.id) : null;
    if (pop.mode === 'edit' && !item) { // deleted or undone while the pop-up was open
      closePopover();
      return;
    }
    const hasNote = Boolean(item && item.note && item.note.trim());
    const state = JSON.stringify([pop.mode, labelsKey(), anno.label, item && [item.kind, item.label, hasNote]]);
    if (state === pop.drawn) return;
    pop.drawn = state;

    // The ring goes on the annotation's own label, or on the current label
    // for a new selection (that is the one U, S and Note will use).
    const ringed = item ? item.label : anno.label;
    const swatches = labels().map((label, i) => {
      const node = makeSwatch(label, i, pop.mode === 'new');
      setPressed(node, label.id === ringed);
      return node;
    });

    const rows = [];
    if (pop.mode === 'new') {
      const row = el('div', 'anno-pop-row');
      row.append(
        ...swatches,
        el('span', 'anno-pop-sep'),
        kindButton('underline', true),
        kindButton('strike', true),
        actionButton('note', 'Note', 'Highlight it and write a note in the margin (N)'),
      );
      rows.push(row);
    } else {
      const top = el('div', 'anno-pop-row');
      top.append(...swatches);
      const bottom = el('div', 'anno-pop-row');
      if (item.kind !== 'block') { // a note on a whole block has no highlight/underline/strike
        for (const kind of Object.keys(KINDS)) {
          const node = kindButton(kind, false);
          setPressed(node, item.kind === kind);
          bottom.append(node);
        }
        bottom.append(el('span', 'anno-pop-sep'));
      }
      bottom.append(
        actionButton('note', hasNote ? 'Edit note' : 'Add note', 'Type a note in the margin'),
        actionButton('delete', 'Delete', 'Delete this annotation (Delete key)', 'anno-danger'),
      );
      rows.push(top, bottom);
    }
    pop.node.replaceChildren(...rows);
    placePopover();
  }

  // Below what it points at when there is room, above when there is not,
  // and always fully inside the window.
  function placePopover() {
    const a = pop.anchor;
    if (!a) return;
    const node = pop.node;
    node.hidden = false; // it has to be visible to be measured
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    const viewW = document.documentElement.clientWidth;
    const viewH = document.documentElement.clientHeight;
    let left = (a.left + a.right) / 2 - w / 2;
    let top = a.bottom + POP_GAP;
    if (top + h > viewH - EDGE && a.top - POP_GAP - h >= EDGE) top = a.top - POP_GAP - h;
    left = Math.max(EDGE, Math.min(left, viewW - w - EDGE));
    top = Math.max(EDGE, Math.min(top, viewH - h - EDGE));
    node.style.left = `${Math.round(left)}px`;
    node.style.top = `${Math.round(top)}px`;
  }

  // Called after every change: keep the pop-up in step, or close it when
  // what it was about has gone.
  function syncPopover() {
    if (!pop.mode) return;
    if (!actions.isAnnotating()) {
      closePopover();
    } else if (pop.mode === 'edit') {
      if (anno.hidden) closePopover();
      else drawPopover(); // closes itself when the annotation no longer exists
    } else {
      // 'new': the saved targets describe a selection on pages that may have
      // just been replaced. If the selection is gone, so is the offer.
      const sel = window.getSelection();
      if (actions.isBusy() || !sel || sel.isCollapsed) closePopover();
      else drawPopover();
    }
  }

  pop.node.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection (see the bar)

  pop.node.addEventListener('click', (e) => {
    const node = closest(e.target, 'button');
    if (!node || !pop.mode) return;
    const { act, value } = node.dataset;
    if (pop.mode === 'new') {
      // pop.targets was worked out when the pop-up opened, so this does not
      // depend on the text still being selected.
      const targets = pop.targets;
      if (act === 'label') createFrom('highlight', value, targets);
      else if (act === 'kind') createFrom(value, anno.label, targets);
      else if (act === 'note') createFrom('note', anno.label, targets);
      return;
    }
    const id = pop.id;
    const item = anno.get(id);
    if (!item) { // it was deleted or undone a moment ago
      closePopover();
      return;
    }
    if (!ready()) return;
    // For a label or a kind the pop-up stays open and redraws. Picking the
    // one it already has changes nothing, so it is not sent (and not undoable).
    if (act === 'label') { if (item.label !== value) anno.update(id, { label: value }); }
    else if (act === 'kind') { if (item.kind !== value) anno.update(id, { kind: value }); }
    else if (act === 'note') { closePopover(); anno.editNote(id); }
    else if (act === 'delete') { closePopover(); anno.remove(id); }
  });

  // A press anywhere outside the pop-up closes it. `true` (capture) means we
  // hear about the press first, even if another handler stops it travelling.
  document.addEventListener('pointerdown', (e) => {
    if (pop.mode && !(e.target instanceof Node && pop.node.contains(e.target))) closePopover();
  }, true);

  // The pop-up does not move with the page, so it closes when the page does.
  // Comparing positions ignores a late scroll event from before it opened.
  els.scroll.addEventListener('scroll', () => {
    if (!pop.mode) return;
    if (els.scroll.scrollTop !== pop.scrollTop || els.scroll.scrollLeft !== pop.scrollLeft) closePopover();
  }, { passive: true });

  window.addEventListener('resize', () => {
    closePopover();
    hideAdd(); // the zoom may have changed, so its position is stale
  });

  // ---- The notes list ---------------------------------------------------------
  //
  // Two views. "All notes" lists everything. Clicking a heading in the contents
  // list opens that one section: a box for your own note on the section (the
  // "section note") and, under it, every note made inside the section,
  // subsections included. anno.section says which view is showing.

  let filter = null; // a label id, SECTION_NOTES, or null to list everything
  let chips = []; // [{ id (null = "All"), node, count }]
  let chipsLabelsKey = null;
  const rowCache = new Map(); // annotation id -> { node, state }

  const paneTitle = el('div', 'anno-pane-title');
  const allBtn = button('anno-all', 'All notes', 'Back to the notes of the whole document');
  allBtn.hidden = true;
  const titleRow = el('div', 'anno-pane-top');
  titleRow.append(paneTitle, allBtn);
  const sectionName = el('div', 'anno-pane-section'); // the open section's heading
  sectionName.hidden = true;
  const chipRow = el('div', 'anno-chips');
  const paneHead = el('div', 'anno-pane-head');
  paneHead.append(titleRow, sectionName, chipRow);

  // The section note box. It is a plain text box: what is typed is saved when
  // the box is left (and before anything that needs the notes to be complete).
  const sectionLabel = el('label', 'anno-section-label', 'Section note');
  const sectionText = el('textarea', 'anno-section-text');
  sectionText.id = 'anno-section-text';
  sectionLabel.htmlFor = sectionText.id;
  sectionText.rows = 4;
  sectionText.maxLength = SECTION_NOTE_MAX;
  sectionText.spellcheck = true;
  sectionText.placeholder = 'Your final notes on this section. Saved when you click away.';
  const sectionMeta = el('div', 'anno-section-meta');
  const sectionBox = el('div', 'anno-section-box');
  sectionBox.append(sectionLabel, sectionText, sectionMeta);
  sectionBox.hidden = true;

  const warnLine = el('p', 'anno-warn');
  const hintLine = el('p', 'anno-hint');
  const placedList = el('div', 'anno-list');
  placedList.setAttribute('role', 'list');
  const unplacedTitle = el('div', 'anno-sub');
  const unplacedList = el('div', 'anno-list');
  unplacedList.setAttribute('role', 'list');
  const unplacedBox = el('div', 'anno-unplaced');
  unplacedBox.append(unplacedTitle, el('p', 'anno-explain', UNPLACED_WHY), unplacedList);
  warnLine.hidden = true;
  hintLine.hidden = true;
  unplacedBox.hidden = true;
  els.annoPane.setAttribute('aria-label', 'Notes');
  els.annoPane.append(paneHead, warnLine, sectionBox, hintLine, placedList, unplacedBox);

  // `label` is a label from the list, SECTION_NOTES, or null for "All".
  function makeChip(label) {
    const sections = label === SECTION_NOTES;
    const name = sections ? 'Section' : label ? label.name : 'All';
    const node = button('anno-chip', '', sections
      ? 'Show only your section notes (click again for all)'
      : label ? `Show only ${label.name} notes (click again for all)` : 'Show every note');
    node.setAttribute('aria-pressed', 'false');
    if (sections) {
      node.append(el('span', 'anno-dot anno-dot-section'));
    } else if (label) {
      const dot = el('span', 'anno-dot');
      tint(dot, label);
      node.append(dot);
    }
    const count = el('span', 'anno-chip-count', '0');
    node.append(el('span', '', name), count);
    return { id: sections ? SECTION_NOTES : label ? label.id : null, node, count };
  }

  function buildRow(item, label) {
    const placed = item.status !== 'unplaced';
    const section = item.kind === 'section';
    const row = el('div', placed ? 'anno-item' : 'anno-item anno-item-unplaced');
    if (section) row.classList.add('anno-item-section');
    row.dataset.id = item.id;
    row.setAttribute('role', 'listitem');
    if (placed) row.tabIndex = 0; // reachable with Tab; Enter jumps to it on the page

    const head = el('div', 'anno-item-head');
    if (item.number !== null && item.number !== undefined) {
      const num = el('span', 'anno-item-num', String(item.number));
      num.title = 'The number on its margin card';
      head.append(num);
    }
    if (section) {
      // No colour label: a section note is your summary, not a mark on the text.
      head.append(el('span', 'anno-dot anno-dot-section'), el('span', 'anno-item-label', 'Section note'));
    } else {
      const dot = el('span', 'anno-dot');
      tint(dot, label);
      head.append(dot, el('span', 'anno-item-label', label.name));
    }
    if (KIND_HINT[item.kind]) head.append(el('span', 'anno-item-kind', KIND_HINT[item.kind]));

    const end = el('span', 'anno-item-end');
    if (item.page !== null && item.page !== undefined) end.append(el('span', 'anno-item-page', `p. ${item.page}`));
    const del = button('anno-item-del', '×', section ? 'Delete this section note' : 'Delete this annotation');
    del.setAttribute('aria-label', del.title);
    end.append(del);
    head.append(end);
    row.append(head);

    const quote = shorten(item.exact, QUOTE_MAX);
    // For a section note the "quote" is the heading it belongs to.
    if (quote) row.append(el('div', 'anno-item-quote', section ? quote : `“${quote}”`));
    const note = String(item.note || '').trim();
    if (note) row.append(el('div', 'anno-item-note', note)); // CSS clamps it to three lines
    if (section && placed) row.title = 'Open this section: its note and every note inside it';
    return row;
  }

  // The row for one annotation. A row whose content has not changed is the
  // very same element as last time, so the list is not rebuilt on every change.
  function rowFor(item) {
    const label = labelById(item.label);
    const state = JSON.stringify([item.kind, item.label, item.note, item.exact, item.status,
      item.number, item.page, label.name, label.color, label.ink]);
    const cached = rowCache.get(item.id);
    if (cached && cached.state === state) return cached.node;
    const node = buildRow(item, label);
    rowCache.set(item.id, { node, state });
    return node;
  }

  // ---- The section note box ---------------------------------------------------

  let boxSection = null; // the heading block the box belongs to, or null while it is hidden
  let boxEpoch = 0; // which document that was (see anno.epoch)
  let boxDirty = false; // the box holds typing that has not been handed over yet
  // Typed text on its way into the notes: { block, text, epoch }, or null. It waits
  // here when the controller cannot take a change (the pages are being
  // rebuilt) and is tried again at the next refresh, so it is never lost.
  let waiting = null;

  // As tall as its text, up to the limit in ui.css (after that it scrolls).
  function growSectionText() {
    sectionText.style.height = 'auto';
    sectionText.style.height = `${sectionText.scrollHeight + 2}px`;
  }

  function showSectionText(text) {
    if (sectionText.value !== text) sectionText.value = text;
    growSectionText();
  }

  // Hand what was typed to the controller. Safe to call at any time.
  function saveSectionNote() {
    if (boxDirty && boxSection !== null) {
      waiting = { block: boxSection, text: sectionText.value, epoch: boxEpoch };
      boxDirty = false;
    }
    // Typed for a document that has since been replaced: block numbers mean
    // something else now, so it cannot be saved (the old document's notes
    // were asked to save before it was replaced).
    if (waiting && waiting.epoch !== anno.epoch) waiting = null;
    if (!waiting) return;
    const job = waiting;
    waiting = null; // before the call: saving redraws this pane, which looks at `waiting`
    if (!anno.setSectionNote(job.block, job.text)) waiting = job;
  }

  sectionText.addEventListener('input', () => {
    boxDirty = true;
    growSectionText();
  });
  sectionText.addEventListener('blur', saveSectionNote);
  sectionText.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation(); // not also "close the pop-up" or "back to the Select tool"
    sectionText.blur(); // which saves
  });
  // Exports, undo, a re-render and closing the window all need the notes to
  // be complete: the controller asks before each of them.
  anno.onCommitEdits(saveSectionNote);

  // `row` is the open section's row from anno.outline(), or null in "All notes".
  function drawSectionBox(row, inSection) {
    if (!row) {
      // The box is going away: whatever was typed in it must not go with it.
      saveSectionNote();
      boxSection = null;
      sectionBox.hidden = true;
      return;
    }
    if (boxSection !== row.block || boxEpoch !== anno.epoch) {
      saveSectionNote();
      boxSection = row.block;
      boxEpoch = anno.epoch;
    }
    sectionBox.hidden = false; // before the text goes in: a hidden box cannot be measured
    // Show what is stored, unless the box holds something newer.
    if (!boxDirty) {
      const own = anno.sectionNote(row.block);
      const pending = waiting && waiting.block === row.block ? waiting.text : null;
      showSectionText(pending !== null ? pending : (own ? own.note : ''));
    }
    const notes = inSection.filter((it) => it.kind !== 'section').length;
    const below = inSection.length - notes; // section notes of its subsections
    setText(sectionMeta, below
      ? `${plural(notes, 'note')} and ${plural(below, 'section note')} in this section`
      : `${plural(notes, 'note')} in this section`);
  }

  function drawPane() {
    // Typing that belongs to a section which is no longer the open one is
    // handed over FIRST. Saving redraws this pane from inside, so it has to
    // happen before anything below reads the notes.
    if (boxSection !== null && (boxSection !== anno.section || boxEpoch !== anno.epoch)) saveSectionNote();

    const all = anno.items() || [];
    const stats = anno.stats() || {};
    const overflow = stats.overflowPages || [];

    // Which view: one section, or everything.
    const outline = anno.outline();
    const index = anno.section === null ? -1 : outline.rows.findIndex((row) => row.block === anno.section);
    const sectionRow = index >= 0 ? outline.rows[index] : null;
    const range = sectionRow ? sectionRange(outline.rows, index) : null;
    const own = sectionRow ? anno.sectionNote(sectionRow.block) : null;
    // The notes this view is about. In a section: everything that starts
    // inside it, except its own section note (that one is in the box).
    const items = sectionRow
      ? all.filter((it) => it.block !== null && it.block >= range.from && it.block < range.to && !(own && it.id === own.id))
      : all;

    const key = labelsKey();
    if (key !== chipsLabelsKey) {
      chipsLabelsKey = key;
      chips = [makeChip(null), ...labels().map(makeChip), makeChip(SECTION_NOTES)];
      chipRow.replaceChildren(...chips.map((c) => c.node));
    }
    // A filter on a label that no longer exists would hide everything.
    if (filter !== null && filter !== SECTION_NOTES && !labels().some((l) => l.id === filter)) filter = null;

    // A section note has no colour label, so it is counted on the chip of its own.
    const groupOf = (it) => (it.kind === 'section' ? SECTION_NOTES : it.label);
    const perGroup = new Map();
    for (const it of items) perGroup.set(groupOf(it), (perGroup.get(groupOf(it)) || 0) + 1);
    for (const chip of chips) {
      setText(chip.count, String(chip.id === null ? items.length : perGroup.get(chip.id) || 0));
      setPressed(chip.node, chip.id === filter);
    }

    setText(paneTitle, `Notes (${items.length})`);
    allBtn.hidden = !sectionRow;
    sectionName.hidden = !sectionRow;
    if (sectionRow) {
      setText(sectionName, sectionRow.title);
      if (sectionName.title !== sectionRow.title) sectionName.title = sectionRow.title;
    }
    drawSectionBox(sectionRow, items);

    const wanted = (it) => filter === null || groupOf(it) === filter;
    const placed = items.filter((it) => it.status !== 'unplaced');
    const unplaced = items.filter((it) => it.status === 'unplaced');
    const shownPlaced = placed.filter(wanted);
    const shownUnplaced = unplaced.filter(wanted);
    syncChildren(placedList, shownPlaced.map(rowFor));
    syncChildren(unplacedList, shownUnplaced.map(rowFor));
    // Forget the rows of annotations that are gone or filtered out.
    const shown = new Set([...shownPlaced, ...shownUnplaced].map((it) => it.id));
    for (const id of Array.from(rowCache.keys())) {
      if (!shown.has(id)) rowCache.delete(id);
    }

    unplacedBox.hidden = unplaced.length === 0;
    setText(unplacedTitle, shownUnplaced.length === unplaced.length
      ? `Unplaced (${unplaced.length})`
      : `Unplaced (${shownUnplaced.length} of ${unplaced.length})`);

    let hint = '';
    if (items.length === 0) hint = sectionRow ? EMPTY_SECTION_HINT : EMPTY_HINT;
    else if (shown.size === 0) hint = filter === SECTION_NOTES ? NO_SECTION_NOTES : 'No notes with this label.';
    setText(hintLine, hint);
    hintLine.hidden = !hint;

    // Anything wrong with this document's notes (the file could not be read,
    // some notes lost their text) stays here for as long as it is true.
    const warnings = [stats.notice || '', overflow.length ? overflowWarning(overflow) : ''].filter(Boolean);
    setText(warnLine, warnings.join(' '));
    warnLine.hidden = warnings.length === 0;
  }

  // A click (or Enter) on a row: go to it on the page. A section note also
  // opens its section here, which is how to get from "All notes" to the box.
  function openRow(row) {
    if (row.classList.contains('anno-item-unplaced')) return; // nowhere on the page to go to
    const item = anno.get(row.dataset.id);
    if (item && item.kind === 'section' && item.block !== null) anno.setSection(item.block);
    anno.focus(row.dataset.id);
  }

  // Keep the selection and the focus where they are, as in the bar. The bare
  // pane is left alone so its scrollbar still works, and so is the section
  // note box, which has to be clicked into.
  els.annoPane.addEventListener('mousedown', (e) => {
    if (closest(e.target, 'button, .anno-item')) e.preventDefault();
  });

  els.annoPane.addEventListener('click', (e) => {
    const node = closest(e.target, 'button');
    if (node) {
      if (node === allBtn) {
        anno.setSection(null);
        return;
      }
      const chip = chips.find((c) => c.node === node);
      if (chip) {
        filter = chip.id === filter ? null : chip.id; // a second click on the same label shows all again
        drawPane();
        return;
      }
      const row = node.closest('.anno-item');
      if (row && node.classList.contains('anno-item-del') && ready()) anno.remove(row.dataset.id);
      return;
    }
    const row = closest(e.target, '.anno-item');
    if (row) openRow(row);
  });

  // Enter or Space on a row that has the keyboard focus does what a click does.
  els.annoPane.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target;
    if (!(row instanceof Element) || !row.classList.contains('anno-item')) return;
    e.preventDefault();
    openRow(row);
  });

  // ---- The "+" beside a block ---------------------------------------------------

  const addBtn = button('anno-add', '+', 'Add a note about this whole block');
  addBtn.setAttribute('aria-label', 'Add a note about this whole block');
  addBtn.hidden = true;
  els.inner.append(addBtn);

  let addBlock = null; // the number of the block the "+" is beside (a number, never an element)
  let addTimer = 0;

  // `pointerY` is where the mouse is (screen pixels). The button sits level
  // with it, kept inside the block, so on a block taller than the window it
  // is always a short sideways move away instead of up at the block's top.
  function showAdd(blockEl, pointerY) {
    const index = Number(blockEl.dataset.block);
    if (blockEl.dataset.block === '' || !Number.isInteger(index)) return;
    clearTimeout(addTimer);
    // Both rectangles are in screen pixels, so the zoom needs no special care.
    const block = blockEl.getBoundingClientRect();
    const inner = els.inner.getBoundingClientRect();
    const column = blockEl.closest('.pagedjs_page_content'); // the page's text column
    const right = column ? column.getBoundingClientRect().right : block.right;
    addBlock = index;
    addBtn.hidden = false;
    const size = addBtn.offsetHeight || 20;
    const top = Math.max(block.top, Math.min(pointerY - size / 2, block.bottom - size));
    addBtn.style.left = `${Math.round(right - inner.left + ADD_GAP)}px`;
    addBtn.style.top = `${Math.round(top - inner.top)}px`;
  }

  function hideAdd() {
    clearTimeout(addTimer);
    addBlock = null;
    addBtn.hidden = true;
  }

  // Not at once: the pointer crosses a small gap on its way to the button.
  function hideAddSoon() {
    clearTimeout(addTimer);
    addTimer = setTimeout(hideAdd, ADD_LINGER);
  }

  els.pages.addEventListener('mousemove', (e) => {
    if (!actions.isAnnotating() || actions.isBusy()) {
      hideAdd();
      return;
    }
    if (e.buttons !== 0) {
      hideAdd(); // a text selection is being dragged: get out from under the pointer
      return;
    }
    const blockEl = closest(e.target, '[data-block]');
    if (blockEl && els.pages.contains(blockEl)) showAdd(blockEl, e.clientY);
    else hideAddSoon();
  });
  els.pages.addEventListener('mouseleave', hideAddSoon);
  addBtn.addEventListener('mouseenter', () => clearTimeout(addTimer));
  addBtn.addEventListener('mouseleave', hideAddSoon);
  addBtn.addEventListener('mousedown', (e) => e.preventDefault());
  addBtn.addEventListener('click', () => {
    const index = addBlock;
    hideAdd();
    if (index === null || !actions.isAnnotating() || !ready()) return;
    closePopover();
    if (anno.hidden) anno.setHidden(false); // otherwise the new card would be invisible
    anno.createBlockNote(index, anno.label);
  });

  // ---- Selecting text and clicking marks on the pages ---------------------------

  let dragFromPages = false; // a press that began on the pages has not been released yet
  // Has the selection changed since the last press on the pages? A click on
  // something that cannot be selected (the page header, say) leaves an old
  // selection untouched, and that must not count as selecting it again.
  let selectionMoved = true;
  document.addEventListener('selectionchange', () => { selectionMoved = true; });

  // Dragging past the end of a line is how people select "to the end of this
  // line". On these pages that puts the pointer over the page margin, which
  // the browser does not treat as part of the text: it would jump the
  // selection to the top of the page or the end of the document. So when the
  // pointer is left or right of the text column, the selection is ended at
  // the nearest place inside the column on the same line.
  function keepInColumn(point) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.anchorNode) return;
    let column = null;
    for (const el of els.pages.querySelectorAll('.pagedjs_page_content')) {
      const r = el.getBoundingClientRect();
      if (point.y >= r.top && point.y <= r.bottom) {
        column = r;
        break;
      }
    }
    if (!column || (point.x >= column.left && point.x <= column.right)) return;
    const x = Math.min(Math.max(point.x, column.left + 2), column.right - 2);
    const at = document.caretRangeFromPoint(x, point.y);
    if (!at) return;
    const node = at.startContainer;
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!el || !el.closest('.pagedjs_page_content')) return;
    try { sel.extend(node, at.startOffset); } catch { /* nothing to extend */ }
  }

  // Runs just after the mouse button is released, when the selection is final.
  function onSelectionEnd(point) {
    if (!actions.isAnnotating() || actions.isBusy() || !selectionMoved) return;
    keepInColumn(point);
    const found = readSelection();
    if (!found) return;
    const tool = anno.tool;
    if (found.targets.length === 0) {
      if (tool !== 'select') {
        actions.setStatus('Nothing in that selection can be marked. For a diagram, use the + beside it.', false);
      }
      return;
    }
    if (tool !== 'select') { // "highlighter pen": mark it at once
      createFrom(tool, anno.label, found.targets);
      return;
    }
    // A selection with no size on screen cannot be pointed at; use the pointer.
    const r = found.rect;
    const anchor = r.width || r.height
      ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
      : { left: point.x, right: point.x, top: point.y, bottom: point.y };
    openPopover('new', anchor, { targets: found.targets });
  }

  // The selection is only final once the browser has finished handling the
  // release, hence the zero-length timer.
  function selectionSoon(e) {
    const point = { x: e.clientX, y: e.clientY };
    setTimeout(() => onSelectionEnd(point), 0);
  }

  // Margin cards handle their own clicks and typing (the controller owns them).
  const inCard = (target) => Boolean(closest(target, '.anno-card'));

  els.pages.addEventListener('pointerdown', (e) => {
    dragFromPages = e.button === 0 && !inCard(e.target);
    selectionMoved = false; // set again by 'selectionchange' if this press selects anything
  });
  els.pages.addEventListener('pointerup', (e) => {
    const dragged = dragFromPages; // began in the text; may end over a margin card
    dragFromPages = false;
    if (e.button === 0 && (dragged || !inCard(e.target))) selectionSoon(e);
  });
  // A drag that began on the pages often ends just outside them (past the
  // end of a line, say). That release never reaches the listener above.
  document.addEventListener('pointerup', (e) => {
    if (!dragFromPages) return;
    dragFromPages = false;
    selectionSoon(e);
  });
  document.addEventListener('pointercancel', () => { dragFromPages = false; });
  // While the drag is still going, correct it once per frame, after the
  // browser has made its own (possibly wild) update for this mouse move.
  let dragFrame = 0;
  document.addEventListener('pointermove', (e) => {
    if (!dragFromPages || (e.buttons & 1) === 0 || !actions.isAnnotating()) return;
    const point = { x: e.clientX, y: e.clientY };
    cancelAnimationFrame(dragFrame);
    dragFrame = requestAnimationFrame(() => keepInColumn(point));
  });

  // A plain click on a mark, or on a block that has a note, opens the pop-up
  // for that annotation. One listener on #pages covers every page, including
  // pages that are built later.
  els.pages.addEventListener('click', (e) => {
    if (!actions.isAnnotating() || anno.hidden || inCard(e.target)) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // this click was the end of a text selection
    const mark = closest(e.target, 'mark.anno[data-anno]');
    const block = mark ? null : closest(e.target, '[data-anno-block]');
    const id = mark ? mark.dataset.anno : block ? block.dataset.annoBlock : '';
    if (!id || !anno.get(id)) return;
    // Level with the mark, centred on the pointer. A block can be very tall,
    // so its pop-up simply opens at the pointer.
    const r = mark ? mark.getBoundingClientRect() : null;
    openPopover('edit', {
      left: e.clientX,
      right: e.clientX,
      top: r ? r.top : e.clientY - POP_GAP,
      bottom: r ? r.bottom : e.clientY + POP_GAP,
    }, { id });
  });

  // ---- Keyboard shortcuts -------------------------------------------------------

  document.addEventListener('keydown', (e) => {
    if (!actions.isAnnotating() || e.defaultPrevented || e.isComposing) return;
    if (isTyping(e.target)) return; // the key is for a text box or a note being typed
    if (typeof e.key !== 'string') return; // some browser-made key events carry no key
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key; // so Shift+U still counts as U

    if (e.ctrlKey || e.metaKey) {
      if (e.altKey) return;
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        if (anno.canUndo() && ready()) anno.undo();
      } else if ((key === 'z' && e.shiftKey) || (key === 'y' && e.ctrlKey && !e.shiftKey)) {
        e.preventDefault();
        if (anno.canRedo() && ready()) anno.redo();
      }
      return; // Ctrl+S, Ctrl+P and the rest are not ours
    }
    if (e.altKey) return;

    if (/^[1-9]$/.test(key)) {
      const label = labels()[Number(key) - 1]; // key 1 is the first label
      if (!label) return;
      e.preventDefault();
      if (pop.mode === 'edit') {
        // A pop-up for an existing mark is open: the key recolours that mark.
        if (ready()) anno.update(pop.id, { label: label.id });
      } else {
        chooseLabel(label.id);
      }
    } else if (key === 'u' || key === 's' || key === 'n') {
      const targets = pendingTargets();
      if (!targets) return; // nothing selected: these keys do nothing
      e.preventDefault();
      createFrom(key === 'u' ? 'underline' : key === 's' ? 'strike' : 'note', anno.label, targets);
    } else if (key === 'Delete' || key === 'Backspace') {
      if (pop.mode !== 'edit') return;
      e.preventDefault();
      if (!ready()) return;
      const id = pop.id;
      closePopover();
      anno.remove(id);
    } else if (key === 'Escape') {
      if (pop.mode) {
        e.preventDefault();
        // Leaving the words selected would make the next press on them start
        // a drag-and-drop of the text instead of a new selection.
        if (pop.mode === 'new') clearSelection();
        closePopover();
      } else if (anno.tool !== 'select') {
        e.preventDefault();
        anno.setTool('select');
      }
    }
  });

  // ---- The Annotate button, and redrawing ---------------------------------------

  els.btnAnnotate.addEventListener('click', () => {
    actions.setAnnotateMode(!actions.isAnnotating());
    refresh();
  });

  // Bring every control in line with the controller. Runs after any change,
  // so it only ever reads state and never changes an annotation itself.
  function refresh() {
    const on = Boolean(actions.isAnnotating());
    setPressed(els.btnAnnotate, on); // ui.css gives the pressed button its "on" look
    drawBar();
    // A section note that could not be saved while the pages were being
    // rebuilt is handed over as soon as they are done.
    if (waiting && !actions.isBusy()) saveSectionNote();
    drawPane();
    syncPopover();
    if (!on || actions.isBusy()) hideAdd();
  }

  anno.onChange(refresh);
  refresh();

  return { refresh };
}
