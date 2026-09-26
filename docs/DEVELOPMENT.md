# Development

Use Node.js 22 or newer. Install locked dependencies with `npm ci`.

```bash
npm test
npm start
npm run package
```

`npm run package` builds an unsigned portable EXE, DMG or AppImage for the current platform. These are local development builds, not signed public downloads.

## Isolated checks

Use `HUSH_DATA_DIR` to keep test preferences and drafts separate from normal use. Never share a profile between simultaneous instances.

```bash
HUSH_SELF_TEST=1 HUSH_DATA_DIR="$PWD/artifacts/test-profile" npm start
```

The self-test drives the real app and writes screenshots and a JSON report under `artifacts/`. On headless Linux, it needs a display and window manager. See `.github/workflows/ci.yml` for setup.

After packaging, run `node test/channel-packaged.cjs` to exercise the channel inside the packaged app. Live provider checks can use an existing sign-in and create new conversations; inspect their scripts before running them.

`HUSH_CODEX_BIN` and `HUSH_CLAUDE_BIN` select specific executables. `HUSH_ARTIFACTS` selects the self-test report directory. Integration details are in [BRIDGE.md](BRIDGE.md), and the evidence and remaining limits are in [VERIFICATION.md](VERIFICATION.md).

## macOS helper

`npm run build:mac-helper` builds the dictation helper with Apple's command-line tools. The helper contains ARM64 and Intel slices, both targeting macOS 13. Its embedded permission descriptions accompany the source app's prepared permission metadata. Packaging uses the same build path. The cache includes the source, permission descriptions, compiler version, architecture set and deployment target.

`node scripts/check-mac-helper.cjs` checks the actual binary's architectures, deployment targets, signature and permission descriptions. SpeechAnalyzer needs a Swift 6.2 or newer compiler and a macOS 26 or newer SDK; older SDKs build only the on-device SFSpeechRecognizer path.
