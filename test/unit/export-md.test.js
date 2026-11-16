import test from 'node:test';
import assert from 'node:assert/strict';

import {
  annotatedMarkdown, findInSource, occurrence, rendersTheSame, codeLineOf,
} from '../../renderer/src/annotations/export-md.js';
import { DEFAULT_LABELS } from '../../renderer/src/annotations/model.js';
import {
  FIXTURES, makeMarked, readFixture, openDoc, annotate, blockNote,
  exportDoc, withoutLegend, stripMarkup,
} from './helpers.js';

const marked = makeMarked();

// Export `md` with the annotations returned by `build(doc)` and give back
// the result without the legend, so expectations stay readable.
function body(md, build, options) {
  const doc = openDoc(marked, md);
  return withoutLegend(exportDoc(doc, [].concat(build(doc)), options));
}

const PARAGRAPH = 'Use a token bucket. Buckets are refilled lazily on read so there is no job.\n';

// ---- Nothing to do, and the legend ----------------------------------------------

test('no annotations: the source comes back unchanged', () => {
  for (const file of FIXTURES) {
    const md = readFixture(file);
    assert.equal(exportDoc(openDoc(marked, md), []), md);
  }
  const doc = openDoc(marked, 'No newline at the end');
  assert.equal(annotatedMarkdown(marked, doc.source, [], {}), 'No newline at the end');
  assert.equal(annotatedMarkdown(marked, doc.source, null, undefined), 'No newline at the end');
});

test('the legend explains the notation, the labels and the counts', () => {
  const doc = openDoc(marked, PARAGRAPH);
  const out = exportDoc(doc, [
    annotate(doc, 'token bucket', { label: 'question', note: 'Which kind?' }),
    annotate(doc, 'no job', { label: 'keep' }),
    annotate(doc, 'lazily', { label: 'question', note: 'Why?' }),
  ]);
  const legend = out.slice(0, out.indexOf('\n\n'));
  assert.deepEqual(legend.split('\n'), [
    '> **Reviewer annotations (CriticMarkup).** `{==text==}` is text the reviewer highlighted. '
      + '`{--text--}` is text the reviewer struck out and wants removed. '
      + '`{>>[label] comment<<}` is the reviewer\'s comment on the text just before it, '
      + 'or on the block above when it stands on its own line.',
    '> Labels: note = general remark; question = needs an answer; change = please change this; '
      + 'keep = good, keep as is; important = do not miss this.',
    '> 3 annotations: 2 question, 1 keep.',
  ]);
  // The legend is one blockquote, and the document follows after a blank line.
  assert.ok(out.startsWith(`${legend}\n\nUse a {==token bucket==}`));
  assert.equal(marked.lexer(out)[0].type, 'blockquote');
});

test('the legend says "1 annotation" and counts labels that are not in the list last', () => {
  const doc = openDoc(marked, PARAGRAPH);
  const one = exportDoc(doc, [annotate(doc, 'lazily')]);
  assert.ok(one.includes('\n> 1 annotation: 1 note.\n\n'));

  const odd = exportDoc(doc, [
    annotate(doc, 'lazily', { label: 'custom' }),
    annotate(doc, 'no job', { label: 'keep' }),
    annotate(doc, 'token', { label: 'custom' }),
  ]);
  assert.ok(odd.includes('\n> 3 annotations: 1 keep, 2 custom.\n\n'));
});

test('the legend uses the labels it is given', () => {
  const doc = openDoc(marked, PARAGRAPH);
  const labels = [
    { id: 'todo', name: 'To do', color: '#fff', ink: '#000', meaning: 'not done\nyet' },
    { id: 'risk', name: 'Risk', color: '#fff', ink: '#000', meaning: '' },
  ];
  const out = exportDoc(doc, [annotate(doc, 'lazily', { label: 'risk' })], { labels });
  assert.ok(out.includes('\n> Labels: todo = not done yet; risk = Risk.\n'
    + '> 1 annotation: 1 risk.\n'));
});

// ---- The inline forms ---------------------------------------------------------

test('highlight with a note, in a plain paragraph', () => {
  const out = body(PARAGRAPH, (doc) => annotate(doc, 'refilled lazily on read',
    { label: 'question', note: 'Why lazily?' }));
  assert.equal(out, 'Use a token bucket. Buckets are {==refilled lazily on read==}'
    + '{>>[question] Why lazily?<<} so there is no job.\n');
});

test('strikethrough is written as a deletion', () => {
  const out = body(PARAGRAPH, (doc) => annotate(doc, 'so there is no job',
    { kind: 'strike', label: 'change', note: 'There is one now' }));
  assert.equal(out, 'Use a token bucket. Buckets are refilled lazily on read '
    + '{--so there is no job--}{>>[change] There is one now<<}.\n');
});

test('underline is a highlight tagged "underline"', () => {
  const noted = body(PARAGRAPH, (doc) => annotate(doc, 'token bucket',
    { kind: 'underline', label: 'question', note: 'Which kind?' }));
  assert.equal(noted, 'Use a {==token bucket==}{>>[underline, question] Which kind?<<}. '
    + 'Buckets are refilled lazily on read so there is no job.\n');
  // Even with the default label and no note the tag is needed, or it would
  // read as a plain highlight.
  const bare = body(PARAGRAPH, (doc) => annotate(doc, 'token bucket', { kind: 'underline' }));
  assert.ok(bare.startsWith('Use a {==token bucket==}{>>[underline, note]<<}. Buckets'));
});

test('a label without a note gives a label-only comment', () => {
  const out = body(PARAGRAPH, (doc) => annotate(doc, 'refilled lazily', { label: 'keep' }));
  assert.ok(out.includes('are {==refilled lazily==}{>>[keep]<<} on read'));
});

test('the "note" label with an empty note gives no comment at all', () => {
  const highlight = body(PARAGRAPH, (doc) => annotate(doc, 'refilled lazily'));
  assert.equal(highlight, 'Use a token bucket. Buckets are {==refilled lazily==} on read '
    + 'so there is no job.\n');
  const strike = body(PARAGRAPH, (doc) => annotate(doc, 'refilled lazily',
    { kind: 'strike', note: '  \n ' }));
  assert.ok(strike.includes('are {--refilled lazily--} on read'));
  // With a note the label is shown again.
  const noted = body(PARAGRAPH, (doc) => annotate(doc, 'refilled lazily', { note: 'Hm' }));
  assert.ok(noted.includes('{==refilled lazily==}{>>[note] Hm<<}'));
});

test('a note is flattened to one line', () => {
  const out = body(PARAGRAPH, (doc) => annotate(doc, 'lazily',
    { label: 'question', note: '  Why?\n\nWhat about\tburst load? ' }));
  assert.ok(out.includes('{==lazily==}{>>[question] Why? What about burst load?<<}'));
});

// ---- Emphasis marks in the source ---------------------------------------------

test('a quote that is bold in the source takes the ** with it', () => {
  const out = body('> **Decision:** fail open rather than fail closed.\n',
    (doc) => annotate(doc, 'Decision:', { label: 'keep' }));
  assert.equal(out, '> {==**Decision:**==}{>>[keep]<<} fail open rather than fail closed.\n');
});

test('code spans, italics and struck text are wrapped whole as well', () => {
  const wrap = (md, phrase) => body(md, (doc) => annotate(doc, phrase, { label: 'keep' }));
  assert.equal(wrap('Set `capacity` to 600.\n', 'capacity'),
    'Set {==`capacity`==}{>>[keep]<<} to 600.\n');
  assert.equal(wrap('It is _about_ 600.\n', 'about'), 'It is {==_about_==}{>>[keep]<<} 600.\n');
  assert.equal(wrap('Not ~~500~~ any more.\n', '500'), 'Not {==~~500~~==}{>>[keep]<<} any more.\n');
  assert.equal(wrap('Or ***more*** than that.\n', 'more'),
    'Or {==***more***==}{>>[keep]<<} than that.\n');
});

test('bold between two comments: the later comment goes below the block', () => {
  // marked stops pairing ** inside anything shaped like "<...>", and the
  // "<<}" of one comment followed by the "{>>" of the next has that shape.
  // Written inline, both comments would turn **must** into plain asterisks.
  const md = 'Buckets are refilled and **must** be drained lazily.\n';
  const both = body(md, (doc) => [
    annotate(doc, 'refilled', { label: 'question', note: 'How?' }),
    annotate(doc, 'lazily', { label: 'question', note: 'When?' }),
  ]);
  assert.equal(both, 'Buckets are {==refilled==}{>>[question] How?<<} and **must** be drained '
    + 'lazily.\n\n{>>[question] On "lazily": When?<<}\n');
  // A second mark without a comment has no "{>>", so it stays inline.
  const bare = body(md, (doc) => [
    annotate(doc, 'refilled', { label: 'question', note: 'How?' }),
    annotate(doc, 'lazily'),
  ]);
  assert.equal(bare, 'Buckets are {==refilled==}{>>[question] How?<<} and **must** be drained '
    + '{==lazily==}.\n');
  // Code spans between two comments are not affected.
  const code = body('Buckets are refilled by `take()` and drained lazily.\n', (doc) => [
    annotate(doc, 'refilled', { label: 'question', note: 'How?' }),
    annotate(doc, 'lazily', { label: 'question', note: 'When?' }),
  ]);
  assert.equal(code, 'Buckets are {==refilled==}{>>[question] How?<<} by `take()` and drained '
    + '{==lazily==}{>>[question] When?<<}.\n');
});

test('a quote that starts or ends with a whole bold phrase or code span includes its marks', () => {
  const bold = body('**Hot keys.** One abusive key hammers one shard.\n',
    (doc) => annotate(doc, 'Hot keys. One abusive', { label: 'important', note: 'Watch' }));
  assert.equal(bold, '{==**Hot keys.** One abusive==}{>>[important] Watch<<} '
    + 'key hammers one shard.\n');

  const md = 'Confirm the cluster has `EVAL` enabled.\n';
  const ends = body(md, (doc) => annotate(doc, 'has EVAL', { label: 'keep' }));
  assert.equal(ends, 'Confirm the cluster {==has `EVAL`==}{>>[keep]<<} enabled.\n');
  const starts = body(md, (doc) => annotate(doc, 'EVAL enabled', { label: 'keep' }));
  assert.equal(starts, 'Confirm the cluster has {==`EVAL` enabled==}{>>[keep]<<}.\n');
});

test('a quote from one emphasised phrase to another takes both sets of marks', () => {
  const out = body('A second *item* with _two_ kinds of **emphasis** here.\n',
    (doc) => annotate(doc, 'two kinds of emphasis',
      { kind: 'strike', label: 'change', note: 'Simplify' }));
  assert.equal(out, 'A second *item* with {--_two_ kinds of **emphasis**--}'
    + '{>>[change] Simplify<<} here.\n');
});

test('part of a bold phrase is marked inside the bold', () => {
  const out = body('This is **fail open rather** than closed.\n',
    (doc) => annotate(doc, 'open', { label: 'question', note: 'Sure?' }));
  assert.equal(out, 'This is **fail {==open==}{>>[question] Sure?<<} rather** than closed.\n');
});

test('underscores inside a word are not mistaken for emphasis', () => {
  const out = body('Set refill_per_sec and max_burst_size here.\n',
    (doc) => annotate(doc, 'burst', { label: 'question', note: 'How big?' }));
  assert.equal(out, 'Set refill_per_sec and max_{==burst==}{>>[question] How big?<<}_size here.\n');
});

test('part of a code span cannot be marked inline', () => {
  const md = 'Run `k6 run scripts/rate-limit.js` against staging.\n';
  const out = body(md, (doc) => annotate(doc, 'k6 run', { label: 'question', note: 'Version?' }));
  assert.equal(out, 'Run `k6 run scripts/rate-limit.js` against staging.\n\n'
    + '{>>[question] On "k6 run": Version?<<}\n');
});

// ---- Other block kinds --------------------------------------------------------

test('a hard-wrapped paragraph: the quote may span a line break in the source', () => {
  const md = 'Buckets are refilled\nlazily on read so there\nis no background job.\n';
  const out = body(md, (doc) => annotate(doc, 'refilled lazily on read',
    { label: 'question', note: 'Why?' }));
  assert.equal(out, 'Buckets are {==refilled\nlazily on read==}{>>[question] Why?<<} so there\n'
    + 'is no background job.\n');
});

test('a list item', () => {
  const md = '1. `app/config.py` — add settings.\n'
    + '2. `app/main.py` — register the middleware ahead of the router.\n';
  const out = body(md, (doc) => annotate(doc, 'register the middleware',
    { label: 'change', note: 'After auth' }));
  assert.equal(out, '1. `app/config.py` — add settings.\n'
    + '2. `app/main.py` — {==register the middleware==}{>>[change] After auth<<} '
    + 'ahead of the router.\n');
});

test('a task list item and a nested list item', () => {
  const md = '- [ ] Load test against staging\n  - with 50 virtual users\n- [x] Confirm EVAL\n';
  const out = body(md, (doc) => [
    annotate(doc, 'Load test', { label: 'question', note: 'How long?' }),
    annotate(doc, '50 virtual users', { label: 'change', note: 'Use 200' }),
  ]);
  assert.equal(out, '- [ ] {==Load test==}{>>[question] How long?<<} against staging\n'
    + '  - with {==50 virtual users==}{>>[change] Use 200<<}\n- [x] Confirm EVAL\n');
});

test('a quote that runs across two list items goes below the list', () => {
  const md = '- first item\n- second item\n\nAfter.\n';
  const out = body(md, (doc) => annotate(doc, 'item second',
    { label: 'question', note: 'Merge?' }));
  assert.equal(out, '- first item\n- second item\n\n'
    + '{>>[question] On "item second": Merge?<<}\n\nAfter.\n');
});

test('a blockquote', () => {
  const md = '> A blockquote with\n> multiple lines\n';
  const inside = body(md, (doc) => annotate(doc, 'multiple lines', { label: 'keep' }));
  assert.equal(inside, '> A blockquote with\n> {==multiple lines==}{>>[keep]<<}\n');
  // Across the line break the source has a ">" in the way, so no inline form.
  const across = body(md, (doc) => annotate(doc, 'with multiple', { label: 'keep' }));
  assert.equal(across, '> A blockquote with\n> multiple lines\n\n'
    + '{>>[keep] On "with multiple"<<}\n');
});

test('a heading', () => {
  const md = '## A wide table\n\nText.\n';
  const out = body(md, (doc) => annotate(doc, 'wide', { label: 'question', note: 'How wide?' }));
  assert.equal(out, '## A {==wide==}{>>[question] How wide?<<} table\n\nText.\n');
});

const TABLE = [
  '| Setting | Default | Notes |',
  '|---|---|---|',
  '| `capacity` | 600 | Maximum burst per key |',
  '| `refill_per_sec` | 10 | Sustained rate |',
  '',
].join('\n');

test('a table cell is annotated inline', () => {
  const out = body(TABLE, (doc) => [
    annotate(doc, '600', { label: 'question', note: 'Per minute?' }),
    annotate(doc, 'refill_per_sec', { label: 'keep' }),
    annotate(doc, 'Default', { kind: 'strike', label: 'change', note: 'Say "Value"' }),
  ]);
  assert.equal(out, [
    '| Setting | {--Default--}{>>[change] Say "Value"<<} | Notes |',
    '|---|---|---|',
    '| `capacity` | {==600==}{>>[question] Per minute?<<} | Maximum burst per key |',
    '| {==`refill_per_sec`==}{>>[keep]<<} | 10 | Sustained rate |',
    '',
  ].join('\n'));
  // Still one table with the same rows and columns.
  const [table] = marked.lexer(out);
  assert.equal(table.type, 'table');
  assert.equal(table.header.length, 3);
  assert.equal(table.rows.length, 2);
});

test('a table cell with "|" in the note goes below the table', () => {
  const out = body(TABLE, (doc) => annotate(doc, '600',
    { label: 'question', note: 'per minute | per key?' }));
  assert.equal(out, `${TABLE.trimEnd()}\n\n{>>[question] On "600": per minute | per key?<<}\n`);
});

test('a quote spanning a link goes below the block', () => {
  const md = 'Please see the [docs](http://x.y/z) for details.\n';
  const out = body(md, (doc) => annotate(doc, 'see the docs for',
    { label: 'question', note: 'Which page?' }));
  assert.equal(out, 'Please see the [docs](http://x.y/z) for details.\n\n'
    + '{>>[question] On "see the docs for": Which page?<<}\n');
});

test('a quote inside the link text stays inline', () => {
  const md = 'Please see the [online docs](http://x.y/z) for details.\n';
  const out = body(md, (doc) => annotate(doc, 'docs', { label: 'question', note: 'Which page?' }));
  assert.equal(out, 'Please see the [online {==docs==}{>>[question] Which page?<<}](http://x.y/z) '
    + 'for details.\n');
});

test('words that also appear in a link address go below the block', () => {
  // "docs" is on the page once but in the source twice: we cannot be sure
  // which one to wrap, so we do not guess.
  const md = 'Read the docs at [this page](http://x.y/docs) first.\n';
  const out = body(md, (doc) => annotate(doc, 'docs', { label: 'keep' }));
  assert.equal(out, `${md.trimEnd()}\n\n{>>[keep] On "docs"<<}\n`);
});

const CODE = [
  'Intro.',
  '',
  '```python',
  'def take(self):',
  '    tokens = 5',
  '',
  '    if tokens < 1:',
  '        return False',
  '```',
  '',
  'After.',
  '',
].join('\n');

test('a code block gets the comment below it, with the line number', () => {
  const out = body(CODE, (doc) => annotate(doc, 'if tokens < 1:',
    { label: 'change', note: 'Compare against the cost' }));
  assert.equal(out, CODE.replace('```\n\nAfter.',
    '```\n\n{>>[change] On code line 4 "if tokens < 1:": Compare against the cost<<}\n\nAfter.'));
  // Nothing was written inside the fence.
  assert.equal(marked.lexer(out)[2].raw, marked.lexer(CODE)[2].raw);
});

test('struck-out and underlined code say so in the tags', () => {
  const out = body(CODE, (doc) => [
    annotate(doc, 'tokens = 5', { kind: 'strike', label: 'change', note: 'Dead code' }),
    annotate(doc, 'return False', { kind: 'underline', label: 'question' }),
    annotate(doc, 'def take', {}),
  ]);
  assert.ok(out.includes('```\n\n'
    + '{>>[strike, change] On code line 2 "tokens = 5": Dead code<<}\n\n'
    + '{>>[underline, question] On code line 5 "return False"<<}\n\n'
    + '{>>[note] On code line 1 "def take"<<}\n\nAfter.'));
});

test('code inside a list item is never written into', () => {
  const md = '- Step one:\n\n  ```js\n  const limit = 600;\n  ```\n- Step two.\n';
  const out = body(md, (doc) => annotate(doc, 'limit', { label: 'question', note: 'Per key?' }));
  assert.equal(out, `${md.trimEnd()}\n\n{>>[question] On "limit": Per key?<<}\n`);
});

const MERMAID = '# Title\n\n```mermaid\nflowchart LR\n    A --> B\n```\n\nAfter.\n';

test('a note on a Mermaid diagram goes below the fence', () => {
  const out = body(MERMAID, (doc) => blockNote(doc, 1, { label: 'question', note: 'Is B right?' }));
  assert.equal(out, '# Title\n\n```mermaid\nflowchart LR\n    A --> B\n```\n\n'
    + '{>>[question] Is B right?<<}\n\nAfter.\n');
});

test('text marked in a Mermaid source block has no line number', () => {
  const out = body(MERMAID, (doc) => annotate(doc, 'A --> B', { label: 'change', note: 'Flip' }));
  assert.ok(out.includes('```\n\n{>>[change] On "A --> B": Flip<<}\n\nAfter.'));
});

test('block notes work on every kind of block', () => {
  const md = '# Title\n\nA paragraph.\n\n- a list\n\n---\n\n| a |\n|---|\n| 1 |\n';
  const out = body(md, (doc) => doc.source.blocks.map((b, i) => blockNote(doc, i,
    { label: 'keep', note: i === 1 ? '' : `on ${b.type}` })));
  assert.equal(out, '# Title\n\n{>>[keep] on heading<<}\n\nA paragraph.\n\n{>>[keep]<<}\n\n'
    + '- a list\n\n{>>[keep] on list<<}\n\n---\n\n{>>[keep] on hr<<}\n\n'
    + '| a |\n|---|\n| 1 |\n\n{>>[keep] on table<<}\n');
});

test('reference-style links are taken into account when checking a block', () => {
  const md = 'See the [reference guide][ref] for details.\n\n[ref]: https://example.com/guide\n';
  const inside = body(md, (doc) => annotate(doc, 'guide', { label: 'keep' }));
  assert.equal(inside, 'See the [reference {==guide==}{>>[keep]<<}][ref] for details.\n\n'
    + '[ref]: https://example.com/guide\n');
  // "[ref]" in the note would become a link inside the link, which Markdown
  // does not allow: the outer link would fall apart.
  const nested = body(md, (doc) => annotate(doc, 'guide', { label: 'keep', note: 'see [ref]' }));
  assert.equal(nested, 'See the [reference guide][ref] for details.\n\n'
    + '{>>[keep] On "guide": see [ref]<<}\n\n[ref]: https://example.com/guide\n');
});

// ---- Blocks with no blank line after them ---------------------------------------

const blockTypes = (md) => marked.lexer(md).filter((t) => t.type !== 'space').map((t) => t.type);

test('a comment below a block keeps clear of text on the very next line', () => {
  // A caption directly under a diagram, as this project's own plans have.
  const md = '```mermaid\nflowchart LR\n    A --> B\n```\nCaption: how requests flow.\n\nAfter.\n';
  const out = body(md, (doc) => [
    blockNote(doc, 0, { label: 'question', note: 'Is B right?' }),
    blockNote(doc, 0, { label: 'keep', note: 'Nice' }),
  ]);
  // One extra newline after the comments, so the caption stays a paragraph
  // of its own instead of continuing the last comment.
  assert.equal(out, '```mermaid\nflowchart LR\n    A --> B\n```\n\n{>>[question] Is B right?<<}\n\n'
    + '{>>[keep] Nice<<}\n\nCaption: how requests flow.\n\nAfter.\n');
  assert.deepEqual(blockTypes(out), ['code', 'paragraph', 'paragraph', 'paragraph', 'paragraph']);
});

test('a comment below a block is not turned into a heading by a rule on the next line', () => {
  // "text" followed by a line of dashes is a heading in Markdown.
  const md = '| a |\n|---|\n| 1 |\n---\n\nAfter.\n';
  assert.deepEqual(blockTypes(md), ['table', 'hr', 'paragraph']);
  const out = body(md, (doc) => blockNote(doc, 0, { label: 'question', note: 'Why?' }));
  assert.equal(out, '| a |\n|---|\n| 1 |\n\n{>>[question] Why?<<}\n\n---\n\nAfter.\n');
  assert.deepEqual(blockTypes(out), ['table', 'paragraph', 'hr', 'paragraph']);
});

test('a heading with its paragraph on the next line', () => {
  const md = '# Title\nText right below.\n';
  const out = body(md, (doc) => [
    blockNote(doc, 0, { label: 'keep' }),
    annotate(doc, 'right below', { label: 'question', note: 'Where?' }),
  ]);
  assert.equal(out, '# Title\n\n{>>[keep]<<}\n\nText {==right below==}{>>[question] Where?<<}.\n');
});

// ---- Several annotations ------------------------------------------------------

test('the same phrase twice in one block: the annotated copy is wrapped', () => {
  const md = 'The limit applies per key. The limit resets hourly.\n';
  const second = body(md, (doc) => annotate(doc, 'The limit',
    { nth: 1, label: 'question', note: 'Which one?' }));
  assert.equal(second, 'The limit applies per key. {==The limit==}{>>[question] Which one?<<} '
    + 'resets hourly.\n');
  const first = body(md, (doc) => annotate(doc, 'The limit', { nth: 0, label: 'keep' }));
  assert.equal(first, '{==The limit==}{>>[keep]<<} applies per key. The limit resets hourly.\n');
});

test('two annotations in one paragraph, whatever order they were made in', () => {
  const expected = 'Use a {==token bucket==}{>>[keep]<<}. Buckets are refilled '
    + '{--lazily--}{>>[change] eagerly<<} on read so there is no job.\n';
  const inOrder = body(PARAGRAPH, (doc) => [
    annotate(doc, 'token bucket', { label: 'keep' }),
    annotate(doc, 'lazily', { kind: 'strike', label: 'change', note: 'eagerly' }),
  ]);
  const reversed = body(PARAGRAPH, (doc) => [
    annotate(doc, 'lazily', { kind: 'strike', label: 'change', note: 'eagerly' }),
    annotate(doc, 'token bucket', { label: 'keep' }),
  ]);
  assert.equal(inOrder, expected);
  assert.equal(reversed, expected);
});

test('two overlapping annotations: the second goes below the block', () => {
  const out = body(PARAGRAPH, (doc) => [
    annotate(doc, 'refilled lazily on read', { label: 'question', note: 'Why?' }),
    annotate(doc, 'lazily on read so there', { label: 'change', note: 'Reword' }),
  ]);
  assert.equal(out, 'Use a token bucket. Buckets are {==refilled lazily on read==}'
    + '{>>[question] Why?<<} so there is no job.\n\n'
    + '{>>[change] On "lazily on read so there": Reword<<}\n');
});

test('adjacent annotations keep their order in the text', () => {
  const md = 'Use a token-bucket limiter.\n';
  const expected = 'Use a {==token==}{>>[note] first half<<}{==-bucket==}'
    + '{>>[note] second half<<} limiter.\n';
  const inOrder = body(md, (doc) => [
    annotate(doc, 'token', { note: 'first half' }),
    annotate(doc, '-bucket', { note: 'second half' }),
  ]);
  const reversed = body(md, (doc) => [
    annotate(doc, '-bucket', { note: 'second half' }),
    annotate(doc, 'token', { note: 'first half' }),
  ]);
  assert.equal(inOrder, expected);
  assert.equal(reversed, expected);
  // Without comments the two wrappers simply touch.
  const bare = body(md, (doc) => [annotate(doc, '-bucket'), annotate(doc, 'token')]);
  assert.equal(bare, 'Use a {==token==}{==-bucket==} limiter.\n');
});

test('comments below one block come out in the order they were made', () => {
  const out = body(CODE, (doc) => [
    blockNote(doc, 1, { label: 'question', note: 'first' }),
    annotate(doc, 'return False', { label: 'change', note: 'second' }),
    blockNote(doc, 1, { label: 'keep', note: 'third' }),
  ]);
  assert.ok(out.includes('```\n\n{>>[question] first<<}\n\n'
    + '{>>[change] On code line 5 "return False": second<<}\n\n{>>[keep] third<<}\n\nAfter.'));
});

test('an inline mark at the very end of a block closes before the comment below', () => {
  const out = body('Hello world', (doc) => [
    blockNote(doc, 0, { label: 'keep', note: 'whole paragraph' }),
    annotate(doc, 'world', { label: 'question', note: 'Which?' }),
  ]);
  assert.equal(out, 'Hello {==world==}{>>[question] Which?<<}\n\n{>>[keep] whole paragraph<<}');
});

test('two notes that would break the block only as a pair: the second goes below', () => {
  // Each "*" alone is harmless. Together they would turn everything between
  // them into italics.
  const out = body(PARAGRAPH, (doc) => [
    annotate(doc, 'token', { label: 'question', note: 'a*b' }),
    annotate(doc, 'lazily', { label: 'question', note: 'c*d' }),
  ]);
  assert.equal(out, 'Use a {==token==}{>>[question] a*b<<} bucket. Buckets are refilled lazily '
    + 'on read so there is no job.\n\n{>>[question] On "lazily": c*d<<}\n');
});

// ---- Awkward notes ------------------------------------------------------------

test('"<<}" inside a note cannot end the comment early', () => {
  const out = body(PARAGRAPH, (doc) => annotate(doc, 'lazily',
    { label: 'question', note: 'ends <<} early, twice <<}' }));
  assert.ok(out.includes('{==lazily==}{>>[question] ends < <} early, twice < <}<<} on read'));
  assert.equal(stripMarkup(`legend\n\n${out}`), PARAGRAPH);
});

test('a stray backtick in a note stays inline when it is harmless', () => {
  const out = body(PARAGRAPH, (doc) => annotate(doc, 'refilled',
    { label: 'question', note: 'rename to `refill' }));
  assert.ok(out.includes('{==refilled==}{>>[question] rename to `refill<<} lazily'));
});

test('a stray backtick that would swallow later code goes below the block', () => {
  const md = 'Buckets are refilled lazily, see `take()` for details.\n';
  const out = body(md, (doc) => annotate(doc, 'refilled',
    { label: 'question', note: 'rename to `refill' }));
  assert.equal(out, `${md.trimEnd()}\n\n{>>[question] On "refilled": rename to \`refill<<}\n`);
});

test('Markdown in a note (*emphasis*, `code`) does not prevent the inline form', () => {
  const out = body(PARAGRAPH, (doc) => annotate(doc, 'lazily',
    { label: 'change', note: 'make this *eager*, like `take()` and **refill**' }));
  assert.ok(out.includes(
    '{==lazily==}{>>[change] make this *eager*, like `take()` and **refill**<<} on read',
  ));
});

test('an unclosed HTML tag in a note goes below the block', () => {
  const out = body(PARAGRAPH, (doc) => annotate(doc, 'lazily',
    { label: 'change', note: 'wrap in <details> please' }));
  assert.equal(out, `${PARAGRAPH.trimEnd()}\n\n`
    + '{>>[change] On "lazily": wrap in <details> please<<}\n');
});

test('a block that already contains CriticMarkup is left alone', () => {
  for (const mark of ['{==was==}', '{--was--}', '{>>was<<}', '{++was++}', '{~~was~>is~~}']) {
    const md = `This ${mark} marked already and has more text.\n\nA clean paragraph.\n`;
    const out = body(md, (doc) => [
      annotate(doc, 'more text', { label: 'question', note: 'Which?' }),
      annotate(doc, 'clean', { label: 'keep' }),
    ]);
    assert.equal(out, `This ${mark} marked already and has more text.\n\n`
      + '{>>[question] On "more text": Which?<<}\n\nA {==clean==}{>>[keep]<<} paragraph.\n');
  }
});

test('a long quote is shortened and its double quotes replaced', () => {
  const long = `say "${'word '.repeat(40)}" end`;
  const md = `\`\`\`\n${long}\n\`\`\`\n`;
  const out = body(md, (doc) => annotate(doc, long, { label: 'question', note: 'Long' }));
  const comment = out.slice(out.indexOf('{>>'));
  const quote = `say '${'word '.repeat(40)}' end`.slice(0, 120);
  assert.equal(comment, `{>>[question] On code line 1 "${quote}…": Long<<}\n`);
});

// ---- Unplaced, and distrust ---------------------------------------------------

test('unplaced annotations are listed at the end with their quotes', () => {
  const md = 'First paragraph.\n\nSecond paragraph.\n';
  const doc = openDoc(marked, md);
  const placed = annotate(doc, 'First', { label: 'keep' });
  const lostText = { ...annotate(doc, 'Second', { kind: 'strike', label: 'change',
    note: 'Still needed?' }) };
  lostText.target = { ...lostText.target, exact: 'deleted "words"' };
  const lostBlock = { ...blockNote(doc, 1, { label: 'question', note: 'Where did this go?' }) };
  lostBlock.target = { block: 9, exact: '## Old heading' };
  const lostBare = { ...blockNote(doc, 0, { label: 'important' }) };
  lostBare.target = { block: 9, exact: '' };

  const out = withoutLegend(exportDoc(doc, [lostText, placed, lostBlock, lostBare],
    { unplaced: [lostText.id, lostBlock.id, lostBare.id] }));
  assert.equal(out, [
    '{==First==}{>>[keep]<<} paragraph.',
    '',
    'Second paragraph.',
    '',
    '> **Unplaced reviewer notes.** The text these notes referred to is no longer in the document.',
    '',
    '{>>[strike, change] On "deleted \'words\'": Still needed?<<}',
    '',
    '{>>[question] On "## Old heading": Where did this go?<<}',
    '',
    '{>>[important]<<}',
    '',
  ].join('\n'));
});

test('the unplaced section starts on a new line when the file has no final newline', () => {
  const doc = openDoc(marked, 'Only paragraph.');
  const lost = annotate(doc, 'Only', { label: 'question', note: 'Gone' });
  const out = withoutLegend(exportDoc(doc, [lost], { unplaced: [lost.id] }));
  assert.equal(out, 'Only paragraph.\n\n> **Unplaced reviewer notes.** The text these notes '
    + 'referred to is no longer in the document.\n\n{>>[question] On "Only": Gone<<}\n');
});

test('an annotation resolved to a block that does not exist counts as unplaced', () => {
  const doc = openDoc(marked, 'Only paragraph.\n');
  const a = annotate(doc, 'Only', { label: 'keep' });
  const out = annotatedMarkdown(marked, doc.source, [a], {
    labels: DEFAULT_LABELS, resolved: { [a.id]: { block: 7, start: 0, end: 4 } }, texts: doc.texts,
  });
  assert.ok(out.endsWith('longer in the document.\n\n{>>[keep] On "Only"<<}\n'));
  // The same when no positions are given at all.
  const none = annotatedMarkdown(marked, doc.source, [a], { labels: DEFAULT_LABELS });
  assert.equal(none, out);
});

test('placement uses the resolved position, not the saved target', () => {
  const doc = openDoc(marked, 'One two three.\n\nFour five six.\n');
  const a = annotate(doc, 'five', { label: 'keep' });
  const moved = { ...a, target: { ...a.target, block: 0, start: 0, end: 4 } }; // stale
  const out = annotatedMarkdown(marked, doc.source, [moved], {
    labels: DEFAULT_LABELS, resolved: { [a.id]: a.target }, texts: doc.texts,
  });
  assert.equal(withoutLegend(out), 'One two three.\n\nFour {==five==}{>>[keep]<<} six.\n');
});

test('when block positions cannot be trusted, everything goes below its block', () => {
  const md = 'First paragraph.\n\n## Heading\n\nSecond paragraph.\n';
  const doc = openDoc(marked, md);
  doc.source = { ...doc.source, exact: false };
  const out = withoutLegend(exportDoc(doc, [
    annotate(doc, 'First', { label: 'keep' }),
    annotate(doc, 'Heading', { kind: 'strike', label: 'change', note: 'Rename' }),
    blockNote(doc, 2, { label: 'question', note: 'Why?' }),
  ]));
  assert.equal(out, 'First paragraph.\n\n{>>[keep] On "First"<<}\n\n## Heading\n\n'
    + '{>>[strike, change] On "Heading": Rename<<}\n\nSecond paragraph.\n\n'
    + '{>>[question] Why?<<}\n');
});

// ---- occurrence ---------------------------------------------------------------

test('occurrence says which copy of the words an annotation is on', () => {
  const key = 'Thelimitappliesperkey.Thelimitresetshourly.';
  assert.deepEqual(occurrence(key, 0, 'The limit'), { nth: 0, of: 2 });
  assert.deepEqual(occurrence(key, 22, 'The limit'), { nth: 1, of: 2 });
  assert.deepEqual(occurrence(key, 8, 'applies'), { nth: 0, of: 1 });
  // Overlapping copies are counted separately.
  assert.deepEqual(occurrence('aaa', 1, 'aa'), { nth: 1, of: 2 });
});

test('occurrence ignores emphasis characters on both sides', () => {
  // On the page: "refill_per_sec is set"; "per" starts after "refill_".
  assert.deepEqual(occurrence('refill_per_secisset', 7, 'per'), { nth: 0, of: 1 });
  assert.deepEqual(occurrence('a*b*c', 2, '*b*'), { nth: 0, of: 1 });
});

test('occurrence returns null when the position does not hold the words', () => {
  const key = 'Thelimitappliesperkey.';
  assert.equal(occurrence(key, 5, 'The limit'), null);
  assert.equal(occurrence(key, 0, 'missing'), null);
  assert.equal(occurrence(key, 0, ''), null);
  assert.equal(occurrence(key, 0, ' *_ '), null);
  assert.equal(occurrence(key, undefined, 'The'), null);
  assert.equal(occurrence(undefined, 0, 'The'), null);
});

// ---- findInSource -------------------------------------------------------------

test('findInSource finds plain words', () => {
  const src = 'Buckets are refilled lazily.';
  assert.deepEqual(findInSource(src, 'refilled lazily', 0, 1), { start: 12, end: 27 });
  assert.equal(src.slice(12, 27), 'refilled lazily');
});

test('findInSource picks the requested copy', () => {
  const src = 'The limit. The limit.';
  assert.deepEqual(findInSource(src, 'The limit', 0, 2), { start: 0, end: 9 });
  assert.deepEqual(findInSource(src, 'The limit', 1, 2), { start: 11, end: 20 });
});

test('findInSource refuses when the counts on page and in source differ', () => {
  const src = 'The limit. The limit.';
  assert.equal(findInSource(src, 'The limit', 0, 1), null);
  assert.equal(findInSource(src, 'The limit', 0, 3), null);
  assert.equal(findInSource(src, 'absent', 0, 1), null);
  assert.equal(findInSource(src, '', 0, 0), null);
  assert.equal(findInSource(src, 'The limit', 5, 2), null);
});

test('findInSource matches across emphasis marks and line breaks', () => {
  const src = 'Use a **token** bucket that\nis _refilled_ lazily.';
  const hit = findInSource(src, 'token bucket that is refilled', 0, 1);
  assert.equal(src.slice(hit.start, hit.end), 'token** bucket that\nis _refilled');
});

test('findInSource never spans a blank line', () => {
  assert.equal(findInSource('- one\n\n  two\n', 'one two', 0, 1), null);
});

test('findInSource includes emphasis marks that wrap the hit on both sides', () => {
  const cut = (src, exact) => {
    const hit = findInSource(src, exact, 0, 1);
    return src.slice(hit.start, hit.end);
  };
  assert.equal(cut('> **Decision:** fail open', 'Decision:'), '**Decision:**');
  assert.equal(cut('Set `capacity` to 600', 'capacity'), '`capacity`');
  assert.equal(cut('about _this_ much', 'this'), '_this_');
  assert.equal(cut('not ~~500~~ now', '500'), '~~500~~');
  assert.equal(cut('a **_nested_** one', 'nested'), '**_nested_**');
  // One side only, or different marks on each side: left as found.
  assert.equal(cut('**Hot keys.** One abusive', 'Hot keys. One'), 'Hot keys.** One');
  assert.equal(cut('**fail open** rather', 'open'), 'open');
  assert.equal(cut('a *mixed_ case', 'mixed'), 'mixed');
});

// ---- rendersTheSame -----------------------------------------------------------

const hitOn = (src, words) => {
  const start = src.indexOf(words);
  return { start, end: start + words.length };
};

test('rendersTheSame accepts markup in ordinary text', () => {
  const src = 'Buckets are **refilled** lazily on read.\n';
  assert.equal(rendersTheSame(marked, src, hitOn(src, 'lazily'), '{==', '==}', ''), true);
  assert.equal(rendersTheSame(marked, src, hitOn(src, 'lazily'), '{--', '--}',
    '{>>[change] not *lazily*, see `take()`<<}'), true);
  assert.equal(rendersTheSame(marked, src, hitOn(src, '**refilled**'), '{==', '==}',
    '{>>[keep]<<}'), true);
});

test('rendersTheSame refuses a split table row', () => {
  const hit = hitOn(TABLE, '600');
  assert.equal(rendersTheSame(marked, TABLE, hit, '{==', '==}', '{>>[question] ok<<}'), true);
  assert.equal(rendersTheSame(marked, TABLE, hit, '{==', '==}', '{>>[question] a | b<<}'), false);
});

test('rendersTheSame refuses markup that a code span would swallow', () => {
  const src = 'Buckets, see `take()` for details.\n';
  // Inside the code span.
  assert.equal(rendersTheSame(marked, src, hitOn(src, 'take'), '{==', '==}', ''), false);
  // The closing half inside the code span.
  assert.equal(rendersTheSame(marked, src, hitOn(src, 'see `take'), '{==', '==}', ''), false);
  // A backtick in the comment pairs up with the code span after it.
  assert.equal(rendersTheSame(marked, src, hitOn(src, 'Buckets'), '{==', '==}',
    '{>>[question] a ` here<<}'), false);
  // The whole span is fine.
  assert.equal(rendersTheSame(marked, src, hitOn(src, '`take()`'), '{==', '==}', ''), true);
});

test('rendersTheSame refuses markup inside a code block, a link address or an image', () => {
  const list = '- Step:\n\n  ```js\n  const limit = 600;\n  ```\n';
  assert.equal(rendersTheSame(marked, list, hitOn(list, 'limit'), '{==', '==}', ''), false);
  const auto = 'Visit https://example.com/path now.\n';
  assert.equal(rendersTheSame(marked, auto, hitOn(auto, 'path'), '{==', '==}', ''), false);
  const link = 'See [docs](http://x.y/guide) now.\n';
  assert.equal(rendersTheSame(marked, link, hitOn(link, 'guide'), '{==', '==}', ''), false);
  const image = 'An ![alt words](x.png) image.\n';
  assert.equal(rendersTheSame(marked, image, hitOn(image, 'words'), '{==', '==}', ''), false);
});

test('rendersTheSame refuses a comment that leaves an HTML tag open', () => {
  const src = 'Buckets are refilled lazily.\n';
  const hit = hitOn(src, 'refilled');
  assert.equal(rendersTheSame(marked, src, hit, '{==', '==}', '{>>[note] use <b> here<<}'), false);
  assert.equal(rendersTheSame(marked, src, hit, '{==', '==}',
    '{>>[note] use <b>bold</b> here<<}'), true);
  assert.equal(rendersTheSame(marked, src, null, '{==', '==}', ''), false);
});

test('rendersTheSame can be given the link definitions a block depends on', () => {
  const src = 'See the [reference guide][ref] for details.\n';
  const defs = '\n\n[ref]: https://example.com/guide\n';
  const hit = hitOn(src, 'guide');
  const nested = '{>>[keep] see [ref]<<}';
  // On its own the block holds no link, so nothing looks broken.
  assert.equal(rendersTheSame(marked, src, hit, '{==', '==}', nested), true);
  assert.equal(rendersTheSame(marked, src, hit, '{==', '==}', nested, defs), false);
  assert.equal(rendersTheSame(marked, src, hit, '{==', '==}', '{>>[keep]<<}', defs), true);
});

// ---- codeLineOf ---------------------------------------------------------------

test('codeLineOf counts lines inside a fenced block', () => {
  const block = '```python\ndef take(self):\n    tokens = 5\n\n'
    + '    if tokens < 1:\n        return\n```';
  // Squeezed code: "deftake(self):" (14) "tokens=5" (8) "iftokens<1:" (11) "return" (6)
  assert.equal(codeLineOf(block, 0), 1);
  assert.equal(codeLineOf(block, 13), 1);
  assert.equal(codeLineOf(block, 14), 2);
  assert.equal(codeLineOf(block, 21), 2);
  assert.equal(codeLineOf(block, 22), 4); // the blank line 3 holds no characters
  assert.equal(codeLineOf(block, 33), 5);
  assert.equal(codeLineOf(block, 38), 5);
  assert.equal(codeLineOf(block, 39), null); // past the end
  assert.equal(codeLineOf(`${block}\n\n`, 22), 4);
});

test('codeLineOf handles other fences, indented code and unclosed blocks', () => {
  assert.equal(codeLineOf('~~~\none\ntwo\n~~~', 3), 2);
  assert.equal(codeLineOf('    line one\n    line two\n', 7), 2);
  assert.equal(codeLineOf('```js\nlet a;\nlet b;', 5), 2); // no closing fence
  // A shorter fence inside a longer one is code, not the end of the block.
  assert.equal(codeLineOf('````md\n```\ninner\n```\n````', 3), 2);
  assert.equal(codeLineOf('````md\n```\ninner\n```\n````', 8), 3);
});

test('codeLineOf gives null for Mermaid and for nonsense positions', () => {
  assert.equal(codeLineOf('```mermaid\nflowchart LR\n    A --> B\n```', 0), null);
  assert.equal(codeLineOf('``` mermaid\nflowchart LR\n```', 0), null);
  assert.equal(codeLineOf('```js\nlet a;\n```', -1), null);
  assert.equal(codeLineOf('```js\nlet a;\n```', 1.5), null);
  assert.equal(codeLineOf('```js\nlet a;\n```', undefined), null);
  assert.equal(codeLineOf('', 0), null);
});

// ---- Whole documents ----------------------------------------------------------

// A document with the awkward corners of Markdown that the three fixtures do
// not have: blocks with no blank line between them, reference links, raw
// HTML, nested lists and quotes, code and a table inside a list, escapes.
const AWKWARD = [
  'Setext title',
  '============',
  '',
  'Intro with a [reference link][ref], an ![image alt](pic.png "title"), a hard  ',
  'break, an autolink <https://example.com/a_b_c>, a bare https://example.com/x_y_z link,',
  '\\*escaped stars\\*, an entity &amp; &copy;, <kbd>Ctrl</kbd>+<kbd>Z</kbd> and a footnote[^1].',
  '',
  '[ref]: https://example.com/ref "Ref title"',
  '',
  '# ATX heading with `code` and **bold** #',
  'Paragraph right under a heading, no blank line.',
  '- list right under a paragraph',
  '- second *item* with _two_ kinds of **emphasis** and ~~strike~~',
  '> quote right under a list',
  '> - list inside quote',
  '> - another `one`',
  '>',
  '> > nested quote with **bold**',
  '',
  '1. First',
  '',
  '   Second paragraph of first item.',
  '',
  '   ```js',
  '   const inList = "code inside a list";',
  '   ```',
  '',
  '   | t | in list |',
  '   |---|---------|',
  '   | a | b \\| c |',
  '',
  '2. Second with <span title="x > y">inline html</span>',
  '   continued lazily',
  'on the next line.',
  '',
  '| Left | Center | Right |',
  '|:-----|:------:|------:|',
  '| `a` | **bold** cell | 1 < 2 |',
  '| [link](http://x.y/z) | _em_ | a*b*c |',
  '---',
  '***',
  '',
  '    indented code block',
  '    second line',
  '',
  '<div align="center">',
  '',
  'Markdown inside an *html* block gap.',
  '',
  '</div>',
  '',
  '```mermaid',
  'flowchart LR',
  '    A --> B',
  '```',
  'Caption: right under the diagram.',
  '',
  'Final line with trailing spaces   ',
  'and snake_case_words and 2*3*4 and a_b and **unclosed bold and `unclosed code.',
  '',
].join('\n');

// A small repeatable random number generator, so a failure can be reproduced.
function randomSource(seed) {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const NOTES = [
  '', '', 'Why?', 'Please reword this.', 'has | a pipe', 'a `stray backtick',
  '*emphasis* and `code` and **bold**', 'two\nlines\n\nand a gap', 'ends <<} early',
  'an open <b> tag', 'say "hi" & <wave>', 'under_score and * star and ~ tilde',
  'see https://example.com/a?b=c', '{==not ours==} {>>nor this', 'a > b and c < d',
  '[ref] and [x](y)', 'ends with a backslash \\', '$1 $& $$', 'x'.repeat(300),
];
const TEXT_KINDS = ['highlight', 'underline', 'strike'];

// Annotations on real phrases of the document: up to three per block, picked
// by word position, plus some block notes and two notes that are unplaced.
function randomAnnotations(doc, seed) {
  const random = randomSource(seed);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const made = [];
  doc.plain.forEach((text, block) => {
    const words = text.split(/\s+/).filter(Boolean);
    const count = Math.floor(random() * 4);
    for (let k = 0; k < count && words.length; k++) {
      const label = pick(DEFAULT_LABELS).id;
      const note = pick(NOTES);
      if (random() < 0.15) {
        made.push(blockNote(doc, block, { label, note }));
        continue;
      }
      const from = Math.floor(random() * words.length);
      const phrase = words.slice(from, from + 1 + Math.floor(random() * 5)).join(' ');
      // Words hold no whitespace, so the squeezed offset is the summed length
      // of the words before.
      const start = words.slice(0, from).join('').length;
      const end = start + phrase.replace(/\s+/g, '').length;
      const a = annotate(doc, words[0], { block, kind: pick(TEXT_KINDS), label, note });
      a.target = { ...a.target, start, end, exact: phrase };
      made.push(a);
    }
  });
  const lost = [
    annotate(doc, doc.plain[0].split(/\s+/)[0], { label: 'change', note: 'gone' }),
    blockNote(doc, 0, { label: 'question', note: pick(NOTES) }),
  ];
  // Shuffle, so the order of creation differs from the order in the document.
  const all = [...made, ...lost].sort(() => random() - 0.5);
  return { all, unplaced: lost.map((a) => a.id) };
}

// How many annotations were written inside their block: the closing marks
// left once every comment (and so every note) is taken out.
const inlineCount = (exported) => (exported.replace(/\{>>[\s\S]*?<<\}/g, '')
  .match(/==\}|--\}/g) || []).length;

// The HTML of an export with our markup cut out again. A comment standing on
// its own line is a paragraph of its own; one after quoted words is not.
function htmlWithoutMarkup(exportedBody) {
  return marked.parse(exportedBody)
    .replace(/<p>\{&gt;&gt;[\s\S]*?&lt;&lt;\}<\/p>\n/g, '')
    .replace(/\{&gt;&gt;[\s\S]*?&lt;&lt;\}/g, '')
    .replace(/\{==|==\}|\{--|--\}/g, '');
}

for (const file of FIXTURES) {
  test(`${file}: removing the markup gives back the original file`, () => {
    const md = readFixture(file);
    const doc = openDoc(marked, md);
    let inline = 0;
    let total = 0;
    for (let seed = 1; seed <= 25; seed++) {
      const { all, unplaced } = randomAnnotations(doc, seed);
      const out = exportDoc(doc, all, { unplaced });
      assert.equal(stripMarkup(out), md, `seed ${seed}`);
      assert.ok(out.endsWith('<<}\n'), `seed ${seed}: the unplaced notes close the file`);
      total += all.filter((a) => a.kind !== 'block').length;
      inline += inlineCount(out);
    }
    // The test would prove little if everything had gone below the blocks.
    assert.ok(inline > total / 4, `only ${inline} of ${total} text annotations were inline`);
  });

  test(`${file}: the annotated file still renders like the original`, () => {
    const md = readFixture(file);
    const doc = openDoc(marked, md);
    const original = marked.parse(md);
    for (let seed = 101; seed <= 115; seed++) {
      const { all } = randomAnnotations(doc, seed);
      const out = withoutLegend(exportDoc(doc, all));
      assert.equal(htmlWithoutMarkup(out), original, `seed ${seed}`);
    }
  });
}

test('an awkward document survives random annotations', () => {
  const doc = openDoc(marked, AWKWARD);
  assert.equal(doc.source.exact, true);
  const original = marked.parse(AWKWARD);
  // Where a block has no blank line after it, a comment below it brings one
  // extra newline (see the "next line" tests), so compare without counting
  // how many newlines sit between two lines.
  const lines = (text) => text.replace(/\n+/g, '\n');
  let inline = 0;
  let total = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const { all, unplaced } = randomAnnotations(doc, seed);
    const out = exportDoc(doc, all, { unplaced });
    assert.equal(lines(stripMarkup(out)), lines(AWKWARD), `seed ${seed}`);
    const placed = withoutLegend(exportDoc(doc, all));
    assert.equal(htmlWithoutMarkup(placed), original, `seed ${seed}`);
    total += all.filter((a) => a.kind !== 'block').length;
    inline += inlineCount(out);
  }
  assert.ok(inline > total / 4, `only ${inline} of ${total} text annotations were inline`);
});

// ---- Added after review ---------------------------------------------------------

test('a selection across two blocks counts as one annotation in the legend', () => {
  const doc = openDoc(marked, 'First paragraph here.\n\nSecond paragraph here.\n');
  const one = annotate(doc, 'First paragraph', { label: 'question' });
  const two = annotate(doc, 'Second paragraph', { label: 'question', note: 'Both?' });
  one.group = 'g1';
  two.group = 'g1';
  const out = exportDoc(doc, [one, two]);
  assert.ok(out.includes('> 1 annotation: 1 question.'), out.split('\n').slice(0, 4).join('\n'));
  // Both parts are still marked in the text.
  assert.ok(out.includes('{==First paragraph==}'));
  assert.ok(out.includes('{==Second paragraph==}{>>[question] Both?<<}'));
});
