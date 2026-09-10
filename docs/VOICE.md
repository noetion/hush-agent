# Dictation

## What other tools do

Voice input for desktop apps splits cleanly into three approaches, and the split is about where the model runs rather than about the UI.

**A local Whisper model.** Superwhisper and MacWhisper ship Whisper (or a Parakeet variant) and run it on the user's machine. Private, works offline, no subscription. The costs are a model download of roughly 75 MB to 1.5 GB depending on size, a native binary per platform and architecture, and speed that tracks the user's CPU. Reported throughput is around 120–140 WPM.

**A cloud model.** Wispr Flow sends audio to its own servers. Fastest of the three at about 184 WPM, and noticeably more robust in a noisy room because the model is larger. It needs a connection, a subscription, and it means the audio leaves the machine. There is no on-device mode at any tier.

**The operating system's own recogniser.** What Hush already does on Windows through `System.Speech`. Nothing to download, nothing to pay for, no audio leaving the machine, but historically the weakest accuracy of the three.

On clean speech in a quiet room the three are within a few points of each other; the differences show up in noise, in throughput, and in what the user has to install or pay for.

## What Hush does, and why

Hush uses **each platform's own recogniser**, behind one contract, and it is the operating-system approach above rather than either of the other two.

That follows from what Hush already is. It states plainly that it does not create an API subscription, so a cloud transcriber that needs its own key or plan would contradict the product. It is a quiet local companion that sits beside your work, so audio leaving the machine is the wrong default. And it is already a large Electron download; adding a Whisper model and a native addon per platform and architecture is a lot of weight for a feature reached from one button.

The decisive change is that the operating-system option is no longer the weak one on macOS. Apple's `SpeechAnalyzer` and `SpeechTranscriber`, in macOS 26, run entirely on device with models the system downloads and manages, carry no duration limit, and Apple measures them at roughly three times the speed of Whisper Small and 2.2 times that of Whisper Large V3. That is a better answer than bundling Whisper ourselves, and it costs nothing to ship.

Two options were ruled out rather than skipped:

- **The Web Speech API**, which would have been the least code by far, does not work here. Google shut its Chrome speech service off for shell environments like Electron, and `webkitSpeechRecognition` is a Chrome-only surface rather than a Chromium one.
- **Whisper through a Node addon.** The maintained options are thin: the most popular binding has not been published in about two years, and the actively developed one describes itself as early and experimental and advises against production use.

## The three backends

Each backend is a process that writes one JSON object per line to stdout and stops when asked. Everything above them — assembling the transcript, the button, the draft — is shared.

| | recogniser | shape |
|---|---|---|
| Windows | `System.Speech` via PowerShell | streams phrases live |
| macOS | `SpeechAnalyzer` on macOS 26, `SFSpeechRecognizer` below it | streams phrases live |
| Linux | records, then transcribes with whatever is installed | one transcript at the end |

Linux is the honest exception. It has no system recogniser to call, so Hush records with the first of `arecord`, `parecord` or `ffmpeg` it finds and then hands the recording to a transcriber: a whisper.cpp CLI if one is on `PATH`, or whatever `HUSH_DICTATION_CMD` names. With neither installed the button does not appear, and Hush says which piece is missing rather than failing at the microphone.

## Line protocol

```
{"type":"ready"}                     the recogniser is listening
{"type":"text","text":"..."}         one recognised phrase, emitted as it lands
{"type":"empty"}                     nothing was said
{"type":"error","message":"..."}     with a non-zero exit
```

Phrases are emitted as they are recognised rather than held to the end, so what has already been said survives even if the helper is killed. Stopping is a file the helper watches, not a signal, so it can finalise the phrase being spoken instead of discarding it — that phrase is usually the reason the user reached for Stop.

## What is verified

The line protocol, transcript assembly, backend selection and the Linux record-then-transcribe pipeline are covered by tests that run on any platform, using stand-in commands. Windows is verified end to end against real synthesised speech.

The macOS helper is compiled in CI, which proves it builds against the real SDK on a real macOS runner. **Nobody has yet spoken into it.** Its accuracy, its permission prompts and its behaviour when Dictation is disabled in System Settings are unverified. The same is true of the Linux path, where no recorder or transcriber was installed on any machine available here.
