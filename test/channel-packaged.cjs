// Does the channel work from a packaged build? Two things only exist there and have
// never been exercised: bin/channel.cjs is read from inside app.asar, and the packaged
// binary is Electron, so it has to be told to behave as Node. Either can fail while
// every unpackaged test passes.
//
// Run directly, after `npm run package`: node test/channel-packaged.cjs
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../src/store.cjs');
const { createBridge } = require('../src/bridge.cjs');

const settle = ms => new Promise(r => setTimeout(r, ms));
async function until(predicate, budget = 20000) {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await settle(200);
  }
  return null;
}

// electron-builder lays a build out differently on each platform, and names the Linux
// executable to its own taste. Rather than guess the name, find the app.asar -- which is
// the thing actually under test, since bin/channel.cjs is read from inside it -- and
// then look for the executable in the place that platform keeps it.
function findPackaged() {
  const root = path.join(__dirname, '..', 'dist');
  if (!fs.existsSync(root)) return null;

  const archives = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); }
      else if (entry.name === 'app.asar') archives.push(full);
    }
  };
  walk(root);

  const name = require('../package.json').build.productName;
  const names = process.platform === 'win32' ? [`${name}.exe`] : [name, name.toLowerCase()];
  for (const asar of archives) {
    // Windows and Linux: <app>/resources/app.asar. macOS: <app>.app/Contents/Resources.
    const resources = path.dirname(asar);
    const appDir = process.platform === 'darwin'
      ? path.resolve(resources, '..', 'MacOS')
      : path.resolve(resources, '..');
    if (!fs.existsSync(appDir)) continue;
    const exe = names.map(n => path.join(appDir, n)).find(p => fs.existsSync(p))
      // macOS keeps exactly one binary in Contents/MacOS, whatever it is called.
      || (process.platform === 'darwin' && fs.readdirSync(appDir).length === 1
          ? path.join(appDir, fs.readdirSync(appDir)[0]) : null);
    if (exe) return { exe, asar };
  }
  // Say what is actually there. Guessing the name is how this failed the first time.
  for (const asar of archives) {
    const dir = process.platform === 'darwin'
      ? path.resolve(path.dirname(asar), '..', 'MacOS') : path.resolve(path.dirname(asar), '..');
    console.log(`beside ${asar}:`, fs.existsSync(dir) ? fs.readdirSync(dir) : '(no such directory)');
  }
  console.log('looked for:', names.join(', '));
  return null;
}

(async () => {
  const build = findPackaged();
  if (!build) {
    console.log('SKIP: no packaged build found under dist/. Run `npm run package` first.');
    process.exit(2);
  }
  const { exe, asar } = build;
  console.log('packaged exe :', exe);
  console.log('app.asar     :', asar);

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

  const store = new Store();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hush-packaged-'));
  const bridge = await createBridge(store, directory);

  const received = [];
  const client = new Client({ name: 'claude-code-stand-in', version: '0.0.1' }, {});
  client.fallbackNotificationHandler = async n => { received.push(n); };

  // Exactly what main.cjs writes into the MCP config for a bridged session.
  const transport = new StdioClientTransport({
    command: exe,
    args: [path.join(asar, 'bin', 'channel.cjs')],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HUSH_BRIDGE_FILE: bridge.filename,
      HUSH_CHANNEL_TITLE: 'Packaged channel check',
    },
    stderr: 'pipe',
  });

  let failure = null;
  try {
    await client.connect(transport);
    console.log('connected over stdio from inside app.asar: true');

    const session = await until(() => store.list().find(s => s.title === 'Packaged channel check'));
    console.log('registered with Hush:', !!session);
    if (!session) throw Error('the packaged channel did not register');

    const tools = await client.listTools();
    const hasReply = tools.tools.some(t => t.name === 'reply');
    console.log('reply tool exposed:', hasReply);
    if (!hasReply) throw Error('the packaged channel exposed no reply tool');

    await store.reply(session.id, 'packaged inbound check');
    const event = await until(() => received.find(n => n.method === 'notifications/claude/channel'));
    console.log('inbound reached the channel:', !!event);
    if (!event) throw Error('a message typed in Hush did not reach the packaged channel');

    await client.callTool({ name: 'reply', arguments: { text: 'packaged outbound check' } });
    const answer = await until(() => store.get(session.id).messages
      .find(m => m.role === 'agent' && m.text.includes('packaged outbound check')));
    console.log('reply tool reached Hush:', !!answer);
    if (!answer) throw Error('the packaged reply tool did not reach Hush');
  } catch (error) {
    failure = error;
  }

  try { await client.close(); } catch {}
  bridge.close();
  await store.close();

  if (failure) { console.log('FAILED:', failure.message); process.exit(1); }
  console.log('packaged channel works end to end');
  process.exit(0);
})();
