// Builds the annotated Markdown export: a copy of the original Markdown with
// each reviewer note written next to the words it is about, in CriticMarkup
// (a plain-text notation LLMs already know). Pure text logic: text in, text
// out, no page (DOM) needed.
//
// Two rules keep the output safe:
//   1. We only ever INSERT text: markup, comments, and where needed a newline
//      to keep a comment apart from the next line. Nothing of the original
//      is changed or removed, so taking the insertions out gives it back.
//   2. Markup goes inside a paragraph only when rendering that block again
//      proves the Markdown structure survived. Otherwise the note goes on its
//      own line just below the block ("the fallback").

import { squeeze } from './match.js';
import { DEFAULT_LABELS } from './model.js';

// Block kinds where writing inside the text is attempted. Code blocks (and
// Mermaid diagrams, which are code blocks) always get the comment below.
const INLINE_OK = new Set(['paragraph', 'heading', 'list', 'blockquote', 'table']);

// What goes round the quoted words. A note on a whole block has no entry.
const WRAP = {
  highlight: ['{==', '==}'],
  underline: ['{==', '==}'],
  strike: ['{--', '--}'],
};

// A block that already contains any of these is left alone: we could not
// tell our markup from the author's.
const CRITIC_MARKS = ['{==', '{--', '{>>', '<<}', '{++', '{~~'];
const COMMENT_END = '<<}';

// Characters ignored when matching a quote against the Markdown source:
// whitespace, and the emphasis marks that are in the source but not on the
// page (** _ ~~ ` and the backslash that escapes them).
const SKIP = /[\s*_~`\\]/;
const SKIP_ALL = /[\s*_~`\\]/g;
const DELIMITER = /[*_~`]/;
const strip = (s) => String(s ?? '').replace(SKIP_ALL, '');

const MAX_QUOTE = 120; // longest quote repeated inside a comment

const LEGEND_INTRO = '> **Reviewer annotations (CriticMarkup).** '
  + '`{==text==}` is text the reviewer highlighted. '
  + '`{--text--}` is text the reviewer struck out and wants removed. '
  + '`{>>[label] comment<<}` is the reviewer\'s comment on the text just before it, '
  + 'or on the block above when it stands on its own line.';
const UNPLACED_INTRO = '> **Unplaced reviewer notes.** '
  + 'The text these notes referred to is no longer in the document.';

// ---- The export itself --------------------------------------------------------

// source       { src, blocks, exact } from renderBlocks()
// annotations  records in the order they were made
// opts.labels    the label list (for the legend)
// opts.resolved  resolved[id] = { block, start, end } for a text annotation
//                found on the page, { block } for a block note, and no entry
//                when the annotation could not be placed
// opts.texts     texts[n] = block n's text as shown on the page, whitespace
//                removed
// opts.docName   accepted for later use; the legend does not mention it yet
export function annotatedMarkdown(marked, source, annotations, opts) {
  const src = String((source && source.src) ?? '');
  const items = Array.isArray(annotations) ? annotations.filter(Boolean) : [];
  if (items.length === 0) return src;

  const blocks = (source && Array.isArray(source.blocks)) ? source.blocks : [];
  const { labels = DEFAULT_LABELS, resolved = {}, texts = [] } = opts || {};
  const trusted = Boolean(source && source.exact); // block positions add up
  // Each block is checked on its own, but "[ref]: https://..." lines can sit
  // anywhere in the document. They are handed to the check, or a
  // reference-style link would look like plain text while checking.
  const context = trusted ? linkDefinitions(marked, src) : '';

  const inserts = []; // { at, rank, seq, text }: text to insert at src[at]
  const inlineByBlock = new Map(); // block index -> inline edits accepted so far
  const htmlByBlock = new Map(); // block index -> its original HTML (cache)
  const padded = new Set(); // positions that already got a separating newline
  const unplaced = [];

  items.forEach((a, seq) => {
    const where = placeOf(resolved, a.id, blocks);
    if (!where) {
      unplaced.push(a);
      return;
    }
    const block = blocks[where.block];
    const blockSrc = src.slice(block.start, block.end);

    let edit = null;
    if (trusted) {
      if (!htmlByBlock.has(where.block)) {
        htmlByBlock.set(where.block, marked.parse(blockSrc + context));
      }
      const accepted = inlineByBlock.get(where.block) || [];
      const check = { context, originalHtml: htmlByBlock.get(where.block) };
      edit = inlineEdit(marked, a, where, block, blockSrc, texts[where.block], accepted, check);
      if (edit) inlineByBlock.set(where.block, [...accepted, edit]);
    }

    if (edit) {
      // rank decides the order of insertions that share one position:
      // 0 = closing markup, 1 = comment below the block, 2 = the newline
      // after such comments, 3 = opening markup. So when two marks touch,
      // the first one closes before the second opens.
      inserts.push({ at: block.start + edit.start, rank: 3, seq, text: edit.open });
      inserts.push({ at: block.start + edit.end, rank: 0, seq, text: edit.close + edit.comment });
    } else {
      // Just after the block's last visible character.
      const at = block.start + blockSrc.trimEnd().length;
      const lead = leadFor(a, block, blockSrc, where);
      inserts.push({ at, rank: 1, seq, text: `\n\n${belowComment(a, lead)}` });
      // Usually a blank line follows the block and nothing more is needed.
      // When text follows on the very next line (a "Caption:" line under a
      // diagram, say) one more newline keeps the comment from being read as
      // the start of that text.
      if (!padded.has(at) && textOnNextLine(src, at)) {
        padded.add(at);
        inserts.push({ at, rank: 2, seq, text: '\n' });
      }
    }
  });

  // Stitch the result together front to back. Sorting by position, then rank,
  // then creation order (seq) keeps notes at one spot in the order they were made.
  inserts.sort((x, y) => x.at - y.at || x.rank - y.rank || x.seq - y.seq);
  let out = legend(items, labels);
  let pos = 0;
  for (const ins of inserts) {
    out += src.slice(pos, ins.at) + ins.text;
    pos = ins.at;
  }
  out += src.slice(pos);

  if (unplaced.length) {
    if (!out.endsWith('\n')) out += '\n';
    const notes = unplaced.map((a) => belowComment(a, quoteLead(a)));
    out += `\n${UNPLACED_INTRO}\n\n${notes.join('\n\n')}\n`;
  }
  return out;
}

// Is there text on the line right after position `at`, with no blank line
// in between? (`at` is the end of a block, so what follows starts with the
// rest of its line: nothing, or spaces.)
function textOnNextLine(src, at) {
  const next = /[^\S\n]*\n?[^\S\n]*\S/y; // y = match exactly at lastIndex
  next.lastIndex = at;
  return next.test(src);
}

// The document's link definitions ("[ref]: https://..."), ready to be put
// after a block that is rendered on its own. '' when there are none.
function linkDefinitions(marked, src) {
  if (!/^ {0,3}\[[^\]\n]+\]:/m.test(src)) return ''; // quick look before the full parse
  const defs = marked.lexer(src).filter((t) => t.type === 'def').map((t) => t.raw.trim());
  return defs.length ? `\n\n${defs.join('\n')}\n` : '';
}

// Where an annotation sits now, or null when it is unplaced.
function placeOf(resolved, id, blocks) {
  if (!resolved || !Object.prototype.hasOwnProperty.call(resolved, id)) return null;
  const where = resolved[id];
  if (!where || !Number.isInteger(where.block) || !blocks[where.block]) return null;
  return where;
}

// Try to write one annotation inside its block. Returns the edit
// { start, end, open, close, comment } (offsets into blockSrc) or null,
// which means "use the comment below the block instead".
function inlineEdit(marked, a, where, block, blockSrc, text, accepted, check) {
  const wrap = WRAP[a.kind];
  if (!wrap || !INLINE_OK.has(block.type)) return null;
  if (CRITIC_MARKS.some((m) => blockSrc.includes(m))) return null;
  const comment = inlineComment(a);
  // A "|" would start a new table cell and split the comment in two.
  if (block.type === 'table' && comment.includes('|')) return null;

  const exact = a.target ? a.target.exact : '';
  const seen = occurrence(text, where.start, exact);
  if (!seen) return null;
  const base = locateInSource(blockSrc, exact, seen.nth, seen.of);
  if (!base) return null;

  for (const hit of candidateHits(blockSrc, base)) {
    // Two marks may not overlap: the one made first wins.
    if (accepted.some((e) => hit.start < e.end && e.start < hit.end)) continue;
    const edit = { start: hit.start, end: hit.end, open: wrap[0], close: wrap[1], comment };
    // Check this edit together with the ones already accepted in this block:
    // two edits can each be harmless alone and still break the block as a
    // pair (see the note on marked above editsRenderTheSame).
    const edits = [...accepted, edit];
    if (editsRenderTheSame(marked, blockSrc, edits, check.context, check.originalHtml)) {
      return edit;
    }
  }
  return null;
}

// ---- Comment text -------------------------------------------------------------

// One line of safe text: line breaks become spaces, and "<<}" is broken up so
// it cannot end the comment early.
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().replace(/<<\}/g, '< <}');

const labelOf = (a) => clean(a.label) || 'note';

// "[underline, question]". A struck-out phrase is already shown by {-- --}
// when written inline, so "strike" is only spelled out in the below-block form.
function tagsFor(a, below) {
  const tags = [];
  if (a.kind === 'underline') tags.push('underline');
  if (a.kind === 'strike' && below) tags.push('strike');
  tags.push(labelOf(a));
  return `[${tags.join(', ')}]`;
}

// The comment written right after the quoted words. Empty for a plain
// highlight or strike with the default label and no note: the wrapper alone
// says everything there is to say.
function inlineComment(a) {
  const note = clean(a.note);
  if (!note && a.kind !== 'underline' && labelOf(a) === 'note') return '';
  return note ? `{>>${tagsFor(a, false)} ${note}<<}` : `{>>${tagsFor(a, false)}<<}`;
}

// The comment written on its own line. `lead` says what it is about
// ('On "quoted words"'), or is '' for a note on the whole block above.
function belowComment(a, lead) {
  const body = [lead, clean(a.note)].filter(Boolean).join(': ');
  return body ? `{>>${tagsFor(a, true)} ${body}<<}` : `{>>${tagsFor(a, true)}<<}`;
}

// The quote as repeated inside a comment: one line, no double quotes, not
// too long.
function readableQuote(exact) {
  const text = clean(exact).replace(/"/g, "'");
  const chars = Array.from(text); // by character, so an emoji is never cut in half
  return chars.length > MAX_QUOTE ? `${chars.slice(0, MAX_QUOTE).join('')}…` : text;
}

// 'On "quoted words"', or 'On code line 12 "quoted words"' when `line` is given.
function quoteLead(a, line) {
  const quote = readableQuote(a.target ? a.target.exact : '');
  if (!quote) return '';
  return line ? `On code line ${line} "${quote}"` : `On "${quote}"`;
}

// The lead of a below-block comment for an annotation that was placed.
function leadFor(a, block, blockSrc, where) {
  if (a.kind === 'block') return ''; // it stands below its block: nothing to add
  const line = block.type === 'code' ? codeLineOf(blockSrc, where.start) : null;
  return quoteLead(a, line);
}

// The blockquote at the top that explains the notation to the reader (an LLM).
function legend(items, labels) {
  const known = (Array.isArray(labels) ? labels : [])
    .filter((l) => l && typeof l.id === 'string' && l.id);
  const lines = [LEGEND_INTRO];
  if (known.length) {
    const meanings = known.map((l) => {
      const meaning = clean(l.meaning) || clean(l.name);
      return meaning ? `${clean(l.id)} = ${meaning}` : clean(l.id);
    });
    // Semicolons between labels: a meaning may itself contain a comma
    // ("good, keep as is").
    lines.push(`> Labels: ${meanings.join('; ')}.`);
  }
  // A selection across several blocks is several records but ONE annotation.
  const seenGroups = new Set();
  const counted = items.filter((a) => {
    if (!a.group) return true;
    if (seenGroups.has(a.group)) return false;
    seenGroups.add(a.group);
    return true;
  });
  // Count per label, in the order of the label list. A label that is not in
  // the list (a hand-edited file) is counted after the known ones.
  const counts = new Map(known.map((l) => [clean(l.id), 0]));
  for (const a of counted) counts.set(labelOf(a), (counts.get(labelOf(a)) || 0) + 1);
  const parts = [...counts].filter(([, n]) => n > 0).map(([id, n]) => `${n} ${id}`);
  const noun = counted.length === 1 ? 'annotation' : 'annotations';
  lines.push(`> ${counted.length} ${noun}: ${parts.join(', ')}.`);
  return `${lines.join('\n')}\n\n`;
}

// ---- Finding the quote in the Markdown source -----------------------------------

// The same words can appear several times in one block. This works out which
// copy an annotation is on: `nth` (0 = first) out of `of`, counted in the
// text as shown on the page. `blockKey` is the block's page text with
// whitespace removed and `start` the annotation's offset into it.
export function occurrence(blockKey, start, exact) {
  const want = strip(exact);
  if (!want || !Number.isInteger(start)) return null;
  const key = strip(blockKey);
  const own = strip(String(blockKey ?? '').slice(0, start)).length;
  const hits = [];
  for (let i = key.indexOf(want); i !== -1; i = key.indexOf(want, i + 1)) hits.push(i);
  const nth = hits.indexOf(own);
  return nth === -1 ? null : { nth, of: hits.length };
}

// Where is the quote in the block's Markdown? Both sides are compared with
// whitespace and emphasis marks removed, so **bold** and hard-wrapped lines
// still match. Returns { start, end } (offsets into blockSrc) or null when
// unsure: the words must appear exactly `of` times in the source, the same
// number of times as on the page, and we take copy number `nth`.
function locateInSource(blockSrc, exact, nth, of) {
  const s = String(blockSrc ?? '');
  let key = '';
  const at = []; // at[i] = index in s of key[i]
  for (let i = 0; i < s.length; i++) {
    if (SKIP.test(s[i])) continue;
    key += s[i];
    at.push(i);
  }
  const want = strip(exact);
  if (!want) return null;
  const hits = [];
  for (let i = key.indexOf(want); i !== -1; i = key.indexOf(want, i + 1)) hits.push(i);
  if (hits.length === 0 || hits.length !== of) return null; // counts must agree
  const first = hits[nth];
  if (first === undefined) return null;
  const start = at[first];
  const end = at[first + want.length - 1] + 1;
  // Never span a blank line: that would be two paragraphs or two list items.
  if (/\n\s*\n/.test(s.slice(start, end))) return null;
  return { start, end };
}

// The emphasis marks touching a hit on each side: for **bold** with the hit
// on "bold" both are "**".
function delimitersAround(s, hit) {
  let l = hit.start;
  while (l > 0 && DELIMITER.test(s[l - 1])) l--;
  let r = hit.end;
  while (r < s.length && DELIMITER.test(s[r])) r++;
  return { l, r, left: s.slice(l, hit.start), right: s.slice(hit.end, r) };
}

const mirrored = (s) => Array.from(s).reverse().join('');

// As locateInSource, plus one nicety: when the hit is wrapped in the same
// emphasis marks on both sides, they are included, giving {==**bold**==}
// rather than **{==bold==}**. rendersTheSame() remains the final judge.
// (annotatedMarkdown() goes through candidateHits(), which tries this and a
// few more widenings; this simpler entry point is here for the unit tests.)
export function findInSource(blockSrc, exact, nth, of) {
  const s = String(blockSrc ?? '');
  const hit = locateInSource(s, exact, nth, of);
  if (!hit) return null;
  const { l, r, left, right } = delimitersAround(s, hit);
  return left && left === mirrored(right) ? { start: l, end: r } : hit;
}

// How many separate runs of the character `ch` are in `text`: 2 in "**a**".
function runsOf(text, ch) {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ch && text[i - 1] !== ch) n++;
  }
  return n;
}

// Every way of writing the hit that is worth trying, best first: with the
// emphasis marks on both sides included, exactly as found, and with the
// marks on one side only (for a quote such as "`fail_open` events", which
// starts with a whole code span). Versions that hold complete pairs of the
// marks next to the hit are tried first: "**Hot keys.** One" before
// "Hot keys.** One". The caller keeps the first one that renders the same.
function candidateHits(blockSrc, hit) {
  const { l, r, left, right } = delimitersAround(blockSrc, hit);
  const same = Boolean(left) && left === mirrored(right); // as in findInSource
  const list = [];
  if (same) list.push({ start: l, end: r });
  list.push(hit);
  // Different marks on each side, as in "_two_ kinds of **emphasis**".
  if (left && right && !same) list.push({ start: l, end: r });
  if (right) list.push({ start: hit.start, end: r });
  if (left) list.push({ start: l, end: hit.end });
  const marks = Array.from(new Set(left + right));
  const paired = (h) => {
    const text = blockSrc.slice(h.start, h.end);
    return marks.every((ch) => runsOf(text, ch) % 2 === 0);
  };
  return [...list.filter(paired), ...list.filter((h) => !paired(h))];
}

// ---- The safety net -------------------------------------------------------------

// How marked itself writes these characters into HTML.
const asHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Is position `at` of the HTML in ordinary text? False inside a tag (an
// attribute such as alt="..."), and false inside <code> or <pre>, where our
// markup would be taken for part of the code.
function inPlainText(html, at) {
  const before = html.slice(0, at);
  if (before.lastIndexOf('<') > before.lastIndexOf('>')) return false;
  if (before.lastIndexOf('<code') > before.lastIndexOf('</code>')) return false;
  if (before.lastIndexOf('<pre') > before.lastIndexOf('</pre>')) return false;
  return true;
}

// Does every tag opened in this piece of HTML also close in it? Markdown in
// a note (*emphasis*, `code`) gives balanced tags and is harmless. A lone
// "<details>" typed into a note would swallow the rest of the document.
function tagsBalanced(html) {
  const VOID = new Set(['br', 'hr', 'img', 'input', 'wbr']); // never closed
  const open = [];
  const tag = /<(\/?)([a-z][a-z0-9-]*)[^>]*>/gi;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    const name = m[2].toLowerCase();
    if (VOID.has(name) || m[0].endsWith('/>')) continue;
    if (!m[1]) open.push(name);
    else if (open.pop() !== name) return false;
  }
  return open.length === 0;
}

// Put the markup in, render the block again and compare. `edits` is a list of
// { start, end, open, close, comment } that do not overlap. The check passes
// only when removing our own pieces from the new HTML leaves exactly the
// original HTML. If a table row split, bold came unbalanced, or a code span
// swallowed part of the markup, the HTML differs and we refuse.
//
// One refusal looks surprising but is correct for this app: marked stops
// looking for the end of **bold** or _italic_ inside anything shaped like
// "<...>", and the "<<}" of one comment followed by the "{>>" of the next has
// that shape. So with two comments in one paragraph, emphasis between them
// would show as plain asterisks. The check sees that, and the later comment
// goes below the block instead.
//
// `context` is extra Markdown rendered after the block both times (the
// document's link definitions). `originalHtml` may be passed in to save
// rendering the unchanged block again.
function editsRenderTheSame(marked, blockSrc, edits, context = '', originalHtml = null) {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  let edited = '';
  let pos = 0;
  for (const e of sorted) {
    edited += blockSrc.slice(pos, e.start) + e.open + blockSrc.slice(e.start, e.end)
      + e.close + e.comment;
    pos = e.end;
  }
  edited += blockSrc.slice(pos);

  const html = marked.parse(edited + context);
  const endMark = asHtml(COMMENT_END);
  let kept = ''; // the new HTML with our pieces cut out
  let cursor = 0;
  for (const e of sorted) {
    const open = asHtml(e.open);
    const close = asHtml(e.close);
    const a = html.indexOf(open, cursor);
    if (a === -1 || !inPlainText(html, a)) return false;
    const b = html.indexOf(close, a + open.length);
    if (b === -1 || !inPlainText(html, b)) return false;
    let stop = b + close.length;
    if (e.comment) {
      // Cut the whole comment as one region, up to its closing "<<}", so
      // that harmless Markdown inside the note does not cause a refusal.
      const c = html.indexOf(endMark, stop);
      if (c === -1 || !tagsBalanced(html.slice(stop, c))) return false;
      stop = c + endMark.length;
    }
    kept += html.slice(cursor, a) + html.slice(a + open.length, b);
    cursor = stop;
  }
  kept += html.slice(cursor);
  return kept === (originalHtml ?? marked.parse(blockSrc + context));
}

// (annotatedMarkdown() checks all of a block's insertions together with
// editsRenderTheSame(); this one-insertion form is here for the unit tests.)
// The check for a single insertion: wrap blockSrc[hit.start..hit.end] in
// `open` and `close`, follow it with `comment` ('' for none), and report
// whether the block still renders the same apart from the inserted text.
// `context` (optional) is Markdown the block depends on, such as the link
// definitions found elsewhere in the document.
export function rendersTheSame(marked, blockSrc, hit, open, close, comment, context = '') {
  if (!hit) return false;
  const edit = { start: hit.start, end: hit.end, open, close, comment: comment || '' };
  return editsRenderTheSame(marked, String(blockSrc ?? ''), [edit], context);
}

// ---- Code blocks ----------------------------------------------------------------

// Which line of a code block holds character `start`? `start` counts the
// code's characters with whitespace removed, as annotation offsets do.
// Returns a 1-based line number, or null when out of range or when the block
// is a Mermaid diagram (its source lines are not what the reader sees).
export function codeLineOf(blockSrc, start) {
  if (!Number.isInteger(start) || start < 0) return null;
  let lines = String(blockSrc ?? '').trimEnd().split('\n');
  const fence = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(lines[0]);
  if (fence) {
    if (fence[2].toLowerCase() === 'mermaid') return null;
    lines = lines.slice(1); // drop the opening ``` line
    // Drop the closing fence too, if the block has one (a block that runs to
    // the end of the file may not).
    const last = lines[lines.length - 1];
    const closing = last === undefined ? null : /^ {0,3}(`{3,}|~{3,})\s*$/.exec(last);
    if (closing && closing[1][0] === fence[1][0] && closing[1].length >= fence[1].length) {
      lines = lines.slice(0, -1);
    }
  }
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    total += squeeze(lines[i]).length;
    if (total > start) return i + 1;
  }
  return null;
}
