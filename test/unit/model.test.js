import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FORMAT, VERSION, KINDS, WHOLE_BLOCK, DEFAULT_LABELS,
  newId, hashText, sanitizeSidecar, createStore,
} from '../../renderer/src/annotations/model.js';
// The main-process half of the same file format (it reads and writes the file).
import mainStore from '../../annotations-store.js';

// A well-formed text annotation; `over` replaces top-level fields.
function record(id, over = {}) {
  return {
    id,
    kind: 'highlight',
    label: 'question',
    note: `note for ${id}`,
    target: {
      block: 5, start: 96, end: 116, exact: 'refilled lazily on read',
      prefix: 'Buckets are ', suffix: ' so there is',
    },
    created: '2026-11-16T10:00:00.000Z',
    modified: '2026-11-16T10:00:00.000Z',
    ...over,
  };
}

const ids = (store) => store.list().map((a) => a.id);

// ---- Small helpers ------------------------------------------------------------

test('constants describe the file format', () => {
  assert.equal(FORMAT, 'plan-printer-annotations');
  // The newest file version the app reads. Version 2 added section notes.
  assert.equal(VERSION, 2);
  assert.deepEqual(KINDS, ['highlight', 'underline', 'strike', 'block', 'section']);
  assert.deepEqual(DEFAULT_LABELS.map((l) => l.id),
    ['note', 'question', 'change', 'keep', 'important']);
  for (const l of DEFAULT_LABELS) {
    assert.match(l.color, /^#[0-9a-f]{6}$/);
    assert.match(l.ink, /^#[0-9a-f]{6}$/);
    assert.ok(l.name && l.meaning);
  }
});

test('newId gives 10 characters from a-z0-9 and does not repeat', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const id = newId();
    assert.match(id, /^[a-z0-9]{10}$/);
    seen.add(id);
  }
  assert.equal(seen.size, 500);
});

test('hashText is FNV-1a: stable, 8 hex characters, different for different text', () => {
  // Published FNV-1a 32-bit test values.
  assert.equal(hashText(''), '811c9dc5');
  assert.equal(hashText('a'), 'e40c292c');
  assert.equal(hashText('foobar'), 'bf9cf968');
  assert.equal(hashText('# Plan\n\nText.'), hashText('# Plan\n\nText.'));
  assert.notEqual(hashText('# Plan\n\nText.'), hashText('# Plan\n\nText!'));
  assert.match(hashText('caf\u00e9 \ud83d\ude00'), /^[0-9a-f]{8}$/);
});

// ---- The store ----------------------------------------------------------------

test('a new store is empty and has the default labels', () => {
  const store = createStore();
  assert.deepEqual(store.list(), []);
  assert.deepEqual(store.labels, DEFAULT_LABELS);
  assert.equal(store.get('nope'), null);
  assert.equal(store.canUndo(), false);
  assert.equal(store.canRedo(), false);
  assert.equal(store.undo(), false);
  assert.equal(store.redo(), false);
});

test('add keeps creation order and returns the stored record', () => {
  const store = createStore();
  const first = store.add(record('a'));
  store.add(record('b'));
  store.add(record('c'));
  assert.deepEqual(ids(store), ['a', 'b', 'c']);
  assert.deepEqual(first, record('a'));
  assert.deepEqual(store.get('b'), record('b'));
});

test('add fills in id, label, note and timestamps when they are missing', () => {
  const store = createStore();
  const before = Date.now();
  const saved = store.add({
    kind: 'block', target: { block: 2, exact: '## Approach' },
  });
  assert.match(saved.id, /^[a-z0-9]{10}$/);
  assert.equal(saved.label, 'note');
  assert.equal(saved.note, '');
  assert.equal(saved.created, saved.modified);
  assert.ok(Date.parse(saved.created) >= before);
  assert.match(saved.created, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  // Existing timestamps are kept.
  const dated = store.add(record('old', { created: '2020-01-01T00:00:00.000Z' }));
  assert.equal(dated.created, '2020-01-01T00:00:00.000Z');
});

test('an array is added as one undo step', () => {
  const store = createStore();
  store.add(record('a'));
  const added = store.add([record('b', { group: 'g1' }), record('c', { group: 'g1' })]);
  assert.deepEqual(added.map((a) => a.id), ['b', 'c']);
  assert.deepEqual(ids(store), ['a', 'b', 'c']);
  assert.equal(store.undo(), true);
  assert.deepEqual(ids(store), ['a']);
  assert.equal(store.redo(), true);
  assert.deepEqual(ids(store), ['a', 'b', 'c']);
  assert.equal(store.get('c').group, 'g1');
});

test('a record whose id is already taken is not added twice', () => {
  const store = createStore();
  store.add(record('a'));
  assert.equal(store.add(record('a', { note: 'second' })), null);
  assert.deepEqual(store.add([record('a'), record('b')]).map((a) => a.id), ['b']);
  assert.deepEqual(ids(store), ['a', 'b']);
  assert.equal(store.get('a').note, 'note for a');
});

test('update merges kind, label, note and target, and sets modified', () => {
  const store = createStore();
  store.add(record('a'));
  const updated = store.update('a', { note: 'new note', label: 'change', kind: 'strike' });
  assert.equal(updated.note, 'new note');
  assert.equal(updated.label, 'change');
  assert.equal(updated.kind, 'strike');
  assert.equal(updated.created, '2026-11-16T10:00:00.000Z');
  assert.notEqual(updated.modified, '2026-11-16T10:00:00.000Z');
  assert.deepEqual(updated.target, record('a').target);
  assert.deepEqual(store.get('a'), updated);

  // A target patch is merged into the existing target.
  const moved = store.update('a', { target: { block: 7, start: 10, end: 30 } });
  assert.deepEqual(moved.target, { ...record('a').target, block: 7, start: 10, end: 30 });

  // Fields outside kind/label/note/target cannot be changed this way.
  store.update('a', { id: 'hacked', created: 'never', note: 'again' });
  assert.equal(store.get('hacked'), null);
  assert.equal(store.get('a').created, '2026-11-16T10:00:00.000Z');
  assert.equal(store.get('a').note, 'again');

  assert.equal(store.update('missing', { note: 'x' }), null);
});

test('an update that changes nothing is not an undo step', () => {
  const store = createStore();
  store.add(record('a'));
  const reasons = [];
  store.subscribe((r) => reasons.push(r));
  const same = store.update('a', { note: 'note for a', label: 'question' });
  assert.deepEqual(same, record('a'));
  assert.deepEqual(reasons, []);
  store.undo(); // undoes the add, not a phantom update
  assert.deepEqual(ids(store), []);
});

test('remove takes one id or several, ignores unknown ids, and is one undo step', () => {
  const store = createStore();
  store.add([record('a'), record('b'), record('c'), record('d')]);
  assert.equal(store.remove('b'), 1);
  assert.deepEqual(ids(store), ['a', 'c', 'd']);
  assert.equal(store.remove(['a', 'zzz', 'd']), 2);
  assert.deepEqual(ids(store), ['c']);
  assert.equal(store.undo(), true);
  assert.deepEqual(ids(store), ['a', 'c', 'd']);

  // Nothing found: nothing happens, and no undo step is recorded.
  const reasons = [];
  store.subscribe((r) => reasons.push(r));
  assert.equal(store.remove('zzz'), 0);
  assert.equal(store.remove([]), 0);
  assert.deepEqual(reasons, []);
});

test('undo puts removed records back in their original positions', () => {
  const store = createStore();
  store.add([record('a'), record('b'), record('c'), record('d'), record('e')]);
  store.remove(['b', 'd']);
  assert.deepEqual(ids(store), ['a', 'c', 'e']);
  store.undo();
  assert.deepEqual(ids(store), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(store.get('d'), record('d'));
  store.redo();
  assert.deepEqual(ids(store), ['a', 'c', 'e']);
});

test('undo and redo walk back and forth through add, update and remove', () => {
  const store = createStore();
  store.add(record('a'));
  store.add(record('b'));
  store.update('a', { note: 'edited' });
  store.remove('b');
  assert.equal(store.canUndo(), true);
  assert.equal(store.canRedo(), false);

  assert.equal(store.undo(), true); // un-remove b
  assert.deepEqual(ids(store), ['a', 'b']);
  assert.equal(store.undo(), true); // un-edit a
  assert.equal(store.get('a').note, 'note for a');
  assert.equal(store.get('a').modified, '2026-11-16T10:00:00.000Z');
  assert.equal(store.undo(), true); // un-add b
  assert.equal(store.undo(), true); // un-add a
  assert.deepEqual(ids(store), []);
  assert.equal(store.undo(), false);
  assert.equal(store.canUndo(), false);
  assert.equal(store.canRedo(), true);

  assert.equal(store.redo(), true);
  assert.equal(store.redo(), true);
  assert.equal(store.redo(), true);
  assert.equal(store.get('a').note, 'edited');
  assert.equal(store.redo(), true);
  assert.deepEqual(ids(store), ['a']);
  assert.equal(store.redo(), false);
});

test('a new change after an undo clears the redo stack', () => {
  const store = createStore();
  store.add(record('a'));
  store.add(record('b'));
  store.undo();
  assert.equal(store.canRedo(), true);
  store.add(record('c'));
  assert.equal(store.canRedo(), false);
  assert.equal(store.redo(), false);
  assert.deepEqual(ids(store), ['a', 'c']);
});

test('records handed out are copies: changing them does not change the store', () => {
  const store = createStore();
  const input = record('a');
  store.add(input);
  input.note = 'changed after add';
  input.target.block = 99;
  assert.equal(store.get('a').note, 'note for a');

  const got = store.get('a');
  got.note = 'scribbled on';
  got.target.block = 42;
  store.list()[0].label = 'keep';
  assert.deepEqual(store.get('a'), record('a'));

  // A record fetched earlier is not rewritten by a later update or undo.
  const snapshot = store.get('a');
  store.update('a', { note: 'v2' });
  assert.equal(snapshot.note, 'note for a');
  const v2 = store.get('a');
  store.undo();
  assert.equal(v2.note, 'v2');
  assert.equal(store.get('a').note, 'note for a');
});

test('subscribers hear the reason for every change and can unsubscribe', () => {
  const store = createStore();
  const reasons = [];
  const stop = store.subscribe((r) => reasons.push(r));
  store.add(record('a'));
  store.update('a', { note: 'x' });
  store.remove('a');
  store.undo();
  store.redo();
  store.load(null);
  assert.deepEqual(reasons, ['add', 'update', 'remove', 'undo', 'redo', 'load']);

  // Nothing to undo: no change, so no call.
  store.undo();
  assert.equal(reasons.length, 6);

  stop();
  store.add(record('b'));
  assert.equal(reasons.length, 6);
});

test('one failing subscriber does not stop the others', (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const store = createStore();
  const reasons = [];
  store.subscribe(() => { throw new Error('painter broke'); });
  store.subscribe((r) => reasons.push(r));
  store.add(record('a'));
  assert.deepEqual(reasons, ['add']);
  assert.equal(logged.mock.callCount(), 1);
});

test('load replaces labels and annotations and clears the history', () => {
  const store = createStore();
  store.add(record('a'));
  store.add(record('b'));
  store.undo();
  const custom = [{ id: 'todo', name: 'To do', color: '#abcdef', ink: '#123456', meaning: 'x' }];
  store.load({ labels: custom, annotations: [record('z')], drawings: [], document: {} });
  assert.deepEqual(ids(store), ['z']);
  assert.deepEqual(store.labels, custom);
  assert.equal(store.canUndo(), false);
  assert.equal(store.canRedo(), false);

  store.load(null);
  assert.deepEqual(store.list(), []);
  assert.deepEqual(store.labels, DEFAULT_LABELS);
});

// ---- Sidecar files ------------------------------------------------------------

test('toSidecar writes the documented file layout', () => {
  const store = createStore();
  store.add(record('a'));
  const text = '# Plan\n\nBuckets are refilled lazily on read.\n';
  const before = Date.now();
  const file = store.toSidecar({ name: 'plan.md', text });
  assert.deepEqual(Object.keys(file),
    ['format', 'version', 'document', 'labels', 'annotations', 'drawings', 'savedAt']);
  assert.equal(file.format, 'plan-printer-annotations');
  assert.equal(file.version, 1);
  assert.deepEqual(file.document, { name: 'plan.md', hash: hashText(text), chars: text.length });
  assert.deepEqual(file.labels, DEFAULT_LABELS);
  assert.deepEqual(file.annotations, [record('a')]);
  assert.deepEqual(file.drawings, []);
  assert.ok(Date.parse(file.savedAt) >= before);
  // It must survive being written to disk as JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(file)), file);
});

test('toSidecar then sanitizeSidecar gives the same annotations back', () => {
  const store = createStore();
  store.add([
    record('a'),
    record('b', { kind: 'underline', label: 'keep', note: '', group: 'g1' }),
    record('c', { kind: 'strike', group: 'g1' }),
    { id: 'd', kind: 'block', label: 'important', note: 'Check this table',
      target: { block: 3, exact: '| Setting | Default | Notes |' },
      created: '2026-11-16T10:00:00.000Z', modified: '2026-11-16T10:00:00.000Z' },
  ]);
  const onDisk = JSON.parse(JSON.stringify(store.toSidecar({ name: 'plan.md', text: 'abc' })));
  const clean = sanitizeSidecar(onDisk);
  assert.deepEqual(clean.annotations, store.list());
  assert.deepEqual(clean.labels, DEFAULT_LABELS);
  assert.deepEqual(clean.drawings, []);
  assert.deepEqual(clean.document, { name: 'plan.md', hash: hashText('abc'), chars: 3 });

  const reopened = createStore();
  reopened.load(clean);
  assert.deepEqual(reopened.list(), store.list());
});

const sidecar = (over = {}) => ({
  format: FORMAT, version: VERSION, document: { name: 'plan.md', hash: '9f2c41aa' },
  labels: DEFAULT_LABELS, annotations: [record('a')], drawings: [], ...over,
});

test('sanitizeSidecar rejects files that are not ours', () => {
  assert.equal(sanitizeSidecar(null), null);
  assert.equal(sanitizeSidecar(undefined), null);
  assert.equal(sanitizeSidecar('text'), null);
  assert.equal(sanitizeSidecar([]), null);
  assert.equal(sanitizeSidecar({}), null);
  assert.equal(sanitizeSidecar(sidecar({ format: 'something-else' })), null);
  assert.equal(sanitizeSidecar(sidecar({ annotations: 'none' })), null);
  assert.equal(sanitizeSidecar(sidecar({ annotations: undefined })), null);
  assert.notEqual(sanitizeSidecar(sidecar()), null);
});

test('sanitizeSidecar rejects a newer or nonsense version', () => {
  assert.equal(sanitizeSidecar(sidecar({ version: VERSION + 1 })), null);
  assert.equal(sanitizeSidecar(sidecar({ version: 0 })), null);
  assert.equal(sanitizeSidecar(sidecar({ version: 1.5 })), null);
  assert.equal(sanitizeSidecar(sidecar({ version: '1' })), null);
  assert.equal(sanitizeSidecar(sidecar({ version: undefined })), null);
});

test('sanitizeSidecar drops malformed annotations and keeps the good ones', () => {
  const good = record('good');
  const target = good.target;
  const clean = sanitizeSidecar(sidecar({
    annotations: [
      null,
      'text',
      record(''), // empty id
      record(7), // id is not a string
      record('bad-kind', { kind: 'circle' }),
      record('no-target', { target: undefined }),
      record('bad-block', { target: { ...target, block: -1 } }),
      record('float-block', { target: { ...target, block: 1.5 } }),
      record('no-exact', { target: { ...target, exact: undefined } }),
      record('no-start', { target: { ...target, start: undefined } }),
      record('negative-start', { target: { ...target, start: -1 } }),
      record('empty-range', { target: { ...target, start: 10, end: 10 } }),
      record('backwards', { target: { ...target, start: 10, end: 5 } }),
      good,
      { id: 'block-ok', kind: 'block', target: { block: 0, exact: '# Title' } },
    ],
  }));
  assert.deepEqual(clean.annotations.map((a) => a.id), ['good', 'block-ok']);
  assert.deepEqual(clean.annotations[0], good);
  // Missing label and note get their defaults; a block note has no offsets.
  assert.deepEqual(clean.annotations[1], {
    id: 'block-ok', kind: 'block', label: 'note', note: '', target: { block: 0, exact: '# Title' },
  });
});

test('sanitizeSidecar drops duplicate ids, keeping the first', () => {
  const clean = sanitizeSidecar(sidecar({
    annotations: [record('a', { note: 'first' }), record('b'), record('a', { note: 'second' })],
  }));
  assert.deepEqual(clean.annotations.map((a) => a.id), ['a', 'b']);
  assert.equal(clean.annotations[0].note, 'first');
});

test('sanitizeSidecar clamps long text and coerces odd fields', () => {
  const long = (n) => 'x'.repeat(n);
  const clean = sanitizeSidecar(sidecar({
    annotations: [
      record('long', {
        note: long(25000),
        target: {
          block: 0, start: 0, end: 10, exact: long(13000), prefix: long(300), suffix: long(300),
        },
      }),
      record('odd', {
        note: 42, label: 7, group: 9, created: 0, modified: null,
        target: { block: 0, start: 0, end: 4, exact: 'text', prefix: 5, extra: 'dropped' },
      }),
    ],
  }));
  const [a, b] = clean.annotations;
  assert.equal(a.note.length, 20000);
  assert.equal(a.target.exact.length, 12000);
  assert.equal(a.target.prefix.length, 200);
  assert.equal(a.target.suffix.length, 200);
  assert.deepEqual(b, {
    id: 'odd', kind: 'highlight', label: 'note', note: '',
    target: { block: 0, start: 0, end: 4, exact: 'text', prefix: '', suffix: '' },
  });
});

test('sanitizeSidecar uses the file labels when they are well formed', () => {
  const custom = [
    { id: 'todo', name: 'To do', color: '#abc', ink: '#123456', meaning: 'not done yet' },
    { id: 'risk', name: 'Risk', color: '#FFD3CF80', ink: '#B3261E' }, // no meaning
  ];
  const clean = sanitizeSidecar(sidecar({ labels: custom }));
  assert.deepEqual(clean.labels, [custom[0], { ...custom[1], meaning: '' }]);
});

test('sanitizeSidecar falls back to the default labels', () => {
  const bad = [
    undefined,
    'labels',
    [],
    [null, 'x'],
    [{ id: 'a', name: 'A', color: 'red', ink: '#000000' }], // not a hex colour
    [{ id: 'a', name: 'A', color: '#fff1a8' }], // no ink
    [{ id: 'a', color: '#fff1a8', ink: '#000000' }], // no name
    [{ id: 'a', name: 'A', color: '#fff; background: url(x)', ink: '#000000' }],
  ];
  for (const labels of bad) {
    assert.deepEqual(sanitizeSidecar(sidecar({ labels })).labels, DEFAULT_LABELS);
  }
  // The result is a copy: changing it must not change the built-in defaults.
  sanitizeSidecar(sidecar({ labels: [] })).labels[0].name = 'Changed';
  assert.equal(DEFAULT_LABELS[0].name, 'Note');
});

test('sanitizeSidecar keeps drawings and document details when present', () => {
  const drawing = { id: 'd1', type: 'pen', points: [[1, 2], [3, 4]] };
  const full = sanitizeSidecar(sidecar({
    drawings: [drawing], document: { name: 'plan.md', hash: '9f2c41aa', chars: 5779, x: 1 },
  }));
  assert.deepEqual(full.drawings, [drawing]);
  assert.deepEqual(full.document, { name: 'plan.md', hash: '9f2c41aa', chars: 5779 });

  const bare = sanitizeSidecar(sidecar({ drawings: 'none', document: 'plan.md' }));
  assert.deepEqual(bare.drawings, []);
  assert.deepEqual(bare.document, {});
  assert.deepEqual(sanitizeSidecar(sidecar({ document: { name: 5 } })).document, {});
});

test('drawings loaded from a file are written back on save', () => {
  const drawing = { id: 'd1', type: 'pen', points: [[1, 2], [3, 4]] };
  const store = createStore();
  store.load(sanitizeSidecar(sidecar({ drawings: [drawing] })));
  assert.deepEqual(store.toSidecar({ name: 'plan.md', text: '' }).drawings, [drawing]);
});

// ---- Added after review ---------------------------------------------------------

test('what the app lets you make survives a save and reload untouched', () => {
  // The longest selection dom.js accepts is 4000 characters NOT counting
  // spaces; with its spaces it is longer. A long note must come back whole too.
  const quote = Array(800).fill('words').join(' '); // 4000 letters, 4799 with spaces
  const note = 'n'.repeat(6000);
  const clean = sanitizeSidecar(sidecar({
    annotations: [record('big', { note, target: { block: 0, start: 0, end: 4000, exact: quote, prefix: '', suffix: '' } })],
  }));
  assert.equal(clean.annotations[0].note, note);
  assert.equal(clean.annotations[0].target.exact, quote);
});

test('ids that are also names every object has are refused', () => {
  const clean = sanitizeSidecar(sidecar({
    annotations: [record('constructor'), record('__proto__'), record('toString'), record('has space'), record('fine-1')],
  }));
  assert.deepEqual(clean.annotations.map((a) => a.id), ['fine-1']);
});

test('the "2nd of 3 copies" record is kept when it makes sense and dropped when it does not', () => {
  const t = (occurrence) => ({ block: 0, start: 0, end: 4, exact: 'text', prefix: '', suffix: '', occurrence });
  const clean = sanitizeSidecar(sidecar({
    annotations: [
      record('good', { target: t({ nth: 1, of: 3 }) }),
      record('bad1', { target: t({ nth: 3, of: 3 }) }),
      record('bad2', { target: t('second') }),
    ],
  }));
  assert.deepEqual(clean.annotations[0].target.occurrence, { nth: 1, of: 3 });
  assert.equal('occurrence' in clean.annotations[1].target, false);
  assert.equal('occurrence' in clean.annotations[2].target, false);
});

test('updateMany changes several records as one undo step', () => {
  const store = createStore();
  store.add([record('p1', { group: 'g' }), record('p2', { group: 'g' }), record('other')]);
  const reasons = [];
  store.subscribe((r) => reasons.push(r));
  assert.equal(store.updateMany(['p1', 'p2'], () => ({ label: 'change' })), true);
  assert.deepEqual(store.list().map((a) => a.label), ['change', 'change', 'question']);
  assert.deepEqual(reasons, ['update']);
  store.undo(); // one press takes both back
  assert.deepEqual(store.list().map((a) => a.label), ['question', 'question', 'question']);
  // A patch that changes nothing is not a step.
  assert.equal(store.updateMany(['p1'], () => ({ label: 'question' })), false);
});

// ---- Section notes --------------------------------------------------------------
// A section note is the reviewer's own note on a whole section. It is stored
// like a note on a block: the block is the section's heading, and `exact` is
// that heading as written in the Markdown ("## Risks").

// A well-formed section note; `over` replaces top-level fields.
function sectionRecord(id, over = {}) {
  return {
    id,
    kind: 'section',
    label: 'note',
    note: `summary for ${id}`,
    target: { block: 4, exact: '## Risks' },
    created: '2026-11-16T10:00:00.000Z',
    modified: '2026-11-16T10:00:00.000Z',
    ...over,
  };
}

// The version number the store would write to disk right now.
const versionOf = (store) => store.toSidecar({ name: 'plan.md', text: '' }).version;

test('the whole-block kinds are "block" and "section"', () => {
  assert.ok(WHOLE_BLOCK instanceof Set);
  assert.deepEqual([...WHOLE_BLOCK].sort(), ['block', 'section']);
  // Both are kinds the app knows, and the three text kinds are not among them.
  for (const kind of WHOLE_BLOCK) assert.ok(KINDS.includes(kind), kind);
  assert.deepEqual(KINDS.filter((kind) => !WHOLE_BLOCK.has(kind)),
    ['highlight', 'underline', 'strike']);
});

test('the page and the main process agree on the file format and its newest version', () => {
  // The page builds the file (model.js) and the main process checks it before
  // writing (annotations-store.js). If the two numbers drifted apart, a file
  // with a section note could be built but never saved.
  assert.equal(mainStore.FORMAT, FORMAT);
  assert.equal(mainStore.VERSION, VERSION);
});

test('a section note read from a file keeps only block and exact in its target', () => {
  const clean = sanitizeSidecar(sidecar({ annotations: [sectionRecord('s1')] }));
  assert.deepEqual(clean.annotations, [sectionRecord('s1')]);
  // No offsets and no context are added: it is about the whole section.
  assert.deepEqual(Object.keys(clean.annotations[0].target), ['block', 'exact']);

  // Missing label and note get their defaults, as for any other record.
  const bare = sanitizeSidecar(sidecar({
    annotations: [{ id: 's2', kind: 'section', target: { block: 0, exact: '# Title' } }],
  }));
  assert.deepEqual(bare.annotations, [
    { id: 's2', kind: 'section', label: 'note', note: '', target: { block: 0, exact: '# Title' } },
  ]);
});

test('stray offsets on a section note are dropped, the same as on a block note', () => {
  // start, end, prefix and suffix belong to notes on some of a block's words.
  const stray = {
    block: 4, exact: '## Risks', start: 3, end: 9, prefix: 'before ', suffix: ' after', extra: 'x',
  };
  const clean = sanitizeSidecar(sidecar({
    annotations: [
      sectionRecord('section', { target: { ...stray } }),
      sectionRecord('block', { kind: 'block', target: { ...stray } }),
      // Offsets that would get a highlight thrown out do no harm here: they
      // are not looked at.
      sectionRecord('nonsense', { target: { block: 4, exact: '## Risks', start: -5, end: 'x' } }),
    ],
  }));
  assert.deepEqual(clean.annotations.map((a) => a.id), ['section', 'block', 'nonsense']);
  for (const a of clean.annotations) {
    assert.deepEqual(a.target, { block: 4, exact: '## Risks' }, a.id);
  }
  // The same stray fields on a highlight are kept: there they mean something.
  const highlight = sanitizeSidecar(sidecar({
    annotations: [record('h', { target: { ...stray } })],
  })).annotations[0];
  assert.deepEqual(highlight.target, {
    block: 4, start: 3, end: 9, exact: '## Risks', prefix: 'before ', suffix: ' after',
  });
});

test('a section note keeps a sensible "2nd of 3 copies" record', () => {
  // Two sections may have the same heading ("### Notes" under each part).
  const t = (occurrence) => ({ block: 4, exact: '### Notes', occurrence });
  const clean = sanitizeSidecar(sidecar({
    annotations: [
      sectionRecord('good', { target: t({ nth: 1, of: 3 }) }),
      sectionRecord('bad1', { target: t({ nth: 3, of: 3 }) }), // there is no 4th of 3
      sectionRecord('bad2', { target: t('second') }),
    ],
  }));
  assert.deepEqual(clean.annotations.map((a) => a.target), [
    { block: 4, exact: '### Notes', occurrence: { nth: 1, of: 3 } },
    { block: 4, exact: '### Notes' },
    { block: 4, exact: '### Notes' },
  ]);
});

test('a section note with no usable block or heading text is dropped', () => {
  const clean = sanitizeSidecar(sidecar({
    annotations: [
      sectionRecord('no-target', { target: undefined }),
      sectionRecord('no-block', { target: { exact: '## Risks' } }),
      sectionRecord('negative-block', { target: { block: -1, exact: '## Risks' } }),
      sectionRecord('fraction-block', { target: { block: 1.5, exact: '## Risks' } }),
      sectionRecord('text-block', { target: { block: '4', exact: '## Risks' } }),
      sectionRecord('no-exact', { target: { block: 4 } }),
      sectionRecord('number-exact', { target: { block: 4, exact: 7 } }),
      sectionRecord('null-exact', { target: { block: 4, exact: null } }),
      sectionRecord('good'),
      // Block 0 is a real block: the document's title is usually there.
      sectionRecord('on-the-title', { target: { block: 0, exact: '# Title' } }),
    ],
  }));
  assert.deepEqual(clean.annotations.map((a) => a.id), ['good', 'on-the-title']);
});

test('sanitizeSidecar reads version 1 and version 2 files and refuses version 3', () => {
  // Version 1: written before section notes existed (or by a file without one).
  const v1 = sanitizeSidecar(sidecar({ version: 1 }));
  assert.deepEqual(v1.annotations, [record('a')]);

  // Version 2: may hold section notes next to everything version 1 had.
  const v2 = sanitizeSidecar(sidecar({
    version: 2, annotations: [record('a'), sectionRecord('s1')],
  }));
  assert.deepEqual(v2.annotations, [record('a'), sectionRecord('s1')]);
  assert.notEqual(sanitizeSidecar(sidecar({ version: 2, annotations: [] })), null);

  // Version 3 would come from a newer copy of the app: hands off.
  assert.equal(sanitizeSidecar(sidecar({ version: 3 })), null);
  assert.equal(sanitizeSidecar(sidecar({ version: 3, annotations: [] })), null);
});

test('toSidecar writes version 1 without a section note and version 2 with one', () => {
  const store = createStore();
  assert.equal(versionOf(store), 1); // nothing at all

  // Every kind an older copy of the app already knows: still version 1, so
  // that older copy can keep reading the file.
  store.add([
    record('h'),
    record('u', { kind: 'underline' }),
    record('s', { kind: 'strike' }),
    { id: 'b', kind: 'block', target: { block: 3, exact: '| Setting | Default |' } },
  ]);
  assert.equal(versionOf(store), 1);

  store.add(sectionRecord('s1'));
  assert.equal(versionOf(store), 2);
  // Never a number this copy of the app could not read back itself.
  assert.ok(versionOf(store) <= VERSION);

  // A second one changes nothing, and one of the two is enough for version 2.
  store.add(sectionRecord('s2', { target: { block: 9, exact: '## Open questions' } }));
  assert.equal(versionOf(store), 2);
  store.remove('s2');
  assert.equal(versionOf(store), 2);
});

test('the file goes back to version 1 once the section note is gone', () => {
  const store = createStore();
  store.add(record('a'));
  store.add(sectionRecord('s1'));
  assert.equal(versionOf(store), 2);

  // Undo the add: the note is gone again.
  store.undo();
  assert.deepEqual(ids(store), ['a']);
  assert.equal(versionOf(store), 1);
  store.redo();
  assert.equal(versionOf(store), 2);

  // Remove it (what the app does when the section note box is emptied).
  assert.equal(store.remove('s1'), 1);
  assert.deepEqual(ids(store), ['a']);
  assert.equal(versionOf(store), 1);

  // Undo the removal: the note is back, and so is version 2.
  store.undo();
  assert.deepEqual(ids(store), ['a', 's1']);
  assert.equal(versionOf(store), 2);

  // Opening a document that has none starts again at version 1.
  store.load(sanitizeSidecar(sidecar({ version: 1 })));
  assert.equal(versionOf(store), 1);
});

test('a file with section notes gives the same records back after a save and reload', () => {
  const store = createStore();
  store.add([
    record('a'),
    sectionRecord('s1'),
    sectionRecord('s2', {
      note: 'Line one\nLine two',
      target: { block: 9, exact: '### Notes', occurrence: { nth: 0, of: 2 } },
    }),
  ]);
  const onDisk = JSON.parse(JSON.stringify(store.toSidecar({ name: 'plan.md', text: 'abc' })));
  assert.equal(onDisk.version, 2);
  // The main process would let this file through to disk.
  assert.equal(mainStore.validateSidecar(onDisk), true);

  const clean = sanitizeSidecar(onDisk);
  assert.deepEqual(clean.annotations, store.list());

  const reopened = createStore();
  reopened.load(clean);
  assert.deepEqual(reopened.list(), store.list());
  assert.equal(versionOf(reopened), 2); // the section notes are still in it
});

test('update can change the text of a section note', () => {
  const store = createStore();
  store.add(sectionRecord('s1'));
  const reasons = [];
  store.subscribe((r) => reasons.push(r));

  const updated = store.update('s1', { note: 'Rewritten summary' });
  assert.equal(updated.note, 'Rewritten summary');
  // Everything else about the record stays as it was.
  assert.equal(updated.kind, 'section');
  assert.equal(updated.label, 'note');
  assert.deepEqual(updated.target, { block: 4, exact: '## Risks' });
  assert.equal(updated.created, '2026-11-16T10:00:00.000Z');
  assert.notEqual(updated.modified, '2026-11-16T10:00:00.000Z');
  assert.deepEqual(store.get('s1'), updated);
  assert.deepEqual(reasons, ['update']);

  // The same text again is not a change, so there is nothing new to undo.
  // (The app saves the section note box every time you click away from it.)
  assert.deepEqual(store.update('s1', { note: 'Rewritten summary' }), updated);
  assert.deepEqual(reasons, ['update']);

  // One undo brings the old text back. The note is still there: version 2.
  store.undo();
  assert.deepEqual(store.get('s1'), sectionRecord('s1'));
  assert.equal(versionOf(store), 2);
});
