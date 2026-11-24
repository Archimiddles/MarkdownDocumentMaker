import test from 'node:test';
import assert from 'node:assert/strict';

import {
  squeeze, locate, locateBlock, occurrenceOf, blockOccurrenceOf,
} from '../../renderer/src/annotations/match.js';

// ---- squeeze ------------------------------------------------------------------

test('squeeze removes every kind of whitespace', () => {
  assert.equal(squeeze(' a b\tc\nd\r\n e f '), 'abcdef');
  assert.equal(squeeze(''), '');
  assert.equal(squeeze(null), '');
  assert.equal(squeeze(undefined), '');
  assert.equal(squeeze(42), '42');
});

// ---- locate -------------------------------------------------------------------

test('the quote is still where it was saved', () => {
  const texts = ['Intro', 'Eachkeygetsafixedwindowof60seconds'];
  const target = {
    block: 1, start: 12, end: 23, exact: 'fixed window',
    prefix: 'Each key gets a ', suffix: ' of 60',
  };
  assert.deepEqual(locate(target, texts), { block: 1, start: 12, end: 23 });
});

test('indistinguishable copies and nothing saved about them: only the same place counts', () => {
  const texts = ['abcabc', 'abc'];
  const target = { block: 0, start: 3, end: 6, exact: 'abc', prefix: '', suffix: '' };
  assert.deepEqual(locate(target, texts), { block: 0, start: 3, end: 6 });
});

test('re-attaches after a paragraph is inserted above', () => {
  // Saved when the sentence was block 1. It is now block 2.
  const target = {
    block: 1, start: 12, end: 23, exact: 'fixed window',
    prefix: 'Each key gets a ', suffix: ' of 60',
  };
  const texts = ['Intro', 'Brandnewparagraph', 'Eachkeygetsafixedwindowof60seconds'];
  assert.deepEqual(locate(target, texts), { block: 2, start: 12, end: 23 });
});

test('re-attaches after words are added earlier in the same block', () => {
  const target = {
    block: 0, start: 12, end: 23, exact: 'fixed window',
    prefix: 'Each key gets a ', suffix: ' of 60',
  };
  const texts = ['Bydefaulteachkeygetsafixedwindowof60seconds'];
  assert.deepEqual(locate(target, texts), { block: 0, start: 21, end: 32 });
});

test('a phrase repeated in two blocks is told apart by its neighbours', () => {
  const texts = [
    'Thelimitis600perminuteforfreekeys',
    'Inserted',
    'Thelimitis600perminuteforpaidkeys',
  ];
  const target = {
    block: 1, start: 10, end: 13, exact: '600',
    prefix: 'The limit is ', suffix: ' per minute for paid',
  };
  // Both copies have the matching prefix; only the second has the suffix.
  assert.deepEqual(locate(target, texts), { block: 2, start: 10, end: 13 });
});

test('identical copies: where the note used to be is not evidence', () => {
  // Neither copy is at the saved place, and nothing says which one it was.
  const texts = ['thecapacity', 'x', 'y', 'z', 'thecapacity'];
  const target = { block: 3, start: 0, end: 8, exact: 'capacity', prefix: 'the ', suffix: '' };
  assert.equal(locate(target, texts), null);
});

test('identical copies: "the 2nd of 3" survives blocks being inserted above', () => {
  const line = 'Hardtoundo:no.Revertingthetwonewlinesrestoresit.';
  const before = ['intro', line, 'a', line, 'b', line];
  const saved = {
    block: 3, start: 0, end: 10, exact: 'Hard to undo', prefix: '', suffix: ': no. Reverting the two new lines',
  };
  const occurrence = occurrenceOf(saved, before, { block: 3, start: 0 });
  assert.deepEqual(occurrence, { nth: 1, of: 3 });
  // Five blocks appear at the top: every copy moves, the old index now holds
  // nothing, and the nearest copy (block 6) is the WRONG one.
  const after = ['1', '2', '3', '4', '5', ...before];
  assert.deepEqual(locate({ ...saved, occurrence }, after), { block: 8, start: 0, end: 10 });
  // Exactly enough blocks to put the first copy where the second used to be.
  const shifted = ['1', '2', ...before];
  assert.deepEqual(locate({ ...saved, occurrence }, shifted), { block: 5, start: 0, end: 10 });
});

test('identical copies: a different number of copies than was saved is refused', () => {
  const line = 'Hardtoundo:no.';
  const saved = {
    block: 1, start: 0, end: 10, exact: 'Hard to undo', prefix: '', suffix: ': no.', occurrence: { nth: 1, of: 2 },
  };
  assert.equal(locate(saved, [line, line, line]), null);
  assert.deepEqual(locate(saved, [line, line]), { block: 1, start: 0, end: 10 });
});

test('occurrenceOf is null when no other copy looks the same', () => {
  const texts = ['Eachkeygetsafixedwindowof60seconds', 'anotherfixedwindowhere'];
  const target = { block: 0, start: 12, end: 23, exact: 'fixed window', prefix: 'Each key gets a ', suffix: ' of 60' };
  assert.equal(occurrenceOf(target, texts, { block: 0, start: 12 }), null);
});

test('a table row inserted above: the note stays on its own row', () => {
  // Rows "A yes", "B yes", "C yes"; the note is on B's "yes".
  const before = ['SettingValueAyesByesCyes'];
  const target = { block: 0, start: 17, end: 20, exact: 'yes', prefix: 'Setting Value A yes B ', suffix: ' C yes' };
  assert.deepEqual(locate(target, before), { block: 0, start: 17, end: 20 });
  // A row "Z yes" goes in at the top. The old offset now lands on A's "yes".
  const after = ['SettingValueZyesAyesByesCyes'];
  assert.equal(after[0].slice(17, 20), 'yes');
  assert.deepEqual(locate(target, after), { block: 0, start: 21, end: 24 });
});

test('a character or two of matching context is not evidence', () => {
  // The text before one copy happens to end in the same letter as the saved prefix.
  const texts = ['themcapacityx', 'ourcapacityy'];
  const target = { block: 5, start: 0, end: 8, exact: 'capacity', prefix: 'maximum ', suffix: ' of the bucket' };
  assert.equal(locate(target, texts), null);
});

test('a short quote with no surviving context is not re-attached inside other words', () => {
  // "open" was deleted; its letters still occur across "to pending".
  const texts = ['movedtopendingstate'];
  const target = { block: 0, start: 4, end: 8, exact: 'open', prefix: 'fail ', suffix: ' rather than' };
  assert.equal(locate(target, texts), null);
});

test('repeated with no matching context: refuses to guess', () => {
  const texts = ['capacityisset', 'filler', 'thencapacitygrows'];
  const target = { block: 1, start: 0, end: 8, exact: 'capacity', prefix: '', suffix: '' };
  assert.equal(locate(target, texts), null);
  // Context that matches nowhere is as good as none.
  const stale = { ...target, prefix: 'old words ', suffix: ' old words' };
  assert.equal(locate(stale, texts), null);
});

test('a unique phrase is found even when its neighbours changed', () => {
  const texts = ['Completelyrewrittenaroundthefixedwindowidea'];
  const target = {
    block: 3, start: 12, end: 23, exact: 'fixed window',
    prefix: 'Each key gets a ', suffix: ' of 60',
  };
  assert.deepEqual(locate(target, texts), { block: 0, start: 28, end: 39 });
});

test('a true tie returns null', () => {
  // Same context, same distance from the original block (1): no way to choose.
  const texts = ['thecapacityhere', 'gone', 'thecapacityhere'];
  const target = {
    block: 1, start: 3, end: 11, exact: 'capacity', prefix: 'the ', suffix: ' here',
  };
  assert.equal(locate(target, texts), null);
});

test('two copies with the same context in one block are a tie too', () => {
  const texts = ['thecapacityhere,thecapacityhere'];
  const target = {
    block: 0, start: 50, end: 58, exact: 'capacity', prefix: 'the ', suffix: ' here',
  };
  assert.equal(locate(target, texts), null);
});

test('deleted text returns null', () => {
  const texts = ['Intro', 'Eachkeygetsaslidinglogof60seconds'];
  const target = {
    block: 1, start: 12, end: 23, exact: 'fixed window',
    prefix: 'Each key gets a ', suffix: ' of 60',
  };
  assert.equal(locate(target, texts), null);
});

test('an empty quote returns null', () => {
  const texts = ['Sometext'];
  assert.equal(locate({ block: 0, start: 0, end: 0, exact: '' }, texts), null);
  assert.equal(locate({ block: 0, start: 0, end: 4, exact: ' \n ' }, texts), null);
});

test('whitespace in the saved quote and context is ignored', () => {
  const texts = ['Bucketsarerefilledlazilyonreadsothere'];
  const target = {
    block: 0, start: 0, end: 5, exact: 'refilled\n  lazily on read',
    prefix: 'Buckets are ', suffix: ' so there',
  };
  assert.deepEqual(locate(target, texts), { block: 0, start: 10, end: 30 });
});

test('a saved block number beyond the end of the document is harmless', () => {
  const texts = ['onlyfixedwindowhere'];
  const target = { block: 9, start: 4, end: 15, exact: 'fixed window', prefix: '', suffix: '' };
  assert.deepEqual(locate(target, texts), { block: 0, start: 4, end: 15 });
  assert.equal(locate(target, []), null);
});

// ---- locateBlock --------------------------------------------------------------

test('locateBlock: the block is still at the same index', () => {
  const sources = ['#Title', 'Firstparagraphoftext', '```jscode```'];
  assert.equal(locateBlock({ block: 1, exact: 'First paragraph' }, sources), 1);
});

test('locateBlock: the same index wins even when another block starts alike', () => {
  const sources = ['-item', 'x', '-item'];
  assert.equal(locateBlock({ block: 2, exact: '- item' }, sources), 2);
});

test('locateBlock: follows a block that moved', () => {
  const sources = ['#Title', 'Anewparagraph', 'Firstparagraphoftext', '```jscode```'];
  assert.equal(locateBlock({ block: 1, exact: 'First paragraph' }, sources), 2);
});

test('locateBlock: several candidates and nothing saved about them: refuses', () => {
  const sources = ['|a|b|', 'x', 'y', 'changed', '|a|b|'];
  assert.equal(locateBlock({ block: 3, exact: '| a | b |' }, sources), null);
});

test('locateBlock: "the 2nd of 2" follows the block when others are inserted', () => {
  const before = ['|a|b|', 'x', '|a|b|'];
  const occurrence = blockOccurrenceOf({ block: 2, exact: '| a | b |' }, before, 2);
  assert.deepEqual(occurrence, { nth: 1, of: 2 });
  const after = ['new', 'new', ...before];
  assert.equal(locateBlock({ block: 2, exact: '| a | b |', occurrence }, after), 4);
  // One of the two tables is deleted: no longer "of 2", so refuse.
  assert.equal(locateBlock({ block: 2, exact: '| a | b |', occurrence }, ['x', '|a|b|', '|a|b|', '|a|b|']), null);
});

test('blockOccurrenceOf is null for a block that begins like no other', () => {
  assert.equal(blockOccurrenceOf({ block: 1, exact: 'First' }, ['#Title', 'Firstparagraph'], 1), null);
});

test('locateBlock: equally near candidates are ambiguous', () => {
  const sources = ['```mermaidflowchartLR', 'changed', '```mermaidflowchartLR'];
  assert.equal(locateBlock({ block: 1, exact: '```mermaid\nflowchart LR' }, sources), null);
});

test('locateBlock: the block is gone', () => {
  const sources = ['#Title', 'Somethingelse'];
  assert.equal(locateBlock({ block: 1, exact: 'First paragraph' }, sources), null);
});

test('locateBlock: with no excerpt the saved index is trusted if it exists', () => {
  const sources = ['#Title', 'Somethingelse'];
  assert.equal(locateBlock({ block: 1, exact: '' }, sources), 1);
  assert.equal(locateBlock({ block: 5, exact: '' }, sources), null);
  assert.equal(locateBlock({ block: -1, exact: '' }, sources), null);
});

// Block number 0 is a perfectly good answer. (It once came back as "not
// found", because JavaScript counts the number 0 as false.)
test('locateBlock: the first block of the document can be the one that is found', () => {
  // Two blocks begin alike and nothing is saved about copies: the note stays
  // where it was made, even when that is block 0.
  assert.equal(locateBlock({ block: 0, exact: '# Plan' }, ['#Plan', 'Intro.', '#PlanB', 'More.']), 0);
  assert.equal(locateBlock({ block: 0, exact: '## Notes' }, ['##Notes', 'One.', '##Notes', 'Two.']), 0);
  assert.equal(locateBlock({ block: 2, exact: '## Notes' }, ['##Notes', 'One.', '##Notes', 'Two.']), 2);
});

// ---- locateBlock with { whole: true } (section notes) ---------------------------
// A section note remembers its whole heading, so only a block that reads
// exactly the same may take it.

test('locateBlock whole: a heading that only begins the same way is not a match', () => {
  const sources = ['#Plan', 'Intro.', '##Risksandmitigations', 'Text.'];
  // Without `whole` the note would follow the longer heading...
  assert.equal(locateBlock({ block: 7, exact: '## Risks' }, sources), 2);
  // ...with it, the heading is gone and the note becomes unplaced.
  assert.equal(locateBlock({ block: 7, exact: '## Risks' }, sources, { whole: true }), null);
  assert.equal(locateBlock({ block: 5, exact: '## Step 1' }, ['##Step10', 'Text.'], { whole: true }), null);
});

test('locateBlock whole: the same heading is followed when it moves', () => {
  const sources = ['#Plan', 'New intro.', 'More.', '##Risks', 'Text.', '##Risksandmitigations'];
  assert.equal(locateBlock({ block: 2, exact: '## Risks' }, sources, { whole: true }), 3);
  // Spaces do not matter, as everywhere else.
  assert.equal(locateBlock({ block: 2, exact: '##   Risks ' }, sources, { whole: true }), 3);
});

test('locateBlock whole: a longer heading nearby does not make the right one ambiguous', () => {
  // By prefix both headings are candidates and, with nothing saved about
  // copies, a note that has moved cannot be told apart. Whole-heading
  // matching has only one candidate.
  const sources = ['Intro.', '##Risksandmitigations', 'Text.', '##Risks', 'Text.'];
  assert.equal(locateBlock({ block: 0, exact: '## Risks' }, sources), null);
  assert.equal(locateBlock({ block: 0, exact: '## Risks' }, sources, { whole: true }), 3);
});

test('blockOccurrenceOf whole: only identical headings count as copies', () => {
  const sources = ['##Notes', 'One.', '##Notesonpricing', 'Two.', '##Notes', 'Three.'];
  // By prefix there are three blocks that begin "## Notes"...
  assert.deepEqual(blockOccurrenceOf({ block: 4, exact: '## Notes' }, sources, 4), { nth: 2, of: 3 });
  // ...but only two headings that ARE "## Notes".
  assert.deepEqual(blockOccurrenceOf({ block: 4, exact: '## Notes' }, sources, 4, { whole: true }), { nth: 1, of: 2 });
  assert.equal(blockOccurrenceOf({ block: 2, exact: '## Notes on pricing' }, sources, 2, { whole: true }), null);
});
