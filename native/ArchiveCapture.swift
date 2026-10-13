// Recorder: explicitly confirmed window or display, H.264 segments, PCM WAV
// sources and original SCK presentation timestamps. No inference in this process.
import AppKit
import AVFoundation
import CoreMedia
import CoreGraphics
import Foundation
import ScreenCaptureKit
import VideoToolbox

var eventFile: FileHandle?
let eventLock = NSLock()
func emit(_ value: [String: Any]) {
    eventLock.lock(); defer { eventLock.unlock() }
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
        if let file = eventFile { try? file.write(contentsOf: data + Data([10])) }
        else { FileHandle.standardOutput.write(data + Data([10])) }
    }
}
func failure(_ message: String) -> NSError {
    NSError(domain: "ArchiveCapture", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}
func ptsObject(_ time: CMTime) -> [String: Any] {
    ["value": time.value, "timescale": time.timescale, "seconds": CMTimeGetSeconds(time)]
}
func frameStatusName(_ status: Int?) -> String {
    switch status {
    case SCFrameStatus.complete.rawValue: return "complete"
    case SCFrameStatus.idle.rawValue: return "idle"
    case SCFrameStatus.blank.rawValue: return "blank"
    case SCFrameStatus.suspended.rawValue: return "suspended"
    case SCFrameStatus.started.rawValue: return "started"
    case SCFrameStatus.stopped.rawValue: return "stopped"
    default: return "waiting"
    }
}
func atomicJSON(_ object: [String: Any], at url: URL) throws {
    try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]).write(to: url, options: .atomic)
}
func syncFile(_ url: URL) throws {
    let handle = try FileHandle(forWritingTo: url)
    try handle.synchronize(); try handle.close()
}

// Copy scalar metadata before crossing the media queue; do not retain an SCK
// object or any other window's pixels/titles in diagnostic snapshots.
struct CaptureTargetObservation: Sendable {
    let windowID: UInt32
    var displayID: UInt32 = 0
    let observedHostSeconds: Double
    let exists: Bool
    let isOnScreen: Bool?
    let frame: [String: Double]?
    let sameApplicationWindowIDs: [UInt32]
    let sameApplicationWindowCount: Int
    var json: [String: Any] {
        var result: [String: Any] = ["windowID": windowID,
            "observedAtHostPTS": ptsObject(CMTime(seconds: observedHostSeconds, preferredTimescale: 1_000_000_000)),
            "exists": exists, "sameApplicationWindowIDs": sameApplicationWindowIDs,
            "sameApplicationWindowCount": sameApplicationWindowCount]
        result["captureKind"] = displayID > 0 ? "display" : "window"
        if displayID > 0 { result["displayID"] = displayID }
        if let isOnScreen = isOnScreen { result["isOnScreen"] = isOnScreen }
        if let frame = frame { result["frame"] = frame }
        return result
    }
}

// These checks do not capture media or open a system prompt. Accessibility is
// not used by the explicit-window ScreenCaptureKit recorder.
func capturePermissions() -> [String: String] {
    let microphone: String
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: microphone = "granted"
    case .notDetermined: microphone = "not-determined"
    case .denied: microphone = "denied"
    case .restricted: microphone = "restricted"
    @unknown default: microphone = "restricted"
    }
    return ["screenRecording": CGPreflightScreenCaptureAccess() ? "granted" : "not-granted",
            "microphone": microphone, "systemAudio": "uses-screen-recording", "accessibility": "not-required"]
}
@MainActor func requestCapturePermissions(screen: Bool, microphone: Bool) async -> [String: String] {
    if screen && !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
    if microphone && AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
        _ = await AVCaptureDevice.requestAccess(for: .audio)
    }
    return capturePermissions()
}
func requireScreenPermission() throws {
    guard CGPreflightScreenCaptureAccess() else {
        throw failure("Screen recording permission is required. Use Grant screen recording, then enable the recorder or its launching app in System Settings > Privacy & Security > Screen & System Audio Recording. Restart the local recorder service if macOS requests it.")
    }
}

struct Options {
    var command = "list"
    var directory = ""
    var file = ""
    var windowID: UInt32 = 0
    var displayID: UInt32 = 0
    var captureKind: String { displayID > 0 ? "display" : "window" }
    var targetName: String { "selected " + captureKind }
    var microphoneID: String?
    var microphone = false
    var systemAudio = false
    var requestScreen = false
    var permission = ""
    var fixtureScenario = "normal"
    var fps = 15
    var maxEdge = 2560
    var bitrate = 6_000_000
    var segmentSeconds = 10.0
    init(_ args: [String]) throws {
        if args.count > 1 { command = args[1] }
        var i = 2
        while i < args.count {
            let key = args[i]
            if key == "--mic" { microphone = true; i += 1; continue }
            if key == "--system-audio" { systemAudio = true; i += 1; continue }
            if key == "--screen" { requestScreen = true; i += 1; continue }
            guard i + 1 < args.count else { throw failure("Missing value for \(key)") }
            let v = args[i + 1]
            switch key {
            case "--dir": directory = v
            case "--file": file = v
            case "--window", "--display":
                guard let id = UInt32(v), id > 0 else { throw failure("Invalid capture target ID") }
                guard windowID == 0, displayID == 0 else { throw failure("Choose exactly one window or display") }
                if key == "--window" { windowID = id } else { displayID = id }
            case "--mic-device": microphoneID = v
            case "--fps": fps = Int(v) ?? 0
            case "--max-edge": maxEdge = Int(v) ?? 0
            case "--bitrate": bitrate = Int(v) ?? 0
            case "--segment-seconds": segmentSeconds = Double(v) ?? 0
            case "--permission": permission = v
            case "--fixture-scenario": fixtureScenario = v
            default: throw failure("Unknown option \(key)")
            }
            i += 2
        }
        guard [15, 30].contains(fps), (320...2560).contains(maxEdge),
              (1_000_000...30_000_000).contains(bitrate), (5...60).contains(segmentSeconds)
        else { throw failure("Invalid recording parameters") }
        if command == "request-permissions" && !requestScreen && !microphone { throw failure("Select --screen and/or --mic to request permission") }
        if command == "open-settings" && !["screen", "microphone"].contains(permission) { throw failure("Use --permission screen or --permission microphone") }
        if ["record", "preview"].contains(command) && windowID == 0 && displayID == 0 { throw failure("An explicit window or display is required") }
        if fixtureScenario != "normal" && (command != "fixture" || !["clock-reorder", "frame-gaps", "frame-health", "capture-diagnostics", "zero-pts-stop"].contains(fixtureScenario)) { throw failure("Invalid synthetic fixture scenario") }
    }
}

func captureFilter(_ content: SCShareableContent, _ options: Options) throws -> SCContentFilter {
    if options.displayID > 0 {
        guard let display = content.displays.first(where: { $0.displayID == options.displayID }) else { throw failure("Selected display is unavailable; select it again") }
        // This branch is reachable only after explicit display selection. Never
        // substitute a display when a window disappears or suspends.
        return SCContentFilter(display: display, excludingWindows: [])
    }
    guard let window = content.windows.first(where: { $0.windowID == options.windowID }) else { throw failure("Selected window is unavailable; select it again") }
    return SCContentFilter(desktopIndependentWindow: window)
}

// Completed segments are independent files. A crash can leave the current
// .partial file; it never overwrites any completed segment.
final class VideoSegment {
    let writer: AVAssetWriter
    let input: AVAssetWriterInput
    let adaptor: AVAssetWriterInputPixelBufferAdaptor
    let start: CMTime
    var end: CMTime
    let base: String
    let directory: URL
    var frames = 0
    init(directory: URL, sequence: Int, start: CMTime, width: Int, height: Int, options: Options) throws {
        self.directory = directory
        self.start = start
        end = start
        base = String(format: "video-%06d", sequence)
        writer = try AVAssetWriter(outputURL: directory.appendingPathComponent(base + ".partial.mp4"), fileType: .mp4)
        writer.movieFragmentInterval = CMTime(seconds: 5, preferredTimescale: 600)
        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height,
            AVVideoEncoderSpecificationKey: [kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder as String: true],
            AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: options.bitrate,
                AVVideoMaxKeyFrameIntervalKey: options.fps * 2, AVVideoAllowFrameReorderingKey: false]
        ]
        input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = true
        adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
        guard writer.canAdd(input) else { throw failure("Cannot create hardware H.264 input") }
        writer.add(input)
        guard writer.startWriting() else { throw writer.error ?? failure("Cannot start video writer") }
        writer.startSession(atSourceTime: start)
        try atomicJSON(["kind": "video", "file": base + ".partial.mp4", "status": "writing", "startPTS": ptsObject(start)],
                       at: directory.appendingPathComponent(base + ".json"))
    }
    func append(_ pixels: CVPixelBuffer, at time: CMTime) throws -> Bool {
        guard input.isReadyForMoreMediaData else { return false }
        guard adaptor.append(pixels, withPresentationTime: time) else { throw writer.error ?? failure("Video append failed") }
        frames += 1
        end = time
        return true
    }
    func finish(at time: CMTime, completion: @escaping (Error?) -> Void) {
        end = CMTimeMaximum(end, time)
        writer.endSession(atSourceTime: end)
        input.markAsFinished()
        writer.finishWriting {
            do {
                guard self.writer.status == .completed else { throw self.writer.error ?? failure("Video finalization failed") }
                let name = self.base + ".mp4"
                try syncFile(self.directory.appendingPathComponent(self.base + ".partial.mp4"))
                try FileManager.default.moveItem(at: self.directory.appendingPathComponent(self.base + ".partial.mp4"),
                                                to: self.directory.appendingPathComponent(name))
                try atomicJSON(["kind": "video", "file": name, "status": "complete", "frames": self.frames,
                    "startPTS": ptsObject(self.start), "endPTS": ptsObject(self.end)],
                    at: self.directory.appendingPathComponent(self.base + ".json"))
                emit(["event": "segment", "kind": "video", "file": name, "startPTS": ptsObject(self.start), "endPTS": ptsObject(self.end)])
                completion(nil)
            } catch { completion(error) }
        }
    }
}

// WAV headers are refreshed on close. PCM is converted to 16-bit at the source
// rate/channel count, never gated for silence/echo. Per-buffer offsets and PTS
// preserve device discontinuities instead of pretending sample count is time.
final class AudioSegment {
    let directory: URL
    let base: String
    let source: String
    let start: CMTime
    let format: AVAudioFormat
    var file: AVAudioFile?
    let index: FileHandle
    var frames: Int64 = 0
    var end: CMTime
    init(directory: URL, source: String, sequence: Int, start: CMTime, format: AVAudioFormat) throws {
        self.directory = directory; self.source = source; self.start = start; self.format = format; end = start
        base = String(format: "%@-%06d", source, sequence)
        let settings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: format.sampleRate,
            AVNumberOfChannelsKey: format.channelCount, AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false]
        file = try AVAudioFile(forWriting: directory.appendingPathComponent(base + ".partial.wav"), settings: settings,
                               commonFormat: format.commonFormat, interleaved: format.isInterleaved)
        let indexURL = directory.appendingPathComponent(base + ".pts.jsonl")
        FileManager.default.createFile(atPath: indexURL.path, contents: nil)
        index = try FileHandle(forWritingTo: indexURL)
        try atomicJSON(["kind": source, "file": base + ".partial.wav", "status": "writing", "startPTS": ptsObject(start),
                        "sampleRate": format.sampleRate, "channels": format.channelCount, "index": base + ".pts.jsonl"], at: directory.appendingPathComponent(base + ".json"))
    }
    func append(_ buffer: AVAudioPCMBuffer, pts: CMTime, duration: CMTime) throws {
        try file?.write(from: buffer)
        var record: [String: Any] = ["pts": ptsObject(pts), "frameOffset": frames, "frames": buffer.frameLength]
        if duration.isValid { record["duration"] = ptsObject(duration) }
        try index.write(contentsOf: JSONSerialization.data(withJSONObject: record) + Data([10]))
        frames += Int64(buffer.frameLength)
        end = CMTimeAdd(pts, CMTime(seconds: Double(buffer.frameLength) / format.sampleRate, preferredTimescale: 1_000_000_000))
    }
    func finish() throws {
        file = nil
        try syncFile(directory.appendingPathComponent(base + ".partial.wav"))
        try index.synchronize(); try index.close()
        let name = base + ".wav"
        try FileManager.default.moveItem(at: directory.appendingPathComponent(base + ".partial.wav"), to: directory.appendingPathComponent(name))
        try atomicJSON(["kind": source, "file": name, "status": "complete", "frames": frames,
            "sampleRate": format.sampleRate, "channels": format.channelCount,
            "startPTS": ptsObject(start), "endPTS": ptsObject(end), "index": base + ".pts.jsonl"],
            at: directory.appendingPathComponent(base + ".json"))
        emit(["event": "segment", "kind": source, "file": name, "startPTS": ptsObject(start), "endPTS": ptsObject(end)])
    }
}

// Mutable media state is confined to queue; UI work is dispatched to main.
final class ArchiveCapture: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let options: Options
    let directory: URL
    let queue = DispatchQueue(label: "meeting.archive.media")
    let finishing = DispatchGroup()
    var videoStream: SCStream?
    var audioStream: SCStream?
    var video: VideoSegment?
    var audio: [String: AudioSegment] = [:]
    var counts: [String: Int] = [:]
    var origin: CMTime?
    var timelineObservedAt: String?
    var lastPTS: CMTime?
    var lastPixels: CVPixelBuffer?
    var width = 0
    var height = 0
    var micEnabled: Bool
    var stopping = false
    var frameState: Int?
    var videoGapStart: CMTime?
    var hasError = false
    var controlBuffer = Data()
    var signalSources: [DispatchSourceSignal] = []
    var monitor: DispatchSourceTimer?
    var heartbeat: DispatchSourceTimer?
    var paused = false
    var lastWrittenPTS: [String: CMTime] = [:]
    var level: [String: Double] = [:]
    var controls: RecorderControls?
    var fixtureTimer: DispatchSourceTimer?
    var fixtureMode = false
    var pendingVideos = 0
    // Stream liveness must remain separate from current frame availability:
    // suspended/blank callbacks may recover on the same stream.
    var videoAvailable = true
    var hasUsableVideo: Bool { videoAvailable && videoGapStart == nil && lastPixels != nil }
    var videoState: String {
        if !hasStarted { return "starting" }
        if paused { return "paused" }
        if !videoAvailable { return "unavailable" }
        if hasUsableVideo { return frameStatusName(frameState) }
        return frameState == SCFrameStatus.idle.rawValue ? "waiting-for-frame" : frameStatusName(frameState)
    }
    var videoWarning: String {
        guard hasStarted, !paused, !hasUsableVideo else { return "" }
        let detail: String
        switch videoState {
        case "suspended": detail = "Video updates from the \(options.targetName) are suspended. Check the recording source; the capture scope has not changed."
        case "blank": detail = "The \(options.targetName) is not providing a picture. Check the recording source."
        case "unavailable", "stopped": detail = "The \(options.targetName) is unavailable."
        default: detail = "Waiting for a new video frame from the \(options.targetName)."
        }
        return detail + ((options.systemAudio || (options.microphone && micEnabled)) ? " Enabled audio sources are handled separately; check their status." : " No audio source is recording.")
    }
    var hasStarted = false
    var warnedLowDisk = false
    var monitorInFlight = false
    // Metadata only, bounded counters. Observe before admission checks so a
    // silent callback stream differs from samples rejected by this recorder.
    let diagnosticStart = CMClockGetTime(CMClockGetHostTimeClock())
    var lastDiagnosticWrite: CMTime?
    var diagnosticWriteFailed = false
    var received: [String: Int] = ["video": 0, "system": 0, "microphone": 0]
    var receivedVideoStatus: [String: Int] = ["complete": 0, "idle": 0, "blank": 0, "suspended": 0,
        "started": 0, "stopped": 0, "missing": 0, "unknown": 0]
    var droppedVideo: [String: Int] = ["paused": 0, "invalidSample": 0, "invalidPTS": 0,
        "videoUnavailable": 0, "missingPixels": 0, "encoderBackpressure": 0]
    var videoFramesWritten = 0
    var lastReceivedHostPTS: [String: CMTime] = [:]
    var lastReceivedMediaPTS: [String: CMTime] = [:]
    var targetProcessID: pid_t?
    var targetProbe: [String: Any] = [:]
    let hostID = UUID().uuidString
    init(_ options: Options) {
        self.options = options; directory = URL(fileURLWithPath: options.directory)
        micEnabled = options.microphone
        super.init()
    }
    func configuration(for filter: SCContentFilter) -> SCStreamConfiguration {
        let config = SCStreamConfiguration()
        let scale = Double(filter.pointPixelScale)
        let sourceW = filter.contentRect.width * scale
        let sourceH = filter.contentRect.height * scale
        let ratio = min(1, Double(options.maxEdge) / max(sourceW, sourceH))
        queue.sync {
            width = max(2, Int(sourceW * ratio) / 2 * 2)
            height = max(2, Int(sourceH * ratio) / 2 * 2)
        }
        config.width = width; config.height = height
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(options.fps))
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = true
        config.ignoreShadowsSingleWindow = true
        config.captureResolution = .best
        config.queueDepth = 5
        return config
    }
    func start() async throws {
        guard options.windowID > 0 || options.displayID > 0, !options.directory.isEmpty else { throw failure("An explicit window or display and archive directory are required") }
        try FileManager.default.createDirectory(at: directory.appendingPathComponent("control/inbox"), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.createDirectory(at: directory.appendingPathComponent("control/results"), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        installControls()
        let permissions = await requestCapturePermissions(screen: true, microphone: options.microphone)
        try requireScreenPermission()
        if options.microphone && permissions["microphone"] != "granted" {
            throw failure("Microphone permission is required for the selected microphone source. Use Grant microphone or enable it in System Settings > Privacy & Security > Microphone, then retry recording. You can also start with microphone saving disabled.")
        }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        let filter = try captureFilter(content, options)
        queue.sync {
            targetProcessID = content.windows.first(where: { $0.windowID == options.windowID })?.owningApplication?.processID
            targetProbe = targetObservation(content).json
        }
        if options.microphone {
            if let id = options.microphoneID, !microphones().contains(where: { $0.uniqueID == id }) { throw failure("Selected microphone is unavailable") }
        }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: directory.appendingPathComponent("control/inbox"), withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try FileManager.default.createDirectory(at: directory.appendingPathComponent("control/results"), withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let config = configuration(for: filter)
        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        videoStream = stream
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        if options.systemAudio || options.microphone {
            guard let display = content.displays.first(where: { options.displayID == 0 || $0.displayID == options.displayID }) else { throw failure("No display is available for system audio") }
            let ac = SCStreamConfiguration()
            ac.width = 2; ac.height = 2; ac.minimumFrameInterval = CMTime(seconds: 1, preferredTimescale: 600)
            ac.capturesAudio = options.systemAudio; ac.excludesCurrentProcessAudio = true; ac.sampleRate = 48000; ac.channelCount = 2
            ac.captureMicrophone = options.microphone; ac.microphoneCaptureDeviceID = options.microphoneID
            // This stream saves only audio. No desktop frames are registered or saved.
            let ast = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: ac, delegate: self)
            audioStream = ast
            if options.systemAudio { try ast.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue) }
            if options.microphone { try ast.addStreamOutput(self, type: .microphone, sampleHandlerQueue: queue) }
            try await ast.startCapture()
        }
        try await stream.startCapture()
        queue.sync { hasStarted = true }
        emit(["event": "started", "captureKind": options.captureKind, "windowID": options.windowID, "displayID": options.displayID, "width": width, "height": height,
              "fps": options.fps, "micEnabled": micEnabled, "systemAudio": options.systemAudio,
              "encoding": "hardware-required-h264", "audioScope": "all-system"])
        monitor = DispatchSource.makeTimerSource(queue: queue)
        monitor?.schedule(deadline: .now() + 3, repeating: 3)
        monitor?.setEventHandler { [weak self] in
            guard let self = self, !self.stopping, self.videoAvailable, !self.monitorInFlight else { return }
            self.monitorInFlight = true
            Task {
                do {
                    let c = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
                    let observation = self.targetObservation(c)
                    self.queue.async {
                        self.targetProbe = observation.json
                        if !observation.exists {
                            self.loseVideo(self.options.displayID > 0 ? "Selected display disconnected; no target replacement" : "Selected window closed; no target replacement")
                        }
                    }
                } catch {
                    let error = error as NSError
                    self.queue.async {
                        self.targetProbe = ["captureKind": self.options.captureKind, "windowID": self.options.windowID, "displayID": self.options.displayID,
                            "observedAtHostPTS": ptsObject(CMClockGetTime(CMClockGetHostTimeClock())),
                            "error": ["domain": error.domain, "code": error.code]]
                    }
                    emit(["event": "warning", "detail": "Cannot verify \(self.options.targetName): \(error.localizedDescription)"])
                }
                self.queue.async { self.monitorInFlight = false }
            }
        }
        monitor?.resume()
    }
    func targetObservation(_ content: SCShareableContent) -> CaptureTargetObservation {
        if options.displayID > 0 {
            let display = content.displays.first { $0.displayID == options.displayID }
            return CaptureTargetObservation(windowID: 0, displayID: options.displayID,
                observedHostSeconds: CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock())), exists: display != nil,
                isOnScreen: nil, frame: display.map { ["x": $0.frame.minX, "y": $0.frame.minY,
                    "width": $0.frame.width, "height": $0.frame.height] },
                sameApplicationWindowIDs: [], sameApplicationWindowCount: 0)
        }
        let window = content.windows.first { $0.windowID == options.windowID }
        let sameAppIDs = content.windows.filter {
            targetProcessID != nil && $0.owningApplication?.processID == targetProcessID
        }.map { $0.windowID }.sorted()
        return CaptureTargetObservation(windowID: options.windowID,
            observedHostSeconds: CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock())), exists: window != nil,
            isOnScreen: window?.isOnScreen, frame: window.map { ["x": $0.frame.minX, "y": $0.frame.minY,
                "width": $0.frame.width, "height": $0.frame.height] },
            sameApplicationWindowIDs: Array(sameAppIDs.prefix(50)), sameApplicationWindowCount: sameAppIDs.count)
    }
    func diagnosticSnapshot(reason: String) -> [String: Any] {
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        return ["event": "capture-diagnostic", "schemaVersion": 1, "reason": reason,
            "pts": ptsObject(now), "elapsedHostSeconds": CMTimeGetSeconds(CMTimeSubtract(now, diagnosticStart)),
            "captureKind": options.captureKind, "windowID": options.windowID, "displayID": options.displayID,
            "videoState": videoState, "paused": paused, "fixture": fixtureMode,
            "counters": ["received": received, "videoStatus": receivedVideoStatus,
                "dropped": droppedVideo, "videoFramesWritten": videoFramesWritten],
            "lastReceivedHostPTS": lastReceivedHostPTS.mapValues { ptsObject($0) },
            "lastReceivedMediaPTS": lastReceivedMediaPTS.mapValues { ptsObject($0) },
            "lastWrittenPTS": lastWrittenPTS.mapValues { ptsObject($0) }, "targetProbe": targetProbe]
    }
    func persistDiagnostics(reason: String) {
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        if reason == "periodic", let last = lastDiagnosticWrite,
           CMTimeGetSeconds(CMTimeSubtract(now, last)) < 3 { return }
        lastDiagnosticWrite = now
        let snapshot = diagnosticSnapshot(reason: reason)
        emit(snapshot)
        do {
            try atomicJSON(snapshot, at: directory.appendingPathComponent("capture-diagnostics.json"))
            diagnosticWriteFailed = false
        } catch {
            // Optional diagnostics must never stop otherwise healthy capture.
            if !diagnosticWriteFailed { emit(["event": "warning", "detail": "Cannot save capture diagnostic snapshot"] ) }
            diagnosticWriteFailed = true
        }
    }
    func installControls() {
        // Private, atomic file IPC remains available if the Node parent exits.
        heartbeat = DispatchSource.makeTimerSource(queue: queue)
        heartbeat?.schedule(deadline: .now(), repeating: 1)
        heartbeat?.setEventHandler { [weak self] in
            guard let self = self else { return }
            do {
                try self.writeStatus()
                let inbox = self.directory.appendingPathComponent("control/inbox")
                for url in try FileManager.default.contentsOfDirectory(at: inbox, includingPropertiesForKeys: nil).sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
                    guard url.pathExtension == "json" else { continue }
                    let object = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] ?? [:]
                    var reply: [String: Any] = ["ok": true]
                    do { try self.control(object) }
                    catch { reply = ["ok": false, "error": error.localizedDescription] }
                    try self.writeStatus()
                    try atomicJSON(reply, at: self.directory.appendingPathComponent("control/results/" + url.lastPathComponent))
                    try FileManager.default.removeItem(at: url)
                }
            } catch { self.abort("Control/status persistence failed: \(error.localizedDescription)") }
        }
        heartbeat?.resume()
        for sig in [SIGINT, SIGTERM] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: queue)
            source.setEventHandler { [weak self] in self?.stop() }
            source.resume(); signalSources.append(source)
        }
    }
    func startFixture() throws {
        // Explicit test mode uses fabricated pixels and sine waves only.
        // It never calls ScreenCaptureKit, EventKit or microphone permissions.
        fixtureMode = true; hasStarted = true; width = 640; height = 360
        try FileManager.default.createDirectory(at: directory.appendingPathComponent("control/inbox"), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.createDirectory(at: directory.appendingPathComponent("control/results"), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        installControls()
        emit(["event": "started", "fixture": true, "width": width, "height": height])
        let timer = DispatchSource.makeTimerSource(queue: queue)
        fixtureTimer = timer
        timer.schedule(deadline: .now(), repeating: 1.0 / Double(options.fps))
        let fixtureStart = CMClockGetTime(CMClockGetHostTimeClock())
        var previousTick: Int64 = -1
        var sentZeroPTSStop = false
        timer.setEventHandler {
            guard !self.stopping, !self.paused else { return }
            // A synthetic sample clock, rather than callback arrival time.
            // Dispatch jitter must not fabricate overlapping audio samples.
            let arrival = CMClockGetTime(CMClockGetHostTimeClock())
            let tick = Int64((CMTimeGetSeconds(CMTimeSubtract(arrival, fixtureStart)) * Double(self.options.fps)).rounded())
            guard tick > previousTick else { return }; previousTick = tick
            let frameNumber = Int(tick)
            let now = CMTimeAdd(fixtureStart, CMTime(value: tick, timescale: CMTimeScale(self.options.fps)))
            do {
                var pixels: CVPixelBuffer?
                guard CVPixelBufferCreate(kCFAllocatorDefault, self.width, self.height, kCVPixelFormatType_32BGRA,
                    [kCVPixelBufferCGImageCompatibilityKey: true, kCVPixelBufferCGBitmapContextCompatibilityKey: true] as CFDictionary, &pixels) == kCVReturnSuccess,
                    let pixels = pixels else { throw failure("Fixture pixel allocation failed") }
                CVPixelBufferLockBaseAddress(pixels, [])
                if let context = CGContext(data: CVPixelBufferGetBaseAddress(pixels), width: self.width, height: self.height,
                    bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(pixels), space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) {
                    context.setFillColor(CGColor(red: 0.08, green: 0.15, blue: 0.11, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: self.width, height: self.height))
                    context.setFillColor(CGColor(red: 0.4, green: 0.75, blue: 0.55, alpha: 1)); context.fill(CGRect(x: (frameNumber * 4) % 580, y: 120, width: 60, height: 120))
                }
                CVPixelBufferUnlockBaseAddress(pixels, [])
                var desc: CMVideoFormatDescription?
                CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pixels, formatDescriptionOut: &desc)
                var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: CMTimeScale(self.options.fps)), presentationTimeStamp: now, decodeTimeStamp: .invalid)
                var sample: CMSampleBuffer?
                CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pixels, formatDescription: desc!, sampleTiming: &timing, sampleBufferOut: &sample)
                if self.options.fixtureScenario == "frame-gaps" {
                    let elapsed = Double(tick) / Double(self.options.fps)
                    let status: SCFrameStatus = elapsed >= 1 && elapsed < 2 ? .blank : elapsed >= 2 && elapsed < 3 ? .suspended : elapsed >= 3 && elapsed < 3.5 ? .idle : .complete
                    let attachments = CMSampleBufferGetSampleAttachmentsArray(sample!, createIfNecessary: true)! as NSArray
                    (attachments[0] as! NSMutableDictionary)[SCStreamFrameInfo.status.rawValue] = status.rawValue
                }
                if self.options.fixtureScenario == "frame-health" {
                    let elapsed = Double(tick) / Double(self.options.fps)
                    // Leave time for the one-second status heartbeat to report
                    // healthy idle, suspension, stale idle and actual recovery.
                    let status: SCFrameStatus = elapsed >= 1 && elapsed < 3 ? .idle : elapsed >= 3 && elapsed < 5 ? .suspended : elapsed >= 5 && elapsed < 7 ? .idle : .complete
                    let attachments = CMSampleBufferGetSampleAttachmentsArray(sample!, createIfNecessary: true)! as NSArray
                    (attachments[0] as! NSMutableDictionary)[SCStreamFrameInfo.status.rawValue] = status.rawValue
                }
                let elapsed = Double(tick) / Double(self.options.fps)
                if self.options.fixtureScenario == "capture-diagnostics" {
                    let status: SCFrameStatus = elapsed >= 1 && elapsed < 3 ? .idle : elapsed >= 3 && elapsed < 9 ? .suspended : .complete
                    let attachments = CMSampleBufferGetSampleAttachmentsArray(sample!, createIfNecessary: true)! as NSArray
                    (attachments[0] as! NSMutableDictionary)[SCStreamFrameInfo.status.rawValue] = status.rawValue
                    if elapsed >= 9 && elapsed < 10 { CMSampleBufferInvalidate(sample!) }
                    if elapsed >= 10 && elapsed < 11 {
                        var invalidTiming = CMSampleTimingInfo(duration: timing.duration, presentationTimeStamp: .invalid, decodeTimeStamp: .invalid)
                        var invalidPTS: CMSampleBuffer?
                        CMSampleBufferCreateCopyWithNewTiming(allocator: kCFAllocatorDefault, sampleBuffer: sample!,
                            sampleTimingEntryCount: 1, sampleTimingArray: &invalidTiming, sampleBufferOut: &invalidPTS)
                        guard let invalidPTS = invalidPTS else { throw failure("Cannot create invalid PTS fixture") }
                        sample = invalidPTS
                    }
                }
                if self.options.fixtureScenario == "zero-pts-stop" && elapsed >= 2 {
                    // Reproduce SCK's terminal control callback with PTS zero,
                    // then stop video callbacks while independent audio runs.
                    if !sentZeroPTSStop {
                        let attachments = CMSampleBufferGetSampleAttachmentsArray(sample!, createIfNecessary: true)! as NSArray
                        (attachments[0] as! NSMutableDictionary)[SCStreamFrameInfo.status.rawValue] = SCFrameStatus.stopped.rawValue
                        var stoppedTiming = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: .zero, decodeTimeStamp: .invalid)
                        var stoppedSample: CMSampleBuffer?
                        CMSampleBufferCreateCopyWithNewTiming(allocator: kCFAllocatorDefault, sampleBuffer: sample!,
                            sampleTimingEntryCount: 1, sampleTimingArray: &stoppedTiming, sampleBufferOut: &stoppedSample)
                        guard let stoppedSample = stoppedSample else { throw failure("Cannot create zero PTS control fixture") }
                        self.consume(stoppedSample, type: .screen)
                        sentZeroPTSStop = true
                    }
                // Simulate video callback loss without suppressing audio.
                } else if !(self.options.fixtureScenario == "capture-diagnostics" && elapsed >= 5 && elapsed < 9) {
                    self.consume(sample!, type: .screen)
                }
                for (source, channels, frequency) in [(SCStreamOutputType.microphone, 1, 440.0), (SCStreamOutputType.audio, 2, 220.0)] {
                    if source == .microphone && !self.options.microphone { continue }
                    if source == .audio && !self.options.systemAudio { continue }
                    let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: AVAudioChannelCount(channels), interleaved: true)!
                    let frames = 48000 / self.options.fps
                    let values = (0..<(frames * channels)).map { i in Float(sin((Double(frameNumber * frames + i / channels) / 48000) * 2 * .pi * frequency) * 0.15) }
                    var block: CMBlockBuffer?
                    let byteCount = values.count * MemoryLayout<Float>.size
                    CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: byteCount,
                        blockAllocator: kCFAllocatorDefault, customBlockSource: nil, offsetToData: 0, dataLength: byteCount, flags: 0, blockBufferOut: &block)
                    values.withUnsafeBytes { data in _ = CMBlockBufferReplaceDataBytes(with: data.baseAddress!, blockBuffer: block!, offsetIntoDestination: 0, dataLength: byteCount) }
                    // Deliberately delivered after video despite an earlier PTS.
                    let audioPTS = self.options.fixtureScenario == "clock-reorder" ? CMTimeSubtract(now, CMTime(value: 50, timescale: 1000)) : now
                    var audioTiming = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 48000), presentationTimeStamp: audioPTS, decodeTimeStamp: .invalid)
                    var size = channels * MemoryLayout<Float>.size
                    var audioSample: CMSampleBuffer?
                    CMSampleBufferCreateReady(allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: format.formatDescription,
                        sampleCount: frames, sampleTimingEntryCount: 1, sampleTimingArray: &audioTiming,
                        sampleSizeEntryCount: 1, sampleSizeArray: &size, sampleBufferOut: &audioSample)
                    self.consume(audioSample!, type: source)
                }
            } catch { self.abort(error.localizedDescription) }
        }
        timer.resume()
    }
    func writeStatus() throws {
        let status: [String: Any] = ["pid": getpid(), "hostID": hostID,
            "state": stopping ? "finalizing" : (!hasStarted ? "starting" : (paused ? "paused" : "recording")),
            "updatedAt": ISO8601DateFormatter().string(from: Date()), "captureKind": options.captureKind,
            "windowID": options.windowID, "displayID": options.displayID,
            "micEnabled": micEnabled, "micAuthorized": options.microphone, "systemAudio": options.systemAudio,
            "width": width, "height": height, "levels": level, "fixture": fixtureMode,
            "videoAvailable": hasUsableVideo, "videoState": videoState, "videoWarning": videoWarning,
            "diagnostics": diagnosticSnapshot(reason: "status"),
            "lastWrittenPTS": lastWrittenPTS.mapValues { ptsObject($0) },
            "originPTS": origin.map { ptsObject($0) } ?? [:], "clockPTS": ptsObject(CMClockGetTime(CMClockGetHostTimeClock()))]
        try atomicJSON(status, at: directory.appendingPathComponent("capture-status.json"))
        persistDiagnostics(reason: "periodic")
        let attrs = try FileManager.default.attributesOfFileSystem(forPath: directory.path)
        let free = (attrs[.systemFreeSize] as? NSNumber)?.int64Value ?? Int64.max
        if free < 2_000_000_000 && !warnedLowDisk {
            warnedLowDisk = true
            emit(["event": "warning", "detail": "Less than 2 GB free; no archives will be deleted automatically", "freeBytes": free])
        }
        if free < 100_000_000 && !stopping { abort("Less than 100 MB free; recording stopped to finalize existing media") }
        let title = stopping ? "◌ Saving" : (!hasStarted ? "◌ Preparing to Record" : (paused ? "Ⅱ Recording Paused" : (!hasUsableVideo ? "⚠ Recording · Video Unavailable" : (micEnabled ? "● Recording · Mic On" : "● Recording · Mic Off"))))
        let warning = videoWarning
        DispatchQueue.main.async {
            self.controls?.item.button?.title = title
            self.controls?.item.button?.toolTip = warning.isEmpty ? nil : warning
        }
    }
    func control(_ object: [String: Any]) throws {
        guard !stopping else { throw failure("Recording is finalizing") }
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        switch object["command"] as? String {
        case "stop": stop()
        case "pause":
            paused = true
            if let video = video { finishVideo(video, at: now); self.video = nil }
            lastPixels = nil // Frames may change while all paused samples are discarded.
            for file in audio.values { try file.finish() }
            audio.removeAll()
            emit(["event": "pause", "pts": ptsObject(now)])
        case "resume": paused = false; emit(["event": "resume", "pts": ptsObject(now)])
        case "mic":
            guard let enabled = object["enabled"] as? Bool else { throw failure("Mic command requires enabled") }
            if enabled && !options.microphone { throw failure("Microphone was not authorized at start; start a new recording with it enabled") }
            // This app's gate applies before acknowledgment. Disabled source
            // buffers never reach disk; meeting-app mute has no effect on it.
            micEnabled = enabled
            try audio.removeValue(forKey: "microphone")?.finish()
            emit(["event": "mic", "enabled": enabled, "pts": ptsObject(now)])
        case "bookmark":
            let event: [String: Any] = ["event": "bookmark", "id": object["id"] ?? UUID().uuidString,
                "text": String((object["text"] as? String ?? "").prefix(4000)), "pts": ptsObject(now)]
            emit(event)
        default: throw failure("Unsupported recorder command")
        }
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        queue.async {
            if stream === self.videoStream { self.loseVideo(error.localizedDescription) }
            else {
                self.audioStream = nil
                emit(["event": "gap", "source": "audio", "reason": error.localizedDescription,
                      "pts": ptsObject(CMClockGetTime(CMClockGetHostTimeClock()))])
                do { for a in self.audio.values { try a.finish() }; self.audio.removeAll() }
                catch { self.abort(error.localizedDescription) }
                if !self.videoAvailable { self.abort("All capture sources are unavailable") }
            }
        }
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        consume(sample, type: type)
    }
    func consume(_ sample: CMSampleBuffer, type: SCStreamOutputType) {
        guard !stopping else { return }
        let source = type == .screen ? "video" : (type == .audio ? "system" : "microphone")
        received[source, default: 0] += 1
        let receivedAt = CMClockGetTime(CMClockGetHostTimeClock())
        lastReceivedHostPTS[source] = receivedAt
        let time = CMSampleBufferGetPresentationTimeStamp(sample)
        if time.isValid && CMTimeGetSeconds(time).isFinite { lastReceivedMediaPTS[source] = time }
        if type == .screen && sample.isValid {
            let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]]
            let status = attachments?.first?[.status] as? Int
            let bucket = status == nil ? "missing" : (SCFrameStatus(rawValue: status!) == nil ? "unknown" : frameStatusName(status))
            receivedVideoStatus[bucket, default: 0] += 1
        }
        if paused {
            if type == .screen { droppedVideo["paused", default: 0] += 1 }
            return
        }
        guard sample.isValid else {
            if type == .screen { droppedVideo["invalidSample", default: 0] += 1 }
            return
        }
        if type == .microphone && !micEnabled { return }
        if type == .screen {
            let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]]
            let status = attachments?.first?[.status] as? Int ?? SCFrameStatus.complete.rawValue
            let hasPixels = status == SCFrameStatus.complete.rawValue ? CMSampleBufferGetImageBuffer(sample) != nil : lastPixels != nil
            let recordable = (status == SCFrameStatus.complete.rawValue || status == SCFrameStatus.idle.rawValue) && hasPixels
            if !recordable {
                // SCK can send a stopped/status buffer with a zero or invalid
                // sentinel PTS. It is diagnostic information, not media. Use
                // callback receipt time for its gap boundary while retaining
                // the original timestamp in the event for investigation.
                let hasEventTime = time.isValid && CMTimeGetSeconds(time).isFinite && time > .zero
                var provenance: [String: Any] = [:]
                if !hasEventTime {
                    var original: [String: Any] = ["value": time.value, "timescale": time.timescale, "flags": time.flags.rawValue]
                    if time.isValid && CMTimeGetSeconds(time).isFinite { original["seconds"] = CMTimeGetSeconds(time) }
                    provenance = ["samplePTS": original, "ptsSource": "host-receipt"]
                }
                do { try appendVideo(sample, time: hasEventTime ? time : receivedAt, timingProvenance: provenance) }
                catch { abort(error.localizedDescription) }
                return
            }
        }
        guard time.isValid, CMTimeGetSeconds(time).isFinite else {
            if type == .screen { droppedVideo["invalidPTS", default: 0] += 1 }
            return
        }
        do {
            if type == .screen { try appendVideo(sample, time: time) }
            else if (type == .audio || type == .microphone) && CMSampleBufferGetNumSamples(sample) > 0 {
                try appendAudio(sample, source: type == .audio ? "system" : "microphone", time: time)
            }
        } catch { abort(error.localizedDescription) }
    }
    func observeWrittenMediaTime(_ time: CMTime) throws {
        // Only successfully written image/audio data can establish the origin.
        // Real sources may arrive out of PTS order; preserve their raw values,
        // including a legitimate zero-based media clock. Status callbacks and
        // empty audio buffers never pass this boundary.
        if origin == nil || time < origin! {
            let previous = origin
            origin = time
            if timelineObservedAt == nil { timelineObservedAt = ISO8601DateFormatter().string(from: Date()) }
            try atomicJSON(["schemaVersion": 1, "clock": "SCK-presentation-time", "originPTS": ptsObject(time),
                            "originPolicy": "earliest-written-source-PTS", "wallClockObservedAt": timelineObservedAt!], at: directory.appendingPathComponent("timeline.json"))
            emit(["event": "timeline", "originPTS": ptsObject(time), "rebased": previous != nil])
        }
        lastPTS = lastPTS.map { CMTimeMaximum($0, time) } ?? time
    }
    func appendVideo(_ sample: CMSampleBuffer, time: CMTime, timingProvenance: [String: Any] = [:]) throws {
        guard videoAvailable else { droppedVideo["videoUnavailable", default: 0] += 1; return }
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]]
        let status = attachments?.first?[.status] as? Int ?? SCFrameStatus.complete.rawValue
        if status == SCFrameStatus.complete.rawValue { lastPixels = CMSampleBufferGetImageBuffer(sample) }
        let usable = (status == SCFrameStatus.complete.rawValue || status == SCFrameStatus.idle.rawValue) && lastPixels != nil
        if status != frameState {
            frameState = status
            emit(["event": "frame-state", "status": status, "state": frameStatusName(status), "pts": ptsObject(time), "usable": usable]
                .merging(timingProvenance) { _, new in new })
        }
        guard usable, let pixels = lastPixels else {
            if status == SCFrameStatus.complete.rawValue || status == SCFrameStatus.idle.rawValue {
                droppedVideo["missingPixels", default: 0] += 1
            }
            if videoGapStart == nil {
                videoGapStart = time
                emit(["event": "gap", "source": "video", "reason": "frame-unavailable", "status": status,
                      "state": frameStatusName(status), "detail": videoWarning, "pts": ptsObject(time)]
                    .merging(timingProvenance) { _, new in new })
            }
            // Finish at the first unavailable PTS. An open MP4 would otherwise
            // freeze its last real image through the missing interval.
            if let old = video { finishVideo(old, at: time); video = nil }
            lastPixels = nil
            return
        }
        if let gap = videoGapStart {
            emit(["event": "gap-end", "source": "video", "reason": "frame-available", "startPTS": ptsObject(gap), "pts": ptsObject(time)])
            videoGapStart = nil
        }
        // An idle frame repeats the last actual image; no screen is synthesized.
        if let old = video, CMTimeGetSeconds(CMTimeSubtract(time, old.start)) >= options.segmentSeconds {
            finishVideo(old, at: time); video = nil
        }
        if video == nil {
            guard pendingVideos < 3 else { throw failure("Video commit backlog exceeded three segments; stopped to bound memory") }
            counts["video", default: 0] += 1
            video = try VideoSegment(directory: directory, sequence: counts["video"]!, start: time,
                                     width: width, height: height, options: options)
        }
        if try video?.append(pixels, at: time) == false {
            droppedVideo["encoderBackpressure", default: 0] += 1
            emit(["event": "gap", "source": "video", "pts": ptsObject(time), "reason": "encoder-backpressure"])
        } else {
            lastWrittenPTS["video"] = time; videoFramesWritten += 1
            try observeWrittenMediaTime(time)
        }
    }
    func appendAudio(_ sample: CMSampleBuffer, source: String, time: CMTime) throws {
        guard let desc = CMSampleBufferGetFormatDescription(sample), let format = AVAudioFormat(cmAudioFormatDescription: desc) as AVAudioFormat? else { throw failure("Missing audio format") }
        var needed = 0
        CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample, bufferListSizeNeededOut: &needed, bufferListOut: nil,
            bufferListSize: 0, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: nil)
        guard needed > 0 else { throw failure("Missing audio buffer list") }
        let memory = UnsafeMutableRawPointer.allocate(byteCount: needed, alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { memory.deallocate() }
        let list = memory.assumingMemoryBound(to: AudioBufferList.self)
        var retained: CMBlockBuffer?
        let result = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample, bufferListSizeNeededOut: nil,
            bufferListOut: list, bufferListSize: needed, blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault, flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            blockBufferOut: &retained)
        guard result == noErr, let pcm = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: list) else { throw failure("Cannot read source audio buffers") }
        guard pcm.frameLength > 0 else { return }
        if let previous = audio[source] {
            let delta = CMTimeGetSeconds(CMTimeSubtract(time, previous.end))
            if delta > 0.25 || delta < -0.05 {
                emit(["event": "gap", "source": source, "reason": "audio-PTS-discontinuity", "deltaSeconds": delta,
                      "startPTS": ptsObject(previous.end), "pts": ptsObject(time)])
            }
        }
        if let old = audio[source], !old.format.isEqual(format) || CMTimeGetSeconds(CMTimeSubtract(time, old.start)) >= options.segmentSeconds {
            if !old.format.isEqual(format) { emit(["event": "gap", "source": source, "reason": "audio-format-epoch", "pts": ptsObject(time)]) }
            try old.finish(); audio.removeValue(forKey: source)
        }
        if audio[source] == nil {
            counts[source, default: 0] += 1
            audio[source] = try AudioSegment(directory: directory, source: source, sequence: counts[source]!, start: time, format: format)
        }
        try withExtendedLifetime(retained) { try audio[source]?.append(pcm, pts: time, duration: CMSampleBufferGetDuration(sample)) }
        lastWrittenPTS[source] = time
        try observeWrittenMediaTime(time)
        // Meter source PCM without dropping, modifying or analyzing samples.
        let buffers = UnsafeMutableAudioBufferListPointer(pcm.mutableAudioBufferList)
        if format.commonFormat == .pcmFormatFloat32, let first = buffers.first, let bytes = first.mData {
            let samples = bytes.assumingMemoryBound(to: Float.self)
            let count = Int(first.mDataByteSize) / MemoryLayout<Float>.size
            var peak: Float = 0
            for i in stride(from: 0, to: count, by: 16) { peak = max(peak, abs(samples[i])) }
            level[source] = Double(peak)
        }
    }
    func finishVideo(_ segment: VideoSegment, at time: CMTime) {
        pendingVideos += 1
        finishing.enter()
        segment.finish(at: time) { error in
            self.queue.async {
                self.pendingVideos -= 1
                if let error = error {
                    self.hasError = true
                    emit(["event": "error", "detail": error.localizedDescription])
                    if !self.stopping { self.stop() }
                }
                self.finishing.leave()
            }
        }
    }
    func loseVideo(_ detail: String) {
        guard videoAvailable, !stopping else { return }
        videoAvailable = false; lastPixels = nil
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        emit(["event": "gap", "source": "video", "reason": detail, "pts": ptsObject(now)])
        if let video = video { finishVideo(video, at: now); self.video = nil }
        let old = videoStream; videoStream = nil
        Task { try? await old?.stopCapture() }
        if audioStream == nil { abort("No available audio source remains after losing the \(options.targetName)") }
    }
    func abort(_ detail: String) {
        guard !stopping else { return }
        hasError = true
        emit(["event": "error", "detail": detail])
        stop()
    }
    func stop() {
        guard !stopping else { return }
        stopping = true
        monitor?.cancel(); fixtureTimer?.cancel()
        try? writeStatus()
        Task {
            do { try await videoStream?.stopCapture(); try await audioStream?.stopCapture() }
            catch { emit(["event": "warning", "detail": error.localizedDescription]) }
            queue.async {
                let end = CMClockGetTime(CMClockGetHostTimeClock())
                if let video = self.video { self.finishVideo(video, at: end); self.video = nil }
                do { for file in self.audio.values { try file.finish() } }
                catch { self.hasError = true; emit(["event": "error", "detail": error.localizedDescription]) }
                self.audio.removeAll()
                self.finishing.notify(queue: self.queue) {
                    self.persistDiagnostics(reason: "stopped")
                    emit(["event": "stopped", "clean": !self.hasError, "endPTS": ptsObject(end)])
                    self.heartbeat?.cancel()
                    try? atomicJSON(["state": self.hasError ? "partial" : "recorded", "pid": getpid(), "hostID": self.hostID,
                        "updatedAt": ISO8601DateFormatter().string(from: Date()), "endPTS": ptsObject(end),
                        "diagnostics": self.diagnosticSnapshot(reason: "stopped")],
                        at: self.directory.appendingPathComponent("capture-status.json"))
                    try? eventFile?.synchronize()
                    exit(self.hasError ? 1 : 0)
                }
            }
        }
    }
}

final class RecorderControls: NSObject {
    let item: NSStatusItem
    weak var capture: ArchiveCapture?
    init(capture: ArchiveCapture) {
        self.capture = capture
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        super.init()
        item.button?.title = "◌ Preparing to Record"
        let menu = NSMenu()
        menu.autoenablesItems = false
        for (title, action, key) in [("Toggle Microphone Recording", #selector(toggleMic), "m"),
                                     ("Pause / Resume All Recording", #selector(togglePause), "p"),
                                     ("Stop and Save", #selector(stop), "s")] {
            let entry = NSMenuItem(title: title, action: action, keyEquivalent: key)
            entry.target = self; menu.addItem(entry)
            if action == #selector(toggleMic) && !capture.options.microphone { entry.isEnabled = false }
        }
        item.menu = menu
    }
    @objc func toggleMic() { capture?.queue.async { [weak self] in try? self?.capture?.control(["command": "mic", "enabled": !(self?.capture?.micEnabled ?? false)]) } }
    @objc func togglePause() { capture?.queue.async { [weak self] in try? self?.capture?.control(["command": self?.capture?.paused == true ? "resume" : "pause"]) } }
    @objc func stop() { capture?.queue.async { [weak self] in self?.capture?.stop() } }
}

func microphones() -> [AVCaptureDevice] {
    AVCaptureDevice.DiscoverySession(deviceTypes: [.microphone, .external], mediaType: .audio, position: .unspecified).devices
}

@main struct Main {
    static var owner: ArchiveCapture?
    @MainActor static func main() {
        signal(SIGHUP, SIG_IGN)
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        Task {
        do {
            let options = try Options(CommandLine.arguments)
            switch options.command {
            case "permissions": emit(capturePermissions())
            case "request-permissions": emit(await requestCapturePermissions(screen: options.requestScreen, microphone: options.microphone))
            case "open-settings":
                let page = options.permission == "screen" ? "Privacy_ScreenCapture" : "Privacy_Microphone"
                guard NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?" + page)!) else {
                    throw failure("Cannot open System Settings. Open Privacy & Security manually and select the requested permission.")
                }
                emit(capturePermissions())
            case "inspect":
                let asset = AVURLAsset(url: URL(fileURLWithPath: options.file))
                let playable = try await asset.load(.isPlayable)
                let duration = try await asset.load(.duration)
                let tracks = try await asset.loadTracks(withMediaType: .video)
                var decoded = false
                if !tracks.isEmpty && duration.seconds > 0 {
                    let generator = AVAssetImageGenerator(asset: asset)
                    _ = try await generator.image(at: .zero)
                    _ = try await generator.image(at: CMTime(seconds: max(0, duration.seconds - 0.1), preferredTimescale: 600))
                    decoded = true
                }
                emit(["playable": playable, "durationSeconds": duration.seconds, "videoTracks": tracks.count, "decodedBoundaryFrames": decoded])
            case "list":
                try requireScreenPermission()
                let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
                emit(["windows": content.windows.filter { $0.frame.width > 100 && $0.frame.height > 100 }.map {
                    ["id": $0.windowID, "title": $0.title ?? "", "app": $0.owningApplication?.applicationName ?? "",
                     "bundleID": $0.owningApplication?.bundleIdentifier ?? "", "widthPoints": $0.frame.width, "heightPoints": $0.frame.height] as [String: Any]
                }, "displays": content.displays.map { display in
                    let screen = NSScreen.screens.first { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == display.displayID }
                    return ["id": display.displayID, "name": screen?.localizedName ?? "Display \(display.displayID)",
                        "widthPixels": display.width, "heightPixels": display.height] as [String: Any]
                }, "microphones": microphones().map { ["id": $0.uniqueID, "name": $0.localizedName] }])
            case "preview":
                try requireScreenPermission()
                let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
                let filter = try captureFilter(content, options)
                let config = SCStreamConfiguration()
                let ratio = min(1, 960 / max(filter.contentRect.width * CGFloat(filter.pointPixelScale), filter.contentRect.height * CGFloat(filter.pointPixelScale)))
                config.width = max(2, Int(filter.contentRect.width * CGFloat(filter.pointPixelScale) * ratio))
                config.height = max(2, Int(filter.contentRect.height * CGFloat(filter.pointPixelScale) * ratio))
                config.ignoreShadowsSingleWindow = true
                let cg = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
                guard let jpeg = NSBitmapImageRep(cgImage: cg).representation(using: .jpeg, properties: [.compressionFactor: 0.8]) else { throw failure("Preview encoding failed") }
                emit(["jpeg": jpeg.base64EncodedString(), "captureKind": options.captureKind, "windowID": options.windowID, "displayID": options.displayID])
            case "record", "fixture":
                let raw = URL(fileURLWithPath: options.directory)
                try FileManager.default.createDirectory(at: raw, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                let log = raw.appendingPathComponent("capture_events.jsonl")
                guard !FileManager.default.fileExists(atPath: log.path) else { throw failure("Archive already exists; recording never overwrites an existing raw archive") }
                FileManager.default.createFile(atPath: log.path, contents: nil)
                eventFile = try FileHandle(forWritingTo: log)
                let capturer = ArchiveCapture(options)
                owner = capturer
                capturer.controls = RecorderControls(capture: capturer)
                if options.command == "fixture" { try capturer.startFixture() }
                else { try await capturer.start() }
                return
            default: throw failure("Use list, preview or record")
            }
            exit(0)
        } catch { emit(["event": "error", "detail": error.localizedDescription]); try? eventFile?.synchronize(); exit(2) }
        }
        app.run()
    }
}
