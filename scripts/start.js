// Launches Electron. On Ubuntu 24.04+ an npm-installed Electron can fail with
// "The SUID sandbox helper binary was found, but is not configured correctly"
// because of the AppArmor user-namespace restriction. When that happens we
// relaunch once with the Chromium sandbox disabled and tell the user how to
// fix it permanently. Extra CLI args are passed through to Electron.
const { spawn } = require('node:child_process');
const path = require('node:path');

const electron = require('electron'); // resolves to the binary path
const root = path.join(__dirname, '..');
const userArgs = process.argv.slice(2);
const SANDBOX_ERROR = /SUID sandbox helper binary was found|chrome-sandbox is owned by root|No usable sandbox/i;

function launch(extraArgs, env) {
  return new Promise((resolve) => {
    const child = spawn(electron, [root, ...extraArgs, ...userArgs], {
      env,
      stdio: ['inherit', 'inherit', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on('exit', (code, signal) => resolve({ code, signal, stderr }));
  });
}

(async () => {
  const first = await launch([], process.env);
  if (first.code !== 0 && SANDBOX_ERROR.test(first.stderr) && !userArgs.includes('--no-sandbox')) {
    console.error('\nPlan Printer: Chromium sandbox could not start (Ubuntu AppArmor restriction). ' +
      'Relaunching with --no-sandbox. To fix permanently run:\n' +
      '  sudo chown root:root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox\n');
    const second = await launch(['--no-sandbox'], { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' });
    process.exit(second.code ?? 1);
  }
  process.exit(first.code ?? (first.signal ? 1 : 0));
})();
