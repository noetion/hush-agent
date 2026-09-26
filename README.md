# Hush

**Keep your coding agents close without interrupting your work.**

Hush is a small desktop panel for Codex, Claude Code and Cursor Agent CLI. See when an agent needs you, send a reply, and return to what you were doing. Notifications are silent and do not take focus.

## Install and run

You need [Node.js 22 or newer](https://nodejs.org/), [Git](https://git-scm.com/), and an account for the agent you want to use. Hush runs on Windows, macOS 13 or newer, and Linux with a desktop session.

On macOS, create a folder with `mkdir -p ~/Developer`, then run `cd ~/Developer` before cloning. This avoids the access restrictions macOS applies to Desktop, Documents and Downloads.

```bash
git clone https://github.com/noetion/hush-agent.git
cd hush-agent
npm ci
npm start
```

Quit Hush from its tray or menu bar menu when you are finished.

Codex is included. Sign in to Codex if you have not already; Hush uses your existing sign-in. To use [Claude Code](https://code.claude.com/docs/en/overview) or [Cursor Agent CLI](https://cursor.com/docs/cli/overview), install and sign in to that CLI first. Your provider's plan and usage limits still apply. Hush requires no separate account or subscription.

On macOS, dictation from a source installation also needs Apple's command-line tools. Install them once with `xcode-select --install`. You can use Hush without dictation while they are unavailable.

## Your first conversation

1. Open **Tasks** and choose an existing conversation, or select **New** to start one. A project folder is optional for a new conversation.
2. Type a reply, attach an image when available, or use the microphone to dictate.
3. Press **Command+Enter** on macOS or **Ctrl+Enter** on Windows and Linux to send and hide the panel.

Use **Command+Shift+Space** on macOS or **Ctrl+Shift+Space** on Windows and Linux to bring Hush back. You can also click its tray or menu bar icon. **Escape** hides the panel and keeps your draft. Closing the panel minimizes it; agents remain connected until you quit Hush.

When an agent finishes or needs input, a small cue appears for five seconds. Click it to open Hush. Cues contain no message preview and are limited to one every fifteen seconds. **Quiet mode** pauses them while the unread count remains available.

## Supported conversations

| Agent | What you can do | What to know |
|---|---|---|
| **Codex** | Start conversations, resume saved ones, send replies and images, and choose models for conversations started or resumed in Hush. | For tasks still owned by Codex, keep Codex running. Replies reach the same task; model changes and approval prompts stay in Codex. |
| **Claude Code** | Start and resume conversations, send images, choose models, and answer tool permissions in Hush. | Replies to a conversation running in another Claude Code window arrive as messages from Hush. Images and permission decisions for that conversation stay in the original window. Close that window before resuming the conversation in Hush. |
| **Cursor Agent CLI** | Start and resume CLI conversations, send images, choose models, and answer permission prompts. | Conversations created in the Cursor IDE are unavailable. Install and sign in to the Agent CLI separately. |

For a finished conversation started or resumed in Hush, **Open terminal** lets you continue in the agent's own CLI. Hush releases that connection first.

If you use Herdr, keep its server running and choose **Connect live Herdr agents** in Tasks. For custom integrations, see the [integration guide](docs/BRIDGE.md).

## Dictation

Click the microphone to start, speak, then click **Stop**. The transcript is added to your draft for editing; it is sent to the agent only when you send your reply.

- **macOS:** uses on-device speech recognition. Allow microphone access when requested. Older macOS versions may also request speech-recognition permission. Enable Dictation in **System Settings → Keyboard** if recognition is unavailable. Apple may need an internet connection to download speech assets before first use.
- **Windows:** uses the installed Windows speech recognizer.
- **Linux:** needs a recorder and a local transcriber. Follow the [Linux dictation setup](docs/VOICE.md#linux-setup).

On macOS, Hush refuses recognition when an on-device recognizer is unavailable rather than sending audio to a speech service. If dictation cannot start, Hush explains the problem and you can continue typing.

## Make it suit your workspace

Choose a screen corner in **Preferences**, or drag the header to place Hush yourself. Notifications appear on the screen where your pointer is.

When idle, the panel dims after about two seconds and rolls up after five. It lets clicks pass through while dimmed. Rest your pointer over it, type, or use the shortcut to wake it. A draft extends the delay; dictation and a pending decision keep it open. Turn this behaviour off in Preferences if you want the panel to stay visible.

Normal windows and borderless fullscreen work with the overlay. Exclusive fullscreen can cover it.

## Privacy and local data

Hush adds no analytics or remote relay. Replies and attachments go to the agent provider you choose and are subject to that provider's data policies.

Preferences, connection details, drafts and saved images are stored locally:

| Platform | Location |
|---|---|
| Windows | `%APPDATA%\Hush` |
| macOS | `~/Library/Application Support/Hush` |
| Linux | `~/.config/Hush` |

Conversation text stays in memory while Hush runs; providers retain their own history. Saved images remain on your computer so replies and history can use them. Remove them with **Preferences → Clear saved images** when no replies or agent turns are pending.

## Update

Quit Hush, then run these commands inside your `hush-agent` folder:

```bash
git pull --ff-only
npm ci
npm start
```

## Troubleshooting

- **No conversations appear:** check that the relevant agent is installed and signed in, select it in Tasks, then click **Refresh**. Cursor IDE chats do not appear in Hush.
- **A reply remains queued in Codex:** keep the owning Codex app open and check that task there before sending again.
- **The shortcut is unavailable:** another app may be using it. Open Hush from the tray or menu bar.
- **Dictation is blocked on macOS:** enable Microphone and, when requested, Speech Recognition in **System Settings → Privacy & Security**, then restart Hush. Source installations also need the command-line tools.
- **Electron is missing after installation:** run `node node_modules/electron/install.js`, then `npm start`.

## Contribute

Bug reports and focused contributions are welcome. Include your operating system, Hush version, agent, and steps to reproduce. See [development and verification](docs/DEVELOPMENT.md) for running checks and building locally.

## License

[MIT](LICENSE).
