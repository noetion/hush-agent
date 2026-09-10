// The channel is the whole point of the Claude integration, so it is tested against
// the real MCP protocol rather than a stub: this file plays the part Claude Code
// plays, spawning bin/channel.cjs over stdio and speaking to it as a client.
//
// What must hold: a message typed in Hush reaches the session as a channel
// notification, and an answer sent through the reply tool appears in Hush.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../src/store.cjs');
const { createBridge } = require('../src/bridge.cjs');

const settle = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, budget = 8000) {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await settle(100);
  }
  return null;
}

async function harness() {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

  const store = new Store();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hush-channel-'));
  const bridge = await createBridge(store, directory);

  const received = [];
  const client = new Client({ name: 'claude-code-stand-in', version: '0.0.1' }, {});
  client.fallbackNotificationHandler = async notification => { received.push(notification); };

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'bin', 'channel.cjs')],
    env: { ...process.env, HUSH_BRIDGE_FILE: bridge.filename, HUSH_CHANNEL_TITLE: 'Channel test' },
    stderr: 'pipe',
  });
  await client.connect(transport);

  const close = async () => {
    try { await client.close(); } catch {}
    bridge.close();
    await store.close();
  };
  return { store, client, received, close };
}

test('the channel registers itself with Hush as a repliable session', async () => {
  const { store, close } = await harness();
  try {
    const session = await until(() => store.list().find(s => s.title === 'Channel test'));
    assert.ok(session, 'the channel should have registered a session in Hush');
    assert.equal(session.provider, 'Claude Code');
    assert.equal(session.canReply, true, 'the user must be able to reply to it');
  } finally { await close(); }
});

test('a message typed in Hush arrives as a channel notification', async () => {
  const { store, received, close } = await harness();
  try {
    const session = await until(() => store.list().find(s => s.title === 'Channel test'));
    await store.reply(session.id, 'does the migration look right?');

    const event = await until(() =>
      received.find(n => n.method === 'notifications/claude/channel'));
    assert.ok(event, 'the message should have reached the session as a channel event');
    assert.equal(event.params.content, 'does the migration look right?');
    assert.equal(event.params.meta.source, 'hush');
  } finally { await close(); }
});

test('a delivered message is acknowledged exactly once', async () => {
  const { store, received, close } = await harness();
  try {
    const session = await until(() => store.list().find(s => s.title === 'Channel test'));
    await store.reply(session.id, 'only once please');
    await until(() => received.filter(n => n.method === 'notifications/claude/channel').length);
    // Long enough for several more poll cycles to have run.
    await settle(2500);
    const deliveries = received.filter(n =>
      n.method === 'notifications/claude/channel' && n.params.content === 'only once please');
    assert.equal(deliveries.length, 1, 'an acknowledged message must not be redelivered');
  } finally { await close(); }
});

test('the reply tool sends Claude answer back into Hush', async () => {
  const { store, client, close } = await harness();
  try {
    const session = await until(() => store.list().find(s => s.title === 'Channel test'));

    const tools = await client.listTools();
    assert.ok(tools.tools.some(t => t.name === 'reply'), 'the channel must expose a reply tool');

    await client.callTool({ name: 'reply', arguments: { text: 'the migration is safe to run' } });

    const message = await until(() =>
      store.get(session.id).messages.find(m => m.role === 'agent'
        && m.text.includes('the migration is safe to run')));
    assert.ok(message, "Claude's answer should appear in Hush");
    assert.equal(store.get(session.id).status, 'done');
  } finally { await close(); }
});

test('an empty reply is refused rather than shown as a blank message', async () => {
  const { store, client, close } = await harness();
  try {
    const session = await until(() => store.list().find(s => s.title === 'Channel test'));
    const result = await client.callTool({ name: 'reply', arguments: { text: '   ' } });
    assert.equal(result.isError, true);
    const agentMessages = store.get(session.id).messages.filter(m => m.role === 'agent');
    assert.equal(agentMessages.length, 0, 'nothing should have been shown in Hush');
  } finally { await close(); }
});

// Permission relay: an approval Claude Code is holding open becomes an Allow once /
// Deny decision in Hush, and the answer goes back as a verdict. The decision is always
// the user's; nothing here may infer or time out into one.
const requestApproval = (client, request_id, extra = {}) =>
  client.notification({
    method: 'notifications/claude/channel/permission_request',
    params: { request_id, tool_name: 'Bash', description: 'Run the test suite',
              input_preview: 'npm test', ...extra },
  });

test('a tool approval is raised in Hush as a decision', async () => {
  const { store, client, close } = await harness();
  try {
    const session = await until(() => store.list().find(s => s.title === 'Channel test'));
    await requestApproval(client, 'abcde');

    const waiting = await until(() => store.get(session.id).request);
    assert.ok(waiting, 'the approval should be waiting in Hush');
    assert.equal(waiting.id, 'abcde');
    assert.equal(waiting.kind, 'approval');
    assert.match(waiting.title, /Bash/);
    assert.match(waiting.detail, /npm test/);
    assert.equal(store.get(session.id).status, 'waiting');
  } finally { await close(); }
});

test('allowing in Hush sends an allow verdict', async () => {
  const { store, client, received, close } = await harness();
  try {
    const session = await until(() => store.list().find(s => s.title === 'Channel test'));
    await requestApproval(client, 'bcdef');
    await until(() => store.get(session.id).request);

    await store.answer(session.id, 'bcdef', 'accept');

    const verdict = await until(() => received.find(n =>
      n.method === 'notifications/claude/channel/permission' && n.params.request_id === 'bcdef'));
    assert.ok(verdict, 'the decision should have reached Claude Code');
    assert.equal(verdict.params.behavior, 'allow');
    assert.equal(store.get(session.id).request, null, 'the approval should be cleared');
  } finally { await close(); }
});

test('denying in Hush sends a deny verdict', async () => {
  const { store, client, received, close } = await harness();
  try {
    const session = await until(() => store.list().find(s => s.title === 'Channel test'));
    await requestApproval(client, 'cdefg');
    await until(() => store.get(session.id).request);

    await store.answer(session.id, 'cdefg', 'decline');

    const verdict = await until(() => received.find(n =>
      n.method === 'notifications/claude/channel/permission' && n.params.request_id === 'cdefg'));
    assert.equal(verdict.params.behavior, 'deny');
  } finally { await close(); }
});

test('a verdict is sent once, not repeated on every poll', async () => {
  const { store, client, received, close } = await harness();
  try {
    const session = await until(() => store.list().find(s => s.title === 'Channel test'));
    await requestApproval(client, 'defgh');
    await until(() => store.get(session.id).request);
    await store.answer(session.id, 'defgh', 'accept');
    await until(() => received.find(n => n.method === 'notifications/claude/channel/permission'));
    await settle(2500);
    const sent = received.filter(n =>
      n.method === 'notifications/claude/channel/permission' && n.params.request_id === 'defgh');
    assert.equal(sent.length, 1, 'a verdict must not be resent');
  } finally { await close(); }
});

test('the same approval arriving twice raises one decision', async () => {
  const { store, client, close } = await harness();
  try {
    const session = await until(() => store.list().find(s => s.title === 'Channel test'));
    await requestApproval(client, 'efghi');
    await until(() => store.get(session.id).request);
    await requestApproval(client, 'efghi');
    await settle(1200);
    assert.equal(store.get(session.id).requests.length, 1,
      'a duplicate must not stack a second decision on the user');
  } finally { await close(); }
});
