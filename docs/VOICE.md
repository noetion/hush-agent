# Dictation setup and implementation

Hush turns speech into an editable draft. It does not send that draft to an agent until you submit it. Click the microphone to start and Stop to finish.

## macOS

Source installations need Apple's command-line tools (`xcode-select --install`). The source launcher prepares the local Electron bundle's permission descriptions and launches it through macOS, so permission requests belong to Hush rather than the terminal or editor that started it.

Allow microphone access in **System Settings → Privacy & Security → Microphone**. The older recognizer also requests Speech Recognition permission. Enable Dictation under **System Settings → Keyboard** when speech assets are unavailable.

macOS 26 and newer use SpeechAnalyzer when compiled with a compatible SDK. Older releases use SFSpeechRecognizer with on-device recognition required. If the recognizer cannot run locally for the selected language, Hush refuses the request and explains how to continue. It never falls back to server recognition. Apple can download system speech assets before first use.

## Windows

Hush uses the installed `System.Speech` recognizer through PowerShell. Check the system's microphone and speech settings if recognition is unavailable.

## Linux setup

Install a recorder (`arecord`, `parecord` or `ffmpeg`) and a whisper.cpp CLI. Obtain a compatible local model and set its path before starting Hush:

```bash
HUSH_DICTATION_MODEL=/absolute/path/to/ggml-model.bin npm start
```

For another transcriber, set `HUSH_DICTATION_CMD` to its command and arguments. Use `{}` where it expects the recorded file path:

```bash
HUSH_DICTATION_CMD='my-transcriber --input {}' npm start
```

The command is split on whitespace; use executable and model paths without spaces. `HUSH_DICTATION_RECORDER` can select a recorder explicitly. Hush reports missing components in the microphone button's tooltip rather than hiding the control.

Linux records first and transcribes after Stop. A custom command controls its own data handling; use a local transcriber if audio must remain on your computer.

## Helper protocol

The platform helper writes JSON objects, one per line:

```json
{"type":"ready"}
{"type":"text","text":"Recognized phrase"}
{"type":"empty"}
{"type":"error","message":"Actionable explanation"}
```

Hush assembles all returned phrases when dictation finishes. A stop file asks the helper to finalize the phrase in progress. An abnormal exit without a transcript becomes a visible error. The parent owns the helper and requests shutdown when the app quits.

## Verification

See [VERIFICATION.md](VERIFICATION.md) for the checks run and their limits. The opt-in macOS recording check uses a generated two-sentence fixture and may request Speech Recognition permission:

```bash
mkdir -p artifacts
say -r 130 -o artifacts/dictation.aiff 'Please fix the keyboard navigation. Then run the tests again.'
HUSH_DICTATION_CHECK=1 HUSH_DATA_DIR="$PWD/artifacts/dictation-profile" HUSH_DICTATION_WAV="$PWD/artifacts/dictation.aiff" npm start
```

The result is written to `artifacts/mac-dictation-live.json`. This exercises both recognition paths on a compatible Mac; it does not measure microphone accuracy.
