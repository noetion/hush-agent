// Where Hush keeps its data. Inside the app Electron decides this; anything that runs
// outside it — the channel server, the CLI client — has to arrive at exactly the same
// directory or it looks for the bridge file somewhere Hush never wrote one.
//
// The three platforms are not interchangeable: ~/.config is right on Linux and wrong on
// macOS, which is why this cannot be one path with a fallback. test/electron-check.cjs
// asserts the result matches Electron's own appData on whatever platform it runs.
const os = require('node:os');
const path = require('node:path');

/** The per-user application data root, matching Electron's 'appData'. */
function appDataRoot() {
  if (process.platform === 'win32')
    return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  if (process.platform === 'darwin')
    return path.join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

/** Hush's own directory: settings, session metadata, attachments, the bridge file. */
function dataDirectory() {
  return process.env.HUSH_DATA_DIR || path.join(appDataRoot(), 'Hush');
}

/** The file a running Hush publishes its bridge address and token to. */
function bridgeFile() {
  return process.env.HUSH_BRIDGE_FILE || path.join(dataDirectory(), 'bridge.json');
}

module.exports = { appDataRoot, dataDirectory, bridgeFile };
