// Annotate mode: the contents list.
//
// A column between the notes list and the pages that lists the document's
// headings like the contents page of a book: the title, a row of dots, how
// many notes sit under that heading, and its page number. Clicking a row
// scrolls the page to the heading and opens that section in the notes list
// (its section note and every note inside it). The row for the section you
// are reading is lit up as the page scrolls, and a tick marks the sections
// that have a section note.
//
// Like the rest of the annotate UI it keeps no data of its own. After every
// change refresh() runs and the list is redrawn from anno.outline(). The
// pages are thrown away and rebuilt whenever the document is laid out again,
// so heading elements are looked up afresh rather than kept.

import './contents.css';

const JUMP_GAP = 24; // px of page left showing above a heading that was jumped to
// px from the top of the view: a heading above this line is "being read". It
// is kept small so that after a jump (heading at JUMP_GAP) a subheading that
// follows straight away is still below the line.
const READ_LINE = 56;
const TRAVEL_MAX = 1500; // ms: the longest a smooth scroll to a heading is waited for
const FLASH_MS = 1300; // how long the ring around the heading stays (see .anno-flash in ui.css)

const HEADINGS = 'h1[data-block], h2[data-block], h3[data-block], h4[data-block], h5[data-block], h6[data-block]';
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
const NO_HEADINGS = 'This document has no headings to list. Lines that start with #, ## or ### show up here.';
const BUSY = 'The pages are still being laid out. Try again in a moment.';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text; // never innerHTML: titles are document text
  return node;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// anno     the annotation controller (anno.outline() is the list's data)
// els      { pane, pages, scroll }: the column, #pages, and the scrolling preview
// actions  { isShown, isBusy, hide, setStatus }
// Returns { refresh() }: call it when the column is shown or hidden, and when
// a re-render has finished.
export function initContents({ anno, els, actions }) {
  // ---- The column ---------------------------------------------------------------

  const title = el('div', 'anno-toc-title', 'Contents');
  const hideBtn = el('button', 'anno-toc-hide', '×');
  hideBtn.type = 'button';
  hideBtn.title = 'Hide the contents (the Contents button in the bar brings it back)';
  hideBtn.setAttribute('aria-label', 'Hide the contents');
  const summary = el('div', 'anno-toc-sub');
  const head = el('div', 'anno-toc-head');
  head.append(title, hideBtn, summary);
  const hint = el('p', 'anno-toc-hint', NO_HEADINGS);
  hint.hidden = true;
  const list = el('div', 'anno-toc-list');
  els.pane.append(head, hint, list);

  let rows = []; // what is listed now: anno.outline().rows
  let rowNodes = []; // the row element for each of them
  let drawn = null; // the outline as text, so an unchanged list is not rebuilt
  let current = -1; // the row that is lit up
  let found = null; // the heading element for each row; null = look them up again

  function buildRow(row, i) {
    const node = el('div', 'anno-toc-row');
    node.dataset.i = String(i);
    node.setAttribute('role', 'link');
    node.tabIndex = 0; // reachable with Tab; Enter jumps to it on the page
    node.style.setProperty('--indent', String(row.indent));
    if (row.indent === 0) node.classList.add('anno-toc-top');

    const where = row.page ? `page ${row.page}` : 'not on a page';
    const notes = (row.count ? `, ${plural(row.count, 'note')}` : '')
      + (row.noted ? ', has a section note' : '');
    node.title = `${row.title} (${where}${notes})`;
    node.setAttribute('aria-label', `${row.title}, ${where}${notes}`);

    node.append(el('span', 'anno-toc-text', row.title), el('span', 'anno-toc-dots'));
    if (row.noted) {
      const tick = el('span', 'anno-toc-noted', '✓');
      tick.title = 'You have written a section note for this section';
      node.append(tick);
    }
    if (row.count) {
      const count = el('span', 'anno-toc-count', String(row.count));
      count.title = `${plural(row.count, 'note')} in this section, subsections included`;
      node.append(count);
    }
    node.append(el('span', 'anno-toc-page', row.page ? String(row.page) : ''));
    return node;
  }

  function draw(outline) {
    rows = outline.rows;
    rowNodes = rows.map(buildRow);
    list.replaceChildren(...rowNodes);
    current = -1; // the old lit row is gone; watch() lights the right one again
    // Every page number gets the room the longest one needs, so they line up.
    const longest = rows.reduce((max, row) => Math.max(max, String(row.page || '').length), 1);
    list.style.setProperty('--page-digits', String(longest));
    summary.textContent = `${plural(rows.length, 'section')} · ${plural(outline.notes, 'note')}`
      + (outline.sectionNotes ? ` · ${plural(outline.sectionNotes, 'section note')}` : '');
  }

  // Mark the row whose section is open in the notes list. That is a different
  // thing from the row that is lit: one is what you are reading on the page,
  // the other is whose notes are showing on the left.
  function markOpen() {
    rowNodes.forEach((node, i) => {
      const open = rows[i].block === anno.section;
      if (node.classList.contains('anno-toc-open') !== open) node.classList.toggle('anno-toc-open', open);
    });
  }

  // ---- Finding the headings on the pages ------------------------------------------

  // The heading element for each row, in the same order as `rows` (null for a
  // heading that is not on the pages right now).
  function headingEls() {
    if (found && found.every((node) => !node || node.isConnected)) return found;
    const byBlock = new Map();
    for (const node of els.pages.querySelectorAll(HEADINGS)) {
      if (!byBlock.has(node.dataset.block)) byBlock.set(node.dataset.block, node);
    }
    found = rows.map((row) => byBlock.get(String(row.block)) || null);
    return found;
  }

  const onScreen = (node, view) => {
    const r = node.getBoundingClientRect();
    return r.bottom > view.top && r.top < view.bottom;
  };

  // The row whose section is at the top of the view: the last heading that has
  // scrolled up past the "read line". -1 when there is nothing to light.
  function readingIndex() {
    const nodes = headingEls();
    const have = [];
    nodes.forEach((node, i) => { if (node) have.push(i); });
    if (have.length === 0) return -1;
    const view = els.scroll.getBoundingClientRect();
    const line = view.top + Math.min(READ_LINE, view.height / 3);
    // Headings come in page order, so their positions only ever go down the
    // screen: halve the search instead of measuring every one.
    let low = 0;
    let high = have.length - 1;
    let best = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (nodes[have[mid]].getBoundingClientRect().top <= line) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (best >= 0) return have[best];
    // Above the first heading (the very top of the document): light the
    // first row as soon as its heading is in view.
    return onScreen(nodes[have[0]], view) ? have[0] : -1;
  }

  // ---- Lighting the row for the section being read ---------------------------------

  // The row that was just clicked. It stays lit while the page travels to its
  // heading, and afterwards for as long as that heading is on screen and the
  // user has not scrolled. Without this the wrong row could be lit after a
  // click: near the end of a document the page cannot scroll far enough to
  // bring the heading to the top (the row before it would light up), and a
  // heading followed at once by a subheading would hand over to that one.
  let pinned = -1;
  let travelling = false; // a smooth scroll started by a click is still going
  let goal = 0; // where that scroll is heading (the preview's scrollTop, in px)
  let travelTimer = 0;
  let frame = 0;

  function setCurrent(i) {
    if (i === current) return;
    if (rowNodes[current]) rowNodes[current].removeAttribute('aria-current');
    current = i;
    const node = rowNodes[i];
    if (!node) return;
    node.setAttribute('aria-current', 'location'); // contents.css lights the row from this
    // Keep the lit row in sight in a list longer than the window.
    node.scrollIntoView({ block: 'nearest' });
  }

  function watch() {
    frame = 0;
    if (els.pane.hidden || travelling) return;
    let i = readingIndex();
    if (pinned >= 0) {
      const node = headingEls()[pinned];
      if (node && onScreen(node, els.scroll.getBoundingClientRect())) i = pinned;
      else pinned = -1;
    }
    setCurrent(i);
  }

  // At most once per frame, however many scroll events arrive.
  function watchSoon() {
    if (!frame) frame = requestAnimationFrame(watch);
  }

  // The user took over (mouse wheel, scrollbar, a scrolling key): follow the
  // page again.
  function unpin() {
    pinned = -1;
    if (!travelling) return;
    travelling = false;
    clearTimeout(travelTimer);
  }

  // ---- Jumping to a heading ----------------------------------------------------------

  function flash(node) {
    node.classList.add('anno-flash');
    setTimeout(() => node.classList.remove('anno-flash'), FLASH_MS);
  }

  // The page has reached the heading (or has gone as far as it can).
  function arrive() {
    if (!travelling) return;
    travelling = false;
    clearTimeout(travelTimer);
    const node = headingEls()[pinned];
    if (node) flash(node);
    watch();
  }

  function jump(i) {
    const node = headingEls()[i];
    if (!node) {
      // The pages are being rebuilt, so the heading is not there to scroll to.
      actions.setStatus(BUSY, false);
      return;
    }
    // Both rectangles are in screen pixels, so the zoom needs no special care.
    const view = els.scroll.getBoundingClientRect();
    const wanted = els.scroll.scrollTop + node.getBoundingClientRect().top - view.top - JUMP_GAP;
    const furthest = els.scroll.scrollHeight - els.scroll.clientHeight;
    const top = Math.max(0, Math.min(wanted, furthest));
    pinned = i;
    travelling = true;
    goal = top;
    setCurrent(i);
    clearTimeout(travelTimer);
    if (Math.abs(top - els.scroll.scrollTop) < 2) {
      arrive(); // already there: no scroll will happen, so no "scrollend" either
      return;
    }
    travelTimer = setTimeout(arrive, TRAVEL_MAX); // in case "scrollend" never comes
    els.scroll.scrollTo({ top, behavior: 'smooth' });
  }

  // A click on a row: show that section's notes on the left, and take the
  // page to its heading.
  function open(i) {
    if (!rows[i]) return;
    anno.setSection(rows[i].block); // this redraws; the rows themselves stay as they are
    jump(i);
  }

  // ---- Events -------------------------------------------------------------------------

  els.scroll.addEventListener('scroll', watchSoon, { passive: true });
  // Only the end of OUR scroll counts. The end of an earlier one (the mouse
  // wheel coming to rest just as a row is clicked) can arrive first.
  els.scroll.addEventListener('scrollend', () => {
    if (travelling && Math.abs(els.scroll.scrollTop - goal) < 2) arrive();
  });
  els.scroll.addEventListener('wheel', unpin, { passive: true });
  els.scroll.addEventListener('touchstart', unpin, { passive: true });
  els.scroll.addEventListener('pointerdown', unpin); // includes a press on the scrollbar
  // Only the keys that scroll. `true` (capture) so this runs before the row's
  // own key handler below: Space on a row pins that row again straight afterwards.
  document.addEventListener('keydown', (e) => {
    if (SCROLL_KEYS.has(e.key)) unpin();
  }, true);
  window.addEventListener('resize', watchSoon);

  // Keep the text selection and the keyboard focus where they are, as the
  // notes list does. The bare list is left alone so its scrollbar still works.
  els.pane.addEventListener('mousedown', (e) => {
    if (e.target instanceof Element && e.target.closest('button, .anno-toc-row')) e.preventDefault();
  });

  els.pane.addEventListener('click', (e) => {
    if (!(e.target instanceof Element)) return;
    if (e.target.closest('.anno-toc-hide')) {
      actions.hide();
      return;
    }
    const node = e.target.closest('.anno-toc-row');
    if (node) open(Number(node.dataset.i));
  });

  // Enter or Space on a row does what a click does; the arrow keys walk the list.
  els.pane.addEventListener('keydown', (e) => {
    const node = e.target;
    if (!(node instanceof Element) || !node.classList.contains('anno-toc-row')) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open(Number(node.dataset.i));
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? node.nextElementSibling : node.previousElementSibling;
      if (next) next.focus();
    }
  });

  // ---- Redrawing ----------------------------------------------------------------------

  function refresh() {
    if (!actions.isShown()) return; // hidden: there is nothing to keep up to date
    const outline = anno.outline();
    const busy = Boolean(actions.isBusy());
    // While a different document is being laid out its headings are not known
    // yet. Leave the list as it is for that moment rather than say "no
    // headings"; refresh() runs again when the render has finished.
    if (busy && outline.rows.length === 0) return;
    const state = JSON.stringify(outline);
    if (state !== drawn) {
      drawn = state;
      draw(outline);
    }
    hint.hidden = outline.rows.length > 0;
    markOpen();
    found = null; // the pages may have been rebuilt since the last look
    watchSoon();
  }

  anno.onChange(refresh);
  refresh();

  return { refresh };
}
