#!/usr/bin/env node
// End-to-end check: launches the real app in test mode, which renders several
// layout/paper combinations, exports each to PDF through webContents.printToPDF
// and takes a screenshot. Then validates the PDFs with pdfinfo (poppler):
//   - the PDF page count equals the page count Paged.js showed in the preview
//   - the PDF page size matches the selected paper
//   - scenario-specific expectations (minimum pages, H2 breaks add pages, ...)
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
const sampleText = fs.readFileSync(sample, 'utf8');

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
];

const env = {
  ...process.env,
  PLAN_PRINTER_TEST_OUT: out,
  PLAN_PRINTER_TEST_SCENARIOS: JSON.stringify(scenarios.map(({ name, settings, md, mdFile }) => ({ name, settings, md, mdFile }))),
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

function SANDBOX_HINT(s) { return /SUID sandbox helper|chrome-sandbox/.test(s || ''); }

function pdfInfo(file) {
  const text = execFileSync('pdfinfo', [file], { encoding: 'utf8' });
  const pages = Number((/Pages:\s+(\d+)/.exec(text) || [])[1]);
  const size = /Page size:\s+([\d.]+) x ([\d.]+)/.exec(text);
  return { pages, width: size ? Number(size[1]) : NaN, height: size ? Number(size[2]) : NaN };
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
    const [ew, eh] = EXPECTED_SIZE[scenario.settings.paper];
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
    // First PDF page as PNG for visual review.
    try {
      execFileSync('pdftoppm', ['-png', '-r', '60', '-f', '1', '-l', '1', pdfPath, path.join(out, `${scenario.name}-pdf-p1`)]);
    } catch (e) { problems.push(`pdftoppm failed: ${e.message}`); }
    rows.push({ scenario: scenario.name, pages: info.pages, preview: r.previewPages, ms: r.renderMs, size: `${info.width}x${info.height}`, ok: problems.length === 0 });
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
if (failures) {
  console.log(`${failures} scenario(s) failed`);
  process.exit(1);
}
console.log('All scenarios passed');
