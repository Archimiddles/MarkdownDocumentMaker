// The contents list: which headings a document has, and how many notes sit
// under each one. Pure logic: no page (DOM) is needed, so this file also runs
// in plain Node for the tests.

// "#", "##" and "###" are listed. Deeper headings are left out, and a note
// under one of them counts for the nearest listed heading above it.
export const MAX_DEPTH = 3;

const NO_TITLE = 'Untitled section';

// headings    every heading on the pages:
//             [{ block, depth, title, page }]
//             block = the heading's block number, depth = 1 for "#", 2 for "##"...
// noteBlocks  the block each note starts in, one entry per note
//
// options     { maxDepth, sectionNotes }
//             sectionNotes = the heading blocks that have a section note
//             (your own summing-up of that section)
//
// Returns { rows, notes, sectionNotes }:
//   rows   one per listed heading, in document order:
//          { block, depth, indent, title, page, count, noted }
//          indent  how many steps in from the left edge the row sits
//          count   notes in this section INCLUDING its subsections, so a
//                  "Part A" row adds up everything in A1, A2, ...
//          noted   true when this heading has a section note
//   notes  how many notes there are in all (one above the first heading has
//          no row to be counted on, but is part of this total)
//   sectionNotes  how many of the rows have a section note
//
// Section notes are not counted in `count` or `notes`: those are the notes
// made on the text, which a section note sums up.
//
// The rule for count is: a row adds up itself and every row drawn indented
// beneath it.
//
// One special case, for both indent and count: a single heading at the very
// top that is shallower than all the others (usually the one "#") is the
// document's title (see leftEdgeDepth below). The main sections are drawn
// level with it, not indented beneath it, so the title's row does not add up
// the whole document; that grand total is `notes`.
export function buildOutline(headings, noteBlocks, options) {
  // A missing or empty option falls back to the usual cut-off.
  const maxDepth = (options && options.maxDepth) ?? MAX_DEPTH;
  const summed = new Set(options && Array.isArray(options.sectionNotes) ? options.sectionNotes : []);
  const rows = (Array.isArray(headings) ? headings : [])
    .filter((h) => h && Number.isInteger(h.block) && Number.isInteger(h.depth)
      && h.depth >= 1 && h.depth <= maxDepth)
    .map((h) => ({
      block: h.block,
      depth: h.depth,
      indent: 0,
      title: String(h.title ?? '').replace(/\s+/g, ' ').trim() || NO_TITLE,
      page: Number.isInteger(h.page) ? h.page : null,
      count: 0,
      noted: summed.has(h.block),
    }))
    .sort((a, b) => a.block - b.block);

  const starts = (Array.isArray(noteBlocks) ? noteBlocks : []).filter(Number.isInteger);

  // A note belongs to the last listed heading at or before the block it
  // starts in. own[i] = notes directly in section i, subsections not included.
  const own = rows.map(() => 0);
  for (const block of starts) {
    const i = sectionOf(rows, block);
    if (i >= 0) own[i] += 1;
  }

  // How deep each row sits, counted from the left edge of the list. A
  // document title is shallower than `base` and is held at 0, which makes
  // it a neighbour of the main sections rather than their parent.
  const base = leftEdgeDepth(rows);
  for (const row of rows) row.indent = Math.max(0, row.depth - base);

  // Add each section's notes to itself and to every heading it sits under.
  // `open` holds the headings we are currently "inside", outermost first.
  const open = [];
  rows.forEach((row, i) => {
    while (open.length && rows[open[open.length - 1]].indent >= row.indent) open.pop();
    for (const parent of open) rows[parent].count += own[i];
    row.count += own[i];
    open.push(i);
  });

  return { rows, notes: starts.length, sectionNotes: rows.filter((row) => row.noted).length };
}

// The blocks that make up row i's section, subsections included:
// { from, to } means blocks from..to-1. It runs from the row's own heading up
// to the next row that is NOT drawn beneath it (`to` is Infinity when the
// section runs to the end of the document). A note whose block is in this
// range is one of the notes `count` adds up. null when there is no row i.
export function sectionRange(rows, i) {
  const row = Array.isArray(rows) ? rows[i] : null;
  if (!row) return null;
  for (let j = i + 1; j < rows.length; j++) {
    if (rows[j].indent <= row.indent) return { from: row.block, to: rows[j].block };
  }
  return { from: row.block, to: Infinity };
}

// Which row's section is this block in? -1 when it comes before the first
// heading. The rows are in block order, so the search can halve each time.
export function sectionOf(rows, block) {
  let low = 0;
  let high = rows.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (rows[mid].block <= block) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

// The heading depth that sits at the left edge of the list. Normally the
// shallowest one in the document. But a single shallowest heading at the very
// top (usually the one "#") is the document's title, not a chapter with
// everything else inside it: the level below it starts at the edge too, which
// keeps the whole list from being pushed one step to the right.
function leftEdgeDepth(rows) {
  if (rows.length === 0) return 1;
  const shallowest = (list) => list.reduce((min, r) => Math.min(min, r.depth), Infinity);
  const top = shallowest(rows);
  const isTitle = rows.length > 1 && rows[0].depth === top
    && rows.filter((r) => r.depth === top).length === 1;
  return isTitle ? shallowest(rows.slice(1)) : top;
}
