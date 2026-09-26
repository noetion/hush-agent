# Verification and limits

This file records what has been exercised and what remains unverified. A successful build is not evidence of every provider or permission journey.

## Automated checks

The workflow in `.github/workflows/ci.yml` runs on Windows, Linux, macOS ARM64 and macOS Intel. It checks:

- The unit suite, including session isolation, delivery failures, approval decisions, history, attachments, dictation protocol and shell quoting.
- The real app through `npm start`, using isolated data. The self-test covers minimize/restore, silent cues, quiet mode, fixture replies and approvals, model selection, draft retention, idle fade/collapse, error visibility and platform-correct shortcut labels.
- A package build and a two-way channel exchange from inside its archive.
- On macOS, the helper's two architecture slices, macOS 13 deployment targets, embedded permission descriptions and signature, both before and after packaging. The ARM64 job also requires SpeechAnalyzer to be compiled in.

The self-test reports any pointer-placement claims it cannot establish. Screenshots are captured as evidence but are not visual assertions. Provider and microphone tests need a signed-in or interactive machine and are not implied by this workflow.

## Local macOS checks, 26 September 2026

On Apple Silicon with macOS 27.0 and Node 24.21.0:

- The unit suite passed: 71 passed, no failures, one Windows-only skip.
- `npm start` and its real-app self-test passed with an isolated profile. The inspected normal and compact layouts remained readable without overflow; Command shortcut labels matched macOS.
- The universal speech helper compiled. Both architecture slices declare macOS 13.0 as their minimum version, and its permission descriptions and ad-hoc signature passed inspection.
- SpeechAnalyzer transcribed a generated recording containing two sentences, including “keyboard navigation” and “tests again”, through the source app's dictation path.
- The legacy recognizer's failure path returned an explicit “Siri and Dictation are disabled” error on this machine. Legacy transcription accuracy has **not** been established with Dictation enabled.
- The updated ARM64 package built, and its universal helper passed the same binary checks.
- A two-way channel exchange passed inside the updated package.
- A live Codex conversation started without a project folder, appeared in Tasks, resumed with its history and retained context on the next reply.

The initial repository audit also exercised live Codex and Claude Code new-session replies on this Mac. Both returned `HUSH_CONNECTED`. It verified the packaged app self-test. Those tests do not establish replies to currently desktop-owned tasks, every tool permission, or image delivery through every provider.

## Earlier evidence

Earlier checks on Windows exercised live Codex and Claude Code replies, Cursor CLI conversations, synthesized-speech dictation, a cold installation and idle resource usage. These historical observations are retained as context; they are not measurements of the current build on every platform.

## Remaining limits

- Microphone recognition quality, permission denial/retry, long dictation and speech cut off during Stop need interactive use on supported Macs. Generated-recording recognition does not establish microphone accuracy.
- macOS 13 and 14 runtime behaviour has not been exercised locally. Targeting macOS 13 establishes the binary deployment target, not a complete oldest-OS compatibility test.
- Cursor and Herdr live integrations were not available on the local Mac.
- Sustained daily use, monitor disconnects, mixed DPI, Spaces, exclusive fullscreen and VoiceOver have not been comprehensively tested.
- Local package builds are unsigned development artifacts. The public installation path for this launch is the source repository.
