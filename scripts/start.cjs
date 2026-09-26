const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync, spawn } = require('node:child_process');
const binary = require('electron');
let command = binary;
let args = [path.resolve(__dirname, '..'), ...process.argv.slice(2)];
let environmentDirectory;

// macOS attributes the helper's permission requests to its parent application.
// Source installs run inside Electron's development bundle, which needs the same
// descriptions as packaged Hush. Keep this limited to this install's node_modules.
if (process.platform === 'darwin') {
  const bundle = path.resolve(path.dirname(binary), '..', '..');
  const info = path.join(bundle, 'Contents', 'Info.plist');
  const descriptions = { ...require('../package.json').build.mac.extendInfo,
    CFBundleDisplayName: 'Hush', CFBundleName: 'Hush', CFBundleIdentifier: 'dev.hush.agent.source' };
  let changed = false;
  for (const [key, value] of Object.entries(descriptions)) {
    let current;
    try { current = execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', info], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
    if (current === value) continue;
    execFileSync('/usr/bin/plutil', ['-replace', key, '-string', value, info]);
    changed = true;
  }
  const validSignature = target => {
    try {
      execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', target], { stdio: 'ignore' });
      return true;
    } catch { return false; }
  };
  // Intel distributions can have unsigned helpers. Repair invalid components from
  // the inside out, leaving valid nested code alone. Retry interrupted preparation
  // even if Info.plist already has our values. This only signs this local install.
  if (changed || !validSignature(bundle)) {
    const frameworks = path.join(bundle, 'Contents', 'Frameworks');
    for (const entry of fs.readdirSync(frameworks, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/\.(app|framework)$/.test(entry.name)) continue;
      const component = path.join(frameworks, entry.name);
      if (!validSignature(component)) execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-',
        '--preserve-metadata=entitlements,flags', component], { stdio: 'inherit' });
    }
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-',
      '--preserve-metadata=entitlements,flags', bundle], { stdio: 'inherit' });
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' });
  }
  // LaunchServices makes this bundle responsible for privacy prompts instead of
  // attributing them to Terminal or whichever editor launched npm. Transfer the
  // shell environment privately; putting tokens in `open --env` exposes argv.
  environmentDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'hush-source-'));
  const environmentFile = path.join(environmentDirectory, 'environment.json');
  fs.writeFileSync(environmentFile, JSON.stringify(process.env), { mode: 0o600 });
  command = '/usr/bin/open';
  args = ['-n', '-W', '-a', bundle, '--args', ...args, `--hush-source-env=${environmentFile}`];
}

const cleanup = () => { if (environmentDirectory) fs.rmSync(environmentDirectory, { recursive: true, force: true }); };
const child = spawn(command, args, { stdio: 'inherit' });
child.on('error', error => { cleanup(); console.error('Hush could not start:', error.message); process.exitCode = 1; });
child.on('exit', code => {
  cleanup();
  process.exitCode = code ?? 1;
  const report = process.env.HUSH_SELF_TEST ? 'electron-check.json'
    : process.env.HUSH_DICTATION_CHECK ? 'mac-dictation-live.json'
    : process.env.HUSH_TASK_CHECK ? 'task-check.json'
    : process.env.HUSH_SHARED_CHECK ? 'shared-check.json' : null;
  if (report) {
    try {
      const directory = process.env.HUSH_ARTIFACTS || (report === 'task-check.json' ? 'artifacts/tasks'
        : report === 'shared-check.json' ? 'artifacts/shared-check' : 'artifacts');
      const result = JSON.parse(fs.readFileSync(path.join(directory, report)));
      process.exitCode = result.passed ? 0 : 1;
    } catch { process.exitCode = 1; }
  }
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
