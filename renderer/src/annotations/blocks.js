// Renders Markdown one top-level block at a time, so every block on the page
// knows which slice of the Markdown source it came from. Pure text logic: no
// page (DOM) is needed, so this file also runs in plain Node for the tests.

// The block kinds a note can attach to. Blank lines (`space`), link
// definitions (`def`) and raw HTML blocks (`html`) get no number.
const STAMPED = new Set([
  'paragraph', 'heading', 'list', 'table', 'code', 'blockquote', 'hr',
]);

// Same HTML as marked.parse(), plus a data-block="N" attribute on the opening
// tag of each numbered block.
//   html    the rendered document
//   blocks  blocks[n] = { start, end, type }: where block n sits in `src`
//   src     the Markdown with Windows/old-Mac line endings turned into \n
//   exact   true when the block positions add up to the whole of `src`
// `stamp` is put in front of each number (data-block="k3f9-7"). The app passes
// a fresh random one per render and afterwards keeps only the attributes that
// carry it, so raw HTML inside a document cannot pass itself off as a block.
export function renderBlocks(marked, markdown, { stamp = '' } = {}) {
  const src = String(markdown ?? '').replace(/\r\n|\r/g, '\n'); // as marked does
  const tokens = marked.lexer(src);
  // marked-highlight colours code blocks through this hook. marked.parse()
  // calls it for us; because we drive the parser by hand, we call it too.
  const hook = marked.defaults && marked.defaults.walkTokens;
  if (hook) marked.walkTokens(tokens, hook);

  const blocks = [];
  let html = '';
  let pos = 0;
  for (const token of tokens) {
    const start = pos;
    pos += token.raw.length; // raw = the exact source text of this token
    let part = marked.parser([token]);
    if (STAMPED.has(token.type)) {
      // Write the number into the opening tag: <p data-block="7">
      part = part.replace(/^<([a-z][a-z0-9]*)/i, `<$1 data-block="${stamp}${blocks.length}"`);
      blocks.push({ start, end: pos, type: token.type });
    }
    html += part;
  }
  return { html, blocks, src, exact: pos === src.length };
}
