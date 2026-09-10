# Why Hush is shaped this way

The problem: coding agents run for minutes and then wait for you. Watching a terminal for that is wasteful, and alt-tabbing back into a full agent application to type one sentence costs more attention than the sentence is worth.

## Shapes this could have taken

| Approach | Strength | Why it was or was not chosen |
|---|---|---|
| Always-visible floating panel | Immediate access | Permanently occupies screen space and can cover whatever you are actually doing. Rejected as the default, though Hush can be left open and recedes instead. |
| Game or application plugin | Deep integration with one host | Specific to that host, and useless for films, browsing or ordinary desktop work. |
| System notification only | Familiar, tiny footprint | No room to read context, pick between sessions, or answer a structured question. |
| Browser extension | Easy where the work is a web app | Cannot reach the desktop, which is where these CLIs run. |
| Tray application with a brief cue and an inbox on demand | Nothing on screen when idle, quick replies over any application | **Selected.** Desktop window behaviour is part of what the self-test checks. |

## Why Electron

A native implementation on each platform would use less memory. Electron was chosen because it gives documented non-activating windows, tray and global-shortcut APIs, and keeps the provider SDKs and local transports in one runtime. The cost is a larger download and a heavier idle footprint, measured and recorded in [what is verified](VERIFICATION.md).

That trade paid off when the app went cross-platform: the parts that were not portable turned out to be six specific places rather than the architecture. Windows, macOS and Linux each build, boot and pass the self-test.

## Interfaces this depends on

Each of these was read and exercised rather than assumed:

- [Codex app-server](https://learn.chatgpt.com/docs/app-server) — initialization, thread start and resume, turn start, notifications, and scoped approval decisions. The installed protocol schemas were generated and inspected. The official runtime is bundled with Hush.
- [Claude Code SDK](https://code.claude.com/docs/en/agent-sdk/user-input) — tool permission callbacks, checked against the installed SDK's TypeScript declarations.
- [Herdr CLI](https://herdr.dev/docs/cli-reference/) and [socket API](https://herdr.dev/docs/socket-api/) — agent discovery, prompting, process identity, output and focus, validated against a real 0.9.0 binary.
- [Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window) — genuinely hidden windows and non-activating notifications, tested on a real desktop.

Hush does not claim universal takeover of existing sessions. Direct providers own their own connections, Herdr provides access to its terminals, and anything else implements the small [local bridge](BRIDGE.md).
