const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { minimumMacOS } = require('../src/mac-helper-build.cjs');

if (process.platform !== 'darwin') {
  console.log('macOS helper check only runs on macOS');
  process.exit(0);
}
const binary = path.resolve(process.argv[2] || 'src/dictation-macos');
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8' });
const architectures = run('/usr/bin/lipo', ['-archs', binary]).trim().split(/\s+/).sort();
assert.deepEqual(architectures, ['arm64', 'x86_64']);
for (const arch of architectures) {
  const build = run('/usr/bin/vtool', ['-arch', arch, '-show-build', binary]);
  assert.match(build, new RegExp(`minos ${minimumMacOS.replace('.', '\\.')}\\b`));
  const info = run('/usr/bin/otool', ['-arch', arch, '-s', '__TEXT', '__info_plist', binary]);
  const hex = info.split('\n').slice(2).flatMap(line => line.trim().split(/\s+/).slice(1))
    .map(word => word.match(/../g)?.reverse().join('') || '').join('');
  const xml = Buffer.from(hex, 'hex').toString('utf8');
  assert.ok(xml.includes('NSMicrophoneUsageDescription'), `${arch} lacks microphone description`);
  assert.ok(xml.includes('NSSpeechRecognitionUsageDescription'), `${arch} lacks speech description`);
}
run('/usr/bin/codesign', ['--verify', '--strict', binary]);
console.log(JSON.stringify({ universal: true, minimumMacOS, embeddedPermissions: true, signatureValid: true }));
