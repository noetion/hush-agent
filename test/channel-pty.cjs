// Settle whether channel events actually reach the model, by running Claude Code in a
// real PTY so its startup banner and channel notice render. -p mode prints neither, so
// the earlier run could not tell an org block from a delivery problem.
//
// Run directly: node test/channel-pty.cjs
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { Store } = require('../src/store.cjs');
const { createBridge } = require('../src/bridge.cjs');
const { executable } = require('../src/providers.cjs');

const settle = ms => new Promise(r => setTimeout(r, ms));
const strip = s => s.replace(/\[[0-9;?]*[A-Za-z]/g, '').replace(/[()][AB012]/g, '');

(async () => {
  const store = new Store();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hush-pty-'));
  const bridge = await createBridge(store, directory);
  const config = path.join(directory, 'channel-mcp.json');
  fs.writeFileSync(config, JSON.stringify({
    mcpServers: {
      hush: {
        command: process.execPath,
        args: [path.join(__dirname, '..', 'bin', 'channel.cjs')],
        env: { HUSH_BRIDGE_FILE: bridge.filename, HUSH_CHANNEL_TITLE: 'PTY channel check' },
      },
    },
  }, null, 2));

  const args = ['-Xallow-non-tty', executable('claude'),
    '--mcp-config', config,
    '--dangerously-load-development-channels', 'server:hush',
    '--allowedTools', 'mcp__hush__reply'];
  const child = spawn('winpty', args, { cwd: directory, env: process.env });

  let screen = '';
  child.stdout.on('data', d => { screen += strip(String(d)); });
  child.stderr.on('data', d => { screen += strip(String(d)); });

  const seen = pattern => pattern.test(screen);
  const waitFor = async (pattern, budget) => {
    const deadline = Date.now() + budget;
    while (Date.now() < deadline) { if (seen(pattern)) return true; await settle(300); }
    return false;
  };

  // The development-channels warning is a full-screen choice; accept it.
  await settle(4000);
  child.stdin.write('\r');
  await settle(3000);
  child.stdin.write('\r');

  const registered = await waitFor(/./, 2000) && await (async () => {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const s = store.list().find(x => x.title === 'PTY channel check');
      if (s) return s;
      await settle(300);
    }
    return null;
  })();
  console.log('channel registered with Hush:', !!registered);

  const notice = /Channels?\s*\(experimental\)|inject directly in this session|blocked by org policy|approved list/i;
  console.log('channel notice seen in banner:', seen(notice));

  let answered = false;
  if (registered) {
    await settle(2000);
    await store.reply(registered.id, 'PTY_ROUNDTRIP_OK');
    console.log('pushed a message from Hush');
    // Claude writes the reply itself, so demanding the exact token back would test its
    // wording rather than the channel. Any answer arriving in Hush is the claim.
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      if (store.get(registered.id).messages.some(m => m.role === 'agent' && m.text.trim())) {
        answered = true; break;
      }
      await settle(500);
    }
    const inboundSeen = /←\s*hush:/.test(screen);
    console.log('inbound event reached the session:', inboundSeen);
    console.log('reply arrived back in Hush:', answered);
    if (answered) console.log('reply text:',
      JSON.stringify(store.get(registered.id).messages.filter(m => m.role === 'agent').at(-1).text.slice(0, 160)));
    answered = answered && inboundSeen;
  }

  console.log('\n--- banner / channel lines ---');
  for (const line of screen.split(/\r?\n/)) {
    if (/channel|mcp|hush|experimental|policy/i.test(line) && line.trim()) console.log('  ' + line.trim().slice(0, 160));
  }

  try { child.stdin.write(''); } catch {}
  child.kill();
  await settle(500);
  bridge.close();
  await store.close();
  process.exit(answered ? 0 : 1);
})();
