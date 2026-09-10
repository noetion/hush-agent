// Compile the macOS dictation helper. There is no speech recogniser on the macOS command
// line and the API is Swift, so this is the one part of Hush that is not JavaScript.
//
// Run directly, or through electron-builder's beforePack when packaging. A no-op off
// macOS, so it can sit unconditionally in scripts that run everywhere.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const source = path.join(__dirname, '..', 'src', 'dictation-macos.swift');
const output = path.join(__dirname, '..', 'src', 'dictation-macos');

function build({ quiet = false } = {}) {
  if (process.platform !== 'darwin') {
    if (!quiet) console.log('not macOS, nothing to build');
    return null;
  }
  if (!fs.existsSync(source)) throw Error(`missing ${source}`);
  // Newer than the source means the last build is still good.
  if (fs.existsSync(output) && fs.statSync(output).mtimeMs >= fs.statSync(source).mtimeMs) {
    if (!quiet) console.log('helper is up to date:', output);
    return output;
  }
  // -O because this runs while someone is speaking; the difference is worth the seconds.
  execFileSync('swiftc', ['-O', '-o', output, source], { stdio: 'inherit', timeout: 300000 });
  if (!quiet) console.log('built', output);
  return output;
}

module.exports = { build, source, output };

if (require.main === module) {
  try {
    build();
  } catch (error) {
    console.error('could not build the macOS dictation helper:', error.message);
    process.exit(1);
  }
}
