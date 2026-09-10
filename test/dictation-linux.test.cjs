// The Linux path is two programs joined together, and neither of them exists on the
// machine this is written on. What can be checked anywhere is the joining: that a
// recording is made, that stopping closes it, that the transcriber is handed the file and
// its output becomes the transcript, and that each way this can fail says which piece
// failed. Stand-in commands stand in for arecord and whisper; the runner under test is
// the real one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const runner = path.join(__dirname, '..', 'src', 'dictation-linux.cjs');

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hush-dictation-linux-'));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** A script that behaves like a recorder: writes audio-sized output, then waits. */
function fakeRecorder(root, { bytes = 8192 } = {}) {
  const file = path.join(root, 'recorder.cjs');
  fs.writeFileSync(file, `
    const fs=require('node:fs');
    fs.writeFileSync(process.argv[process.argv.length-1],Buffer.alloc(${bytes},1));
    // Stay up until stopped, the way a real recorder does.
    setInterval(()=>{},1000);
  `);
  return file;
}

/** A script that behaves like a transcriber: prints text for the file it is given. */
function fakeTranscriber(root, { prints = 'the quick brown fox', code = 0, stderr = '' } = {}) {
  const file = path.join(root, 'transcriber.cjs');
  fs.writeFileSync(file, `
    const fs=require('node:fs');
    const wave=process.argv[process.argv.length-1];
    if(!fs.existsSync(wave)){process.stderr.write('no such wave file: '+wave);process.exit(3);}
    ${stderr ? `process.stderr.write(${JSON.stringify(stderr)});` : ''}
    process.stdout.write(${JSON.stringify(prints)});
    process.exit(${code});
  `);
  return file;
}

// Drive the real runner the way Dictation does, and stop it once it says it is ready.
// Both halves run under this same node, so the stand-ins are plain scripts rather than
// executables, which keeps the test identical on every platform.
function dictate({ root, recorder, transcriber, stopAfterReady = true }) {
  const stopFile = path.join(root, 'stop');
  const child = spawn(process.execPath, [
    runner, '--stop-file', stopFile,
    '--recorder', process.execPath, '--recorder-args', JSON.stringify([recorder, '{}']),
    '--transcriber', process.execPath, '--transcriber-args', JSON.stringify([transcriber, '{}']),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  return new Promise((resolve, reject) => {
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(Error(`timed out; stdout so far: ${out}`)); }, 30000);
    child.stdout.on('data', b => {
      out += b;
      if (stopAfterReady && out.includes('"ready"') && !fs.existsSync(stopFile)) fs.writeFileSync(stopFile, '');
    });
    child.stderr.on('data', b => { err += b; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      const rows = out.trim().split(/\r?\n/).filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch { throw Error(`not a JSON line: ${line}`); }
      });
      resolve({ code, rows, err });
    });
  });
}

test('a recording is transcribed and comes back as the spoken text', async () => {
  const { root, cleanup } = scratch();
  try {
    const { code, rows } = await dictate({
      root,
      recorder: fakeRecorder(root),
      transcriber: fakeTranscriber(root, { prints: 'please fix the keyboard navigation' }),
    });
    assert.equal(code, 0);
    assert.equal(rows[0].type, 'ready', 'the recorder must announce itself before anything waits on it');
    assert.deepEqual(rows.filter(r => r.type === 'text').map(r => r.text),
      ['please fix the keyboard navigation']);
  } finally { cleanup(); }
});

test('whisper timestamp prefixes are stripped rather than dictated into the draft', async () => {
  const { root, cleanup } = scratch();
  try {
    const { rows } = await dictate({
      root,
      recorder: fakeRecorder(root),
      // What a whisper.cpp CLI actually prints when it is not asked for plain text.
      transcriber: fakeTranscriber(root, {
        prints: '[00:00:00.000 --> 00:00:02.000]   Please fix the keyboard navigation.\n'
              + '[00:00:02.000 --> 00:00:04.000]   Then run the tests again.\n',
      }),
    });
    assert.equal(rows.find(r => r.type === 'text').text,
      'Please fix the keyboard navigation. Then run the tests again.');
  } finally { cleanup(); }
});

test('a recording with nothing in it is empty rather than an error', async () => {
  const { root, cleanup } = scratch();
  try {
    const { code, rows } = await dictate({
      root,
      // Below the point where a wave file could hold any audio.
      recorder: fakeRecorder(root, { bytes: 100 }),
      transcriber: fakeTranscriber(root, { prints: 'should never run' }),
    });
    assert.equal(code, 0);
    assert.ok(rows.some(r => r.type === 'empty'), 'silence is a normal outcome');
    assert.equal(rows.some(r => r.type === 'text'), false);
  } finally { cleanup(); }
});

test('a transcriber that fails names itself instead of failing silently', async () => {
  const { root, cleanup } = scratch();
  try {
    const { code, rows } = await dictate({
      root,
      recorder: fakeRecorder(root),
      transcriber: fakeTranscriber(root, { prints: '', code: 2, stderr: 'model not found' }),
    });
    assert.equal(code, 1);
    const error = rows.find(r => r.type === 'error');
    assert.ok(error, 'a failure has to arrive as a protocol line, not just an exit code');
    assert.match(error.message, /model not found/);
  } finally { cleanup(); }
});

test('the transcriber is given the recording that was just made', async () => {
  const { root, cleanup } = scratch();
  try {
    // The stand-in exits 3 with a message if the path it is handed does not exist.
    const { code, rows } = await dictate({
      root,
      recorder: fakeRecorder(root),
      transcriber: fakeTranscriber(root, { prints: 'reached the file' }),
    });
    assert.equal(code, 0);
    assert.equal(rows.find(r => r.type === 'text').text, 'reached the file');
  } finally { cleanup(); }
});
