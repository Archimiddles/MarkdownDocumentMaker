'use strict';
// Unit tests for annotations-store.js (the sidecar file beside a document).
// Run with: node --test test/unit/store.test.js
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../../annotations-store');
const { FORMAT, VERSION, sidecarPath, readSidecar, writeSidecar, validateSidecar } = store;

const valid = (annotations = []) => ({ format: FORMAT, version: VERSION, annotations });
const sample = () => valid([
  { id: 'a1', kind: 'highlight', label: 'question', quote: 'Why “this”? — naïve café' },
  { id: 'a2', kind: 'note', body: 'Line one\nLine two' },
]);

// A section note the way the app saves it: the reviewer's own note on a whole
// section, stored like a note on a block (the block is the section's heading).
const sectionNote = () => ({
  id: 's1',
  kind: 'section',
  label: 'note',
  note: 'Mostly fine.\nCheck the “clock” part — naïve?',
  target: { block: 4, exact: '## Risks' },
  created: '2026-11-16T10:00:00.000Z',
  modified: '2026-11-16T10:00:00.000Z',
});
// A whole file that holds one. The app marks such a file version 2, so an
// older copy of the app (which only knows version 1) leaves it alone.
const withSectionNote = () => ({
  format: FORMAT,
  version: 2,
  document: { name: 'plan.md', hash: '9f2c41aa', chars: 19 },
  annotations: [{ id: 'a1', kind: 'highlight', label: 'question' }, sectionNote()],
  drawings: [],
});

// Every test gets its own scratch folder holding a document called plan.md.
let dir;
let doc;
let side;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-store-'));
  doc = path.join(dir, 'plan.md');
  side = `${doc}.annotations.json`;
  fs.writeFileSync(doc, '# Plan\n\nSome text.\n', 'utf8');
});

afterEach(() => {
  mock.restoreAll();
  fs.rmSync(dir, { recursive: true, force: true });
});

const listing = () => fs.readdirSync(dir).sort();

describe('sidecarPath', () => {
  it('adds .annotations.json to Markdown and text documents', () => {
    assert.equal(sidecarPath('/a/plan.md'), '/a/plan.md.annotations.json');
    assert.equal(sidecarPath('/a/notes.markdown'), '/a/notes.markdown.annotations.json');
    assert.equal(sidecarPath('/a/notes.txt'), '/a/notes.txt.annotations.json');
    assert.equal(sidecarPath('plan.md'), 'plan.md.annotations.json');
  });

  it('ignores the case of the extension and keeps the name as given', () => {
    assert.equal(sidecarPath('/a/PLAN.MD'), '/a/PLAN.MD.annotations.json');
    assert.equal(sidecarPath('/a/Notes.MarkDown'), '/a/Notes.MarkDown.annotations.json');
    assert.equal(sidecarPath('/a/README.TXT'), '/a/README.TXT.annotations.json');
  });

  it('returns null for other file types', () => {
    assert.equal(sidecarPath('/a/picture.png'), null);
    assert.equal(sidecarPath('/a/plan.md.png'), null);
    assert.equal(sidecarPath('/a/plan.md.annotations.json'), null);
    assert.equal(sidecarPath('/a/no-extension'), null);
    assert.equal(sidecarPath('/a/folder.md/file'), null);
  });

  it('returns null for an empty string and for non-strings', () => {
    assert.equal(sidecarPath(''), null);
    for (const value of [undefined, null, 0, 42, true, {}, [], ['plan.md'], { path: 'plan.md' }]) {
      assert.equal(sidecarPath(value), null);
    }
  });
});

describe('validateSidecar', () => {
  it('accepts the minimal valid shape and keeps unknown fields legal', () => {
    assert.equal(validateSidecar(valid()), true);
    assert.equal(validateSidecar(sample()), true);
    assert.equal(validateSidecar({ ...valid(), labels: [], savedAt: 'today' }), true);
    assert.equal(validateSidecar(JSON.parse(JSON.stringify(valid()))), true);
  });

  it('rejects anything that is not a plain object', () => {
    for (const value of [undefined, null, 0, 1, '', 'text', true, [], [valid()], new Map(), new Date()]) {
      assert.equal(validateSidecar(value), false);
    }
    assert.equal(validateSidecar(JSON.stringify(valid())), false);
  });

  it('rejects a missing or wrong format', () => {
    assert.equal(validateSidecar({ version: VERSION, annotations: [] }), false);
    assert.equal(validateSidecar({ ...valid(), format: 'something-else' }), false);
    assert.equal(validateSidecar({ ...valid(), format: FORMAT.toUpperCase() }), false);
  });

  it('accepts only an integer version from 1 up to VERSION', () => {
    assert.equal(validateSidecar({ ...valid(), version: 1 }), true);
    for (const version of [0, -1, 1.5, VERSION + 1, NaN, Infinity, '1', null, undefined, [1]]) {
      assert.equal(validateSidecar({ ...valid(), version }), false, `version ${String(version)}`);
    }
  });

  it('accepts version 1 and version 2 files and nothing newer', () => {
    // Version 2 added section notes. The numbers are written out here, not
    // taken from VERSION, so a change to VERSION has to be made on purpose.
    assert.equal(VERSION, 2);
    assert.equal(validateSidecar({ format: FORMAT, version: 1, annotations: [] }), true);
    assert.equal(validateSidecar({ format: FORMAT, version: 2, annotations: [] }), true);
    assert.equal(validateSidecar({ format: FORMAT, version: 3, annotations: [] }), false);
    assert.equal(validateSidecar(withSectionNote()), true);
  });

  it('needs annotations to be an array of at most 5000 entries', () => {
    assert.equal(validateSidecar({ format: FORMAT, version: VERSION }), false);
    for (const annotations of [null, {}, 'none', 3, { length: 0 }]) {
      assert.equal(validateSidecar({ ...valid(), annotations }), false);
    }
    assert.equal(validateSidecar(valid(new Array(5000).fill({ id: 'x' }))), true);
    assert.equal(validateSidecar(valid(new Array(5001).fill({ id: 'x' }))), false);
  });
});

describe('readSidecar', () => {
  it('reports none when the document has no sidecar file', () => {
    assert.deepEqual(readSidecar(doc), { status: 'none' });
    assert.deepEqual(readSidecar(path.join(dir, 'missing', 'plan.md')), { status: 'none' });
  });

  it('reports none when the path can have no sidecar at all', () => {
    const png = path.join(dir, 'picture.png');
    fs.writeFileSync(`${png}.annotations.json`, JSON.stringify(valid()));
    assert.deepEqual(readSidecar(png), { status: 'none' });
    assert.deepEqual(readSidecar(''), { status: 'none' });
    assert.deepEqual(readSidecar(undefined), { status: 'none' });
    assert.deepEqual(readSidecar(null), { status: 'none' });
  });

  it('returns the data when the file parses and validates', () => {
    fs.writeFileSync(side, JSON.stringify(sample()), 'utf8');
    assert.deepEqual(readSidecar(doc), { status: 'ok', data: sample() });
  });

  it('reads a file that starts with a byte-order mark', () => {
    fs.writeFileSync(side, `﻿${JSON.stringify(sample())}`, 'utf8');
    assert.deepEqual(readSidecar(doc), { status: 'ok', data: sample() });
  });

  it('reports corrupt for text that is not JSON', () => {
    for (const text of ['', '{ "format": ', 'not json at all', '{"a":1}}']) {
      fs.writeFileSync(side, text, 'utf8');
      const result = readSidecar(doc);
      assert.equal(result.status, 'corrupt', JSON.stringify(text));
      assert.equal(typeof result.error, 'string');
      assert.ok(result.error.length > 0);
      assert.deepEqual(Object.keys(result).sort(), ['error', 'status']);
    }
  });

  it('reports corrupt for JSON of the wrong shape', () => {
    const wrong = [
      [],
      null,
      'a string',
      {},
      { format: 'something-else', version: VERSION, annotations: [] },
      { format: FORMAT, version: VERSION },
      { format: FORMAT, version: VERSION, annotations: {} },
      { format: FORMAT, version: 0, annotations: [] },
      { format: FORMAT, version: '2', annotations: [] },
      { format: FORMAT, version: VERSION + 0.5, annotations: [] },
      // A higher version only counts as "newer" with the right format.
      { format: 'something-else', version: VERSION + 1, annotations: [] },
    ];
    for (const value of wrong) {
      fs.writeFileSync(side, JSON.stringify(value), 'utf8');
      const result = readSidecar(doc);
      assert.equal(result.status, 'corrupt', JSON.stringify(value));
      assert.equal(typeof result.error, 'string');
    }
  });

  it('reports corrupt when the sidecar cannot be read as a file', () => {
    fs.mkdirSync(side);
    const result = readSidecar(doc);
    assert.equal(result.status, 'corrupt');
    assert.equal(typeof result.error, 'string');
  });

  it('reports corrupt for a file over 5 MB without parsing it', () => {
    fs.writeFileSync(side, Buffer.alloc(5 * 1024 * 1024 + 1, 0x20));
    assert.equal(readSidecar(doc).status, 'corrupt');
  });

  it('reports newer for a file from a later version of the app', () => {
    fs.writeFileSync(side, JSON.stringify({ ...valid(), version: VERSION + 1 }), 'utf8');
    assert.deepEqual(readSidecar(doc), { status: 'newer', version: VERSION + 1 });

    // A later version may have changed everything except format and version.
    fs.writeFileSync(side, JSON.stringify({ format: FORMAT, version: VERSION + 41, pages: {} }), 'utf8');
    assert.deepEqual(readSidecar(doc), { status: 'newer', version: VERSION + 41 });
  });

  it('still reads a version 1 file, written before section notes existed', () => {
    const old = { format: FORMAT, version: 1, annotations: [{ id: 'a1', kind: 'highlight' }] };
    fs.writeFileSync(side, JSON.stringify(old), 'utf8');
    assert.deepEqual(readSidecar(doc), { status: 'ok', data: old });
  });

  it('reads a version 2 file with a section note in it', () => {
    fs.writeFileSync(side, JSON.stringify(withSectionNote()), 'utf8');
    const result = readSidecar(doc);
    assert.deepEqual(result, { status: 'ok', data: withSectionNote() });
    // The section note comes back whole: this module passes records through
    // untouched (the page checks them one by one, see model.js).
    assert.deepEqual(result.data.annotations[1], sectionNote());
  });

  it('reports version 3 as newer', () => {
    // What a later copy of the app might write. This copy reads up to version 2.
    const later = { ...withSectionNote(), version: 3 };
    fs.writeFileSync(side, JSON.stringify(later), 'utf8');
    assert.deepEqual(readSidecar(doc), { status: 'newer', version: 3 });
  });
});

describe('writeSidecar', () => {
  it('round-trips data through the file and returns the sidecar path', () => {
    const data = sample();
    assert.equal(writeSidecar(doc, data), side);
    assert.equal(side, sidecarPath(doc));
    assert.equal(fs.readFileSync(side, 'utf8'), JSON.stringify(data, null, 2));
    assert.deepEqual(readSidecar(doc), { status: 'ok', data });
  });

  it('round-trips a version 2 file that holds a section note', () => {
    const data = withSectionNote();
    assert.equal(writeSidecar(doc, data), side);
    // On disk: marked version 2, and the section note is in it as given.
    const onDisk = JSON.parse(fs.readFileSync(side, 'utf8'));
    assert.equal(onDisk.version, 2);
    assert.deepEqual(onDisk.annotations[1], sectionNote());
    // Read back: exactly what was written, nothing added or dropped.
    assert.deepEqual(readSidecar(doc), { status: 'ok', data });
    assert.deepEqual(data, withSectionNote()); // and writing did not change what it was given
    assert.deepEqual(listing(), ['plan.md', 'plan.md.annotations.json']);
  });

  it('writes a version 1 file over a version 2 file once the section note is gone', () => {
    writeSidecar(doc, withSectionNote());
    // The same notes without the section note: the app marks that version 1 again.
    const without = { ...withSectionNote(), version: 1, annotations: [withSectionNote().annotations[0]] };
    assert.equal(writeSidecar(doc, without), side);
    assert.deepEqual(readSidecar(doc), { status: 'ok', data: without });
    // A plain replacement: the version 2 file was fine, so no backup is made.
    assert.deepEqual(listing(), ['plan.md', 'plan.md.annotations.json']);
  });

  it('refuses to save version 3 data and leaves a version 3 file alone', () => {
    const later = { ...withSectionNote(), version: 3 };
    assert.throws(() => writeSidecar(doc, later), (err) => err instanceof Error && err.message.length > 0);
    assert.deepEqual(listing(), ['plan.md']);

    // A version 3 file already beside the document is not overwritten, not
    // even by a version 2 file with a section note.
    fs.writeFileSync(side, JSON.stringify(later), 'utf8');
    const before = fs.readFileSync(side);
    assert.throws(() => writeSidecar(doc, withSectionNote()), /newer version/);
    assert.deepEqual(fs.readFileSync(side), before);
    assert.deepEqual(listing(), ['plan.md', 'plan.md.annotations.json']);
  });

  it('leaves no temp file behind and never touches the document', () => {
    writeSidecar(doc, sample());
    assert.deepEqual(listing(), ['plan.md', 'plan.md.annotations.json']);
    assert.equal(fs.readFileSync(doc, 'utf8'), '# Plan\n\nSome text.\n');
  });

  it('replaces an existing valid sidecar without making a backup', () => {
    writeSidecar(doc, sample());
    const next = valid([{ id: 'b1', kind: 'underline' }]);
    writeSidecar(doc, next);
    assert.deepEqual(readSidecar(doc), { status: 'ok', data: next });
    assert.deepEqual(listing(), ['plan.md', 'plan.md.annotations.json']);
  });

  it('clears a temp file left by an earlier crash', () => {
    fs.writeFileSync(`${side}.${process.pid}.tmp`, 'half a fi', 'utf8');
    writeSidecar(doc, sample());
    assert.deepEqual(readSidecar(doc), { status: 'ok', data: sample() });
    assert.deepEqual(listing(), ['plan.md', 'plan.md.annotations.json']);
  });

  it('refuses a document type that has no sidecar', () => {
    assert.throws(() => writeSidecar(path.join(dir, 'picture.png'), valid()), Error);
    assert.throws(() => writeSidecar('', valid()), Error);
    assert.throws(() => writeSidecar(null, valid()), Error);
    assert.deepEqual(listing(), ['plan.md']);
  });

  it('refuses invalid data and writes nothing', () => {
    const invalid = [
      undefined,
      null,
      [],
      'text',
      {},
      { format: 'something-else', version: VERSION, annotations: [] },
      { format: FORMAT, version: VERSION + 1, annotations: [] },
      { format: FORMAT, version: VERSION, annotations: 'none' },
      valid(new Array(5001).fill({ id: 'x' })),
    ];
    for (const data of invalid) {
      assert.throws(() => writeSidecar(doc, data), (err) => err instanceof Error && err.message.length > 0);
    }
    assert.deepEqual(listing(), ['plan.md']);
  });

  it('refuses invalid data without disturbing an existing sidecar', () => {
    writeSidecar(doc, sample());
    const before = fs.readFileSync(side);
    assert.throws(() => writeSidecar(doc, { nope: true }), Error);
    assert.deepEqual(fs.readFileSync(side), before);
    assert.deepEqual(listing(), ['plan.md', 'plan.md.annotations.json']);
  });

  it('refuses data that would make a file over 5 MB', () => {
    const big = valid([{ id: 'big', body: 'x'.repeat(5 * 1024 * 1024) }]);
    assert.equal(validateSidecar(big), true);
    assert.throws(() => writeSidecar(doc, big), /5 MB/);
    assert.deepEqual(listing(), ['plan.md']);
  });

  it('refuses to overwrite a file from a newer version, byte for byte', () => {
    const newer = `${JSON.stringify({ format: FORMAT, version: VERSION + 1, annotations: [], extra: 1 })}\n`;
    fs.writeFileSync(side, newer, 'utf8');
    const before = fs.readFileSync(side);
    assert.throws(() => writeSidecar(doc, sample()), /newer version/);
    assert.deepEqual(fs.readFileSync(side), before);
    assert.deepEqual(listing(), ['plan.md', 'plan.md.annotations.json']);
    assert.deepEqual(readSidecar(doc), { status: 'newer', version: VERSION + 1 });
  });

  it('backs up a corrupt file before writing the new one', () => {
    const damaged = '{ "format": "plan-printer-annotations", "annot';
    fs.writeFileSync(side, damaged, 'utf8');
    const started = Date.now();
    assert.equal(writeSidecar(doc, sample()), side);
    const finished = Date.now();

    assert.deepEqual(readSidecar(doc), { status: 'ok', data: sample() });
    const names = listing();
    assert.equal(names.length, 3);
    const backup = names.find((name) => /^plan\.md\.annotations\.json\.corrupt-\d+$/.test(name));
    assert.ok(backup, `no backup among ${names.join(', ')}`);
    assert.equal(fs.readFileSync(path.join(dir, backup), 'utf8'), damaged);
    const stamp = Number(backup.split('.corrupt-')[1]);
    assert.ok(stamp >= started && stamp <= finished);
  });

  it('backs up a wrong-shape file too', () => {
    const other = JSON.stringify({ format: 'something-else', notes: ['keep me'] });
    fs.writeFileSync(side, other, 'utf8');
    writeSidecar(doc, sample());
    const backup = listing().find((name) => name.includes('.corrupt-'));
    assert.ok(backup);
    assert.equal(fs.readFileSync(path.join(dir, backup), 'utf8'), other);
    assert.deepEqual(readSidecar(doc), { status: 'ok', data: sample() });
  });

  it('refuses when the sidecar path is a folder', () => {
    fs.mkdirSync(side);
    fs.writeFileSync(path.join(side, 'inside.txt'), 'keep', 'utf8');
    assert.throws(() => writeSidecar(doc, sample()), Error);
    assert.ok(fs.statSync(side).isDirectory());
    assert.equal(fs.readFileSync(path.join(side, 'inside.txt'), 'utf8'), 'keep');
    assert.deepEqual(listing(), ['plan.md', 'plan.md.annotations.json']);
  });

  // Creating a symlink needs extra rights on Windows.
  it('refuses when the sidecar path is a symlink', { skip: process.platform === 'win32' }, () => {
    const target = path.join(dir, 'elsewhere.json');
    const original = JSON.stringify(valid([{ id: 'target' }]));
    fs.writeFileSync(target, original, 'utf8');
    fs.symlinkSync(target, side);
    assert.throws(() => writeSidecar(doc, sample()), Error);
    assert.ok(fs.lstatSync(side).isSymbolicLink());
    assert.equal(fs.readFileSync(target, 'utf8'), original);

    // A link that points nowhere reads as "none" but is still not written through.
    fs.rmSync(target);
    assert.deepEqual(readSidecar(doc), { status: 'none' });
    assert.throws(() => writeSidecar(doc, sample()), Error);
    assert.ok(fs.lstatSync(side).isSymbolicLink());
    assert.equal(fs.existsSync(target), false);
  });

  it('removes the temp file and keeps the old sidecar when the rename fails', () => {
    writeSidecar(doc, sample());
    const before = fs.readFileSync(side);
    mock.method(fs, 'renameSync', () => { throw new Error('disk says no'); });
    assert.throws(() => writeSidecar(doc, valid([{ id: 'new' }])), /disk says no/);
    mock.restoreAll();
    assert.deepEqual(fs.readFileSync(side), before);
    assert.deepEqual(listing(), ['plan.md', 'plan.md.annotations.json']);
  });

  it('throws a readable error when the folder cannot be written to', () => {
    const gone = path.join(dir, 'missing', 'plan.md');
    assert.throws(() => writeSidecar(gone, sample()), (err) => err instanceof Error && /Could not save/.test(err.message));
    assert.deepEqual(listing(), ['plan.md']);
  });
});
