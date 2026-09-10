// Does a real tool approval reach Hush, and does answering it there let the tool run?
// Claude Code is launched in a PTY with Bash deliberately not pre-allowed, so the
// terminal dialog opens and the relay has something to forward.
//
// Run directly: node test/channel-permission-pty.cjs
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { Store } = require('../src/store.cjs');
const { createBridge } = require('../src/bridge.cjs');
const { executable } = require('../src/providers.cjs');

const settle = ms => new Promise(r => setTimeout(r, ms));
const strip = s => s.replace(/\[[0-9;?]*[A-Za-z]/g, '').replace(/[()][AB012]/g, '');
async function until(predicate, budget) {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await settle(300);
  }
  return null;
}

(async () => {
  const store = new Store();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hush-perm-'));
  const bridge = await createBridge(store, directory);
  const config = path.join(directory, 'channel-mcp.json');
  fs.writeFileSync(config, JSON.stringify({
    mcpServers: {
      hush: {
        command: process.execPath,
        args: [path.join(__dirname, '..', 'bin', 'channel.cjs')],
        env: { HUSH_BRIDGE_FILE: bridge.filename, HUSH_CHANNEL_TITLE: 'Permission relay check', HUSH_CHANNEL_LOG: path.join(directory,'channel.log') },
      },
    },
  }, null, 2));

  // Bash is deliberately absent from allowedTools so the approval actually happens.
  const child = spawn('winpty', ['-Xallow-non-tty', executable('claude'),
    '--mcp-config', config,
    '--dangerously-load-development-channels', 'server:hush',
    '--allowedTools', 'mcp__hush__reply'], { cwd: directory, env: process.env });

  let screen = '';
  child.stdout.on('data', d => { screen += strip(String(d)); });
  child.stderr.on('data', d => { screen += strip(String(d)); });

  await settle(4000); child.stdin.write('\r');   // accept the development-channels warning
  await settle(3000); child.stdin.write('\r');

  const session = await until(() => store.list().find(s => s.title === 'Permission relay check'), 45000);
  console.log('channel registered:', !!session);
  if (!session) { child.kill(); bridge.close(); await store.close(); process.exit(1); }

  // Ask through Hush rather than typing at the terminal: that is the journey being
  // tested, and it avoids depending on how the TUI accepts synthetic keystrokes.
  await settle(2000);
  // echo is auto-approved, so it never prompts and there is nothing to relay. Writing
  // a file does prompt, which is the case this test exists for.
  await store.reply(session.id,
    'Use the Write tool to create a file called relay.txt containing exactly RELAY_APPROVED');
  console.log('asked through Hush');

  const approval = await until(() => store.get(session.id).request, 90000);
  console.log('approval reached Hush:', !!approval);
  if (approval) {
    console.log('  title :', JSON.stringify(String(approval.title).slice(0, 120)));
    console.log('  detail:', JSON.stringify(String(approval.detail || '').slice(0, 120)));
  }

  let ran = false;
  if (approval) {
    await store.answer(session.id, approval.id, 'accept');
    console.log('allowed it from Hush');
    ran = !!await until(() => fs.existsSync(path.join(directory,'relay.txt')) ? true : null, 90000);
    console.log('the write happened after being allowed from Hush:', ran);
  }

  child.kill();
  await settle(500);
  console.log('\n--- relevant terminal lines ---');
  for (const line of screen.split(/\r?\n/)) {
    if (/RELAY_APPROVED|permission|allow|hush|Bash/i.test(line) && line.trim())
      console.log('  ' + line.trim().slice(0, 150));
  }
  console.log('--- channel server log ---');
  try { console.log(fs.readFileSync(path.join(directory,'channel.log'),'utf8').slice(-2000)); }
  catch { console.log('(no log)'); }
  bridge.close();
  await store.close();
  process.exit(approval && ran ? 0 : 1);
})();
