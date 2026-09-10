const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

// Apply the compositor only to our own HWNDs. No polling or screen reads.
async function applyWindowsGlass(windows) {
  const build = Number(os.release().split('.')[2]);
  if (build >= 22621) {
    for (const win of windows) win.setBackgroundMaterial('acrylic');
    return 'acrylic';
  }
  if (build < 17134) return 'solid';
  const handles = windows.map(win => win.getNativeWindowHandle().readBigUInt64LE().toString());
  const source = fs.readFileSync(path.join(__dirname, 'assets', 'glass.cs'), 'utf8');
  const command = `Add-Type -TypeDefinition @'\n${source}\n'@\n${handles.map(h => `[HushGlass]::Apply([IntPtr][long]${h})`).join('\n')}`;
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    const stdout = await new Promise((resolve, reject) => execFile(powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 15000 }, (error, output) => error ? reject(error) : resolve(output)));
    return stdout.trim().split(/\s+/).filter(x => x === 'True').length === windows.length ? 'blur' : 'solid';
  } catch { return 'solid'; }
}

// macOS has the same effect built in, so it needs no helper process and no C#. 'hud' is
// the dark floating-panel material, which is what these windows already look like.
// Vibrancy is unavailable on older releases and on a Mac with reduced transparency
// turned on, and Electron signals that by throwing, so fall back rather than assume.
function applyMacGlass(windows) {
  try {
    for (const win of windows) win.setVibrancy('hud');
    return 'vibrancy';
  } catch { return 'solid'; }
}

/**
 * Give the windows a translucent background where the platform offers one.
 * Returns the material the UI should style itself for: acrylic, blur, vibrancy or solid.
 */
async function applyGlass(windows) {
  if (process.platform === 'win32') return applyWindowsGlass(windows);
  if (process.platform === 'darwin') return applyMacGlass(windows);
  // Linux has no portable compositor API in Electron. The opaque surface is the design
  // the CSS already falls back to, so there is nothing to do here.
  return 'solid';
}
module.exports = { applyGlass };
