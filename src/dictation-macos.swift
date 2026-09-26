// macOS dictation helper. Speaks the same line protocol as the Windows and Linux
// helpers: one JSON object per line on stdout, stop when the stop file appears.
//
// Two recognisers, because the good one is new. macOS 26 has SpeechAnalyzer, which runs
// on device with models the system downloads and manages, has no duration limit, and is
// several times faster than a bundled Whisper would be. Below that, SFSpeechRecognizer
// is what exists; it is weaker and caps an utterance at about a minute, so the helper
// restarts it rather than stopping dead at the cap.
//
// Built by scripts/build-mac-helper.cjs during packaging, or compiled once and cached on
// a source checkout. See docs/VOICE.md.

import AVFoundation
import Foundation
import Speech

// MARK: - protocol

let out = FileHandle.standardOutput
let lock = NSLock()

func emit(_ row: [String: String]) {
    guard let data = try? JSONSerialization.data(withJSONObject: row),
          var line = String(data: data, encoding: .utf8) else { return }
    line += "\n"
    lock.lock()
    out.write(Data(line.utf8))
    lock.unlock()
}

func say(_ text: String) {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    emit(["type": "text", "text": trimmed])
}

func die(_ message: String) -> Never {
    emit(["type": "error", "message": message])
    exit(1)
}

func argument(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let at = args.firstIndex(of: name), at + 1 < args.count else { return nil }
    return args[at + 1]
}

let stopFile = argument("--stop-file")
// A wave file is how this is checked without a microphone, matching the other helpers.
let wavePath = argument("--wave")
let legacyRecognizer = CommandLine.arguments.contains("--legacy-recognizer")

/// True once Hush has asked us to wind up.
func stopRequested() -> Bool {
    guard let stopFile else { return false }
    return FileManager.default.fileExists(atPath: stopFile)
}

// MARK: - permission

// Asking is required before either recogniser will do anything, and a refusal has to
// read as a refusal rather than as silence.
func requireAuthorisation() {
    let waiting = DispatchSemaphore(value: 0)
    var granted = false
    SFSpeechRecognizer.requestAuthorization { status in
        granted = status == .authorized
        waiting.signal()
    }
    if waiting.wait(timeout: .now() + 30) == .timedOut {
        die("Speech recognition did not answer the permission request.")
    }
    guard granted else {
        die("Hush is not allowed to use speech recognition. Turn it on in System Settings under Privacy & Security, then try again.")
    }
}

func requireMicrophone() {
    let waiting = DispatchSemaphore(value: 0)
    var granted = false
    AVCaptureDevice.requestAccess(for: .audio) { allowed in
        granted = allowed
        waiting.signal()
    }
    guard waiting.wait(timeout: .now() + 30) != .timedOut, granted else {
        die("Microphone access is disabled. Allow Hush in System Settings > Privacy & Security > Microphone, then try again.")
    }
}

// MARK: - microphone

/// Feeds 16 kHz mono buffers to whichever recogniser is in use.
final class Microphone {
    private let engine = AVAudioEngine()
    private var tapped = false
    private var converter: AVAudioConverter?
    let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000,
                               channels: 1, interleaved: false)!

    func start(_ onBuffer: @escaping (AVAudioPCMBuffer) -> Void) throws {
        let input = engine.inputNode
        let native = input.outputFormat(forBus: 0)
        guard native.sampleRate > 0 else {
            die("No microphone is available. Check the input device in System Settings.")
        }
        converter = AVAudioConverter(from: native, to: format)
        input.installTap(onBus: 0, bufferSize: 2048, format: native) { [weak self] buffer, _ in
            guard let self, let converter = self.converter else { return }
            let ratio = self.format.sampleRate / native.sampleRate
            let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1024
            guard let converted = AVAudioPCMBuffer(pcmFormat: self.format, frameCapacity: capacity) else { return }
            var supplied = false
            var error: NSError?
            converter.convert(to: converted, error: &error) { _, status in
                if supplied { status.pointee = .noDataNow; return nil }
                supplied = true
                status.pointee = .haveData
                return buffer
            }
            if error == nil && converted.frameLength > 0 { onBuffer(converted) }
        }
        tapped = true
        engine.prepare()
        try engine.start()
    }

    func stop() {
        if tapped { engine.inputNode.removeTap(onBus: 0); tapped = false }
        if engine.isRunning { engine.stop() }
    }
}

// MARK: - the newer recogniser

// SpeechAnalyzer is macOS 26 and later. Guarded so this same source still compiles and
// runs against an older SDK, where only the fallback below exists.
//
// compiler(>=6.2) and not swift(>=6.0): the latter tests the language mode, which
// defaults to 5 whatever compiler you have, so it excluded this block on a Swift 6.3
// toolchain. Xcode 26 is the first with both Swift 6.2 and the macOS 26 SDK that
// carries these symbols, which is exactly the pairing this needs.
#if canImport(Speech) && compiler(>=6.2)
@available(macOS 26.0, *)
func runSpeechAnalyzer() async throws -> Bool {
    // Read the list once. Awaiting inside ?? does not compile, because its right side is
    // an autoclosure and an autoclosure cannot await.
    let supported = await SpeechTranscriber.supportedLocales
    let wanted = Locale.current.identifier(.bcp47)
    guard let locale = supported.first(where: { $0.identifier(.bcp47) == wanted })
        ?? supported.first(where: { $0.language.languageCode?.identifier == "en" })
    else { return false }

    // Spelled out rather than taking a preset: only final results are used here, so
    // there is nothing to gain from asking for volatile ones.
    let transcriber = SpeechTranscriber(locale: locale,
                                        transcriptionOptions: [],
                                        reportingOptions: [],
                                        attributeOptions: [])
    let analyzer = SpeechAnalyzer(modules: [transcriber])

    // The model is the system's to fetch, not ours to bundle.
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        try await request.downloadAndInstall()
    }

    let (stream, feed) = AsyncStream<AnalyzerInput>.makeStream()
    let microphone = Microphone()
    guard let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
        return false
    }

    let results = Task {
        for try await result in transcriber.results where result.isFinal {
            say(String(result.text.characters))
        }
    }

    defer { microphone.stop(); feed.finish(); results.cancel() }
    if stopRequested() { return true }
    if let wavePath {
        let audio = try AVAudioFile(forReading: URL(fileURLWithPath: wavePath))
        emit(["type": "ready"])
        try await analyzer.start(inputAudioFile: audio, finishAfterFile: true)
        try await results.value
        return true
    }

    try microphone.start { buffer in
        guard let converted = convert(buffer, to: analyzerFormat) else { return }
        feed.yield(AnalyzerInput(buffer: converted))
    }
    try await analyzer.start(inputSequence: stream)
    emit(["type": "ready"])

    while !stopRequested() { try await Task.sleep(nanoseconds: 200_000_000) }

    microphone.stop()
    feed.finish()
    // Finalise rather than cancel: the phrase being spoken is usually why Stop was hit.
    try await analyzer.finalizeAndFinishThroughEndOfInput()
    try await results.value
    return true
}

@available(macOS 26.0, *)
func convert(_ buffer: AVAudioPCMBuffer, to format: AVAudioFormat) -> AVAudioPCMBuffer? {
    if buffer.format == format { return buffer }
    guard let converter = AVAudioConverter(from: buffer.format, to: format) else { return nil }
    let ratio = format.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1024
    guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
    var supplied = false
    var error: NSError?
    converter.convert(to: converted, error: &error) { _, status in
        if supplied { status.pointee = .noDataNow; return nil }
        supplied = true
        status.pointee = .haveData
        return buffer
    }
    return error == nil ? converted : nil
}
#endif

// MARK: - the older recogniser

// SFSpeechRecognizer ends an utterance after about a minute, so a long dictation means
// starting a fresh task each time one finishes. Everything already said has been emitted,
// so nothing is lost across the seam.
func runSpeechRecognizer() {
    guard let recogniser = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer() else {
        die("This Mac has no speech recogniser for the current language.")
    }
    guard recogniser.isAvailable else {
        die("Speech recognition is unavailable. Turn Dictation on in System Settings under Keyboard, then try again.")
    }
    guard recogniser.supportsOnDeviceRecognition else {
        die("On-device dictation is unavailable for this language. Enable Dictation in System Settings > Keyboard, or type your reply instead. Hush will not send audio to a speech service.")
    }

    let microphone = Microphone()
    let queue = DispatchQueue(label: "dev.hush.dictation")
    var request: SFSpeechAudioBufferRecognitionRequest?
    var task: SFSpeechRecognitionTask?
    var finished = false
    var lastSaid = ""

    func begin() {
        let fresh = SFSpeechAudioBufferRecognitionRequest()
        fresh.shouldReportPartialResults = true
        fresh.requiresOnDeviceRecognition = true
        request = fresh
        lastSaid = ""
        task = recogniser.recognitionTask(with: fresh) { result, error in
            if let result {
                let text = result.bestTranscription.formattedString
                if result.isFinal {
                    say(text)
                    lastSaid = text
                    // The cap was reached rather than the user stopping: pick straight up.
                    if !finished && !stopRequested() { queue.async { begin() } }
                }
            }
            if error != nil && !finished {
                // An error after something was said is the utterance ending, not a fault.
                if lastSaid.isEmpty && !stopRequested() {
                    die("Dictation stopped: \(error!.localizedDescription). Check Dictation in System Settings > Keyboard, then try again.")
                }
            }
        }
    }

    queue.sync { begin() }
    do {
        try microphone.start { buffer in request?.append(buffer) }
    } catch {
        die("Could not open the microphone: \(error.localizedDescription)")
    }
    emit(["type": "ready"])

    while !stopRequested() { RunLoop.current.run(until: Date().addingTimeInterval(0.2)) }

    finished = true
    microphone.stop()
    // Let the recogniser settle the phrase in flight instead of cutting it off.
    request?.endAudio()
    let settle = Date().addingTimeInterval(5)
    while Date() < settle && task?.isFinishing == false { RunLoop.current.run(until: Date().addingTimeInterval(0.1)) }
    task?.finish()
    RunLoop.current.run(until: Date().addingTimeInterval(0.4))
}

// MARK: - a wave file, for checking without a microphone

func runWaveFile(_ path: String) {
    guard let recogniser = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer() else {
        die("This Mac has no speech recogniser for the current language.")
    }
    guard recogniser.supportsOnDeviceRecognition else {
        die("On-device dictation is unavailable for this language. Hush will not send audio to a speech service.")
    }
    let request = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: path))
    request.requiresOnDeviceRecognition = true
    request.shouldReportPartialResults = false
    emit(["type": "ready"])
    var spoke = false
    let task = recogniser.recognitionTask(with: request) { result, error in
        if let result, result.isFinal {
            say(result.bestTranscription.formattedString)
            spoke = true
        } else if error != nil {
            die("Could not transcribe the recording: \(error!.localizedDescription)")
        }
    }
    let deadline = Date().addingTimeInterval(60)
    withExtendedLifetime(task) {
        while !spoke && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
    }
    if !spoke { task.cancel(); die("Speech recognition did not finish. Enable Dictation in System Settings > Keyboard, then try again.") }
}

// MARK: - what this build can actually do

// Reports which recogniser this binary was compiled with and which one this Mac would
// use, without touching the microphone or asking for permission. CI runs this: compiling
// proves the Swift is valid, but only running it proves the newer path was compiled in
// rather than quietly excluded by the version guard around it.
func reportCapabilities() {
    // Decided inside the guard rather than by a flag read outside it: once the block is
    // compiled the flag is a constant, and the compiler warns about the branch it can
    // prove is dead. That warning was useful once and is only noise now.
    #if canImport(Speech) && compiler(>=6.2)
    let analyzerCompiled = "yes"
    let analyzerUsable = { if #available(macOS 26.0, *) { return "yes" } else { return "no" } }()
    #else
    let analyzerCompiled = "no"
    let analyzerUsable = "no"
    #endif
    let recogniser = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer()
    let row: [String: String] = [
        "type": "capabilities",
        "analyzerCompiled": analyzerCompiled,
        "analyzerUsable": analyzerUsable,
        "recognizer": recogniser == nil ? "no" : "yes",
        "os": ProcessInfo.processInfo.operatingSystemVersionString,
    ]
    emit(row)
}

// MARK: - main

if CommandLine.arguments.contains("--capabilities") {
    reportCapabilities()
    exit(0)
}

if wavePath == nil { requireMicrophone() }
if stopRequested() { exit(0) }

var handled = false
#if canImport(Speech) && compiler(>=6.2)
if #available(macOS 26.0, *), !legacyRecognizer {
    let waiting = DispatchSemaphore(value: 0)
    Task {
        do { handled = try await runSpeechAnalyzer() }
        catch { die("Could not start on-device dictation: \(error.localizedDescription). Check Dictation in System Settings > Keyboard, then try again.") }
        waiting.signal()
    }
    waiting.wait()
}
#endif
if !handled {
    requireAuthorisation()
    if stopRequested() { exit(0) }
    if let wavePath { runWaveFile(wavePath) }
    else { runSpeechRecognizer() }
}
exit(0)
