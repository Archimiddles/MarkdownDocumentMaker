// Bundles the renderer (JS + CSS + fonts) with esbuild so the app runs with
// nodeIntegration off and no bundler config to learn. Run with --watch for dev.
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const watch = process.argv.includes('--watch');

// page.css is handed to Paged.js as a string at runtime (it has to parse the
// @page rules itself), so it is bundled as text rather than as a stylesheet.
const pageCssAsText = {
  name: 'page-css-as-text',
  setup(build) {
    build.onLoad({ filter: /[\\/]page\.css$/ }, async (args) => ({
      contents: await fs.promises.readFile(args.path, 'utf8'),
      loader: 'text',
    }));
  },
};

const options = {
  entryPoints: [path.join(__dirname, '..', 'renderer', 'src', 'app.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  outdir: path.join(__dirname, '..', 'renderer', 'dist'),
  loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
  assetNames: 'assets/[name]-[hash]',
  sourcemap: 'inline',
  logLevel: 'info',
  plugins: [pageCssAsText],
};

(async () => {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  } else {
    await esbuild.build(options);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
