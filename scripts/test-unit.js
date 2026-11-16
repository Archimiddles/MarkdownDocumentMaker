// Runs the unit tests in test/unit/ with Node's built-in test runner.
// The tests are first bundled with esbuild, which lets them import the
// renderer's ES modules (and marked, highlight.js) directly without the
// project needing "type": "module" or a test framework.
const esbuild = require('esbuild');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dir = path.join(root, 'test', 'unit');
const outdir = path.join(root, 'test', '.unit-build');

const entryPoints = fs.readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => path.join(dir, f));
if (entryPoints.length === 0) {
  console.error(`No *.test.js files found in ${dir}`);
  process.exit(1);
}

// Start from an empty folder so a deleted or renamed test cannot linger.
fs.rmSync(outdir, { recursive: true, force: true });

try {
  esbuild.buildSync({
    entryPoints,
    outdir,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    // Electron cannot be bundled (it locates its binary relative to its own
    // folder), so a test that pulls in main-process code loads it at run time.
    external: ['electron'],
    sourcemap: 'inline', // failures point at the real source lines
    logLevel: 'warning',
  });
} catch {
  process.exit(1); // esbuild has already printed what went wrong
}

const built = fs.readdirSync(outdir)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => path.join(outdir, f));
// cwd is the project root, so tests can read fixtures by project-relative path.
const run = spawnSync(process.execPath, ['--enable-source-maps', '--test', ...built], {
  cwd: root,
  stdio: 'inherit',
});
process.exit(run.status ?? 1);
