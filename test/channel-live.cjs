// Live check: does Claude Code actually load the Hush channel and reach it?
// Starts a real bridge, writes the MCP config Hush writes, launches Claude Code with
// the research-preview flags, and reports whether the channel registered and whether a
// message typed in Hush produced an answer back through the reply tool.
//
// Run directly: node test/channel-live.cjs
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { Store } = require('../src/store.cjs');
const { createBridge } = require('../src/bridge.cjs');
const { executable } = require('../src/providers.cjs');

const settle = ms => new Promise(r => setTimeout(r, ms));
async function until(predicate, budget) {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await settle(250);
  }
  return null;
}

(async () => {
  const store = new Store();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hush-live-'));
  const bridge = await createBridge(store, directory);
  const config = path.join(directory, 'channel-mcp.json');
  fs.writeFileSync(config, JSON.stringify({
    mcpServers: {
      hush: {
        command: process.execPath,
        args: [path.join(__dirname, '..', 'bin', 'channel.cjs')],
        env: { HUSH_BRIDGE_FILE: bridge.filename, HUSH_CHANNEL_TITLE: 'Live channel check' },
      },
    },
  }, null, 2));

  // Hush's own reply tool only sends text back to Hush, so it is pre-allowed rather
  // than prompting the user for it every session.
  const args = ['--mcp-config', config,
    '--dangerously-load-development-channels', 'server:hush',
    '--allowedTools', 'mcp__hush__reply Bash(sleep:*)',
    '-p', 'Run the command: sleep 3 . Do that six times, one after another. '
        + 'A message will arrive from the hush channel while you are doing it. '
        + 'As soon as you notice it, call the hush reply tool with its exact text, '
        + 'then stop.'];
  console.log('launching:', executable('claude'), args.join(' '));

  const child = spawn(executable('claude'), args,
    { cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });

  const registered = await until(() => store.list().find(s => s.title === 'Live channel check'), 60000);
  console.log('channel registered with Hush:', !!registered);

  let answered = null;
  if (registered) {
    // Inbound: type into Hush exactly as the user would.
    await settle(4000);
    await store.reply(registered.id, 'CHANNEL_LIVE_OK');
    console.log('pushed a message from Hush into the session mid-turn');
    answered = await until(() =>
      store.get(registered.id).messages.find(m => m.role === 'agent' && m.text.includes('CHANNEL_LIVE_OK')),
      120000);
    console.log('round trip completed (Hush -> Claude -> Hush):', !!answered);
  }

  child.kill();
  await settle(500);
  console.log('--- claude stdout (trimmed) ---');
  console.log(out.slice(0, 900) || '(empty)');
  console.log('--- claude stderr (trimmed) ---');
  console.log(err.slice(0, 900) || '(empty)');

  bridge.close();
  await store.close();
  process.exit(registered && answered ? 0 : 1);
})();
