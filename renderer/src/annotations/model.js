// The annotation data: what one record looks like, the default labels, the
// checks applied to a file read from disk, and the in-memory list with undo
// and redo. Pure logic: no page (DOM) is needed.
//
// One annotation record:
//   { id, kind, label, note, group?, target, created, modified }
//   kind    'highlight' | 'underline' | 'strike' | 'block' (note on a block)
//   target  { block, exact } plus, for the three text kinds,
//           { start, end, prefix, suffix }. start/end count characters of the
//           block's text with all whitespace removed.

export const FORMAT = 'plan-printer-annotations';
export const VERSION = 1;
export const KINDS = ['highlight', 'underline', 'strike', 'block'];

// color = the highlighter colour, ink = a darker shade for text and borders.
// `meaning` is written into the Markdown export so an LLM knows what each
// label stands for.
export const DEFAULT_LABELS = [
  { id: 'note', name: 'Note', color: '#fff1a8', ink: '#8a6d00',
    meaning: 'general remark' },
  { id: 'question', name: 'Question', color: '#cfe4ff', ink: '#1a56b0',
    meaning: 'needs an answer' },
  { id: 'change', name: 'Change', color: '#ffd3cf', ink: '#b3261e',
    meaning: 'please change this' },
  { id: 'keep', name: 'Keep', color: '#d3f2d0', ink: '#1e7a34',
    meaning: 'good, keep as is' },
  { id: 'important', name: 'Important', color: '#ffe0b3', ink: '#b35a00',
    meaning: 'do not miss this' },
];

// Size limits. They are applied when an annotation is MADE (dom.js refuses a
// longer selection, cards.js a longer note), so reading a file back never has
// to cut anything short. The file-reading limits below are deliberately
// looser: they only stop a damaged or hand-edited sidecar flooding the page.
export const MAX_QUOTE = 4000; // characters of a selection, not counting spaces
export const MAX_NOTE = 20000; // characters of one typed note
const MAX_EXACT = MAX_QUOTE * 3; // the same selection with its spaces put back
const MAX_CONTEXT = 200;
// Ids are used as object keys and inside CSS selectors: plain characters only.
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
// ...and never a name every object already has ("constructor", "toString").
const isSafeId = (id) => typeof id === 'string' && SAFE_ID.test(id) && !(id in {});
const MAX_HISTORY = 200; // undo steps kept
const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const now = () => new Date().toISOString();
// Records are copied on the way into and out of the store, so nothing outside
// can change the store's data (or its undo history) by accident.
const copyRecord = (a) => {
  const target = { ...a.target };
  if (isObject(target.occurrence)) target.occurrence = { ...target.occurrence };
  return { ...a, target };
};
const copyLabels = (labels) => labels.map((l) => ({ ...l }));

// A short random id: 10 characters from a-z and 0-9.
export function newId() {
  let id = '';
  while (id.length < 10) id += Math.random().toString(36).slice(2);
  return id.slice(0, 10);
}

// A fingerprint of the document text (FNV-1a, 32 bit) as 8 hex characters.
// Used only to notice "the Markdown changed since these notes were saved";
// it is not a security feature.
export function hashText(text) {
  const s = String(text ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // 32-bit multiply by the FNV prime
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ---- Reading a sidecar file ---------------------------------------------------

const clampText = (v, max, fallback = '') => (typeof v === 'string' ? v.slice(0, max) : fallback);

// One annotation from a file -> a clean record, or null if it is malformed.
function cleanAnnotation(raw) {
  if (!isObject(raw) || !isSafeId(raw.id)) return null;
  if (!KINDS.includes(raw.kind)) return null;
  const t = raw.target;
  if (!isObject(t) || !Number.isInteger(t.block) || t.block < 0) return null;
  if (typeof t.exact !== 'string') return null;

  const target = { block: t.block };
  if (raw.kind !== 'block') {
    // Text kinds must say which characters they cover.
    if (!Number.isInteger(t.start) || !Number.isInteger(t.end)) return null;
    if (t.start < 0 || t.end <= t.start) return null;
    target.start = t.start;
    target.end = t.end;
  }
  target.exact = t.exact.slice(0, MAX_EXACT);
  if (raw.kind !== 'block') {
    target.prefix = clampText(t.prefix, MAX_CONTEXT);
    target.suffix = clampText(t.suffix, MAX_CONTEXT);
  }
  // "The 2nd of 3 identical copies" (see match.js). Kept only when it makes sense.
  const o = t.occurrence;
  if (isObject(o) && Number.isInteger(o.nth) && Number.isInteger(o.of) && o.nth >= 0 && o.nth < o.of && o.of <= 100000) {
    target.occurrence = { nth: o.nth, of: o.of };
  }

  const out = {
    id: raw.id,
    kind: raw.kind,
    label: typeof raw.label === 'string' && raw.label ? raw.label : 'note',
    note: clampText(raw.note, MAX_NOTE),
  };
  if (typeof raw.group === 'string') out.group = raw.group;
  out.target = target;
  if (typeof raw.created === 'string') out.created = raw.created;
  if (typeof raw.modified === 'string') out.modified = raw.modified;
  return out;
}

// The file's own labels when they are usable, otherwise the defaults.
function cleanLabels(raw) {
  if (!Array.isArray(raw)) return copyLabels(DEFAULT_LABELS);
  const seen = new Set();
  const out = [];
  for (const l of raw) {
    if (!isObject(l) || typeof l.id !== 'string' || !l.id || seen.has(l.id)) continue;
    if (typeof l.name !== 'string') continue;
    // Colours end up in CSS, so only plain hex colours are let through.
    if (!HEX_COLOR.test(l.color) || !HEX_COLOR.test(l.ink)) continue;
    seen.add(l.id);
    out.push({
      id: l.id,
      name: l.name,
      color: l.color,
      ink: l.ink,
      meaning: typeof l.meaning === 'string' ? l.meaning : '',
    });
  }
  return out.length ? out : copyLabels(DEFAULT_LABELS);
}

// Check a parsed sidecar file before trusting it. Returns
// { labels, annotations, drawings, document }, or null when this is not one
// of our files (or was written by a newer version of the app).
// Malformed annotations are dropped one by one rather than failing the file.
export function sanitizeSidecar(raw) {
  if (!isObject(raw) || raw.format !== FORMAT) return null;
  if (!Number.isInteger(raw.version) || raw.version < 1 || raw.version > VERSION) return null;
  if (!Array.isArray(raw.annotations)) return null;

  const seen = new Set();
  const annotations = [];
  for (const item of raw.annotations) {
    const a = cleanAnnotation(item);
    if (!a || seen.has(a.id)) continue; // malformed, or a duplicate id
    seen.add(a.id);
    annotations.push(a);
  }

  // What the file says about the Markdown it belongs to. (Named `about`
  // because `document` already means the web page in browser code.)
  const about = {};
  if (isObject(raw.document)) {
    if (typeof raw.document.name === 'string') about.name = raw.document.name;
    if (typeof raw.document.hash === 'string') about.hash = raw.document.hash;
    if (Number.isInteger(raw.document.chars)) about.chars = raw.document.chars;
  }

  return {
    labels: cleanLabels(raw.labels),
    annotations,
    drawings: Array.isArray(raw.drawings) ? raw.drawings : [],
    document: about,
  };
}

// ---- The store ----------------------------------------------------------------

// The list of annotations in the order they were made, with undo and redo.
//
// How undo works: the list is never changed in place. Every change builds a
// new list and keeps the old one in `past`. Undo simply swaps the old list
// back in, which is why a removed record returns to its original position.
export function createStore() {
  let labels = copyLabels(DEFAULT_LABELS);
  let drawings = []; // not used yet (milestone 2); kept so saving never drops them
  let items = []; // the current list; treated as read-only
  let past = []; // earlier lists, oldest first (for undo)
  let future = []; // lists that were undone (for redo)
  const listeners = new Set();

  function emit(reason) {
    for (const cb of [...listeners]) {
      // One broken listener (say, the painter) must not stop the others
      // (say, autosave) from hearing about the change.
      try { cb(reason); } catch (err) { console.error(err); }
    }
  }

  // `old` with `patch` applied, or null when the patch changes nothing.
  function patched(old, patch) {
    const next = { ...old };
    if (isObject(patch)) {
      if (KINDS.includes(patch.kind)) next.kind = patch.kind;
      if (typeof patch.label === 'string' && patch.label) next.label = patch.label;
      if (typeof patch.note === 'string') next.note = patch.note.slice(0, MAX_NOTE);
      if (isObject(patch.target)) next.target = { ...old.target, ...patch.target };
    }
    const targetKeys = Object.keys(next.target || {});
    const unchanged = next.kind === old.kind && next.label === old.label
      && next.note === old.note
      && targetKeys.every((k) => next.target[k] === old.target[k]);
    if (unchanged) return null;
    next.modified = now();
    return next;
  }

  // Make `next` the current list as one undo step.
  function commit(next, reason) {
    past.push(items);
    if (past.length > MAX_HISTORY) past.shift();
    future = []; // a new change after an undo: there is nothing left to redo
    items = next;
    emit(reason);
  }

  return {
    // The label list: DEFAULT_LABELS until load() supplies others. Read it,
    // do not change it (there is no label editing yet).
    get labels() { return labels; },

    // All records, oldest first. The array and the records are copies.
    list() { return items.map(copyRecord); },

    // One record (a copy), or null.
    get(id) {
      const found = items.find((a) => a.id === id);
      return found ? copyRecord(found) : null;
    },

    // Add one record or an array of records (a selection across several
    // blocks arrives as an array). Either way it is ONE undo step.
    // Returns the stored record, or an array of them when given an array.
    add(recordOrArray) {
      const many = Array.isArray(recordOrArray);
      const taken = new Set(items.map((a) => a.id));
      const stamp = now();
      const fresh = [];
      for (const raw of many ? recordOrArray : [recordOrArray]) {
        if (!isObject(raw)) continue;
        const rec = copyRecord(raw);
        if (!isSafeId(rec.id)) rec.id = newId();
        if (taken.has(rec.id)) continue; // ids must stay unique
        taken.add(rec.id);
        if (typeof rec.label !== 'string' || !rec.label) rec.label = 'note';
        if (typeof rec.note !== 'string') rec.note = '';
        if (!rec.created) rec.created = stamp;
        if (!rec.modified) rec.modified = rec.created;
        fresh.push(rec);
      }
      if (fresh.length) commit([...items, ...fresh], 'add');
      if (many) return fresh.map(copyRecord);
      return fresh.length ? copyRecord(fresh[0]) : null;
    },

    // Change kind, label, note and/or target of one record. Fields of
    // `patch.target` are merged into the existing target. Returns the
    // updated record, or null when there is no record with that id.
    update(id, patch) {
      const index = items.findIndex((a) => a.id === id);
      if (index === -1) return null;
      const old = items[index];
      const next = patched(old, patch);
      if (!next) return copyRecord(old); // nothing to undo, nothing to save
      commit(items.map((a, i) => (i === index ? next : a)), 'update');
      return copyRecord(next);
    },

    // Change several records as ONE undo step (the pieces of a selection that
    // crosses several blocks change together). `patchFor(record)` returns the
    // patch for each. Returns true when anything changed.
    updateMany(ids, patchFor) {
      const wanted = new Set(Array.isArray(ids) ? ids : [ids]);
      let changed = false;
      const next = items.map((old) => {
        if (!wanted.has(old.id)) return old;
        const record = patched(old, patchFor(copyRecord(old)));
        if (record) changed = true;
        return record || old;
      });
      if (changed) commit(next, 'update');
      return changed;
    },

    // Remove one id or an array of ids as ONE undo step. Ids that are not in
    // the list are ignored. Returns how many records were removed.
    remove(idOrArray) {
      const ids = new Set(Array.isArray(idOrArray) ? idOrArray : [idOrArray]);
      const next = items.filter((a) => !ids.has(a.id));
      const removed = items.length - next.length;
      if (removed) commit(next, 'remove');
      return removed;
    },

    // Both return true when something changed.
    undo() {
      if (!past.length) return false;
      future.push(items);
      items = past.pop();
      emit('undo');
      return true;
    },

    redo() {
      if (!future.length) return false;
      past.push(items);
      items = future.pop();
      emit('redo');
      return true;
    },

    canUndo() { return past.length > 0; },
    canRedo() { return future.length > 0; },

    // Replace everything with the result of sanitizeSidecar() (or with
    // nothing when given null). Opening a file is not something to undo, so
    // the history is cleared.
    load(data) {
      const ok = isObject(data);
      labels = ok && Array.isArray(data.labels) && data.labels.length
        ? copyLabels(data.labels) : copyLabels(DEFAULT_LABELS);
      items = ok && Array.isArray(data.annotations)
        ? data.annotations.filter(isObject).map(copyRecord) : [];
      drawings = ok && Array.isArray(data.drawings) ? data.drawings.slice() : [];
      past = [];
      future = [];
      emit('load');
    },

    // The object written to "<file>.annotations.json". `name` is the Markdown
    // file's name and `text` its current content.
    toSidecar({ name = '', text = '' } = {}) {
      const body = String(text ?? '');
      return {
        format: FORMAT,
        version: VERSION,
        document: { name: String(name ?? ''), hash: hashText(body), chars: body.length },
        labels: copyLabels(labels),
        annotations: items.map(copyRecord),
        drawings: drawings.slice(),
        savedAt: now(),
      };
    },

    // Call `cb(reason)` after every change. reason is one of
    // 'add' | 'update' | 'remove' | 'undo' | 'redo' | 'load'.
    // Returns a function that stops the calls.
    subscribe(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
  };
}
