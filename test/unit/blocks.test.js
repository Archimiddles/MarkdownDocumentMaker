import test from 'node:test';
import assert from 'node:assert/strict';
import { Marked } from 'marked';

import { renderBlocks } from '../../renderer/src/annotations/blocks.js';
import { FIXTURES, makeMarked, readFixture } from './helpers.js';

const marked = makeMarked();
const STAMPED = ['paragraph', 'heading', 'list', 'table', 'code', 'blockquote', 'hr'];

for (const file of FIXTURES) {
  test(`${file}: same HTML as marked.parse once the numbers are removed`, () => {
    const md = readFixture(file);
    const { html } = renderBlocks(marked, md);
    assert.equal(html.replace(/ data-block="\d+"/g, ''), marked.parse(md));
  });

  test(`${file}: block ranges are in order, do not overlap, and add up`, () => {
    const md = readFixture(file);
    const { blocks, src, exact } = renderBlocks(marked, md);
    assert.equal(exact, true);
    assert.equal(src, md);
    assert.ok(blocks.length > 5);
    let previousEnd = 0;
    for (const b of blocks) {
      assert.ok(STAMPED.includes(b.type), `unexpected type ${b.type}`);
      assert.ok(b.start >= previousEnd, 'blocks overlap or are out of order');
      assert.ok(b.end > b.start, 'empty block');
      // These files have no raw HTML blocks or link definitions, so only
      // blank lines may sit between two numbered blocks.
      assert.equal(src.slice(previousEnd, b.start).trim(), '');
      previousEnd = b.end;
    }
    assert.equal(src.slice(previousEnd).trim(), '');
  });

  test(`${file}: every block is numbered once, in order, and its slice is that block`, () => {
    const md = readFixture(file);
    const { html, blocks, src } = renderBlocks(marked, md);
    const numbers = Array.from(html.matchAll(/ data-block="(\d+)"/g), (m) => Number(m[1]));
    assert.deepEqual(numbers, blocks.map((_, i) => i));
    for (const b of blocks) {
      // Lexing the slice on its own must give back one token of that type.
      const [first] = marked.lexer(src.slice(b.start, b.end));
      assert.equal(first.type, b.type);
    }
  });
}

test('the number is written into the opening tag of each block', () => {
  const { html, blocks } = renderBlocks(marked, '# Title\n\nSome *text*.\n\n- one\n- two\n\n---\n');
  assert.equal(html, [
    '<h1 data-block="0">Title</h1>\n',
    '<p data-block="1">Some <em>text</em>.</p>\n',
    '<ul data-block="2">\n<li>one</li>\n<li>two</li>\n</ul>\n',
    '<hr data-block="3">\n',
  ].join(''));
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'paragraph', 'list', 'hr']);
});

test('block offsets point at the block source', () => {
  const md = '# Title\n\nFirst paragraph.\n\n```js\nconst a = 1;\n```\n\n> quoted\n';
  const { blocks, src } = renderBlocks(marked, md);
  const slices = blocks.map((b) => src.slice(b.start, b.end).trimEnd());
  assert.deepEqual(slices, [
    '# Title', 'First paragraph.', '```js\nconst a = 1;\n```', '> quoted',
  ]);
});

test('Windows and old-Mac line endings give the same blocks as \\n', () => {
  for (const file of FIXTURES) {
    const unix = readFixture(file);
    const expected = renderBlocks(marked, unix);
    for (const eol of ['\r\n', '\r']) {
      const other = renderBlocks(marked, unix.replace(/\n/g, eol));
      assert.equal(other.src, unix);
      assert.deepEqual(other.blocks, expected.blocks);
      assert.equal(other.html, expected.html);
      assert.equal(other.exact, true);
    }
  }
});

test('blank lines, link definitions and raw HTML blocks get no number', () => {
  const md = [
    'A paragraph with a [link][ref].',
    '',
    '[ref]: https://example.com',
    '',
    '<div class="box">raw html</div>',
    '',
    'Last paragraph.',
    '',
  ].join('\n');
  const { html, blocks, exact } = renderBlocks(marked, md);
  assert.equal(exact, true);
  assert.deepEqual(blocks.map((b) => b.type), ['paragraph', 'paragraph']);
  assert.equal(html.replace(/ data-block="\d+"/g, ''), marked.parse(md));
  assert.ok(html.includes('<div class="box">raw html</div>'));
  assert.ok(!/<div[^>]*data-block/.test(html));
  // The reference-style link still resolves when rendered block by block.
  assert.ok(html.includes('<a href="https://example.com">link</a>'));
});

test('an empty document gives no blocks', () => {
  assert.deepEqual(renderBlocks(marked, ''), { html: '', blocks: [], src: '', exact: true });
});

test('works with a renderer that has no walkTokens hook', () => {
  const plain = new Marked(); // no marked-highlight, so no hook to call
  const md = 'Text.\n\n```js\nlet a;\n```\n';
  const { html, blocks } = renderBlocks(plain, md);
  assert.equal(html.replace(/ data-block="\d+"/g, ''), plain.parse(md));
  assert.equal(blocks.length, 2);
});
