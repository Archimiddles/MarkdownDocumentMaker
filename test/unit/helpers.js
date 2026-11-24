// Shared helpers for the unit tests. Not a test file itself (the runner only
// picks up *.test.js); esbuild bundles it into each test that imports it.
import fs from 'node:fs';
import path from 'node:path';
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js/lib/common';

import { renderBlocks } from '../../renderer/src/annotations/blocks.js';
import { squeeze } from '../../renderer/src/annotations/match.js';
import { annotatedMarkdown } from '../../renderer/src/annotations/export-md.js';
import { DEFAULT_LABELS } from '../../renderer/src/annotations/model.js';

export const FIXTURES = [
  'samples/sample-plan.md',
  'test/fixtures/edge-cases.md',
  'test/fixtures/mermaid.md',
];

// Paths are relative to the project root: scripts/test-unit.js runs the
// tests with that as the working directory.
export function readFixture(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

// The same Markdown renderer the app builds in renderer/src/app.js.
export function makeMarked() {
  const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const marked = new Marked(
    markedHighlight({
      emptyLangClass: 'hljs',
      langPrefix: 'hljs language-',
      highlight(code, lang) {
        const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
        try {
          return hljs.highlight(code, { language, ignoreIllegals: true }).value;
        } catch {
          return escapeHtml(code);
        }
      },
    }),
  );
  marked.setOptions({ gfm: true, breaks: false });
  return marked;
}

// Roughly what the reader sees: the HTML with tags removed and entities
// decoded. Good enough for tests; the app reads the real page instead.
export function plainText(html) {
  return html.replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

// Everything the export needs to know about one document.
//   source  { src, blocks, exact } from renderBlocks
//   plain   plain[n] = block n's text as shown on the page
//   texts   texts[n] = the same with whitespace removed
export function openDoc(marked, markdown) {
  const source = renderBlocks(marked, markdown);
  // "[ref]: https://..." lines, so a block rendered on its own still shows
  // its reference-style links as links, as the real page does.
  const defs = marked.lexer(source.src).filter((t) => t.type === 'def')
    .map((t) => t.raw.trim()).join('\n');
  const plain = source.blocks
    .map((b) => plainText(marked.parse(`${source.src.slice(b.start, b.end)}\n\n${defs}`)));
  return { marked, source, plain, texts: plain.map(squeeze) };
}

// Index of the first block whose page text contains `phrase`.
export function blockWith(doc, phrase) {
  const index = doc.texts.findIndex((t) => t.includes(squeeze(phrase)));
  if (index === -1) throw new Error(`No block contains "${phrase}"`);
  return index;
}

let counter = 0;

// An annotation on `phrase`, as the app would save it. props may hold
// { block, nth, kind, label, note }: `nth` picks the 2nd, 3rd... copy of the
// phrase inside the block (0 = first).
export function annotate(doc, phrase, props = {}) {
  const { nth = 0, kind = 'highlight', label = 'note', note = '' } = props;
  const block = props.block ?? blockWith(doc, phrase);
  const want = squeeze(phrase);
  let start = -1;
  for (let i = 0; i <= nth; i++) {
    start = doc.texts[block].indexOf(want, start + 1);
    if (start === -1) throw new Error(`"${phrase}" (copy ${i}) is not in block ${block}`);
  }
  return {
    id: `a${++counter}`,
    kind,
    label,
    note,
    target: { block, start, end: start + want.length, exact: phrase, prefix: '', suffix: '' },
    created: '2026-11-16T10:00:00.000Z',
    modified: '2026-11-16T10:00:00.000Z',
  };
}

// A note on a whole block.
export function blockNote(doc, block, props = {}) {
  const { label = 'note', note = '' } = props;
  const b = doc.source.blocks[block];
  const exact = doc.source.src.slice(b.start, b.end).trim().slice(0, 80);
  return {
    id: `a${++counter}`,
    kind: 'block',
    label,
    note,
    target: { block, exact },
    created: '2026-11-16T10:00:00.000Z',
    modified: '2026-11-16T10:00:00.000Z',
  };
}

// The block number of the heading written as `line` in the Markdown
// ("## Risks"). Headings inside code blocks do not count: they are code.
export function headingBlock(doc, line) {
  const index = doc.source.blocks.findIndex((b) => b.type === 'heading'
    && doc.source.src.slice(b.start, b.end).trim() === line);
  if (index === -1) throw new Error(`No heading "${line}"`);
  return index;
}

// A section note: the reviewer's own note on a whole section. `block` is the
// section's heading. It is saved the way the app saves it, like a note on a
// block: the heading's Markdown ("## Risks") is the text it remembers.
export function sectionNote(doc, block, note = '') {
  const b = doc.source.blocks[block];
  if (!b || b.type !== 'heading') throw new Error(`Block ${block} is not a heading`);
  const exact = doc.source.src.slice(b.start, b.end).replace(/\s+/g, ' ').trim().slice(0, 80);
  return {
    id: `a${++counter}`,
    kind: 'section',
    label: 'note', // the app always stores "note"; a section note has no colour
    note,
    target: { block, exact },
    created: '2026-11-16T10:00:00.000Z',
    modified: '2026-11-16T10:00:00.000Z',
  };
}

// Run the export. Every annotation counts as found exactly where it was
// made, except the ids listed in `unplaced`.
export function exportDoc(doc, annotations, { unplaced = [], labels = DEFAULT_LABELS } = {}) {
  const resolved = {};
  for (const a of annotations) {
    if (unplaced.includes(a.id)) continue;
    const { block, start, end } = a.target;
    // As in the app: a block note and a section note are found as a whole
    // block, a note on words also has the place of those words in it.
    const wholeBlock = a.kind === 'block' || a.kind === 'section';
    resolved[a.id] = wholeBlock ? { block } : { block, start, end };
  }
  return annotatedMarkdown(doc.marked, doc.source, annotations, {
    labels, resolved, texts: doc.texts, docName: 'test.md',
  });
}

// The export without the legend at the top (its "> " lines, three or four of
// them, and the blank line that follows).
export function withoutLegend(exported) {
  return exported.slice(exported.indexOf('\n\n') + 2);
}

// Undo the export: drop the legend, the "Unplaced" section and every comment,
// and unwrap {==x==} and {--x--}. What is left should be the original file.
export function stripMarkup(exported) {
  let text = withoutLegend(exported);
  const tail = text.indexOf('\n> **Unplaced reviewer notes.**');
  if (tail !== -1) text = text.slice(0, tail);
  return text
    .replace(/\n\n\{>>[\s\S]*?<<\}/g, '') // comments standing on their own line
    .replace(/\{>>[\s\S]*?<<\}/g, '') // comments right after the quoted words
    .replace(/\{==([\s\S]*?)==\}/g, '$1')
    .replace(/\{--([\s\S]*?)--\}/g, '$1');
}
