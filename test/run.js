#!/usr/bin/env node
// End-to-end check: launches the real app in test mode, which renders several
// layout/paper combinations, exports each to PDF through webContents.printToPDF
// and takes a screenshot. Then validates the PDFs with pdfinfo (poppler):
//   - the PDF page count equals the page count Paged.js showed in the preview
//   - the PDF page size matches the selected paper
//   - scenario-specific expectations (minimum pages, H2 breaks add pages, ...)
//   - every Mermaid diagram is on its page in one piece and keeps its colours,
//     and the preview zoom never changes where pages break or what they hold
//   - annotation scenarios: notes attach, no line of text moves, margin notes
//     are real text in the PDF (pdftotext), the Markdown export matches
// Usage: node test/run.js [--no-sandbox]
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const out = path.join(__dirname, 'output');
const electron = require('electron');
const extraArgs = process.argv.slice(2);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const sample = path.join(root, 'samples', 'sample-plan.md');
const edge = path.join(__dirname, 'fixtures', 'edge-cases.md');
const mermaidDoc = path.join(__dirname, 'fixtures', 'mermaid.md');
// A made-up plan with a tall flowchart placed where it cannot fit in what is
// left of the page (see "Diagrams and page breaks" below).
const tallDiagram = path.join(__dirname, 'fixtures', 'tall-diagram.md');
const sampleText = fs.readFileSync(sample, 'utf8');
// Annotation fixtures: a saved set of notes on the sample plan, the same plan
// after an edit, and the Markdown export those notes should produce.
const sampleNotes = path.join(__dirname, 'fixtures', 'sample.annotations.json');
const sampleEdited = path.join(__dirname, 'fixtures', 'sample-edited.md');
const sampleAnnotatedMd = path.join(__dirname, 'fixtures', 'sample.annotated.md');
const margin = { layout: 'margin', paper: 'letter', notes: 'medium', pattern: 'dots', breakH2: false };
const noteCount = fs.existsSync(sampleNotes) ? JSON.parse(fs.readFileSync(sampleNotes, 'utf8')).annotations.length : 0;
// The tall-diagram plan in each of the three layouts, on both papers, with
// and without a new page at each H2.
const tall = { mdFile: tallDiagram, minPages: 4, expectDiagrams: { rendered: 2, failed: 0 } };
// "Prints exactly like that other scenario": as many pages (samePagesAs), and
// on them the same words and the same picture (samePdfAs).
const printsLike = (name) => ({ samePagesAs: name, samePdfAs: name });
const tallMargin = { ...margin, breakH2: true };
const tallReview = { layout: 'review', paper: 'letter', notes: 'medium', pattern: 'dots', breakH2: false };
const tallDense = { layout: 'dense', paper: 'a4', notes: 'small', pattern: 'lines', breakH2: true };

const scenarios = [
  { name: 'review-letter-medium-dots', settings: { layout: 'review', paper: 'letter', notes: 'medium', pattern: 'dots', breakH2: false }, minPages: 2 },
  { name: 'margin-letter-dots', settings: { layout: 'margin', paper: 'letter', notes: 'medium', pattern: 'dots', breakH2: false }, minPages: 2 },
  { name: 'dense-letter-small-lines', settings: { layout: 'dense', paper: 'letter', notes: 'small', pattern: 'lines', breakH2: false }, minPages: 1 },
  { name: 'review-a4-large-lines', settings: { layout: 'review', paper: 'a4', notes: 'large', pattern: 'lines', breakH2: false }, minPages: 2 },
  { name: 'review-letter-nonotes-blank', settings: { layout: 'review', paper: 'letter', notes: 'none', pattern: 'blank', breakH2: false }, minPages: 1 },
  { name: 'review-letter-breakh2', settings: { layout: 'review', paper: 'letter', notes: 'medium', pattern: 'dots', breakH2: true }, minPages: 7, morePagesThan: 'review-letter-medium-dots' },
  { name: 'edge-cases-review-letter', settings: { layout: 'review', paper: 'letter', notes: 'medium', pattern: 'dots', breakH2: false }, mdFile: edge, minPages: 2 },
  { name: 'long-dense-letter', settings: { layout: 'dense', paper: 'letter', notes: 'small', pattern: 'dots', breakH2: false }, md: Array(4).fill(sampleText).join('\n\n---\n\n'), minPages: 6, maxMs: 30000 },
  { name: 'empty-review-letter', settings: { layout: 'review', paper: 'letter', notes: 'medium', pattern: 'dots', breakH2: false }, md: '', minPages: 1, maxPages: 1 },
  { name: 'mermaid-review-letter', settings: { layout: 'review', paper: 'letter', notes: 'medium', pattern: 'dots', breakH2: false }, mdFile: mermaidDoc, minPages: 2, expectDiagrams: { rendered: 5, failed: 1 } },
  { name: 'mermaid-margin-letter', settings: { layout: 'margin', paper: 'letter', notes: 'none', pattern: 'dots', breakH2: false }, mdFile: mermaidDoc, minPages: 2, expectDiagrams: { rendered: 5, failed: 1 } },

  // ---- Diagrams and page breaks ----
  // A tall flowchart that cannot fit under the text above it must move to the
  // next page in one piece and keep its colours (checked for every scenario,
  // see diagramProblems below). The zoom must not matter: it only scales the
  // finished pages, but it is still on them while the next render is laid
  // out, and that used to make Paged.js mis-measure. So each layout is
  // rendered with the preview at 100% (zoom: '1') and then again with it
  // zoomed in or out; the two must print exactly alike (printsLike).
  // 0.5, 0.75 and 1.25 are on the Zoom menu; 0.8 is what "Fit width" gives in
  // a narrow window, and is the zoom that tore the diagram in two.
  { name: 'tall-diagram-margin-letter', settings: { ...tallMargin, zoom: '1' }, ...tall },
  { name: 'tall-diagram-margin-letter-zoom80', settings: { ...tallMargin, zoom: '0.8' }, ...tall, ...printsLike('tall-diagram-margin-letter') },
  { name: 'tall-diagram-margin-letter-zoom50', settings: { ...tallMargin, zoom: '0.5' }, ...tall, ...printsLike('tall-diagram-margin-letter') },
  { name: 'tall-diagram-margin-letter-zoom125', settings: { ...tallMargin, zoom: '1.25' }, ...tall, ...printsLike('tall-diagram-margin-letter') },
  { name: 'tall-diagram-review-letter', settings: { ...tallReview, zoom: '1' }, ...tall },
  { name: 'tall-diagram-review-letter-zoom75', settings: { ...tallReview, zoom: '0.75' }, ...tall, ...printsLike('tall-diagram-review-letter') },
  { name: 'tall-diagram-dense-a4', settings: { ...tallDense, zoom: '1' }, ...tall },
  { name: 'tall-diagram-dense-a4-zoom75', settings: { ...tallDense, zoom: '0.75' }, ...tall, ...printsLike('tall-diagram-dense-a4') },
  // Belt and braces. With the zoom deliberately left on while the pages are
  // laid out (layoutUnderZoom, the old behaviour), Paged.js again chooses a
  // page break in the middle of the flowchart. The diagram must still reach
  // the next page in one piece, with its colours. Pages and text are not
  // compared here: the old behaviour loses text, which is the reason the
  // zoom is paused in the first place.
  { name: 'tall-diagram-kept-whole', settings: { ...tallMargin, zoom: '0.8', layoutUnderZoom: true }, ...tall },

  // ---- Annotations ----
  // A saved set of notes loads, every note attaches, nothing on the page moves,
  // the margin notes are real text in the PDF, and the export is as expected.
  { name: 'annotated-margin-letter', settings: margin, annotationsFile: sampleNotes, minPages: 2, samePagesAs: 'margin-letter-dots', expectNotes: { placed: noteCount, unplaced: 0 }, linesMustNotMove: true, marginHasNotes: true, expectMd: sampleAnnotatedMd, expectPainted: 'some' },
  // Notes made the way a user makes them: select the words, pick a tool.
  { name: 'annotated-by-selection', settings: margin, minPages: 2, samePagesAs: 'margin-letter-dots', linesMustNotMove: true,
    quotes: [
      { quote: 'refilled lazily on read', kind: 'highlight', label: 'question', note: 'Why lazily? What happens under burst load?' },
      { quote: 'fail open rather than fail closed', kind: 'strike', label: 'change', note: '' },
      { quote: 'Maximum burst per key', kind: 'underline', label: 'keep', note: 'Good default.' },
    ],
    expectNotes: { placed: 3, unplaced: 0, cards: 2 },
    marginText: ['Why lazily? What happens under burst load?', 'Good default.'],
    mdText: ['{==refilled lazily on read==}{>>[question] Why lazily? What happens under burst load?<<}', '{--fail open rather than fail closed--}{>>[change]<<}', '{==Maximum burst per key==}{>>[underline, keep] Good default.<<}'] },
  // A highlight on a block that Paged.js split across two pages is painted on
  // both pages and costs no text (same PDF text as the un-annotated run).
  { name: 'edge-cases-margin-letter', settings: margin, mdFile: edge, minPages: 2 },
  { name: 'annotated-page-break', settings: margin, mdFile: edge, acrossBreak: true, minPages: 2, samePagesAs: 'edge-cases-margin-letter', samePdfTextAs: 'edge-cases-margin-letter', linesMustNotMove: true, expectAcrossBreak: true },
  // The same notes still attach after the pages are laid out differently.
  { name: 'annotated-relayout', settings: margin, annotationsFile: sampleNotes, relayout: { paper: 'a4', breakH2: true }, minPages: 2, expectNotes: { placed: noteCount, unplaced: 0 } },
  // After an edit (one paragraph added, one annotated sentence deleted) every
  // other note finds its words again and the lost one is kept as "unplaced".
  // (The export is checked too: each surviving note must be on its own words, not merely "placed".)
  { name: 'reanchor-after-edit', settings: margin, annotationsFile: sampleNotes, editedMdFile: sampleEdited, minPages: 2, expectNotes: { placed: noteCount - 1, unplaced: 1 },
    mdText: ['Unplaced reviewer notes',
      '{==roughly 40k requests in ten minutes==}{>>[important] Add the source for this figure.<<}',
      '{==refilled lazily on read==}{>>[question] Why lazily? What happens under burst load?<<}',
      '{==Maximum burst per key==}{>>[underline, keep] Good default.<<}',
      '{==Integration: 601 requests in a burst produce exactly one==}{>>[question] Why 601 and not 600?<<}',
      '{==**Clock skew between app nodes.**==}{>>[important]<<}',
      'On "The read-modify-write above is racy under concurrency."'] },
  // "Hide" gives a clean printout: same pages, no note text, no colour.
  { name: 'annotated-hidden', settings: margin, annotationsFile: sampleNotes, hidden: true, minPages: 2, samePagesAs: 'margin-letter-dots', marginHasNotes: false, expectPainted: 'none' },
  // A document with a real file behind it: notes are written to a sidecar
  // beside it through the real save path, the Markdown itself is untouched,
  // and after "the app restarts" the notes come back FROM THE FILE (one note
  // is removed from the file in between; the app must not put it back).
  { name: 'sidecar-roundtrip', settings: margin, mdFile: sample, docFile: sample, minPages: 2,
    quotes: [
      { quote: 'refilled lazily on read', kind: 'highlight', label: 'question', note: 'Why lazily?' },
      { quote: 'Maximum burst per key', kind: 'underline', label: 'keep', note: 'Good default.' },
      { quote: 'Sustained rate', kind: 'highlight', label: 'note', note: '' },
    ],
    expectPersist: { status: 'ok', saved: 3, restored: 2, markdownUntouched: true },
    expectNotes: { placed: 2, unplaced: 0 } },
  // Opening a file and never annotating it leaves no notes file behind.
  { name: 'file-without-notes', settings: margin, mdFile: sample, docFile: sample, minPages: 2,
    expectPersist: { status: 'none', restored: 0, sidecarExists: false, markdownUntouched: true } },
];

const env = {
  ...process.env,
  PLAN_PRINTER_TEST_OUT: out,
  PLAN_PRINTER_TEST_SCENARIOS: JSON.stringify(scenarios.map(({ name, settings, md, mdFile, annotationsFile, quotes, acrossBreak, relayout, editedMdFile, hidden, docFile }) => (
    { name, settings, md, mdFile, annotationsFile, quotes, acrossBreak, relayout, editedMdFile, hidden, docFile }))),
};

console.log(`Launching Electron test mode (${scenarios.length} scenarios)…`);
const run = spawnSync(electron, [root, ...extraArgs], { env, encoding: 'utf8', timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
const noise = /Gtk-Message|dbus|libva|MESA|Fontconfig|GLib-GObject|ozone|Failed to connect to the bus|DRI3|Vulkan|skia/i;
const stderrLines = (run.stderr || '').split('\n').filter((l) => l.trim() && !noise.test(l));
if (stderrLines.length) console.log('stderr (filtered):\n  ' + stderrLines.slice(0, 40).join('\n  '));
if (run.error) {
  console.error('Failed to launch Electron:', run.error);
  process.exit(2);
}

const reportPath = path.join(out, 'report.json');
if (!fs.existsSync(reportPath)) {
  console.error(`No report written (exit code ${run.status}, signal ${run.signal}).`);
  if (SANDBOX_HINT(run.stderr)) console.error('Hint: Chromium sandbox failed; rerun with: node test/run.js --no-sandbox');
  process.exit(2);
}
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
if (report.error) {
  console.error('Test mode reported an error:\n' + report.error);
  process.exit(2);
}
// The app must never talk to the network: no hosted renderers, no API keys.
const external = report.externalRequests || [];
if (external.length) {
  console.log(`FAIL network: ${external.length} external request(s) were made:\n  - ` + external.map((r) => `${r.resourceType} ${r.url}`).join('\n  - '));
} else {
  console.log('ok   network: no external requests were made by any scenario');
}

function SANDBOX_HINT(s) { return /SUID sandbox helper|chrome-sandbox/.test(s || ''); }

function pdfInfo(file) {
  const text = execFileSync('pdfinfo', [file], { encoding: 'utf8' });
  const pages = Number((/Pages:\s+(\d+)/.exec(text) || [])[1]);
  const size = /Page size:\s+([\d.]+) x ([\d.]+)/.exec(text);
  return { pages, width: size ? Number(size[1]) : NaN, height: size ? Number(size[2]) : NaN };
}

// All the text of a PDF, or only the text in the right-hand margin column of a
// US Letter page in the Margin notes layout (where typed notes are printed).
function pdfText(file, marginOnly = false) {
  const crop = marginOnly ? ['-r', '72', '-x', '425', '-y', '0', '-W', '187', '-H', '792'] : [];
  return execFileSync('pdftotext', [...crop, file, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
// Notes wrap in the narrow column, so compare with all whitespace removed.
const squeeze = (t) => String(t).replace(/\s+/g, '');
// A PDF as a picture: every page drawn small and grey, one after the other.
// Two PDFs that print alike give exactly the same bytes.
function pdfPixels(file) {
  return execFileSync('pdftoppm', ['-gray', '-r', '40', file], { maxBuffer: 256 * 1024 * 1024 });
}

// What is wrong with the Mermaid diagrams on the pages of one scenario (an
// empty list when all is well). `rendered` is how many diagrams the document
// has; `figures` describes each one found on the pages (the diagramsOnPages
// test hook in renderer/src/app.js).
// Mermaid colours a diagram with CSS that only matches the <svg>'s own id.
// If a page break lands inside a diagram, Paged.js continues it on the next
// page under a copy of the <svg> without that id, and every shape there
// falls back to the SVG default: solid black.
function diagramProblems({ rendered, figures }) {
  const found = [];
  const BLACK = 'rgb(0, 0, 0)';
  if (figures.length !== rendered) found.push(`${rendered} diagram(s) rendered but ${figures.length} found on the pages`);
  const refs = new Set();
  for (const f of figures) {
    const where = `the diagram on page ${f.page}`;
    if (f.piece || refs.has(f.ref)) found.push(`${where} is one piece of a diagram that was split across pages`);
    refs.add(f.ref);
    if (f.svgs !== 1) {
      found.push(`${where} holds ${f.svgs} <svg> elements, expected exactly 1`);
    } else {
      if (!f.id) found.push(`${where} lost its id, so its styles no longer apply`);
      if (f.styles !== 1) found.push(`${where} has ${f.styles} <style> elements, expected exactly 1`);
      else if (f.id && !f.cssMatchesId) found.push(`${where} has styles written for a different id than its own`);
      if (!f.shapes) found.push(`${where} is empty (no shapes or text inside)`);
      if (f.nodeFill === BLACK) found.push(`${where} is drawn without its styles (its boxes are solid black)`);
    }
    if (!f.onPage) found.push(`${where} is not inside the page's text area (cut off or out of sight)`);
  }
  return found;
}

const EXPECTED_SIZE = { letter: [612, 792], a4: [595.28, 841.89] };
const byName = {};
let failures = 0;
const rows = [];

for (const scenario of scenarios) {
  const r = report.scenarios.find((s) => s.name === scenario.name);
  const problems = [];
  if (!r) {
    problems.push('missing from report');
  } else {
    if (r.error) problems.push(`render error: ${r.error}`);
    const pdfPath = path.join(out, r.pdf);
    let info = { pages: NaN, width: NaN, height: NaN };
    try { info = pdfInfo(pdfPath); } catch (e) { problems.push(`pdfinfo failed: ${e.message}`); }
    byName[scenario.name] = { ...r, pdfPages: info.pages };
    const [ew, eh] = EXPECTED_SIZE[{ ...scenario.settings, ...(scenario.relayout || {}) }.paper];
    if (Math.abs(info.width - ew) > 1 || Math.abs(info.height - eh) > 1) problems.push(`page size ${info.width}x${info.height}pt, expected ${ew}x${eh}`);
    if (info.pages !== r.previewPages) problems.push(`PDF has ${info.pages} pages but preview had ${r.previewPages}`);
    if (scenario.minPages && info.pages < scenario.minPages) problems.push(`only ${info.pages} pages, expected >= ${scenario.minPages}`);
    if (scenario.maxPages && info.pages > scenario.maxPages) problems.push(`${info.pages} pages, expected <= ${scenario.maxPages}`);
    if (scenario.maxMs && r.renderMs > scenario.maxMs) problems.push(`render took ${r.renderMs} ms, limit ${scenario.maxMs}`);
    if (scenario.morePagesThan) {
      const other = byName[scenario.morePagesThan];
      if (other && !(info.pages > other.pdfPages)) problems.push(`expected more pages than ${scenario.morePagesThan} (${other.pdfPages})`);
    }
    if (r.pdfBytes < 10000) problems.push(`PDF suspiciously small (${r.pdfBytes} bytes)`);
    if (scenario.expectDiagrams) {
      const d = r.diagrams || {};
      if (d.rendered !== scenario.expectDiagrams.rendered || d.failed !== scenario.expectDiagrams.failed) {
        problems.push(`diagrams rendered/failed = ${d.rendered}/${d.failed}, expected ${scenario.expectDiagrams.rendered}/${scenario.expectDiagrams.failed}`);
      }
    }
    // Every scenario: each diagram is on its page, whole and styled.
    if (r.diagramsOnPages) problems.push(...diagramProblems(r.diagramsOnPages));
    else problems.push('no diagram results in the report');
    // A scenario that sets a zoom really had it on the pages during layout.
    if (scenario.settings.zoom && r.zoomDuringLayout !== `scale(${Number(scenario.settings.zoom)})`) {
      problems.push(`zoom during layout was ${r.zoomDuringLayout}, expected scale(${Number(scenario.settings.zoom)})`);
    }
    // ---- Annotation expectations ----
    const a = r.annotations;
    if (scenario.annotationsFile || scenario.quotes || scenario.acrossBreak || scenario.docFile) {
      if (!a) problems.push('no annotation results in the report');
    }
    if (a) {
      if (a.missed && a.missed.length) problems.push(`could not select: ${a.missed.join(' | ')}`);
      const want = scenario.expectNotes;
      if (want) {
        for (const key of Object.keys(want)) {
          if (a.stats[key] !== want[key]) problems.push(`notes ${key} = ${a.stats[key]}, expected ${want[key]}`);
        }
      }
      if (scenario.linesMustNotMove && a.linesMoved !== 0) problems.push(`${a.linesMoved} of ${a.lines} lines of text moved when annotations were painted`);
      // The app's own safety net must agree that no mark pushed text off a page.
      if (a.stats.shiftedPages && a.stats.shiftedPages.length) problems.push(`marks changed the layout of page ${a.stats.shiftedPages.join(', ')}`);
      if (scenario.expectPainted === 'none' && a.paintedMarks !== 0) problems.push(`${a.paintedMarks} marks still show colour while hidden`);
      if (scenario.expectPainted === 'some' && !(a.paintedMarks > 0)) problems.push('no mark shows any colour or line');
      if (scenario.expectPersist) {
        const got = a.persist || {};
        for (const key of Object.keys(scenario.expectPersist)) {
          if (got[key] !== scenario.expectPersist[key]) problems.push(`sidecar ${key} = ${got[key]}, expected ${scenario.expectPersist[key]}`);
        }
      }
      if (scenario.expectAcrossBreak && !(a.acrossBreak && a.acrossBreak.id && a.acrossBreak.pagesWithMarks >= 2)) {
        problems.push(`expected a highlight painted on two pages, got ${JSON.stringify(a.acrossBreak)}`);
      }
      const mdOut = fs.readFileSync(path.join(out, a.markdownFile), 'utf8');
      for (const piece of scenario.mdText || []) {
        if (!mdOut.includes(piece)) problems.push(`Markdown export is missing: ${piece}`);
      }
      if (scenario.expectMd) {
        if (process.env.UPDATE_FIXTURES) fs.writeFileSync(scenario.expectMd, mdOut);
        const expected = fs.existsSync(scenario.expectMd) ? fs.readFileSync(scenario.expectMd, 'utf8') : null;
        if (expected === null) problems.push(`missing fixture ${path.basename(scenario.expectMd)} (run with UPDATE_FIXTURES=1 to create it)`);
        else if (expected !== mdOut) problems.push(`Markdown export differs from ${path.basename(scenario.expectMd)} (diff it against ${a.markdownFile})`);
      }
      try {
        const marginNotes = squeeze(pdfText(pdfPath, true));
        const typed = scenario.marginText
          || (scenario.marginHasNotes === undefined ? [] : JSON.parse(fs.readFileSync(scenario.annotationsFile, 'utf8')).annotations.map((n) => n.note).filter(Boolean));
        for (const note of typed) {
          const present = marginNotes.includes(squeeze(note));
          if (scenario.marginHasNotes === false && present) problems.push(`hidden note still printed: ${note}`);
          if (scenario.marginHasNotes !== false && !present) problems.push(`margin note not found in the PDF text: ${note}`);
        }
        if (scenario.samePdfTextAs) {
          const other = path.join(out, `${scenario.samePdfTextAs}.pdf`);
          if (pdfText(pdfPath) !== pdfText(other)) problems.push(`PDF text differs from ${scenario.samePdfTextAs}`);
        }
      } catch (e) { problems.push(`pdftotext failed: ${e.message}`); }
    }
    if (scenario.samePagesAs) {
      const other = byName[scenario.samePagesAs];
      if (other && info.pages !== other.pdfPages) problems.push(`${info.pages} pages, expected the same as ${scenario.samePagesAs} (${other.pdfPages})`);
    }
    // Prints exactly like another scenario's PDF: the same words on every page
    // and the same picture.
    if (scenario.samePdfAs) {
      try {
        const other = path.join(out, `${scenario.samePdfAs}.pdf`);
        if (pdfText(pdfPath) !== pdfText(other)) problems.push(`PDF text differs from ${scenario.samePdfAs}`);
        if (!pdfPixels(pdfPath).equals(pdfPixels(other))) problems.push(`PDF pages look different from ${scenario.samePdfAs}`);
      } catch (e) { problems.push(`comparing with ${scenario.samePdfAs}.pdf failed: ${e.message}`); }
    }
    // First PDF page as PNG for visual review.
    try {
      execFileSync('pdftoppm', ['-png', '-r', '60', '-f', '1', '-l', '1', pdfPath, path.join(out, `${scenario.name}-pdf-p1`)]);
    } catch (e) { problems.push(`pdftoppm failed: ${e.message}`); }
    rows.push({ scenario: scenario.name, pages: info.pages, preview: r.previewPages, ms: r.renderMs, diagrams: r.diagrams ? `${r.diagrams.rendered}/${r.diagrams.failed}` : '', size: `${info.width}x${info.height}`, notes: r.annotations && r.annotations.stats ? `${r.annotations.stats.placed}/${r.annotations.stats.unplaced}` : '', ok: problems.length === 0 });
  }
  if (problems.length) {
    failures++;
    console.log(`FAIL ${scenario.name}\n  - ${problems.join('\n  - ')}`);
  } else {
    console.log(`ok   ${scenario.name}`);
  }
}

console.log('');
console.table(rows);
console.log(`Electron ${report.electron} · Chromium ${report.chrome}`);
console.log(`Artifacts in ${out}`);
if (external.length) failures++;
if (failures) {
  console.log(`${failures} scenario(s) failed`);
  process.exit(1);
}
console.log('All scenarios passed');
