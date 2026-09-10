# What is verified, and what is not

Hush makes some specific claims. This says which of them have been checked, how, and which have not — so you can judge the rest of the documentation by it.

The blow-by-blow record of every release lives in this file's git history rather than here.

## Checked automatically, on every pull request and merge

On Windows, macOS and Linux:

- **70 unit tests**, including the shell quoting used for the macOS terminal handoff, which is verified by asking a real shell what nineteen hostile values expand to rather than by comparing against expected output.
- **The real application**, booted and driven through its own windows: no visible idle window, a cue that is visible but never focused or focusable, quiet mode suppressing it, replies and approvals, the two-stage recede, dwell-to-wake, and both error paths reaching the user.
- **A package build**, which is where an icon in a format the target cannot read, or a runtime file that does not survive being put in an asar, shows up.
- **The channel from that packaged build**, reading `bin/channel.cjs` out of `app.asar` with the packaged binary behaving as Node.

The macOS dictation helper is compiled against the real macOS SDK and then run, because compiling alone would not prove the newer recogniser was included rather than quietly excluded by the version guard around it.

## Checked by hand

- **Providers, live**: Codex and Claude Code returned `HUSH_CONNECTED`; Cursor discovered existing ACP conversations and replied on `gpt-5.6-luna`.
- **Windows dictation**, against real synthesised speech: a two-sentence recording comes back whole.
- **Idle cost**: zero CPU seconds across a ten second window, 386 MB across five processes.
- **A cold clone**: `git clone`, `npm ci`, boot, and the full self-test passing.

## Not verified

- **Nobody has used Hush on a Mac or a Linux desktop.** Continuous integration proves it builds, boots, drives its own windows and packages there. It does not prove it feels right.
- **Nobody has spoken into the macOS or Linux dictation.** Accuracy, the permission prompts, and what happens when Dictation is off in System Settings are all unknown.
- **Herdr has not been re-checked recently**, because no `herdr` binary exists on the machine this was built on. It completed a live round trip when it was written.
- **Sustained real use**, multiple monitors, mixed DPI, and exclusive-fullscreen games are untested.
- The packaged builds are **unsigned**.
