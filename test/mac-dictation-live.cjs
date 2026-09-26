// Opt-in check: run with the source Electron bundle after `npm start` has prepared
// its permission descriptions. Speech permission may require user interaction.
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { Dictation } = require('../src/dictation.cjs');
const { build } = require('../scripts/build-mac-helper.cjs');
module.exports = async ({ app, shutdown }) => {
  const report = {};
  try {
    assert.equal(process.platform, 'darwin');
    assert.ok(process.env.HUSH_DICTATION_WAV, 'Set HUSH_DICTATION_WAV to the two-sentence fixture');
    const transcript = await new Dictation().start();
    assert.match(transcript, /keyboard navigation/i);
    assert.match(transcript, /tests again/i);
    report.default = transcript;
    const binary = await build({ quiet: true });
    const output = await new Promise((resolve, reject) => execFile(binary,
      ['--legacy-recognizer', '--wave', process.env.HUSH_DICTATION_WAV],
      { timeout: 120000 }, (error, stdout, stderr) => error ? reject(Error(`${error.message}\n${stdout}\n${stderr}`)) : resolve(stdout)));
    const rows = output.trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(rows.some(row => row.type === 'error'), false, output);
    const legacy = rows.filter(row => row.type === 'text').map(row => row.text).join(' ');
    assert.match(legacy, /keyboard navigation/i);
    assert.match(legacy, /tests again/i);
    report.legacy = legacy;
    report.passed = true;
  } catch (error) { report.error = error.stack; }
  const directory = process.env.HUSH_ARTIFACTS || 'artifacts';
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'mac-dictation-live.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  shutdown();
  app.exit(report.passed ? 0 : 1);
};
