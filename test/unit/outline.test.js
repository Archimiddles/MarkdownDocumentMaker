import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_DEPTH, buildOutline, sectionOf, sectionRange,
} from '../../renderer/src/annotations/outline.js';
import { renderBlocks } from '../../renderer/src/annotations/blocks.js';
import { makeMarked, readFixture } from './helpers.js';

const marked = makeMarked();

// One heading, as the app hands it to buildOutline.
//   block  the heading's block number: its place in the document
//   depth  1 for "#", 2 for "##", 3 for "###"...
function heading(block, depth, title = `Heading ${block}`, page = 1) {
  return { block, depth, title, page };
}

// One field of every row, by title: { 'Part A': 3, A1: 2 }. A failing test
// then says which row is wrong, which a bare list of numbers does not.
function byTitle(outline, field) {
  return Object.fromEntries(outline.rows.map((row) => [row.title, row[field]]));
}
const counts = (outline) => byTitle(outline, 'count');
const indents = (outline) => byTitle(outline, 'indent');
const noted = (outline) => byTitle(outline, 'noted');
const titles = (outline) => outline.rows.map((row) => row.title);

// ---- The rows: order, titles, pages -------------------------------------------

test('no headings and no notes give an empty outline', () => {
  assert.deepEqual(buildOutline([], []), { rows: [], notes: 0, sectionNotes: 0 });
});

test('rows come back in document order, even when the headings do not', () => {
  const outline = buildOutline([
    heading(9, 2, 'Risks', 3),
    heading(0, 1, 'The plan', 1),
    heading(4, 2, 'Approach', 2),
  ], [10, 5]);
  // Sorted by block number. Each row keeps its own title and page, and the
  // notes are counted against the sorted list (block 5 is under Approach).
  assert.deepEqual(outline, {
    rows: [
      { block: 0, depth: 1, indent: 0, title: 'The plan', page: 1, count: 0, noted: false },
      { block: 4, depth: 2, indent: 0, title: 'Approach', page: 2, count: 1, noted: false },
      { block: 9, depth: 2, indent: 0, title: 'Risks', page: 3, count: 1, noted: false },
    ],
    notes: 2,
    sectionNotes: 0, // nobody has written a section note here
  });
});

test('the lists passed in are left as they were', () => {
  const headings = [heading(6, 2, '  B  '), heading(1, 1, 'A')];
  const noteBlocks = [7, 2, 2];
  const headingsBefore = structuredClone(headings);
  const outline = buildOutline(headings, noteBlocks);
  assert.deepEqual(headings, headingsBefore); // same order, same fields
  assert.deepEqual(noteBlocks, [7, 2, 2]);
  // The rows are new objects, so changing a row cannot change a heading.
  assert.notEqual(outline.rows[0], headings[1]);
});

test('whitespace in a title is collapsed to single spaces', () => {
  const outline = buildOutline([
    heading(0, 2, '  Add   rate\tlimiting \n to the API  '),
    heading(1, 2, 'Non breaking  spaces'),
    heading(2, 2, 'Already tidy'),
  ], []);
  assert.deepEqual(titles(outline), [
    'Add rate limiting to the API', 'Non breaking spaces', 'Already tidy',
  ]);
});

test('a heading with no words in it gets a placeholder title', () => {
  const outline = buildOutline([
    heading(0, 2, ''),
    heading(1, 2, ' \n\t '),
    heading(2, 2, null),
    { block: 3, depth: 2, page: 1 }, // no title at all
    heading(4, 2, '0'), // short, but a real title: it must be kept
  ], []);
  assert.deepEqual(titles(outline), [
    'Untitled section', 'Untitled section', 'Untitled section', 'Untitled section', '0',
  ]);
});

test('a page that is not a whole number becomes null', () => {
  const outline = buildOutline([
    heading(0, 2, 'a whole number', 7),
    heading(1, 2, 'text', '3'),
    heading(2, 2, 'a fraction', 2.5),
    heading(3, 2, 'not a number', NaN),
    heading(4, 2, 'null', null),
    { block: 5, depth: 2, title: 'no page at all' },
  ], []);
  assert.deepEqual(outline.rows.map((row) => row.page), [7, null, null, null, null, null]);
});

// ---- Which headings are listed ------------------------------------------------

test('"#", "##" and "###" are listed, deeper headings are left out', () => {
  assert.equal(MAX_DEPTH, 3);
  const outline = buildOutline([
    heading(0, 1, 'one'), heading(1, 2, 'two'), heading(2, 3, 'three'),
    heading(3, 4, 'four'), heading(4, 5, 'five'), heading(5, 6, 'six'),
  ], []);
  assert.deepEqual(titles(outline), ['one', 'two', 'three']);
});

test('a note under a heading that is too deep counts for the nearest listed heading above', () => {
  const outline = buildOutline([
    heading(0, 2, 'A'),
    heading(2, 4, 'too deep'), // "####": not listed
    heading(5, 3, 'A1'),
    heading(7, 5, 'deeper still'), // "#####": not listed
    heading(9, 2, 'B'),
  ], [2, 3, 3, 7, 8]);
  // Blocks 2 and 3 are under "too deep", which is inside A.
  // Blocks 7 and 8 are under "deeper still", which is inside A1 (and so A).
  assert.deepEqual(counts(outline), { A: 5, A1: 2, B: 0 });
  assert.equal(outline.notes, 5);
});

test('the maxDepth option moves the cut-off', () => {
  const headings = [
    heading(0, 2, 'A'), heading(2, 3, 'A1'), heading(4, 4, 'A1a'), heading(6, 2, 'B'),
  ];
  const noteBlocks = [1, 3, 5, 7]; // one note under each heading

  // Only "#" and "##": the notes under A1 and A1a move up to A.
  const shallow = buildOutline(headings, noteBlocks, { maxDepth: 2 });
  assert.deepEqual(counts(shallow), { A: 3, B: 1 });

  // The default cut-off: A1a is too deep, so its note counts for A1.
  for (const options of [undefined, {}, { maxDepth: undefined }, { maxDepth: MAX_DEPTH }]) {
    const usual = buildOutline(headings, noteBlocks, options);
    assert.deepEqual(counts(usual), { A: 3, A1: 2, B: 1 });
  }

  // Down to "####": A1a gets a row of its own, two steps in.
  const deep = buildOutline(headings, noteBlocks, { maxDepth: 4 });
  assert.deepEqual(counts(deep), { A: 3, A1: 2, A1a: 1, B: 1 });
  assert.deepEqual(indents(deep), { A: 0, A1: 1, A1a: 2, B: 0 });

  // Only "#", and this document has none: nothing is listed, but the notes
  // are still there.
  assert.deepEqual(buildOutline(headings, noteBlocks, { maxDepth: 1 }),
    { rows: [], notes: 4, sectionNotes: 0 });
});

// ---- Counting notes -----------------------------------------------------------

test('a note in the same block as a heading belongs to that heading', () => {
  const outline = buildOutline([heading(2, 2, 'A'), heading(5, 2, 'B')], [2, 5, 5]);
  assert.deepEqual(counts(outline), { A: 1, B: 2 });
});

test('a note anywhere before the next listed heading belongs to the section above it', () => {
  const headings = [heading(2, 2, 'A'), heading(10, 2, 'B')];
  // Blocks 3 to 9 are all still inside A. Block 10 is where B starts.
  assert.deepEqual(counts(buildOutline(headings, [3, 6, 9])), { A: 3, B: 0 });
  assert.deepEqual(counts(buildOutline(headings, [9, 10, 11, 400])), { A: 1, B: 3 });
});

test('a note before the first heading is on no row but is still in the total', () => {
  const outline = buildOutline([heading(3, 2, 'A'), heading(6, 2, 'B')], [0, 2, 4]);
  assert.deepEqual(counts(outline), { A: 1, B: 0 }); // only block 4 is in a section
  assert.equal(outline.notes, 3);
});

test('every note is counted: several in one block, in any order', () => {
  const outline = buildOutline([heading(0, 2, 'A'), heading(4, 2, 'B')], [5, 1, 5, 1, 5]);
  assert.deepEqual(counts(outline), { A: 2, B: 3 });
  assert.equal(outline.notes, 5);
});

test('a single "#" at the very top is the title: it counts only its own notes', () => {
  const outline = buildOutline([
    heading(0, 1, 'Title'),
    heading(2, 2, 'A'),
    heading(4, 3, 'A1'),
    heading(6, 2, 'B'),
    heading(8, 3, 'B1'),
  ], [0, 1, 3, 5, 5, 7, 9]);
  // Notes directly in each section: Title 2 (blocks 0 and 1), A 1, A1 2,
  // B 1, B1 1.
  assert.deepEqual(counts(outline), {
    Title: 2, // not 7: a title is not a chapter with everything inside it
    A: 3, // its own 1 + the 2 in A1
    A1: 2,
    B: 2, // its own 1 + the 1 in B1
    B1: 1,
  });
  assert.equal(outline.notes, 7); // the grand total is here instead
});

test('two or more "#" headings are chapters: each adds up everything under it', () => {
  const outline = buildOutline([
    heading(0, 1, 'One'),
    heading(2, 2, 'A'),
    heading(4, 3, 'A1'),
    heading(6, 1, 'Two'),
    heading(8, 2, 'B'),
    heading(10, 3, 'B1'),
  ], [1, 3, 5, 5, 7, 9, 11, 11, 11]);
  // Notes directly in each section: One 1, A 1, A1 2, Two 1, B 1, B1 3.
  assert.deepEqual(counts(outline), {
    One: 4, // 1 + A's 1 + A1's 2: every level below is included
    A: 3,
    A1: 2,
    Two: 5, // 1 + B's 1 + B1's 3
    B: 4,
    B1: 3,
  });
  assert.equal(outline.notes, 9);
});

test('a later section does not leak into an earlier one', () => {
  const outline = buildOutline([
    heading(0, 1, 'One'), heading(1, 2, 'A'), heading(2, 3, 'A1'),
    heading(3, 1, 'Two'), heading(4, 2, 'B'), heading(5, 3, 'B1'),
  ], [5, 5]);
  // Both notes are in B1, the very last section.
  assert.deepEqual(counts(outline), { One: 0, A: 0, A1: 0, Two: 2, B: 2, B1: 2 });
});

test('sibling "##" sections each add up only their own "###" sections', () => {
  const outline = buildOutline([
    heading(0, 2, 'A'), heading(1, 3, 'A1'), heading(2, 3, 'A2'),
    heading(3, 2, 'B'), heading(4, 3, 'B1'),
    heading(5, 2, 'C'),
  ], [1, 2, 2, 4, 4, 4, 5]);
  // A1 and A2 are neighbours too: A1 does not include A2.
  assert.deepEqual(counts(outline), { A: 3, A1: 1, A2: 2, B: 3, B1: 3, C: 1 });
});

test('a "###" straight under a chapter, with no "##" between, still adds up into it', () => {
  const outline = buildOutline([
    heading(0, 1, 'One'), heading(1, 3, 'deep in One'),
    heading(2, 1, 'Two'), heading(3, 3, 'deep in Two'),
  ], [1, 3, 3]);
  assert.deepEqual(counts(outline), { One: 1, 'deep in One': 1, Two: 2, 'deep in Two': 2 });
});

test('a shallower heading is never inside the deeper one before it', () => {
  // A document that starts deep and climbs out: "###", then "##", then "#".
  const outline = buildOutline([
    heading(0, 3, 'deep'), heading(1, 2, 'middle'), heading(2, 1, 'top'),
  ], [1, 2]);
  assert.deepEqual(counts(outline), { deep: 0, middle: 1, top: 1 });
});

test('a single "#" that is not at the very top is an ordinary chapter', () => {
  const outline = buildOutline([
    heading(0, 2, 'Foreword'), heading(2, 1, 'Main'), heading(4, 2, 'A'),
  ], [1, 3, 5]);
  // Main comes after the Foreword, so it holds A but not the Foreword.
  assert.deepEqual(counts(outline), { Foreword: 1, Main: 2, A: 1 });
});

test('a document with only one heading: every note from it onwards is on its row', () => {
  for (const depth of [1, 2, 3]) {
    const outline = buildOutline([heading(2, depth, 'Only')], [0, 2, 5]);
    assert.deepEqual(counts(outline), { Only: 2 }, `depth ${depth}`); // block 0 is above it
    assert.equal(outline.notes, 3);
  }
});

// The rule is "a row adds up itself and every row drawn indented beneath
// it". A "###" that comes straight after the title, before the first "##", is
// drawn one step in from the title, so its note counts on the title too. The
// main sections ("## A") are level with the title and do not.
test('a title adds up a deeper heading drawn beneath it, but not the main sections', () => {
  const outline = buildOutline([
    heading(0, 1, 'Title'),
    heading(1, 3, 'Preface'), // a "###" before the first "##"
    heading(3, 2, 'A'),
    heading(5, 3, 'A1'),
  ], [2, 6]);
  assert.deepEqual(indents(outline), { Title: 0, Preface: 1, A: 0, A1: 1 });
  assert.deepEqual(counts(outline), { Title: 1, Preface: 1, A: 1, A1: 1 });
});

test('a missing or empty options argument uses the usual cut-off', () => {
  const headings = [heading(0, 2, 'A'), heading(1, 3, 'A1'), heading(2, 4, 'Too deep')];
  for (const options of [null, undefined, {}, { maxDepth: null }]) {
    assert.deepEqual(titles(buildOutline(headings, [], options)), ['A', 'A1']);
  }
});

// ---- Section notes: which rows have one ------------------------------------------

// A section note is the reviewer's own note on a whole section. The app
// passes the block numbers of the headings that have one in
// options.sectionNotes. Each row then says so in `noted`, and the result
// counts those rows in `sectionNotes`.

// A title, two main sections and a subsection in each: used by several tests.
const PLAN = [
  heading(0, 1, 'Title'),
  heading(2, 2, 'A'),
  heading(4, 3, 'A1'),
  heading(6, 2, 'B'),
  heading(8, 3, 'B1'),
];

test('a row is "noted" exactly when its heading has a section note', () => {
  const sectionNotes = [6, 2]; // B and A, in the order the notes were written
  const outline = buildOutline(PLAN, [], { sectionNotes });
  assert.deepEqual(noted(outline), { Title: false, A: true, A1: false, B: true, B1: false });
  assert.equal(outline.sectionNotes, 2);
  // Always true or false, never left out: the list draws its marker from it.
  for (const row of outline.rows) assert.equal(typeof row.noted, 'boolean', row.title);
  assert.deepEqual(sectionNotes, [6, 2]); // the list passed in is left as it was
});

test('any heading that is listed can have a section note: title, section or subsection', () => {
  for (const row of buildOutline(PLAN, []).rows) {
    const outline = buildOutline(PLAN, [], { sectionNotes: [row.block] });
    const expected = { Title: false, A: false, A1: false, B: false, B1: false };
    expected[row.title] = true; // this row and no other
    assert.deepEqual(noted(outline), expected, row.title);
    assert.equal(outline.sectionNotes, 1, row.title);
  }
  // All of them at once.
  const all = buildOutline(PLAN, [], { sectionNotes: [0, 2, 4, 6, 8] });
  assert.deepEqual(noted(all), { Title: true, A: true, A1: true, B: true, B1: true });
  assert.equal(all.sectionNotes, 5);
});

test('with no section notes, no row is noted', () => {
  const none = [
    undefined, null, {}, { maxDepth: 3 },
    { sectionNotes: undefined }, { sectionNotes: null }, { sectionNotes: [] },
    // Not a list: treated as an empty list, like the other two arguments.
    { sectionNotes: 2 }, { sectionNotes: '2' }, { sectionNotes: new Set([2]) },
  ];
  for (const options of none) {
    const outline = buildOutline(PLAN, [3, 5], options);
    assert.deepEqual(noted(outline),
      { Title: false, A: false, A1: false, B: false, B1: false }, JSON.stringify(options));
    assert.equal(outline.sectionNotes, 0, JSON.stringify(options));
  }
});

test('a section note on a block that is not a listed heading is ignored', () => {
  const headings = [
    heading(0, 2, 'A'),
    heading(2, 4, 'too deep'), // "####": a heading, but not in the list
    heading(5, 2, 'B'),
  ];
  // 1 is a paragraph, 2 is the "####", 99 is past the end of the document,
  // and the rest are not block numbers at all.
  const stray = [1, 2, 99, -1, 0.5, '5', null, undefined];
  const outline = buildOutline(headings, [], { sectionNotes: stray });
  assert.deepEqual(noted(outline), { A: false, B: false });
  assert.equal(outline.sectionNotes, 0);

  // Mixed with a real one, only the real one counts.
  const mixed = buildOutline(headings, [], { sectionNotes: [...stray, 5] });
  assert.deepEqual(noted(mixed), { A: false, B: true });
  assert.equal(mixed.sectionNotes, 1);

  // List one level more and the "####" has a row, so its note shows on it.
  const deeper = buildOutline(headings, [], { maxDepth: 4, sectionNotes: [2] });
  assert.deepEqual(noted(deeper), { A: false, 'too deep': true, B: false });
  assert.equal(deeper.sectionNotes, 1);
});

test('sectionNotes counts rows: a heading named twice is still one row', () => {
  const outline = buildOutline(PLAN, [], { sectionNotes: [6, 6, 2, 6] });
  assert.deepEqual(noted(outline), { Title: false, A: true, A1: false, B: true, B1: false });
  assert.equal(outline.sectionNotes, 2);
});

test('section notes are not counted as notes: count and notes stay the same', () => {
  const noteBlocks = [0, 1, 3, 5, 5, 7, 9];
  const plain = buildOutline(PLAN, noteBlocks);
  const summed = buildOutline(PLAN, noteBlocks, { sectionNotes: [0, 2, 8] });

  // The counts are the ones from the title test further up, with or without.
  assert.deepEqual(counts(plain), { Title: 2, A: 3, A1: 2, B: 2, B1: 1 });
  assert.deepEqual(counts(summed), counts(plain));
  assert.equal(summed.notes, 7);
  assert.equal(plain.notes, 7);
  assert.equal(summed.sectionNotes, 3);
  // In fact nothing about a row changes except `noted`.
  assert.deepEqual(summed.rows.map((row) => ({ ...row, noted: false })), plain.rows);

  // A document whose only notes are section notes has no notes to count.
  const only = buildOutline(PLAN, [], { sectionNotes: [2, 6] });
  assert.deepEqual(counts(only), { Title: 0, A: 0, A1: 0, B: 0, B1: 0 });
  assert.equal(only.notes, 0);
  assert.equal(only.sectionNotes, 2);
});

// ---- Indent: how far in from the left edge a row sits --------------------------

test('a single "#" at the very top sits at the edge together with "##"', () => {
  const outline = buildOutline([
    heading(0, 1, 'Title'), heading(1, 2, 'A'), heading(2, 3, 'A1'), heading(3, 2, 'B'),
  ], []);
  // So "###" is one step in, not two.
  assert.deepEqual(indents(outline), { Title: 0, A: 0, A1: 1, B: 0 });
});

test('two or more "#" headings push "##" one step in', () => {
  const outline = buildOutline([
    heading(0, 1, 'One'), heading(1, 2, 'A'), heading(2, 3, 'A1'),
    heading(3, 1, 'Two'), heading(4, 2, 'B'),
  ], []);
  assert.deepEqual(indents(outline), { One: 0, A: 1, A1: 2, Two: 0, B: 1 });
});

test('a single "#" that is not at the very top is not a title', () => {
  const outline = buildOutline([
    heading(0, 2, 'Foreword'), heading(1, 1, 'Main'), heading(2, 2, 'A'),
  ], []);
  assert.deepEqual(indents(outline), { Foreword: 1, Main: 0, A: 1 });
});

test('a document that starts at "##" has "##" at the edge', () => {
  const outline = buildOutline([
    heading(0, 2, 'A'), heading(1, 3, 'A1'), heading(2, 2, 'B'), heading(3, 3, 'B1'),
  ], []);
  assert.deepEqual(indents(outline), { A: 0, A1: 1, B: 0, B1: 1 });
});

test('a document with only one heading has it at the edge', () => {
  for (const depth of [1, 2, 3]) {
    const outline = buildOutline([heading(0, depth, 'Only')], []);
    assert.deepEqual(indents(outline), { Only: 0 }, `depth ${depth}`);
  }
});

test('skipped levels: a title followed only by "###" has them all at the edge', () => {
  const outline = buildOutline([
    heading(0, 1, 'Title'), heading(1, 3, 'a'), heading(2, 3, 'b'),
  ], [0, 1, 2, 2]);
  assert.deepEqual(indents(outline), { Title: 0, a: 0, b: 0 });
  // Neighbours, so nothing is added up into the title.
  assert.deepEqual(counts(outline), { Title: 1, a: 1, b: 2 });
});

test('skipped levels: the edge is the shallowest level below the title', () => {
  const outline = buildOutline([
    heading(0, 1, 'Title'), heading(1, 3, 'early'), heading(2, 2, 'A'), heading(3, 3, 'A1'),
  ], []);
  assert.deepEqual(indents(outline), { Title: 0, early: 1, A: 0, A1: 1 });
});

test('skipped levels: under chapters a "###" is two steps in, the gap is kept', () => {
  const outline = buildOutline([
    heading(0, 1, 'One'), heading(1, 3, 'a'), heading(2, 1, 'Two'), heading(3, 3, 'b'),
  ], []);
  // The indent is the heading's depth counted from the edge depth. Levels
  // that no heading uses are not squeezed out.
  assert.deepEqual(indents(outline), { One: 0, a: 2, Two: 0, b: 2 });
});

test('the indent only looks at the headings that are listed', () => {
  // The "####" lines are not listed, so the "#" is the first row: a title.
  const outline = buildOutline([
    heading(0, 4, 'too deep'), heading(1, 1, 'Title'), heading(2, 2, 'A'), heading(3, 4, 'A1a'),
  ], []);
  assert.deepEqual(indents(outline), { Title: 0, A: 0 });
  // With a cut-off of 1 only the two "#" are left, both at the edge.
  const chapters = buildOutline([
    heading(0, 1, 'One'), heading(1, 2, 'A'), heading(2, 1, 'Two'),
  ], [], { maxDepth: 1 });
  assert.deepEqual(indents(chapters), { One: 0, Two: 0 });
});

// ---- sectionOf ----------------------------------------------------------------

// sectionOf only reads each row's block number. These rows start at blocks
// 2, 5 and 9, so they are rows 0, 1 and 2.
const ROWS = [{ block: 2 }, { block: 5 }, { block: 9 }];

test('sectionOf: a block before the first row is in no section', () => {
  assert.equal(sectionOf(ROWS, 0), -1);
  assert.equal(sectionOf(ROWS, 1), -1);
});

test('sectionOf: a heading\'s own block is in its own section', () => {
  assert.equal(sectionOf(ROWS, 2), 0);
  assert.equal(sectionOf(ROWS, 5), 1);
  assert.equal(sectionOf(ROWS, 9), 2);
});

test('sectionOf: a block between two rows belongs to the earlier one', () => {
  assert.equal(sectionOf(ROWS, 3), 0);
  assert.equal(sectionOf(ROWS, 4), 0);
  assert.equal(sectionOf(ROWS, 6), 1);
  assert.equal(sectionOf(ROWS, 8), 1);
});

test('sectionOf: a block after the last row belongs to the last row', () => {
  assert.equal(sectionOf(ROWS, 10), 2);
  assert.equal(sectionOf(ROWS, 5000), 2);
});

test('sectionOf: with no rows there is no section', () => {
  assert.equal(sectionOf([], 0), -1);
  assert.equal(sectionOf([], 7), -1);
});

test('sectionOf: gives the same answer as checking every row in turn', () => {
  // sectionOf halves the list each step. Try every length from 0 to 9 rows so
  // the halving meets odd and even lengths, and every block around the rows.
  for (let length = 0; length <= 9; length++) {
    const rows = Array.from({ length }, (_, i) => ({ block: 3 + i * 4 })); // 3, 7, 11...
    for (let block = 0; block <= 3 + length * 4 + 2; block++) {
      let expected = -1;
      rows.forEach((row, i) => { if (row.block <= block) expected = i; });
      assert.equal(sectionOf(rows, block), expected, `${length} rows, block ${block}`);
    }
  }
});

// ---- sectionRange -------------------------------------------------------------

// sectionRange says which blocks make up a row's section, subsections
// included: { from, to } means blocks from, from + 1, ... up to to - 1.

// The range of the row with this title.
function rangeOf(outline, title) {
  const i = outline.rows.findIndex((row) => row.title === title);
  assert.notEqual(i, -1, `no row called "${title}"`);
  return sectionRange(outline.rows, i);
}

// How many of the notes start inside a range.
const notesIn = (noteBlocks, range) => noteBlocks
  .filter((block) => block >= range.from && block < range.to).length;

test('sectionRange: a section with no subsections ends where the next row starts', () => {
  const outline = buildOutline([
    heading(0, 2, 'A'),
    heading(3, 2, 'B'), heading(7, 3, 'B1'), heading(9, 3, 'B2'),
    heading(12, 2, 'C'),
  ], []);
  assert.deepEqual(rangeOf(outline, 'A'), { from: 0, to: 3 }); // blocks 0, 1 and 2
  assert.deepEqual(rangeOf(outline, 'B1'), { from: 7, to: 9 }); // stops at its neighbour B2
  assert.deepEqual(rangeOf(outline, 'B2'), { from: 9, to: 12 }); // stops at C, which is shallower
});

test('sectionRange: a section with subsections runs to the next row at its own indent or shallower', () => {
  const outline = buildOutline([
    heading(0, 1, 'One'),
    heading(2, 2, 'A'), heading(4, 3, 'A1'), heading(6, 3, 'A2'),
    heading(8, 2, 'B'),
    heading(10, 1, 'Two'),
    heading(12, 2, 'C'),
  ], []);
  assert.deepEqual(indents(outline), { One: 0, A: 1, A1: 2, A2: 2, B: 1, Two: 0, C: 1 });
  // A holds A1 and A2 and stops at B, the next row at A's own indent.
  assert.deepEqual(rangeOf(outline, 'A'), { from: 2, to: 8 });
  // One holds A, A1, A2 and B: every row up to the next chapter.
  assert.deepEqual(rangeOf(outline, 'One'), { from: 0, to: 10 });
  // B has no subsections and stops at Two, which is shallower.
  assert.deepEqual(rangeOf(outline, 'B'), { from: 8, to: 10 });
  // A subsection never reaches into the one after it.
  assert.deepEqual(rangeOf(outline, 'A1'), { from: 4, to: 6 });
});

test('sectionRange: the last section runs to the end of the document', () => {
  const outline = buildOutline([
    heading(0, 1, 'One'), heading(2, 2, 'A'),
    heading(4, 1, 'Two'), heading(6, 2, 'B'), heading(8, 3, 'B1'),
  ], []);
  // Nothing at their indent or shallower comes after these three, so there
  // is no block where they stop: `to` is Infinity.
  assert.deepEqual(rangeOf(outline, 'Two'), { from: 4, to: Infinity });
  assert.deepEqual(rangeOf(outline, 'B'), { from: 6, to: Infinity });
  assert.deepEqual(rangeOf(outline, 'B1'), { from: 8, to: Infinity });
  // The ones before them do stop.
  assert.deepEqual(rangeOf(outline, 'One'), { from: 0, to: 4 });
  assert.deepEqual(rangeOf(outline, 'A'), { from: 2, to: 4 });

  // A document with a single heading: everything from it onwards.
  const single = buildOutline([heading(2, 2, 'Only')], []);
  assert.deepEqual(rangeOf(single, 'Only'), { from: 2, to: Infinity });
});

test('sectionRange: the document title ends at the first main section', () => {
  // A single "#" at the very top is the title. The main sections are its
  // neighbours, not its subsections, so its range does not take in the whole
  // document (just as its count does not add up the whole document).
  const outline = buildOutline(PLAN, []);
  assert.deepEqual(rangeOf(outline, 'Title'), { from: 0, to: 2 });
  assert.deepEqual(rangeOf(outline, 'A'), { from: 2, to: 6 });
  assert.deepEqual(rangeOf(outline, 'B'), { from: 6, to: Infinity });

  // A deeper heading straight under the title is drawn beneath it, so it IS
  // inside the title's range. The first main section still ends it.
  const preface = buildOutline([
    heading(0, 1, 'Title'), heading(1, 3, 'Preface'), heading(3, 2, 'A'), heading(5, 3, 'A1'),
  ], []);
  assert.deepEqual(rangeOf(preface, 'Title'), { from: 0, to: 3 });
  assert.deepEqual(rangeOf(preface, 'Preface'), { from: 1, to: 3 });

  // Two "#" headings are chapters, not a title: the first one holds its sections.
  const chapters = buildOutline([
    heading(0, 1, 'One'), heading(2, 2, 'A'), heading(4, 1, 'Two'),
  ], []);
  assert.deepEqual(rangeOf(chapters, 'One'), { from: 0, to: 4 });
});

test('sectionRange: there is no range for a row that does not exist', () => {
  const { rows } = buildOutline([heading(0, 2, 'A'), heading(3, 2, 'B')], []);
  assert.deepEqual(sectionRange(rows, 1), { from: 3, to: Infinity }); // the last real row
  assert.equal(sectionRange(rows, 2), null); // one past the end
  assert.equal(sectionRange(rows, 99), null);
  // -1 is what findIndex gives when the section that was open has gone.
  assert.equal(sectionRange(rows, -1), null);
  assert.equal(sectionRange(rows, 0.5), null);
  assert.equal(sectionRange(rows, undefined), null);
  // No rows at all, or something that is not a list of rows.
  assert.equal(sectionRange([], 0), null);
  assert.equal(sectionRange(null, 0), null);
  assert.equal(sectionRange(undefined, 0), null);
});

test('sectionRange: the rows are only read, not changed', () => {
  const { rows } = buildOutline(PLAN, [1, 3], { sectionNotes: [2] });
  const before = structuredClone(rows);
  rows.forEach((_, i) => sectionRange(rows, i));
  assert.deepEqual(rows, before);
});

test('sectionRange: the notes inside a row\'s range are exactly the notes its count adds up', () => {
  // A mixed document: a title with a "###" straight under it, main sections
  // with and without subsections, a "####" that is not listed, notes above
  // the first heading, on headings, between them and far past the last one.
  const headings = [
    heading(1, 1, 'Title'),
    heading(2, 3, 'Preface'),
    heading(4, 2, 'A'),
    heading(6, 3, 'A1'),
    heading(8, 4, 'too deep'),
    heading(10, 3, 'A2'),
    heading(12, 2, 'B'),
    heading(14, 2, 'C'),
    heading(16, 3, 'C1'),
  ];
  const noteBlocks = [0, 1, 1, 3, 4, 5, 7, 8, 9, 9, 11, 12, 13, 13, 15, 16, 17, 40];
  const outline = buildOutline(headings, noteBlocks, { sectionNotes: [4, 16] });

  // First make sure the counts are what the document says, so the loop
  // below is not just comparing one wrong number with another.
  assert.deepEqual(counts(outline), {
    Title: 3, // blocks 1, 1 and the 3 under Preface
    Preface: 1,
    A: 7, // 4 and 5, then 7, 8, 9, 9 in A1 and 11 in A2
    A1: 4,
    A2: 1,
    B: 3,
    C: 4, // 15, then 16, 17 and 40 in C1
    C1: 3,
  });
  outline.rows.forEach((row, i) => {
    assert.equal(notesIn(noteBlocks, sectionRange(outline.rows, i)), row.count, row.title);
  });
  // The note in block 0 is above the first heading: it is in nobody's range.
  outline.rows.forEach((row, i) => {
    assert.ok(sectionRange(outline.rows, i).from > 0, row.title);
  });
});

test('sectionRange: agrees with count for every arrangement of up to five headings', () => {
  // Every way of giving one to five headings a depth from 1 to 4: 4 + 16 +
  // 64 + 256 + 1024 = 1364 documents. ("####" is not listed, so these also
  // cover headings that have no row.) Heading i sits at block 2i + 1 and
  // every block holds one note, so each section has a note on its heading
  // and one on the paragraph after it, and block 0 is above the first heading.
  let documents = 0;
  for (let length = 1; length <= 5; length++) {
    for (let n = 0; n < 4 ** length; n++) {
      // Read n as `length` digits in base 4: each digit picks one depth.
      const depths = Array.from({ length }, (_, i) => 1 + (Math.floor(n / 4 ** i) % 4));
      const headings = depths.map((depth, i) => heading(2 * i + 1, depth));
      const noteBlocks = Array.from({ length: 2 * length + 1 }, (_, block) => block);
      const { rows } = buildOutline(headings, noteBlocks);
      rows.forEach((row, i) => {
        assert.equal(notesIn(noteBlocks, sectionRange(rows, i)), row.count,
          `depths ${depths.join(' ')}, row ${i}`);
      });
      documents += 1;
    }
  }
  assert.equal(documents, 1364);
});

// ---- Junk input ---------------------------------------------------------------

test('missing lists give an empty outline instead of an error', () => {
  const empty = { rows: [], notes: 0, sectionNotes: 0 };
  assert.deepEqual(buildOutline(), empty);
  assert.deepEqual(buildOutline(null, null), empty);
  assert.deepEqual(buildOutline(undefined, undefined), empty);
  assert.deepEqual(buildOutline(undefined, undefined, undefined), empty);
  assert.deepEqual(buildOutline(null, null, {}), empty);
});

test('one missing list does not spoil the other', () => {
  // Notes but no headings: nothing to list, and the total still has them.
  assert.deepEqual(buildOutline(null, [0, 3]), { rows: [], notes: 2, sectionNotes: 0 });
  // Headings but no notes.
  const outline = buildOutline([heading(0, 2, 'A'), heading(1, 3, 'A1')], undefined);
  assert.deepEqual(counts(outline), { A: 0, A1: 0 });
  assert.equal(outline.notes, 0);
});

test('something that is not a list is treated as an empty list', () => {
  for (const junk of ['## A', 42, true, { length: 2 }, new Set([1])]) {
    assert.deepEqual(buildOutline(junk, junk), { rows: [], notes: 0, sectionNotes: 0 });
  }
});

test('headings that cannot be used are skipped', () => {
  const junk = [
    null, undefined, 'text', 42, [], {},
    { depth: 2, title: 'no block' },
    { block: 1, title: 'no depth' },
    { block: 1.5, depth: 2, title: 'block is a fraction' },
    { block: '1', depth: 2, title: 'block is text' },
    { block: NaN, depth: 2, title: 'block is not a number' },
    { block: 1, depth: 0, title: 'depth 0' },
    { block: 1, depth: -1, title: 'depth below 0' },
    { block: 1, depth: 2.5, title: 'depth is a fraction' },
    { block: 1, depth: '2', title: 'depth is text' },
    { block: 1, depth: null, title: 'depth is null' },
  ];
  const good = [heading(0, 2, 'A'), heading(2, 3, 'A1'), heading(4, 2, 'B')];
  const noteBlocks = [1, 3, 5];
  const outline = buildOutline([...junk, good[0], ...junk, good[1], good[2], ...junk], noteBlocks);
  // Exactly what the good headings give on their own: the junk adds no rows
  // and changes no count or indent.
  assert.deepEqual(outline, buildOutline(good, noteBlocks));
  assert.deepEqual(counts(outline), { A: 2, A1: 1, B: 1 });
});

test('a heading missing only its title or its page is still listed', () => {
  const outline = buildOutline([{ block: 0, depth: 2 }], [0]);
  assert.deepEqual(outline.rows, [
    {
      block: 0, depth: 2, indent: 0, title: 'Untitled section', page: null, count: 1, noted: false,
    },
  ]);
});

test('note blocks that are not whole numbers are ignored', () => {
  const headings = [heading(0, 2, 'A'), heading(4, 2, 'B')];
  const junk = [1.5, '5', null, undefined, NaN, Infinity, -Infinity, true, {}, [5]];
  const outline = buildOutline(headings, [1, ...junk, 5, 5]);
  assert.deepEqual(counts(outline), { A: 1, B: 2 });
  assert.equal(outline.notes, 3); // the junk is not part of the total either
});

// ---- Real documents -----------------------------------------------------------

// The headings of a Markdown document, found the way the app finds them:
// every block of type "heading". depth = how many "#" its line starts with,
// title = the rest of that line. (No page: there are no pages in these tests.)
function headingsOf(source) {
  const found = [];
  source.blocks.forEach((b, block) => {
    if (b.type !== 'heading') return;
    const line = source.src.slice(b.start, b.end).split('\n')[0];
    const depth = /^#*/.exec(line)[0].length;
    found.push({ block, depth, title: line.slice(depth) });
  });
  return found;
}

// The number of the first block whose Markdown contains `text`.
function blockOf(source, text) {
  const n = source.blocks.findIndex((b) => source.src.slice(b.start, b.end).includes(text));
  assert.notEqual(n, -1, `no block contains "${text}"`);
  return n;
}

// "## Context": a row written back the way its heading looks in Markdown.
const asMarkdown = (row) => `${'#'.repeat(row.depth)} ${row.title}`;

test('sample-plan.md: the real headings in order, each with its notes', () => {
  const source = renderBlocks(marked, readFixture('samples/sample-plan.md'));
  const noteBlocks = [
    blockOf(source, '# Add rate limiting'), // on the title itself
    blockOf(source, 'have no per-client limits'), // the first paragraph of Context
    blockOf(source, 'class TokenBucket:'), // the code under "1. Token bucket"
    blockOf(source, '### 2. Middleware'), // on a heading
    blockOf(source, 'Clock skew'), // the list under Risks
  ];
  const outline = buildOutline(headingsOf(source), noteBlocks);

  assert.deepEqual(outline.rows.map(asMarkdown), [
    '# Add rate limiting to the public API',
    '## Context',
    '## Approach',
    '## Files to touch (in order)',
    '## Implementation',
    '### 1. Token bucket',
    '### 2. Middleware',
    '### 3. Atomic update with Lua',
    '### 4. Response headers',
    '## Verification',
    '## Risks',
    '## Open questions',
  ]);
  // One "#" at the top: it is the title, so "##" is at the edge with it.
  for (const row of outline.rows) {
    assert.equal(row.indent, row.depth === 3 ? 1 : 0, row.title);
    assert.equal(row.page, null, row.title);
  }
  assert.deepEqual(counts(outline), {
    'Add rate limiting to the public API': 1, // the title: only its own note
    Context: 1,
    Approach: 0,
    'Files to touch (in order)': 0,
    Implementation: 2, // nothing of its own, 1 + 1 from its "###" sections
    '1. Token bucket': 1,
    '2. Middleware': 1,
    '3. Atomic update with Lua': 0,
    '4. Response headers': 0,
    Verification: 0,
    Risks: 1,
    'Open questions': 0,
  });
  assert.equal(outline.notes, 5);
});

test('edge-cases.md: the "####" heading is left out and its note goes to "Heading 3"', () => {
  const source = renderBlocks(marked, readFixture('test/fixtures/edge-cases.md'));
  const headings = headingsOf(source);
  const noteBlocks = [blockOf(source, 'Text under heading 4.')];
  const outline = buildOutline(headings, noteBlocks);

  assert.deepEqual(outline.rows.map(asMarkdown), [
    '# Edge cases: long code, wide tables, deep lists',
    '## A code block taller than one page',
    '## A wide table',
    '## Deeply nested lists and tasks',
    '## Headings right before a page break',
    '### Heading 3',
  ]);
  assert.deepEqual(counts(outline), {
    'Edge cases: long code, wide tables, deep lists': 0,
    'A code block taller than one page': 0,
    'A wide table': 0,
    'Deeply nested lists and tasks': 0,
    'Headings right before a page break': 1,
    'Heading 3': 1,
  });

  // Ask for one level more and "Heading 4" gets its own row and the note.
  const deeper = buildOutline(headings, noteBlocks, { maxDepth: 4 });
  assert.deepEqual(deeper.rows.slice(-2).map(asMarkdown), ['### Heading 3', '#### Heading 4']);
  assert.equal(deeper.rows.at(-1).count, 1);
  assert.equal(deeper.rows.at(-1).indent, 2);
});

test('a "##" line inside a fenced code block is not listed', () => {
  const md = [
    '# Writing Markdown',
    '',
    '## Headings',
    '',
    'A heading is a line that starts with "#":',
    '',
    '```markdown',
    '## This line is code, not a heading',
    '```',
    '',
    '```bash',
    '# a shell comment, not a second title',
    'npm run test:unit',
    '```',
    '',
    '## Lists',
    '',
    'Text.',
    '',
  ].join('\n');
  const source = renderBlocks(marked, md);
  const inMarkdownFence = blockOf(source, 'This line is code');
  const inBashFence = blockOf(source, 'a shell comment');
  assert.equal(source.blocks[inMarkdownFence].type, 'code');
  assert.equal(source.blocks[inBashFence].type, 'code');

  const outline = buildOutline(headingsOf(source), [inMarkdownFence, inBashFence]);
  assert.deepEqual(outline.rows.map(asMarkdown), [
    '# Writing Markdown', '## Headings', '## Lists',
  ]);
  // Still only one "#", so it is still the title and "##" stays at the edge.
  assert.deepEqual(indents(outline), { 'Writing Markdown': 0, Headings: 0, Lists: 0 });
  // Notes on the two code blocks count for the section the blocks are in.
  assert.deepEqual(counts(outline), { 'Writing Markdown': 0, Headings: 2, Lists: 0 });
});
