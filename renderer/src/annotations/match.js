// Finds a saved annotation again after the document has been re-rendered or
// edited. Pure text logic: no page (DOM) is needed.
//
// Everything here compares "squeezed" text: text with every whitespace
// character removed. Whitespace changes in too many places to be trusted
// (page breaks, code blocks, hard-wrapped Markdown), letters do not.
//
// The rule throughout is: never guess. Where a note used to be is NOT
// evidence of where it is now (rows get inserted, paragraphs move). Only two
// things count: the words around the quote, and, for several identical
// copies, which one of them it was ("the 2nd of 3").

export const squeeze = (s) => String(s ?? '').replace(/\s+/g, '');

// How many characters of matching surroundings count as real evidence. A
// character or two can match by coincidence.
const ENOUGH = 8;
// With no surroundings to go on, a quote this short is too easy to find by
// accident inside other words.
const MIN_UNIQUE = 8;

function sameAtEnd(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function sameAtStart(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

// Every place the quote occurs, in document order, each with a score: how
// many characters of the saved "words before" and "words after" still
// surround it there.
function findHits(target, texts) {
  const want = squeeze(target.exact);
  const hits = [];
  if (!want) return hits; // an empty quote would "match" everywhere
  const pre = squeeze(target.prefix);
  const post = squeeze(target.suffix);
  texts.forEach((text, b) => {
    if (typeof text !== 'string') return;
    for (let i = text.indexOf(want); i !== -1; i = text.indexOf(want, i + 1)) {
      const stop = i + want.length;
      const score = sameAtEnd(text.slice(Math.max(0, i - pre.length), i), pre)
        + sameAtStart(text.slice(stop, stop + post.length), post);
      hits.push({ block: b, start: i, end: stop, score });
    }
  });
  return hits;
}

// Several candidates look equally right. `known` is the saved { nth, of }.
function pickAmongEqual(candidates, known, isSamePlace) {
  if (known) {
    // Saved as "the 2nd of 3 identical copies". Still 3 copies -> the 2nd.
    const { nth, of } = known;
    return of === candidates.length && Number.isInteger(nth) && nth >= 0 && nth < of ? candidates[nth] : null;
  }
  // Nothing saved about copies (a note made a moment ago, before it was
  // first painted): only the exact same place is acceptable.
  return candidates.find(isSamePlace) || null;
}

// Find a saved quote again. `texts[n]` is block n's rendered text, squeezed.
// Returns { block, start, end } (offsets into texts[block]) or null when the
// quote is gone or we cannot tell which copy of it was meant.
export function locate(target, texts) {
  if (!target || !Array.isArray(texts)) return null;
  const hits = findHits(target, texts);
  if (hits.length === 0) return null; // the text is gone -> "Unplaced"

  const best = Math.max(...hits.map((h) => h.score));
  const top = hits.filter((h) => h.score === best);
  const available = squeeze(target.prefix).length + squeeze(target.suffix).length;
  let pick = null;
  if (top.length > 1) {
    // Identical copies (a line that is repeated in the document).
    pick = pickAmongEqual(top, target.occurrence,
      (h) => h.block === target.block && h.start === target.start);
  } else if (best >= Math.min(ENOUGH, available) && best > 0) {
    pick = top[0]; // one copy clearly has the right surroundings
  } else if (hits.length === 1 && squeeze(target.exact).length >= MIN_UNIQUE) {
    pick = top[0]; // surroundings rewritten, but the words exist only once
  }
  return pick ? { block: pick.block, start: pick.start, end: pick.end } : null;
}

// Which of several identical copies a found quote is: { nth, of }, or null
// when no other copy looks the same. Saved with the note (see locate).
// `target` must describe the quote where it is NOW (fresh prefix and suffix).
export function occurrenceOf(target, texts, hit) {
  if (!target || !Array.isArray(texts) || !hit) return null;
  const hits = findHits(target, texts);
  const mine = hits.find((h) => h.block === hit.block && h.start === hit.start);
  if (!mine) return null;
  const same = hits.filter((h) => h.score === mine.score);
  return same.length > 1 ? { nth: same.indexOf(mine), of: same.length } : null;
}

// The blocks whose Markdown source begins the way the note remembers.
function blockCandidates(target, sources) {
  const fp = squeeze(target.exact); // fp = fingerprint
  const found = [];
  if (!fp) return found;
  sources.forEach((source, n) => {
    if (typeof source === 'string' && source.startsWith(fp)) found.push(n);
  });
  return found;
}

// The same job for a note on a whole block (kind 'block'). `sources[n]` is
// the squeezed Markdown source of block n. The note remembers how its block
// began (target.exact); we look for the block that still begins that way.
// Returns the block's index or null.
export function locateBlock(target, sources) {
  if (!target || !Array.isArray(sources)) return null;
  const { block } = target;
  const valid = Number.isInteger(block) && block >= 0 && block < sources.length;
  if (!squeeze(target.exact)) return valid ? block : null; // nothing to compare: trust the number

  const found = blockCandidates(target, sources);
  if (found.length === 0) return null;
  if (found.length === 1) return found[0];
  // Several blocks begin the same way (two tables with the same header row).
  const pick = pickAmongEqual(found, target.occurrence, (n) => n === block);
  return pick === null || pick === undefined ? null : pick;
}

// Which of several blocks that begin alike block `n` is: { nth, of } or null.
export function blockOccurrenceOf(target, sources, n) {
  if (!target || !Array.isArray(sources)) return null;
  const found = blockCandidates(target, sources);
  const nth = found.indexOf(n);
  return found.length > 1 && nth !== -1 ? { nth, of: found.length } : null;
}
