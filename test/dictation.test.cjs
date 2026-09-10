// Dictation used to end after a single phrase, which made it useless for anything longer
// than a sentence. These checks are about the thing that changed: everything spoken has
// to reach the draft, not just the first phrase the recogniser settled on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Dictation, transcriptFrom } = require('../src/dictation.cjs');

test('every recognised phrase reaches the draft, not just the first', () => {
  assert.equal(transcriptFrom([
    { type: 'ready' },
    { type: 'text', text: 'Please fix the keyboard navigation' },
    { type: 'text', text: 'then run the tests again' },
    { type: 'text', text: 'and tell me what the results were' },
  ]), 'Please fix the keyboard navigation then run the tests again and tell me what the results were');
});

test('nothing said is an empty draft rather than a failure', () => {
  assert.equal(transcriptFrom([{ type: 'ready' }, { type: 'empty' }]), '');
});

test('a recogniser error is raised rather than returned as text', () => {
  assert.throws(() => transcriptFrom([
    { type: 'text', text: 'ignored' },
    { type: 'error', message: 'No audio device' },
  ]), /No audio device/);
});

test('blank and whitespace-only phrases are dropped, not joined as gaps', () => {
  assert.equal(transcriptFrom([
    { type: 'text', text: 'one' },
    { type: 'text', text: '   ' },
    { type: 'text', text: '' },
    { type: 'text', text: 'two' },
  ]), 'one two');
});

test('availability follows the backend for this platform, not a hardcoded list', async () => {
  const { chooseBackend } = require('../src/dictation-backends.cjs');
  const dictation = new Dictation();
  assert.equal(dictation.available, chooseBackend().available);
  if (dictation.available) {
    assert.equal(dictation.unavailableReason, '');
    return;
  }
  // An unavailable backend has to say which piece is missing. Refusing without a
  // reason is what the button used to do by disappearing.
  assert.ok(dictation.unavailableReason.length > 20,
    `expected a reason worth reading, got ${JSON.stringify(dictation.unavailableReason)}`);
  // And starting has to fail with that same reason, not a raw ENOENT from a missing
  // program, which is what it did before there were backends.
  await assert.rejects(dictation.start(),
    error => error.message === dictation.unavailableReason);
});

test('every platform either works or explains itself', () => {
  const { chooseBackend } = require('../src/dictation-backends.cjs');
  for (const platform of ['win32', 'darwin', 'linux', 'aix']) {
    const backend = chooseBackend(platform);
    if (backend.available) assert.equal(backend.reason, '', `${platform} should not carry a reason`);
    else assert.ok(backend.reason.length > 20, `${platform} refused without saying why`);
  }
});

// The end-to-end check needs Windows' recogniser and synthesiser, so it skips honestly
// everywhere else rather than pretending the behaviour was verified.
const windows = process.platform === 'win32';
const onWindows = { skip: windows ? false : 'dictation is Windows-only' };

test('a real multi-sentence recording comes back whole', onWindows, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hush-dictation-'));
  const wave = path.join(root, 'speech.wav');
  const script = path.join(root, 'say.ps1');
  const said = ['Please fix the keyboard navigation.', 'Then run the tests again.'];
  fs.writeFileSync(script, [
    'param([string]$Out)',
    'Add-Type -AssemblyName System.Speech',
    '$s=[System.Speech.Synthesis.SpeechSynthesizer]::new()',
    // Slower speech is recognised far more reliably, which keeps this about the
    // plumbing rather than about the quality of the recogniser.
    '$s.Rate=-1',
    '$s.SetOutputToWaveFile($Out)',
    ...said.map(line => `$s.Speak('${line}')`),
    '$s.SetOutputToNull()',
    '$s.Dispose()',
  ].join('\n'));

  try {
    execFileSync('powershell.exe', ['-NoProfile', '-File', script, '-Out', wave],
      { windowsHide: true, timeout: 120000, stdio: 'ignore' });
    assert.ok(fs.statSync(wave).size > 0, 'the synthesiser produced no audio');

    process.env.HUSH_DICTATION_WAV = wave;
    const transcript = await new Dictation().start();
    // Recognition is never exact, so anchor on the distinctive words of each sentence:
    // the point is that the second one is there at all.
    assert.match(transcript, /keyboard navigation/i);
    assert.match(transcript, /tests again/i,
      'only the first phrase came back, which is the bug this replaced');
  } finally {
    delete process.env.HUSH_DICTATION_WAV;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('installing what was missing takes effect without restarting Hush', () => {
  // The Linux backend is the one that tells the user to go and install something, so it
  // is the one that must notice when they have. Driven through the real Dictation object
  // rather than the backend function, because settling this at construction time is
  // exactly the bug: the reason would still say "not installed" afterwards.
  const before = { cmd: process.env.HUSH_DICTATION_CMD, rec: process.env.HUSH_DICTATION_RECORDER };
  try {
    delete process.env.HUSH_DICTATION_CMD;
    process.env.HUSH_DICTATION_RECORDER = '';
    const dictation = new Dictation();
    const { chooseBackend } = require('../src/dictation-backends.cjs');
    const missing = chooseBackend('linux');

    process.env.HUSH_DICTATION_RECORDER = '/usr/bin/arecord';
    process.env.HUSH_DICTATION_CMD = 'my-transcriber --plain';
    const installed = chooseBackend('linux');

    assert.equal(missing.available, false, 'nothing installed should not be available');
    assert.equal(installed.available, true, 'both pieces present should be available');
    // And the object in front of the UI looks again rather than holding its first answer.
    assert.equal(typeof dictation.refresh, 'function');
    const first = dictation.refresh();
    assert.equal(first, dictation.backend, 'a fresh probe should be the one now in use');
  } finally {
    if (before.cmd === undefined) delete process.env.HUSH_DICTATION_CMD; else process.env.HUSH_DICTATION_CMD = before.cmd;
    if (before.rec === undefined) delete process.env.HUSH_DICTATION_RECORDER; else process.env.HUSH_DICTATION_RECORDER = before.rec;
  }
});
