// Margin note cards.
//
// Each note is a small card in the page's right-hand `.margin-notes` column,
// level with the text it is about. Cards are absolutely positioned inside that
// column, which sits outside the text flow, so adding or moving a card can
// never push text onto another page. Cards are real text in the page, so they
// print and can be found by pdftotext.

import './cards.css';
import { MAX_NOTE } from './model.js';

const GAP = 4; // px between stacked cards

// Where each card would like to sit (level with its text), remembered so the
// column can be re-stacked while a card grows as it is typed into.
const wantedTop = new WeakMap();

function labelName(labels, id) {
  const label = (labels || []).find((l) => l.id === id);
  return label ? label.name : id;
}

function buildCard(entry, labels) {
  const { annotation, number } = entry;
  const card = document.createElement('div');
  card.className = 'anno-card';
  card.dataset.anno = annotation.id;
  card.dataset.label = annotation.label;

  const head = document.createElement('div');
  head.className = 'anno-card-head';
  const num = document.createElement('span');
  num.className = 'anno-num';
  num.textContent = String(number);
  const tag = document.createElement('span');
  tag.className = 'anno-tag';
  tag.textContent = labelName(labels, annotation.label);
  // Screen-only delete button; hidden in print by ui.css.
  const tools = document.createElement('span');
  tools.className = 'anno-card-tools';
  tools.setAttribute('role', 'button');
  tools.title = 'Delete this note';
  tools.textContent = '×';
  head.append(num, tag, tools);

  const text = document.createElement('div');
  text.className = 'anno-text';
  text.textContent = annotation.note; // user text: never innerHTML
  card.append(head, text);
  return card;
}

// Take every card off the pages.
export function clearCards(pagesEl) {
  pagesEl.querySelectorAll('.anno-card').forEach((card) => card.remove());
  pagesEl.querySelectorAll('.margin-notes').forEach((col) => col.classList.remove('anno-overflow', 'anno-tight'));
}

// Where the anchor sits inside the column, in page pixels (zoom cancelled).
function anchorTop(anchor, col) {
  const box = col.getBoundingClientRect();
  if (!col.offsetHeight || !box.height) return 0;
  const zoom = box.height / col.offsetHeight; // screen px per page px
  const rects = anchor.getClientRects();
  const top = rects.length ? rects[0].top : anchor.getBoundingClientRect().top;
  return Math.max(0, (top - box.top) / zoom);
}

// Stack cards downwards from where they want to be; if the last one runs off
// the bottom, slide the stack back up. Returns false when they cannot all fit.
function stack(col, items) {
  const height = col.clientHeight;
  let floor = 0;
  for (const it of items) {
    it.h = it.card.offsetHeight;
    it.top = Math.max(it.y, floor);
    floor = it.top + it.h + GAP;
  }
  let ceiling = height;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.top + it.h > ceiling) it.top = ceiling - it.h;
    ceiling = it.top - GAP;
  }
  const fits = items.length === 0 || items[0].top >= 0;
  if (!fits) {
    // More notes than room: stack from the top and let the column clip.
    floor = 0;
    for (const it of items) {
      it.top = floor;
      floor += it.h + GAP;
    }
  }
  // The card being typed into must stay wholly in view, even if that means
  // it sits on top of a neighbour for a moment.
  for (const it of items) {
    if (it.card.classList.contains('editing')) it.top = Math.max(0, Math.min(it.top, height - it.h));
  }
  for (const it of items) it.card.style.top = `${Math.round(it.top)}px`;
  return fits;
}

// Place every card. `entries` are in document order:
//   { annotation, number, anchor }   anchor = the first mark, or the block's first piece
// Returns { cards, overflowPages } where overflowPages lists 1-based page numbers
// whose notes had to be clipped.
export function layoutCards(pagesEl, entries, { labels } = {}) {
  clearCards(pagesEl);

  const byColumn = new Map();
  for (const entry of entries) {
    const page = entry.anchor && entry.anchor.closest('.pagedjs_page');
    const col = page && page.querySelector('.margin-notes');
    if (!col) continue; // not the Margin notes layout: cards are not shown
    if (!byColumn.has(col)) byColumn.set(col, []);
    byColumn.get(col).push(entry);
  }

  const pages = Array.from(pagesEl.querySelectorAll('.pagedjs_page'));
  const overflowPages = [];
  let cards = 0;
  for (const [col, list] of byColumn) {
    const items = list
      .map((entry) => ({ entry, y: anchorTop(entry.anchor, col), card: buildCard(entry, labels) }))
      .sort((a, b) => a.y - b.y);
    for (const it of items) {
      col.appendChild(it.card);
      wantedTop.set(it.card, it.y);
    }
    cards += items.length;
    if (fitColumn(col, items)) overflowPages.push(pages.indexOf(col.closest('.pagedjs_page')) + 1);
  }
  return { cards, overflowPages: overflowPages.sort((a, b) => a - b) };
}

// Stack a column's cards; if they do not fit, clamp each to a few lines and
// stack again; if they still do not fit, clip at the column's edge. Returns
// true when the notes had to be shortened (the page is then reported, since
// its notes are no longer shown in full).
function fitColumn(col, items) {
  col.classList.remove('anno-tight', 'anno-overflow');
  if (stack(col, items)) return false;
  col.classList.add('anno-tight');
  if (!stack(col, items)) col.classList.add('anno-overflow');
  return true;
}

// The 1-based numbers of the pages whose notes are currently shortened.
export function crowdedPages(pagesEl) {
  const pages = Array.from(pagesEl.querySelectorAll('.pagedjs_page'));
  return pages
    .map((page, i) => (page.querySelector('.margin-notes.anno-tight') ? i + 1 : 0))
    .filter(Boolean);
}

// Re-stack one column while a card in it is being typed into (its height
// changes with every line).
function restackColumn(col) {
  if (!col) return;
  const items = Array.from(col.querySelectorAll('.anno-card')).map((card) => ({
    card,
    y: wantedTop.has(card) ? wantedTop.get(card) : (parseFloat(card.style.top) || 0),
  }));
  fitColumn(col, items.sort((a, b) => a.y - b.y));
}

export function findCard(pagesEl, id) {
  return pagesEl.querySelector(`.anno-card[data-anno="${CSS.escape(id)}"]`);
}

// Put a card into typing mode. `onCommit(text)` is called once, when the user
// clicks away or presses Escape / Ctrl+Enter. Nothing typed is ever thrown
// away: Undo is the way to take an edit back.
export function beginEdit(card, { onCommit }) {
  const text = card.querySelector('.anno-text');
  if (!text || card.classList.contains('editing')) return;
  card.classList.add('editing');
  // plaintext-only: pasted text can never bring markup with it.
  text.setAttribute('contenteditable', 'plaintext-only');
  text.spellcheck = false;
  // A shortened note opens out to its full text: make room for it now.
  restackColumn(card.parentElement);

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    text.removeEventListener('blur', finish);
    text.removeEventListener('keydown', onKey);
    text.removeEventListener('input', onInput);
    text.removeAttribute('contenteditable');
    card.classList.remove('editing');
    // What is stored is what the card shows: tidy the text in place, so the
    // controller does not have to rebuild the card just to display it.
    const value = text.textContent.replace(/\u00a0/g, ' ').trim().slice(0, MAX_NOTE);
    text.textContent = value;
    restackColumn(card.parentElement);
    onCommit(value);
  };
  const onKey = (e) => {
    e.stopPropagation(); // typing must not trigger the annotate shortcuts
    const closing = e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey));
    if (closing) {
      e.preventDefault();
      finish();
    }
  };
  const onInput = () => restackColumn(card.parentElement);
  text.addEventListener('blur', finish);
  text.addEventListener('keydown', onKey);
  text.addEventListener('input', onInput);

  text.focus({ preventScroll: true });
  // Caret at the end of any existing text.
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(text);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
  card.scrollIntoView({ block: 'nearest' });
}

// True while some card is being typed into.
export function isEditing(pagesEl) {
  return Boolean(pagesEl.querySelector('.anno-card.editing'));
}

// Finish any open edit now (before printing, exporting or re-rendering).
export function commitEdits(pagesEl) {
  const active = pagesEl.querySelector('.anno-card.editing .anno-text');
  if (active) active.blur();
}
