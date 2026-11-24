// The annotation controller: the one object app.js and the annotate UI talk to.
//
// It owns the list of annotations (model.js), finds each one's text again on
// the finished pages (match.js), paints marks and margin cards (dom.js,
// cards.js), saves to the sidecar file through the preload bridge, and builds
// the annotated Markdown export (export-md.js).
//
// Painting is always a full repaint: take every mark off, look every
// annotation up again, put the marks back. It is fast, it is the same code
// after a re-render and after a single new highlight, and it cannot drift.

import { createStore, sanitizeSidecar, newId, hashText, MAX_NOTE } from './model.js';
import { locate, locateBlock, occurrenceOf, blockOccurrenceOf, squeeze } from './match.js';
import { annotatedMarkdown } from './export-md.js';
import { buildOutline, MAX_DEPTH } from './outline.js';
import {
  collectBlocks, blockText, describe, readable, isWordAligned,
  wrapRange, numberMark, unwrapAll, markBlock, unmarkBlocks,
  targetsFromRange as targetsFromDomRange,
} from './dom.js';
import {
  layoutCards, clearCards, crowdedPages, findCard, beginEdit, commitEdits as commitCardEdits, isEditing,
} from './cards.js';

const STORAGE_CACHE = 'planPrinter.annotations.v2';
const TOOLS = new Set(['select', 'highlight', 'underline', 'strike', 'note']);
const TEXT_KINDS = new Set(['highlight', 'underline', 'strike']);
const SAVE_DELAY = 500; // ms after the last change
const EXCERPT_MAX = 80; // characters of a block's source remembered by a note on the whole block
// Label ids and colours are written into a stylesheet, so only plain ones are used.
const CSS_ID = /^[a-z0-9_-]{1,40}$/i;
const CSS_COLOR = /^#[0-9a-f]{3,8}$/i;

// A lookup table keyed by annotation id. Created without the usual object
// extras, so an id such as "constructor" is just another key.
const table = () => Object.create(null);

// The copy of the current document's notes that is kept inside the app:
//   { doc, unsynced, data }
//   doc       which document it belongs to (an id from main.js; '' = no file)
//   unsynced  true when `data` holds changes that are NOT in the sidecar file
//   data      the sidecar contents
// It is the only storage for a document with no file, and the safety net for
// one whose file could not be written.
export function readCachedAnnotations() {
  try {
    const cached = JSON.parse(localStorage.getItem(STORAGE_CACHE) || 'null');
    return cached && typeof cached === 'object' && cached.data ? cached : null;
  } catch {
    return null;
  }
}

function writeCache(doc, unsynced, data) {
  try {
    localStorage.setItem(STORAGE_CACHE, JSON.stringify({ doc, unsynced, data }));
  } catch { /* storage unavailable */ }
}

// pagesEl       #pages (it survives re-renders; only its children are replaced)
// getSource()   { src, blocks, exact } from the last render, or null
// getDocument() { name, hasFile, id }: id identifies the file to main.js
// getText()     the Markdown in the editor
// canEdit()     true in annotate mode while no re-render is running
export function createAnnotations({ marked, api, pagesEl, getSource, getDocument, getText, canEdit, setStatus }) {
  const store = createStore();
  const listeners = new Set();

  let tool = 'select';
  let label = 'note';
  let hidden = false;
  // The section whose notes the notes list is showing: the block number of
  // its heading, or null for "all notes".
  let section = null;
  // Other places that hold typing which is not saved yet (the section note
  // box). commitEdits() asks each of them to save.
  const flushers = new Set();
  // Goes up by one every time a document's notes are loaded. Something typed
  // for one document must never be saved into the next; this tells them apart.
  let epoch = 0;

  // Rebuilt by every paint():
  let placed = table(); // id -> { block, start, end }, or { block } for a block note
  let fresh = table(); // id -> the target as it is now, written to the sidecar
  let texts = []; // squeezed text of every block as it appears on the pages
  let rank = table(); // id -> position in document order
  let numbers = table(); // id -> the number on its margin card
  let pageOf = table(); // id -> 1-based page number
  let shown = table(); // id -> how a block note's block reads on the page (for the notes list)
  let headings = []; // every heading on the pages: { block, depth, title, page } (for the contents list)
  let cardCount = 0;
  let overflowPages = []; // pages whose notes had to be shortened to fit the margin
  let shiftedPages = []; // pages where a mark changed the layout (should stay empty)

  // Where each note was last found. The next look-up starts from here, so a
  // note keeps up with a document that is edited a little at a time.
  let known = table();

  let editingId = null; // the note whose card is open for typing
  // A note on a whole block that is still being typed for the first time.
  // It is painted like any other, but only joins the list once it has words.
  let draft = null;
  let saveTrouble = false; // the last save to the file failed
  let skipNextPaint = false; // set for a change the page already shows
  let saveTimer = null;
  let dirty = false; // there are changes the next save should write
  let unsynced = false; // the sidecar file does not have the current notes
  let changes = 0; // counts changes, to tell whether a finished save is still current
  let readOnly = false; // the sidecar came from a newer app version: hands off
  let notice = ''; // something the user should know about this document's notes
  let corruptPending = false; // the unreadable notes file has not been set aside yet
  let warnedNoFile = false;
  let savedHash = ''; // the document's fingerprint when its notes were last saved
  let justLoaded = false; // the next paint is the first for this document

  function emit() {
    for (const cb of listeners) {
      try { cb(); } catch (err) { console.error(err); }
    }
  }

  const docNow = () => getDocument() || {};

  // ---- Groups ---------------------------------------------------------------
  // A selection that crosses several blocks is stored as one record per block,
  // sharing a `group`. To the user it is one annotation; its note lives on the
  // last piece.

  function piecesOf(id) {
    const all = store.list();
    const one = all.find((a) => a.id === id);
    if (!one) return [];
    return one.group ? all.filter((a) => a.group === one.group) : [one];
  }

  function toItem(pieces) {
    const last = pieces[pieces.length - 1];
    const placedPieces = pieces.filter((a) => placed[a.id]);
    const pages = placedPieces.map((a) => pageOf[a.id]).filter(Boolean);
    const blocks = placedPieces.map((a) => placed[a.id].block);
    return {
      id: last.id,
      kind: last.kind,
      label: last.label,
      note: last.note,
      // A block note and a section note show their block the way it reads on the page.
      exact: pieces.map((a) => shown[a.id] || a.target.exact).join(' … '),
      status: placedPieces.length ? 'placed' : 'unplaced',
      number: numbers[last.id] ?? null,
      page: pages.length ? Math.min(...pages) : null,
      // The block it starts in (which section it is in follows from this).
      block: blocks.length ? Math.min(...blocks) : null,
    };
  }

  function items() {
    const seen = new Set();
    const groups = [];
    for (const a of store.list()) {
      const key = a.group || a.id;
      if (seen.has(key)) continue;
      seen.add(key);
      groups.push(piecesOf(a.id));
    }
    const first = (pieces) => Math.min(...pieces.map((a) => rank[a.id] ?? Infinity));
    const all = groups.map((pieces) => ({ item: toItem(pieces), order: first(pieces) }));
    const placedItems = all.filter((g) => g.item.status === 'placed').sort((a, b) => a.order - b.order);
    const unplacedItems = all.filter((g) => g.item.status !== 'placed');
    return [...placedItems, ...unplacedItems].map((g) => g.item);
  }

  function get(id) {
    const pieces = piecesOf(id);
    return pieces.length ? toItem(pieces) : null;
  }

  // ---- Painting -------------------------------------------------------------

  function resetPainted() {
    placed = table();
    fresh = table();
    rank = table();
    numbers = table();
    pageOf = table();
    shown = table();
    headings = [];
    cardCount = 0;
    overflowPages = [];
    shiftedPages = [];
  }

  // Take everything off the pages (used when a different document's notes
  // are loaded: the pages still show the previous document until it renders).
  function clearPaint() {
    resetPainted();
    unwrapAll(pagesEl);
    unmarkBlocks(pagesEl);
    clearCards(pagesEl);
    emit();
  }

  function paint() {
    // A card that is being typed into is about to be rebuilt: keep its text.
    // (Committing may repaint by itself; this pass then starts from a clean slate.)
    if (isEditing(pagesEl)) commitCardEdits(pagesEl);

    resetPainted();
    const source = getSource();
    if (!source) {
      emit();
      return;
    }

    unwrapAll(pagesEl);
    unmarkBlocks(pagesEl);
    // Safety net: remember how much room each page's text takes before any
    // mark goes in. Marks are meant to change nothing; if one ever pushes
    // text past the edge of a page, we want to know rather than print it.
    const flows = Array.from(pagesEl.querySelectorAll('.pagedjs_page_content > div'));
    const roomBefore = flows.map((el) => [el.scrollWidth, el.scrollHeight]);
    const groups = collectBlocks(pagesEl);
    texts = source.blocks.map((_, n) => blockText(groups.get(n)).key);
    const sources = source.blocks.map((b) => squeeze(source.src.slice(b.start, b.end)));
    const pageEls = Array.from(pagesEl.querySelectorAll('.pagedjs_page'));
    const anchors = table();
    const lastMark = table();

    // The document's headings, for the contents list. Only real headings are
    // found this way: a "## line" inside a code block is part of that code
    // block, not a block of its own.
    source.blocks.forEach((b, n) => {
      if (b.type !== 'heading' || !groups.has(n)) return;
      const el = groups.get(n)[0];
      const level = /^H([1-6])$/.exec(el.tagName);
      if (!level) return;
      const page = el.closest('.pagedjs_page');
      headings.push({
        block: n,
        depth: Number(level[1]),
        title: el.textContent, // a note's number is drawn by CSS, so it is not part of this
        page: page ? pageEls.indexOf(page) + 1 : null,
      });
    });

    const all = draft ? [...store.list(), draft] : store.list();
    for (const a of all) {
      const target = known[a.id] || a.target;
      if (a.kind === 'block' || a.kind === 'section') {
        // A section note remembers its heading. When the excerpt is the whole
        // heading (it was not cut short), only that exact heading will do.
        const whole = a.kind === 'section' && String(target.exact ?? '').length < EXCERPT_MAX;
        const n = locateBlock(target, sources, { whole });
        if (n === null || n === undefined || !groups.has(n)) continue;
        // A section note belongs to a heading. If the block that now begins
        // with its words is not one, the heading has gone: unplaced.
        if (a.kind === 'section' && source.blocks[n].type !== 'heading') continue;
        placed[a.id] = { block: n };
        const b = source.blocks[n];
        const excerpt = source.src.slice(b.start, b.end).replace(/\s+/g, ' ').trim().slice(0, EXCERPT_MAX);
        const now = { block: n, exact: excerpt };
        const copies = blockOccurrenceOf(now, sources, n, { whole });
        if (copies) now.occurrence = copies;
        fresh[a.id] = now;
        // A section note shows nothing on the page: it lives in the notes list.
        if (a.kind === 'block') markBlock(groups.get(n), a);
        anchors[a.id] = groups.get(n)[0];
        // The saved excerpt is Markdown source ("| Setting | Default |"); the
        // notes list should show the block the way it reads on the page.
        const words = blockText(groups.get(n));
        shown[a.id] = words.key ? readable(words, 0, 70) : (b.type === 'code' ? 'Diagram' : 'Block');
      } else {
        const hit = locate(target, texts);
        if (!hit || !groups.has(hit.block)) continue;
        // Re-read the block each time: an earlier mark may have split its text nodes.
        const bt = blockText(groups.get(hit.block));
        // Every annotation starts and ends at word edges. A match that cuts
        // through a word is a coincidence of letters, not the saved quote.
        if (!isWordAligned(bt, hit.start, hit.end)) continue;
        const now = describe(bt, hit.block, hit.start, hit.end);
        const marks = wrapRange(bt, hit.start, hit.end, a);
        if (marks.length === 0) continue;
        // "The 2nd of 3 identical copies", so it can be told apart later.
        const copies = occurrenceOf(now, texts, hit);
        if (copies) now.occurrence = copies;
        placed[a.id] = hit;
        fresh[a.id] = now;
        anchors[a.id] = marks[0];
        lastMark[a.id] = marks[marks.length - 1];
      }
      known[a.id] = fresh[a.id];
    }

    shiftedPages = flows
      .map((el, i) => (el.scrollWidth > roomBefore[i][0] + 1 || el.scrollHeight > roomBefore[i][1] + 1 ? i + 1 : 0))
      .filter(Boolean);
    if (shiftedPages.length) {
      setStatus(`A highlight pushed text past the edge of page ${shiftedPages.join(', ')}. Undo the last mark, or select slightly different words.`, true);
    }

    // Document order: by block, then by position in the block. A section
    // note comes before everything else at its heading.
    const startOf = (a) => (a.kind === 'section' ? -2 : (placed[a.id].start ?? -1));
    const ordered = all
      .filter((a) => placed[a.id])
      .sort((a, b) => (placed[a.id].block - placed[b.id].block) || (startOf(a) - startOf(b)));
    ordered.forEach((a, i) => { rank[a.id] = i; });

    // The section that is open in the notes list must still be a listed heading.
    if (section !== null && !headings.some((h) => h.block === section && h.depth <= MAX_DEPTH)) section = null;

    // Margin cards (and the little numbers that pair a mark with its card)
    // exist only in the Margin notes layout.
    const hasMargin = Boolean(pagesEl.querySelector('.margin-notes'));
    const entries = [];
    let n = 0;
    for (const a of ordered) {
      const page = anchors[a.id].closest('.pagedjs_page');
      if (page) pageOf[a.id] = pageEls.indexOf(page) + 1;
      if (a.kind === 'section') continue; // never a margin card
      if (!hasMargin) continue;
      if (!a.note && a.id !== editingId) continue; // nothing to show in the margin
      n += 1;
      numbers[a.id] = n;
      if (lastMark[a.id]) numberMark(lastMark[a.id], n, a);
      entries.push({ annotation: a, number: n, anchor: anchors[a.id] });
    }
    const result = layoutCards(pagesEl, entries, { labels: store.labels });
    cardCount = result.cards;
    overflowPages = result.overflowPages;
    pagesEl.classList.toggle('anno-off', hidden);

    if (justLoaded) {
      justLoaded = false;
      // The Markdown is not what it was when these notes were saved: say how
      // the re-attaching went, once.
      const total = all.length;
      if (total && savedHash && savedHash !== hashText(getText())) {
        const lost = all.filter((a) => !placed[a.id]).length;
        notice = lost
          ? `The document changed since it was annotated: ${total - lost} of ${total} notes found their text again, ${lost} could not (listed as Unplaced).`
          : notice;
      }
    }
    emit();
  }

  // ---- Saving ---------------------------------------------------------------

  function toSidecar() {
    const doc = docNow();
    const data = store.toSidecar({ name: doc.name || '', text: getText() });
    // Save each note with where it sits now, so it keeps up with gradual edits.
    data.annotations = data.annotations.map((a) => (
      fresh[a.id] ? { ...a, target: { ...a.target, ...fresh[a.id] } } : a
    ));
    return data;
  }

  // The file now has exactly what we hold, provided nothing changed and the
  // document was not switched while the save was on its way.
  function markSynced(doc, data, atChange) {
    if (saveTrouble) {
      saveTrouble = false;
      setStatus('Notes are saved beside the file again.'); // clears the red message
    }
    if (corruptPending) {
      // main.js has just set the unreadable file aside and written a good one.
      corruptPending = false;
      notice = '';
      setStatus('The unreadable notes file was kept as a .corrupt copy. Notes are saved normally again.');
      emit();
    }
    if (atChange !== changes || (docNow().id || '') !== (doc.id || '')) return;
    unsynced = false;
    writeCache(doc.id || '', false, data);
  }

  function saveFailed(result) {
    if (result && result.stale) return; // main.js has moved on to another document
    saveTrouble = true;
    // "EACCES: permission denied, open '/long/path/x.tmp'" -> the part a person needs.
    const why = String((result && result.error) || 'unknown error').replace(/,? (open|rename|unlink|mkdir|lstat|stat) '[^']*'$/, '');
    setStatus(`Notes could not be saved beside the file (${why}). They are kept inside the app.`, true);
  }

  // Returns the data to send to main.js, or null when there is nothing to send.
  function prepareSave() {
    clearTimeout(saveTimer);
    if (!dirty) return null;
    dirty = false;
    const doc = docNow();
    const data = toSidecar();
    writeCache(doc.id || '', true, data); // first inside the app, so nothing is lost if the file cannot be written
    if (readOnly) return null;
    if (!doc.hasFile) {
      // Pasted text and the like: the copy inside the app is all there is.
      if (!warnedNoFile && data.annotations.length) {
        warnedNoFile = true;
        setStatus('Notes are kept inside the app for now. Use Save Markdown As… to store them beside a file.');
      }
      return null;
    }
    return { doc, data, atChange: changes };
  }

  async function saveNow() {
    const job = prepareSave();
    if (!job) return;
    let result = null;
    try {
      result = await api.saveAnnotations(job.data, job.doc.id);
    } catch (err) {
      result = { ok: false, error: String(err && err.message ? err.message : err) };
    }
    if (result && result.ok) markSynced(job.doc, job.data, job.atChange);
    else saveFailed(result);
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, SAVE_DELAY);
  }

  // Save right now and wait for the answer. Used while the window is closing
  // and just before the document is replaced, when a save "in half a second"
  // would be too late or would land on the wrong document.
  function flush() {
    commitEdits();
    const job = prepareSave();
    if (!job) return;
    let result = null;
    try {
      result = api.saveAnnotationsSync(job.data, job.doc.id);
    } catch (err) {
      result = { ok: false, error: String(err && err.message ? err.message : err) };
    }
    if (result && result.ok) markSynced(job.doc, job.data, job.atChange);
    else saveFailed(result);
  }

  store.subscribe((reason) => {
    if (reason === 'load') {
      clearPaint(); // the pages still show the old document; the next render paints
      return;
    }
    dirty = true;
    unsynced = true;
    changes += 1;
    scheduleSave();
    if (skipNextPaint) {
      skipNextPaint = false;
      emit(); // the page already shows it; only the lists need to catch up
    } else {
      paint();
    }
  });

  // Replace everything with a document's saved notes (or none). Call it AFTER
  // the document itself has been switched (getDocument and getText must
  // already describe the new one).
  //   info.status   the sidecar's state as main.js reported it
  //   info.unsaved  these notes came from the copy inside the app and are
  //                 newer than the file: write them out
  function load(raw, info = {}) {
    clearTimeout(saveTimer);
    dirty = false;
    warnedNoFile = false;
    editingId = null;
    draft = null;
    section = null; // a different document: back to "all notes"
    epoch += 1;
    saveTrouble = false;
    skipNextPaint = false;
    known = table();
    readOnly = info.status === 'newer';
    notice = '';
    if (info.status === 'newer') {
      notice = 'The notes beside this file were made by a newer version of Plan Printer. They are left untouched and annotating is off for this document.';
    } else if (info.status === 'corrupt') {
      notice = 'The notes file beside this document could not be read. It will be kept as a .corrupt copy when new notes are saved.';
    }
    corruptPending = info.status === 'corrupt';
    const clean = sanitizeSidecar(raw);
    savedHash = clean && clean.document && typeof clean.document.hash === 'string' ? clean.document.hash : '';
    justLoaded = true;
    store.load(clean);
    if (!store.labels.some((l) => l.id === label)) label = store.labels[0] ? store.labels[0].id : 'note';

    const doc = docNow();
    const count = store.list().length;
    // Notes for a document with no file exist only inside the app.
    unsynced = Boolean(info.unsaved) || (!doc.hasFile && count > 0);
    if (info.unsaved) {
      dirty = true;
      changes += 1;
      scheduleSave();
    } else {
      // Keep the copy inside the app in step with the document in the editor.
      writeCache(doc.id || '', unsynced, store.toSidecar({ name: doc.name || '', text: getText() }));
    }
  }

  // True when leaving this document now would lose notes: they are not in a
  // file (there is none, or it could not be written).
  function notOnDisk() {
    return unsynced && (store.list().length > 0 || Boolean(docNow().hasFile));
  }

  // ---- Changes --------------------------------------------------------------

  function create({ kind, label: labelId, targets, note = '' }) {
    if (!canEdit() || !TEXT_KINDS.has(kind) || !Array.isArray(targets) || targets.length === 0) return null;
    const group = targets.length > 1 ? newId() : undefined;
    const records = targets.map((target, i) => ({
      id: newId(),
      kind,
      label: labelId || label,
      note: i === targets.length - 1 ? String(note || '') : '',
      ...(group ? { group } : {}),
      target,
    }));
    store.add(records.length === 1 ? records[0] : records);
    return records[records.length - 1].id;
  }

  function createBlockNote(blockIndex, labelId) {
    const source = getSource();
    const block = source && source.blocks[blockIndex];
    if (!canEdit() || !block) return null;
    commitCardEdits(pagesEl); // finish any other note first
    const excerpt = source.src.slice(block.start, block.end).replace(/\s+/g, ' ').trim().slice(0, EXCERPT_MAX);
    const record = { id: newId(), kind: 'block', label: labelId || label, note: '', target: { block: blockIndex, exact: excerpt } };
    // It starts as a draft: the card opens for typing, and only once there
    // are words does it become a real annotation (ONE undo step). Clicking
    // away from an empty card leaves nothing behind, not even in the history.
    draft = record;
    editingId = record.id;
    paint();
    const card = findCard(pagesEl, record.id);
    const settle = (text) => {
      draft = null;
      editingId = null;
      if (text) store.add({ ...record, note: text });
      else paint();
    };
    if (!card) {
      settle('');
      setStatus('Margin notes are shown in the Margin notes layout.', true);
      return null;
    }
    beginEdit(card, { onCommit: settle });
    return record.id;
  }

  // Label and kind apply to every piece of a multi-block selection; the note
  // belongs to its last piece. One undo step either way.
  function update(id, patch = {}) {
    const pieces = piecesOf(id);
    if (!pieces.length || !canEdit()) return;
    const last = pieces[pieces.length - 1];
    store.updateMany(pieces.map((a) => a.id), (a) => {
      const change = {};
      if (typeof patch.label === 'string') change.label = patch.label;
      if (TEXT_KINDS.has(patch.kind) && a.kind !== 'block') change.kind = patch.kind;
      if (a.id === last.id && typeof patch.note === 'string') change.note = patch.note;
      return change;
    });
  }

  function remove(id) {
    const pieces = piecesOf(id);
    if (!pieces.length || !canEdit()) return;
    if (pieces.some((a) => a.id === editingId)) editingId = null;
    store.remove(pieces.length === 1 ? pieces[0].id : pieces.map((a) => a.id));
  }

  // The user finished typing in a card (cards.js has already tidied the text
  // shown in it).
  function commitNote(id, text) {
    editingId = null;
    const a = store.get(id);
    if (!a) {
      paint();
    } else if (a.kind === 'block' && !text) {
      store.remove(id); // a block note with nothing in it is no note at all
    } else if (text === a.note) {
      if (!text) paint(); // an empty card that stayed empty: take it away
    } else {
      // The card already shows the new words, so there is nothing to repaint
      // unless the note was emptied (then its card has to go). Not rebuilding
      // the page here also means the click that ended the edit still lands
      // on whatever it was aimed at.
      skipNextPaint = Boolean(text);
      // cards.js has already re-fitted the card's column around the new text;
      // pick up whether that page's notes now have to be shown shortened.
      if (skipNextPaint) overflowPages = crowdedPages(pagesEl);
      store.update(id, { note: text });
      skipNextPaint = false; // in case the store saw nothing to change
    }
  }

  // Open a note's margin card for typing, creating the card if it has no note yet.
  function editNote(id) {
    const pieces = piecesOf(id);
    if (!pieces.length || !canEdit()) return;
    const last = pieces[pieces.length - 1];
    if (!placed[last.id]) {
      setStatus('This note is unplaced: its text is no longer in the document.', true);
      return;
    }
    editingId = last.id;
    paint();
    const card = findCard(pagesEl, last.id);
    if (!card) {
      editingId = null;
      setStatus('Margin notes are shown in the Margin notes layout.', true);
      return;
    }
    beginEdit(card, { onCommit: (text) => commitNote(last.id, text) });
  }

  // Clicking a card opens it; its × clears the note.
  pagesEl.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    const card = target && target.closest('.anno-card');
    if (!card || !canEdit()) return;
    const id = card.dataset.anno;
    if (target.closest('.anno-card-tools')) {
      const a = store.get(id);
      if (!a) return;
      if (a.kind === 'block') remove(id);
      else update(id, { note: '' });
      return;
    }
    if (!card.classList.contains('editing')) editNote(id);
  });

  function focus(id) {
    const pieces = piecesOf(id);
    const found = [];
    for (const a of pieces) {
      const safe = CSS.escape(a.id);
      found.push(...pagesEl.querySelectorAll(`mark[data-anno="${safe}"], [data-anno-block="${safe}"], .anno-card[data-anno="${safe}"]`));
      // A section note has nothing of its own on the page: go to its heading.
      if (a.kind === 'section' && placed[a.id]) {
        const heading = pagesEl.querySelector(`[data-block="${placed[a.id].block}"]`);
        if (heading) found.push(heading);
      }
    }
    if (found.length === 0) return;
    found[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
    for (const el of found) el.classList.add('anno-flash');
    setTimeout(() => { for (const el of found) el.classList.remove('anno-flash'); }, 1300);
  }

  // ---- Everything else ------------------------------------------------------

  // One rule per label, appended to the page stylesheet by app.js.
  function labelCss() {
    return store.labels
      .filter((l) => CSS_ID.test(l.id) && CSS_COLOR.test(l.color) && CSS_COLOR.test(l.ink))
      .map((l) => `[data-label="${l.id}"], [data-anno-label="${l.id}"] { --anno-color: ${l.color}; --anno-ink: ${l.ink}; }`)
      .join('\n');
  }

  function exportMarkdown() {
    const source = getSource();
    if (!source) return '';
    return annotatedMarkdown(marked, source, store.list(), {
      labels: store.labels,
      resolved: placed,
      texts,
    });
  }

  // The contents list: every "#", "##" and "###" heading with its page and
  // the number of notes under it. See outline.js for the shape.
  function outline() {
    // Where each note starts. A selection across several blocks is one note
    // to the user (see "Groups" above), so it is counted once, where it begins.
    const firstBlock = new Map();
    const summed = []; // the headings that have a section note
    for (const a of store.list()) {
      const at = placed[a.id];
      if (!at) continue; // unplaced: it is not on any page, so in no section
      if (a.kind === 'section') {
        summed.push(at.block); // marked on its row, not counted as one of the notes
        continue;
      }
      const key = a.group || a.id;
      firstBlock.set(key, Math.min(firstBlock.get(key) ?? Infinity, at.block));
    }
    return buildOutline(headings, Array.from(firstBlock.values()), { sectionNotes: summed });
  }

  // ---- Section notes ----------------------------------------------------------
  // Your own note on a whole section. It is stored like a note on a block (the
  // block being the section's heading) and shows in the notes list, the
  // contents list and the Markdown export, never on the page itself.

  function sectionRecord(block) {
    return store.list().find((a) => a.kind === 'section' && placed[a.id] && placed[a.id].block === block) || null;
  }

  // The note on the section whose heading is block `block`, as an item (the
  // same shape items() returns), or null when it has none.
  function sectionNote(block) {
    const record = sectionRecord(block);
    return record ? toItem([record]) : null;
  }

  // Write, change or (with empty text) remove that note. ONE undo step.
  // Returns false when it cannot be done right now (the pages are being
  // rebuilt, or there is no such heading); the caller then keeps the text and
  // tries again.
  function setSectionNote(block, text) {
    const source = getSource();
    const heading = source && source.blocks[block];
    if (!canEdit() || !heading || heading.type !== 'heading') return false;
    const note = String(text ?? '').trim().slice(0, MAX_NOTE);
    const existing = sectionRecord(block);
    if (existing) {
      if (!note) store.remove(existing.id);
      else store.update(existing.id, { note }); // does nothing when the text is the same
      return true;
    }
    if (!note) return true; // nothing was there and nothing was typed
    const excerpt = source.src.slice(heading.start, heading.end).replace(/\s+/g, ' ').trim().slice(0, EXCERPT_MAX);
    store.add({ id: newId(), kind: 'section', label: 'note', note, target: { block, exact: excerpt } });
    return true;
  }

  // Show one section's notes in the notes list (null = all notes again).
  // Anything still being typed is saved first: it belongs to the section
  // that is open now, not to the one about to be shown.
  function setSection(block) {
    const listed = (h) => h.block === block && h.depth <= MAX_DEPTH;
    const next = Number.isInteger(block) && headings.some(listed) ? block : null;
    if (next === section) return;
    commitEdits();
    section = next;
    emit();
  }

  // Finish every edit that is in progress: a margin card being typed into,
  // and whatever the registered flushers hold.
  function commitEdits() {
    commitCardEdits(pagesEl);
    for (const save of flushers) {
      try { save(); } catch (err) { console.error(err); }
    }
  }

  function stats() {
    const list = items();
    const unplaced = list.filter((it) => it.status !== 'placed').length;
    return {
      total: list.length,
      placed: list.length - unplaced,
      unplaced,
      cards: cardCount,
      overflowPages: [...overflowPages],
      shiftedPages: [...shiftedPages],
      notice,
    };
  }

  return {
    get labels() { return store.labels; },
    get tool() { return tool; },
    get label() { return label; },
    get hidden() { return hidden; },
    setTool(next) { if (TOOLS.has(next)) { tool = next; emit(); } },
    setLabel(id) { if (store.labels.some((l) => l.id === id)) { label = id; emit(); } },
    setHidden(value) { hidden = Boolean(value); pagesEl.classList.toggle('anno-off', hidden); emit(); },
    items,
    get,
    targetsFromRange: (range) => targetsFromDomRange(pagesEl, range),
    create,
    createBlockNote,
    update,
    remove,
    // A note that is mid-edit is finished first, so the step being undone is
    // the one the user sees as the latest.
    undo() { if (canEdit()) { commitEdits(); store.undo(); } },
    redo() { if (canEdit()) { commitEdits(); store.redo(); } },
    canUndo: () => store.canUndo(),
    canRedo: () => store.canRedo(),
    editNote,
    focus,
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    stats,
    outline,
    get section() { return section; },
    get epoch() { return epoch; },
    setSection,
    sectionNote,
    setSectionNote,
    // `save` is called whenever edits in progress must be finished (before an
    // export, an undo, a re-render, closing the window). Returns a function
    // that takes it off the list again.
    onCommitEdits(save) { flushers.add(save); return () => flushers.delete(save); },
    // For app.js:
    get notice() { return notice; },
    get readOnly() { return readOnly; },
    notOnDisk,
    load,
    paint,
    labelCss,
    exportMarkdown,
    toSidecar,
    saveNow() { dirty = true; return saveNow(); },
    flush,
    commitEdits,
    count: () => store.list().length,
  };
}
