// Reading and marking the paginated pages.
//
// Everything here works on the live page DOM inside #pages, AFTER Paged.js has
// finished laying it out. Marks are "paint only": they add colour or a line but
// never change the size or position of any text, so page breaks cannot move.
//
// Text is always compared with all whitespace removed ("squeezed"). Paged.js
// deletes whitespace-only text nodes, code blocks lose their line breaks, and a
// paragraph can be split across two pages, so whitespace is the one thing that
// is not stable between renders. Letters are.

import { MAX_QUOTE } from './model.js';

// Elements that start a new "unit" of text. Crossing from one unit to the next
// counts as a space when a quote is written out for a person to read.
const UNIT = 'p, li, td, th, h1, h2, h3, h4, h5, h6, dt, dd, blockquote, pre, .code-line';

// Text inside these is never part of a block's text: diagrams (SVG labels),
// the "could not render" notice, and the CSS-drawn task checkboxes.
const SKIP = '.mermaid-diagram, .diagram-error, svg, .cb';

// Whitespace sitting directly inside these separates rows or items, not words.
const STRUCTURAL = new Set(['UL', 'OL', 'DL', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR']);

// Paged.js appends this glyph to a word it had to break across two pages.
const HYPHEN = '\u2011';

const WORD_CHAR = /[\p{L}\p{N}_]/u;

// A selection longer than MAX_QUOTE (counted without spaces) is almost
// certainly a mis-drag; a block note is the better tool for "this whole
// section". The limit lives in model.js so reading a file agrees with it.

function endsWithGlyph(node) {
  const parent = node.parentElement;
  return Boolean(parent) && parent.classList.contains('pagedjs_hyphen') && node.nodeValue.endsWith(HYPHEN);
}

// True when characters start..end of a block begin and end at the edges of
// words. Every annotation is made that way (see targetsFromRange), so a match
// that cuts through a word ("open" found inside "to pending") is a coincidence.
export function isWordAligned(bt, start, end) {
  const joined = (i) => i > 0 && i < bt.key.length && !bt.spaced[i]
    && WORD_CHAR.test(bt.key[i - 1]) && WORD_CHAR.test(bt.key[i]);
  return !joined(start) && !joined(end);
}

// Every block on the pages, grouped by its number. A block split across two
// pages has two pieces, in page order.
export function collectBlocks(pagesEl) {
  const groups = new Map();
  for (const el of pagesEl.querySelectorAll('[data-block]')) {
    if (!/^\d+$/.test(el.dataset.block)) continue; // '' would otherwise count as 0
    const n = Number(el.dataset.block);
    if (!groups.has(n)) groups.set(n, []);
    groups.get(n).push(el);
  }
  return groups;
}

// One block's text with whitespace removed, plus where every kept character
// lives in the DOM.
//   key       the squeezed text
//   where[i]  [textNode, offset] of key[i]
//   spaced[i] true when whitespace (or a new line/list item/cell) came before key[i]
export function blockText(els) {
  let key = '';
  const where = [];
  const spaced = [];
  let gap = false;
  let lastUnit = null;
  for (const el of els || []) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || parent.closest(SKIP)) continue;
      // The two halves of a paragraph split across pages share a data-ref, so
      // a word broken at the page edge still reads as one word.
      const unitEl = parent.closest(UNIT);
      const unit = unitEl ? (unitEl.getAttribute('data-ref') || unitEl) : null;
      if (unit !== lastUnit) {
        if (key) gap = true;
        lastUnit = unit;
      }
      const value = node.nodeValue;
      const end = endsWithGlyph(node) ? value.length - 1 : value.length;
      for (let i = 0; i < end; i++) {
        if (/\s/.test(value[i])) {
          gap = true;
          continue;
        }
        key += value[i];
        where.push([node, i]);
        spaced.push(gap);
        gap = false;
      }
    }
  }
  return { key, where, spaced };
}

// Characters start..end written the way a person would read them, with single
// spaces put back where whitespace was.
export function readable(bt, start, end) {
  let out = '';
  for (let i = Math.max(0, start); i < Math.min(end, bt.key.length); i++) {
    if (i > start && bt.spaced[i]) out += ' ';
    out += bt.key[i];
  }
  return out;
}

// The saved form of "these characters of this block": the quote itself plus
// about 32 characters either side, used to find it again after edits.
export function describe(bt, block, start, end) {
  const before = readable(bt, Math.max(0, start - 32), start);
  const after = readable(bt, end, Math.min(bt.key.length, end + 32));
  return {
    block,
    start,
    end,
    exact: readable(bt, start, end),
    prefix: before + (bt.spaced[start] && before ? ' ' : ''),
    suffix: (bt.spaced[end] && after ? ' ' : '') + after,
  };
}

function wrapPiece(node, from, to, annotation) {
  if (to <= from) return null;
  const range = document.createRange();
  range.setStart(node, from);
  range.setEnd(node, to);
  const mark = document.createElement('mark');
  mark.className = `anno anno-${annotation.kind}`;
  mark.dataset.anno = annotation.id;
  mark.dataset.label = annotation.label;
  range.surroundContents(mark); // splits the text node for us
  return mark;
}

// Whitespace-only text nodes that sit between two wrapped pieces, e.g. the
// space between a bold word and an italic word. Without them a highlight
// would show a gap at every change of formatting.
function spacesBetween(a, b) {
  const found = [];
  const root = a.ownerDocument.body;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  walker.currentNode = a;
  for (let node = walker.nextNode(); node && node !== b; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || node.nodeValue.trim() !== '' || node.nodeValue === '') continue;
    if (STRUCTURAL.has(parent.tagName) || parent.closest(SKIP) || !parent.closest(UNIT)) continue;
    if (!parent.closest('[data-block]')) continue; // page headers, margin cards
    found.push(node);
  }
  return found;
}

const codeLineOf = (node) => (node.parentElement ? node.parentElement.closest('.code-line') : null);
const inCode = (node) => Boolean(node.parentElement && node.parentElement.closest('pre'));

// May a mark run unbroken across the gap between these two pieces of text?
// In prose, yes. In a code block only within one line: the gap between two
// lines is the second line's indentation, and a strike-through or underline
// drawn across that looks wrong.
function joinable(a, b) {
  if (!inCode(a) && !inCode(b)) return true;
  const line = codeLineOf(a);
  return line !== null && line === codeLineOf(b);
}

// Wrap characters start..end of a block in <mark> elements, one per text node,
// so a wrapper never crosses an element boundary. Returns the marks in order.
// `bt` is stale afterwards (text nodes were split); call blockText() again
// before wrapping anything else in the same block.
export function wrapRange(bt, start, end, annotation) {
  const pieces = new Map(); // textNode -> [from, to]
  const order = [];
  for (let i = Math.max(0, start); i < Math.min(end, bt.where.length); i++) {
    const [node, off] = bt.where[i];
    let piece = pieces.get(node);
    if (!piece) {
      piece = [off, off + 1];
      pieces.set(node, piece);
      order.push(node);
    }
    piece[1] = off + 1;
  }
  if (order.length === 0) return [];

  // Gather the in-between spaces before anything is split.
  const extra = [];
  for (let i = 0; i + 1 < order.length; i++) {
    if (joinable(order[i], order[i + 1])) extra.push(...spacesBetween(order[i], order[i + 1]));
  }

  const marks = [];
  order.forEach((node, index) => {
    let [from, to] = pieces.get(node);
    // Inside the run, take the node's leading and trailing spaces too, but
    // never the page-break hyphen glyph.
    if (index > 0 && joinable(order[index - 1], node)) from = 0;
    if (index < order.length - 1 && joinable(node, order[index + 1])) {
      to = endsWithGlyph(node) ? node.length - 1 : node.length;
    }
    const mark = wrapPiece(node, from, to, annotation);
    if (mark) marks.push(mark);
  });
  for (const node of extra) {
    if (node.isConnected && node.length > 0) wrapPiece(node, 0, node.length, annotation);
  }
  // Document order, so "the last mark" really is where the quote ends.
  return Array.from(new Set(marks)).sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
}

// Show a note's number at the end of its quote. The number is drawn by CSS on
// whatever element carries data-n, at that element's top-right corner. A mark
// that wraps onto a second line has no single corner, so the last word (which
// cannot wrap) gets a small mark of its own to carry the number.
export function numberMark(mark, n, annotation) {
  const walker = document.createTreeWalker(mark, NodeFilter.SHOW_TEXT);
  let last = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeValue.trim()) last = node;
  }
  const cut = last ? last.nodeValue.search(/\S+\s*$/) : -1;
  if (!last || cut <= 0) {
    mark.dataset.n = String(n); // one word (or nothing to split): the mark itself
    if (n >= 10) mark.dataset.wide = '1';
    return;
  }
  const range = document.createRange();
  range.setStart(last, cut);
  range.setEnd(last, last.length);
  const ref = document.createElement('mark');
  ref.className = 'anno'; // no colour of its own: the mark around it shows through
  ref.dataset.anno = annotation.id;
  ref.dataset.label = annotation.label;
  ref.dataset.n = String(n);
  // Two digits do not fit in the space between two words: page.css draws
  // them a little smaller.
  if (n >= 10) ref.dataset.wide = '1';
  range.surroundContents(ref);
}

// Take every annotation mark back out, leaving the text exactly as it was.
export function unwrapAll(pagesEl) {
  const parents = new Set();
  for (const mark of Array.from(pagesEl.querySelectorAll('mark.anno'))) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    mark.remove();
    parents.add(parent);
  }
  // Re-join the text nodes that wrapping split apart.
  for (const parent of parents) if (parent.isConnected) parent.normalize();
}

// A note on a whole block: a coloured bar beside every piece of it.
export function markBlock(pieces, annotation) {
  for (const el of pieces || []) {
    el.classList.add('anno-block');
    el.dataset.annoBlock = annotation.id;
    el.dataset.annoLabel = annotation.label;
  }
}

export function unmarkBlocks(pagesEl) {
  for (const el of pagesEl.querySelectorAll('.anno-block')) {
    el.classList.remove('anno-block');
    delete el.dataset.annoBlock;
    delete el.dataset.annoLabel;
  }
}

// Turn what the user selected with the mouse into saved targets, one per
// block the selection touches. Returns [] when nothing markable is selected.
export function targetsFromRange(pagesEl, range) {
  if (!range || range.collapsed) return [];
  const targets = [];
  for (const [block, pieces] of collectBlocks(pagesEl)) {
    if (!pieces.some((el) => range.intersectsNode(el))) continue;
    const bt = blockText(pieces);
    if (!bt.key) continue; // e.g. a diagram: nothing to quote
    let start = -1;
    let end = -1;
    let lastNode = null;
    let touched = false;
    for (let i = 0; i < bt.where.length; i++) {
      const [node, off] = bt.where[i];
      if (node !== lastNode) {
        lastNode = node;
        touched = range.intersectsNode(node);
      }
      if (!touched) continue;
      // A character is selected when both of its edges lie inside the range.
      if (range.comparePoint(node, off) !== 0 || range.comparePoint(node, off + 1) !== 0) continue;
      if (start < 0) start = i;
      end = i + 1;
    }
    if (start < 0) continue;
    // Widen to whole words. A mark that starts mid-word could nudge letter
    // spacing; one that starts at a space cannot.
    while (start > 0 && !bt.spaced[start] && WORD_CHAR.test(bt.key[start - 1]) && WORD_CHAR.test(bt.key[start])) start--;
    while (end < bt.key.length && !bt.spaced[end] && WORD_CHAR.test(bt.key[end - 1]) && WORD_CHAR.test(bt.key[end])) end++;
    if (end - start > MAX_QUOTE) continue;
    targets.push(describe(bt, block, start, end));
  }
  return targets.sort((a, b) => a.block - b.block);
}
