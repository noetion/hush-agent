// Compile the macOS dictation helper. There is no speech recogniser on the macOS command
// line and the API is Swift, so this is the one part of Hush that is not JavaScript.
//
// Run directly, or through electron-builder's beforePack when packaging. A no-op off
// macOS, so it can sit unconditionally in scripts that run everywhere.
const fs = require('node:fs');
const path = require('node:path');
const { buildMacHelper } = require('../src/mac-helper-build.cjs');

const source = path.join(__dirname, '..', 'src', 'dictation-macos.swift');
const output = path.join(__dirname, '..', 'src', 'dictation-macos');

async function build({ quiet = false } = {}) {
  if (process.platform !== 'darwin') {
    if (!quiet) console.log('not macOS, nothing to build');
    return null;
  }
  if (!fs.existsSync(source)) throw Error(`missing ${source}`);
  await buildMacHelper(source, output, 'swiftc', quiet ? 'pipe' : 'inherit');
  if (!quiet) console.log('built', output);
  return output;
}

module.exports = { build, source, output };

if (require.main === module) {
  build().catch(error => {
    console.error('could not build the macOS dictation helper:', error.message);
    process.exit(1);
  });
}
