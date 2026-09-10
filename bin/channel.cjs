#!/usr/bin/env node
// Hush channel: a two-way bridge between a running Claude Code session and Hush.
//
// Claude Code spawns this over stdio as a channel server, so the session stays a
// normal Claude Code session that you can also use in its own terminal. Hush is a
// channel into it rather than a second owner, which is what makes this different
// from resuming: resuming starts a second process against a session an interactive
// client already holds, and the message is written to the transcript without the
// running client ever seeing it.
//
// Your replies reach the session as channel events. Claude's answers come back
// through the reply tool. Both directions go through Hush's existing local bridge,
// which is authenticated and bound to loopback.
//
// Nothing may be written to stdout except MCP protocol traffic; diagnostics go to
// stderr, which Claude Code captures.
const fs = require('node:fs');
const path = require('node:path');
const { bridgeFile } = require('../src/app-data.cjs');

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } =
  require('@modelcontextprotocol/sdk/types.js');

const POLL_MS = 800;
// stderr goes to the terminal, where a redrawing TUI can bury it. HUSH_CHANNEL_LOG
// also writes somewhere readable, for diagnosing what Claude Code did or did not send.
const note = message => {
  const line = `[hush-channel] ${message}\n`;
  process.stderr.write(line);
  if (process.env.HUSH_CHANNEL_LOG) {
    try { fs.appendFileSync(process.env.HUSH_CHANNEL_LOG, new Date().toISOString() + ' ' + line); }
    catch {}
  }
};

function readBridge() {
  const file = bridgeFile();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw Error(`Hush is not running, or its bridge file is unreadable at ${file}.`);
  }
  const { url, token } = JSON.parse(raw);
  if (!url || !token) throw Error('Hush bridge file is missing its url or token.');
  return { url, token };
}

async function main() {
  const bridge = readBridge();
  const title = process.env.HUSH_CHANNEL_TITLE
    || path.basename(process.cwd())
    || 'Claude Code';

  const call = async (method, pathname, body, key) => {
    const response = await fetch(bridge.url + pathname, {
      method,
      headers: {
        authorization: `Bearer ${bridge.token}`,
        'content-type': 'application/json',
        ...(key ? { 'x-session-key': key } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(data.error || `Hush bridge returned ${response.status}.`);
    return data;
  };

  const session = await call('POST', '/sessions',
    { provider: 'Claude Code', title, canReply: true });
  note(`registered with Hush as ${session.id}`);

  const mcp = new Server(
    { name: 'hush', version: '0.1.0' },
    {
      capabilities: {
        experimental: {
          'claude/channel': {},
          // Relay tool approvals to Hush. Declared only because the bridge
          // authenticates: whoever can answer here can allow tool use in the session.
          'claude/channel/permission': {},
        },
        tools: {},
      },
      instructions:
        'Messages from the user arrive as <channel source="hush"> events. They are '
        + 'the user speaking to you through Hush, a companion app, not another agent. '
        + 'Answer them as you would a message typed at the terminal, and send your '
        + 'answer back by calling the hush reply tool so it reaches them. Keep replies '
        + 'brief: they are read on a small panel over whatever the user is doing.',
    },
  );

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: 'reply',
      description: 'Send your answer back to the user in Hush. Call this whenever you '
        + 'have responded to a message that arrived from the hush channel.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The reply to show in Hush.' } },
        required: ['text'],
      },
    }],
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async request => {
    if (request.params.name !== 'reply') throw Error(`unknown tool: ${request.params.name}`);
    const { text } = request.params.arguments || {};
    if (typeof text !== 'string' || !text.trim())
      return { content: [{ type: 'text', text: 'Nothing to send.' }], isError: true };
    // The bridge caps a single event; keep the tail, which carries the conclusion.
    await call('POST', `/sessions/${session.id}/events`,
      { text: text.slice(-60000), status: 'done' }, session.key);
    return { content: [{ type: 'text', text: 'Sent to Hush.' }] };
  });

  // A tool approval Claude Code is holding open. Hand it to Hush as an Allow once /
  // Deny decision. The terminal dialog stays open too, and whichever answer arrives
  // first wins, so nothing here has to guess or time out on the user's behalf.
  const open = new Set();
  mcp.fallbackNotificationHandler = async notification => {
    note(`notification: ${notification.method}`);
    if (notification.method !== 'notifications/claude/channel/permission_request') return;
    const { request_id: requestId, tool_name: tool, description, input_preview: preview } =
      notification.params || {};
    if (!requestId) return;
    try {
      await call('POST', `/sessions/${session.id}/requests`, {
        id: requestId,
        title: `Allow ${tool || 'this step'}?${description ? ` ${description}` : ''}`.slice(0, 300),
        // Both fields are relayed from the model and are treated as text to show,
        // never as instructions.
        detail: typeof preview === 'string' ? preview
          : preview ? JSON.stringify(preview, null, 2) : undefined,
      }, session.key);
      open.add(requestId);
      note(`relayed approval ${requestId} for ${tool}`);
    } catch (error) {
      note(`could not relay approval ${requestId}: ${error.message}`);
    }
  };

  await mcp.connect(new StdioServerTransport());
  note('connected to Claude Code');

  let stopped = false;
  const shutdown = () => { stopped = true; };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Poll Hush for what the user has typed and push each message into the session.
  // Acknowledge only after the notification is away, so a crash re-delivers rather
  // than dropping: a message the user believes they sent must not vanish.
  while (!stopped) {
    try {
      const { messages } = await call('GET', `/sessions/${session.id}/replies`, null, session.key);
      for (const message of messages || []) {
        await mcp.notification({
          method: 'notifications/claude/channel',
          params: { content: message.text, meta: { source: 'hush' } },
        });
        await call('POST', `/sessions/${session.id}/ack`, { id: message.id }, session.key);
        note(`delivered ${message.id}`);
      }

      // Decisions the user made in Hush. Send each once; Claude Code ignores a verdict
      // for a request the terminal already answered, so a late one is harmless.
      const { verdicts } = await call('GET', `/sessions/${session.id}/verdicts`, null, session.key);
      for (const verdict of verdicts || []) {
        await mcp.notification({
          method: 'notifications/claude/channel/permission',
          params: {
            request_id: verdict.requestId,
            behavior: verdict.value === 'accept' ? 'allow' : 'deny',
          },
        });
        await call('POST', `/sessions/${session.id}/verdict-ack`,
          { requestId: verdict.requestId }, session.key);
        open.delete(verdict.requestId);
        note(`answered ${verdict.requestId} with ${verdict.value}`);
      }
    } catch (error) {
      note(`bridge poll failed: ${error.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

main().catch(error => {
  note(error.message);
  process.exit(1);
});
