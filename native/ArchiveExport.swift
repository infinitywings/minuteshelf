// Offline, file-only export worker. Never captures a screen/microphone or
// rewrites raw media. Uses source sample offsets + PTS, not concatenated bytes.
import Foundation
import AVFoundation
import CoreGraphics
import CryptoKit
import Darwin

struct VideoPart: Decodable { let path: String; let startSeconds: Double; let durationSeconds: Double }
struct AudioSpan: Decodable { let startSeconds: Double; let frameOffset: Int64; let frames: Int64 }
struct AudioPart: Decodable { let path: String; let source: String; let sampleRate: Double; let spans: [AudioSpan] }
struct Plan: Decodable {
    let durationSeconds: Double; let video: [VideoPart]; let audio: [AudioPart]
    let mixedAudioGainPerSource: Float; let jitterToleranceMs: Double
}
func problem(_ message: String) -> Error { NSError(domain: "MeetingExport", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
func time(_ seconds: Double) -> CMTime { CMTime(seconds: seconds, preferredTimescale: 1_000_000_000) }
func saveJSON(_ value: [String: Any], _ url: URL) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
    try data.write(to: url, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    let file = try FileHandle(forWritingTo: url); try file.synchronize(); try file.close()
}
func checksum(_ url: URL) throws -> String {
    let file = try FileHandle(forReadingFrom: url); defer { try? file.close() }
    var digest = SHA256()
    while let data = try file.read(upToCount: 1024 * 1024), !data.isEmpty { digest.update(data: data) }
    return digest.finalize().map { String(format: "%02x", $0) }.joined()
}
func sourceURL(_ root: URL, _ relative: String) throws -> URL {
    guard !relative.hasPrefix("/"), !relative.contains("\\"), !relative.split(separator: "/").contains("..") else { throw problem("Invalid source path") }
    let url = root.appendingPathComponent(relative).resolvingSymlinksInPath()
    guard url.path.hasPrefix(root.resolvingSymlinksInPath().path + "/"), FileManager.default.fileExists(atPath: url.path) else { throw problem("Source not in this meeting archive") }
    return url
}

@MainActor final class ExportWorker {
    let root: URL; let job: URL; let plan: Plan; let statusURL: URL
    var state: [String: Any]; var files: [[String: Any]] = []; var adjustments: [[String: Any]] = []
    init(root: URL, jobId: String) throws {
        self.root = root; job = root.appendingPathComponent("exports/" + jobId)
        statusURL = job.appendingPathComponent("export-status.json")
        guard let saved = try JSONSerialization.jsonObject(with: Data(contentsOf: statusURL)) as? [String: Any] else { throw problem("Invalid export status") }
        state = saved
        plan = try JSONDecoder().decode(Plan.self, from: Data(contentsOf: job.appendingPathComponent("export-plan.json")))
        state["pid"] = getpid(); state["status"] = "processing"
    }
    func update(_ progress: Float, _ phase: String) throws {
        state["progress"] = progress; state["phase"] = phase; state["files"] = files
        state["updatedAt"] = ISO8601DateFormatter().string(from: Date()); try saveJSON(state, statusURL)
    }
    func blackPlaceholder(_ url: URL) async throws -> AVURLAsset {
        // Gap instructions without a real source sample can disappear from an
        // exported track, especially at non-frame-aligned capture boundaries.
        // Use actual session times: stretching a short clip can cause its held
        // final frame to be truncated. The tiny 1 fps clip stays inexpensive.
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: 64, AVVideoHeightKey: 64])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: 64, kCVPixelBufferHeightKey as String: 64])
        writer.add(input)
        guard writer.startWriting() else { throw writer.error ?? problem("Cannot prepare gap placeholder") }
        writer.startSession(atSourceTime: .zero)
        var buffer: CVPixelBuffer?
        guard CVPixelBufferCreate(kCFAllocatorDefault, 64, 64, kCVPixelFormatType_32BGRA, nil, &buffer) == kCVReturnSuccess,
              let buffer else { throw problem("Cannot allocate gap placeholder") }
        CVPixelBufferLockBaseAddress(buffer, [])
        if let base = CVPixelBufferGetBaseAddress(buffer) { memset(base, 0, CVPixelBufferGetDataSize(buffer)) }
        CVPixelBufferUnlockBaseAddress(buffer, [])
        var positions = Set((0...Int(floor(plan.durationSeconds))).map { Double($0) })
        positions.insert(max(0, plan.durationSeconds - 1.0 / 30))
        positions.insert(plan.durationSeconds)
        for position in positions.sorted() {
            while !input.isReadyForMoreMediaData {
                guard writer.status == .writing else { throw writer.error ?? problem("Cannot encode gap placeholder") }
                try await Task.sleep(nanoseconds: 10_000_000)
            }
            guard adaptor.append(buffer, withPresentationTime: time(position)) else { throw writer.error ?? problem("Cannot encode gap placeholder") }
        }
        writer.endSession(atSourceTime: time(plan.durationSeconds + 1.0 / 30)); input.markAsFinished(); await writer.finishWriting()
        guard writer.status == .completed else {
            throw writer.error ?? problem("Cannot save gap placeholder")
        }
        return AVURLAsset(url: url)
    }
    func export(_ composition: AVMutableComposition, preset: String, name: String, type: AVFileType,
                videoComposition: AVMutableVideoComposition?, audioMix: AVMutableAudioMix, from: Float, to: Float) async throws {
        guard let session = AVAssetExportSession(asset: composition, presetName: preset) else { throw problem("Cannot create media export session") }
        let temporary = job.appendingPathComponent(name.replacingOccurrences(of: ".", with: ".partial.", range: name.range(of: ".", options: .backwards)))
        session.shouldOptimizeForNetworkUse = true
        session.audioMix = audioMix; session.videoComposition = videoComposition
        session.timeRange = CMTimeRange(start: .zero, duration: time(plan.durationSeconds))
        let progress = Task { [self] in
            for await state in session.states(updateInterval: 0.5) {
                if Task.isCancelled { break }
                if case .exporting(let progress) = state { try? update(from + Float(progress.fractionCompleted) * (to - from), name) }
            }
        }
        defer { progress.cancel() }
        try await session.export(to: temporary, as: type)
        let outputAsset = AVURLAsset(url: temporary)
        let actualDuration = try await outputAsset.load(.duration).seconds
        guard abs(actualDuration - plan.durationSeconds) < 0.1 else { throw problem("Output duration does not preserve session timeline") }
        let videoTracks = try await outputAsset.loadTracks(withMediaType: .video)
        let audioTracks = try await outputAsset.loadTracks(withMediaType: .audio)
        if type == .mp4 && !plan.video.isEmpty && videoTracks.isEmpty { throw problem("Export has no video track") }
        if type == .mp4, let track = videoTracks.first {
            let range = try await track.load(.timeRange)
            guard range.start.seconds < 0.05, range.end.seconds >= plan.durationSeconds - 0.05 else {
                throw problem("Exported video ends before the session timeline")
            }
            // The movie duration may be supplied by audio even if video samples
            // stop early. Decode the tail before publishing a playable export.
            let generator = AVAssetImageGenerator(asset: outputAsset)
            generator.maximumSize = CGSize(width: 128, height: 128)
            generator.requestedTimeToleranceBefore = time(1.0 / 30)
            generator.requestedTimeToleranceAfter = time(1.0 / 30)
            _ = try await generator.image(at: time(max(0, actualDuration - 0.05)))
        }
        if !plan.audio.isEmpty && audioTracks.isEmpty { throw problem("Export has no audio track") }
        let file = try FileHandle(forWritingTo: temporary); try file.synchronize(); try file.close()
        let output = job.appendingPathComponent(name); try FileManager.default.moveItem(at: temporary, to: output)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: output.path)
        files.append(["path": "exports/\(job.lastPathComponent)/\(name)", "durationSeconds": actualDuration,
                      "videoTracks": videoTracks.count, "audioTracks": audioTracks.count, "sha256": try checksum(output)])
        try update(to, name)
    }
    func run() async throws {
        try update(0, "Preparing timeline")
        guard plan.durationSeconds > 0, plan.durationSeconds <= 86400,
              plan.audio.allSatisfy({ !$0.spans.isEmpty && $0.sampleRate >= 8000 && $0.sampleRate <= 384000 && $0.sampleRate.rounded() == $0.sampleRate }) else { throw problem("Invalid export plan") }
        let composition = AVMutableComposition(), total = time(plan.durationSeconds)
        var instructions: [AVVideoCompositionInstructionProtocol] = []
        var canvas = CGSize.zero, lastVideoEnd = 0.0, lastVideoTime = CMTime.zero
        var background: AVMutableCompositionTrack?
        let placeholder = job.appendingPathComponent("black-placeholder.partial.mp4")
        defer { try? FileManager.default.removeItem(at: placeholder) }
        func black(_ start: CMTime, _ end: CMTime) {
            guard end > start else { return }
            let instruction = AVMutableVideoCompositionInstruction()
            instruction.timeRange = CMTimeRange(start: start, end: end)
            instruction.backgroundColor = CGColor(gray: 0, alpha: 1)
            instruction.layerInstructions = background.map { [AVMutableVideoCompositionLayerInstruction(assetTrack: $0)] } ?? []
            instructions.append(instruction)
        }
        if !plan.video.isEmpty {
            guard let track = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw problem("Cannot add gap track") }
            let blackAsset = try await blackPlaceholder(placeholder)
            guard let source = try await blackAsset.loadTracks(withMediaType: .video).first else { throw problem("Cannot read gap placeholder") }
            let range = try await source.load(.timeRange)
            try withExtendedLifetime(blackAsset) { try track.insertTimeRange(range, of: source, at: .zero) }
            background = track
            guard let destination = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw problem("Cannot add video track") }
            destination.naturalTimeScale = 1_000_000_000
            for part in plan.video {
                let asset = AVURLAsset(url: try sourceURL(root, part.path))
                guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw problem("No video track in source") }
                let sourceRange = try await track.load(.timeRange)
                var start = part.startSeconds, skip = 0.0
                if start < lastVideoEnd {
                    skip = lastVideoEnd - start
                    guard skip <= plan.jitterToleranceMs / 1000 + 0.00001 else { throw problem("Overlapping video PTS require review") }
                    adjustments.append(["source": part.path, "leadingTrimSeconds": skip]); start = lastVideoEnd
                }
                let duration = min(part.durationSeconds, sourceRange.duration.seconds) - skip
                guard duration > 0 else { throw problem("Invalid video duration") }
                // Adjacent instruction boundaries share exact rational values.
                // Separately rounding (end - start) creates nanosecond gaps
                // which AVFoundation rejects as an invalid composition.
                let startTime = time(start), endTime = time(start + duration)
                black(lastVideoTime, startTime)
                try destination.insertTimeRange(CMTimeRange(start: CMTimeAdd(sourceRange.start, time(skip)), duration: CMTimeSubtract(endTime, startTime)), of: track, at: startTime)
                let naturalSize = try await track.load(.naturalSize), preferred = try await track.load(.preferredTransform)
                let bounds = CGRect(origin: .zero, size: naturalSize).applying(preferred)
                let size = CGSize(width: abs(bounds.width), height: abs(bounds.height))
                if canvas == .zero { canvas = CGSize(width: floor(size.width / 2) * 2, height: floor(size.height / 2) * 2) }
                let scale = min(1, canvas.width / size.width, canvas.height / size.height)
                let transform = preferred.concatenating(CGAffineTransform(translationX: -bounds.minX, y: -bounds.minY))
                    .concatenating(CGAffineTransform(scaleX: scale, y: scale))
                    .concatenating(CGAffineTransform(translationX: (canvas.width - size.width * scale) / 2, y: (canvas.height - size.height * scale) / 2))
                let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: destination); layer.setTransform(transform, at: time(start))
                let instruction = AVMutableVideoCompositionInstruction()
                instruction.timeRange = CMTimeRange(start: startTime, end: endTime)
                instruction.backgroundColor = CGColor(gray: 0, alpha: 1); instruction.layerInstructions = [layer]
                instructions.append(instruction); lastVideoEnd = start + duration; lastVideoTime = endTime
            }
            black(lastVideoTime, total)
            // The audio track can outlive the last captured frame. Instructions
            // alone do not extend a composition track: without an empty tail,
            // AVFoundation stops emitting video and players freeze the last frame.
            if lastVideoTime < total {
                destination.insertEmptyTimeRange(CMTimeRange(start: lastVideoTime, end: total))
            }
        }
        let mix = AVMutableAudioMix(); var inputParameters: [AVAudioMixInputParameters] = []
        for source in Set(plan.audio.map { $0.source }).sorted() {
            guard let destination = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw problem("Cannot add audio track") }
            destination.naturalTimeScale = 1_000_000_000
            var end = 0.0
            for part in plan.audio.filter({ $0.source == source }).sorted(by: { $0.spans[0].startSeconds < $1.spans[0].startSeconds }) {
                let asset = AVURLAsset(url: try sourceURL(root, part.path))
                guard let track = try await asset.loadTracks(withMediaType: .audio).first else { throw problem("No audio track in source") }
                let sourceRange = try await track.load(.timeRange)
                for span in part.spans {
                    var start = span.startSeconds, skip = 0.0
                    if start < end {
                        skip = end - start
                        guard skip <= plan.jitterToleranceMs / 1000 + 0.00001 else { throw problem("Overlapping audio PTS require review") }
                        adjustments.append(["source": part.path, "frameOffset": span.frameOffset, "leadingTrimSeconds": skip]); start = end
                    }
                    let duration = Double(span.frames) / part.sampleRate - skip
                    guard duration > 0, start + duration <= plan.durationSeconds + 0.002 else { throw problem("Invalid audio span") }
                    let offset = CMTime(value: span.frameOffset, timescale: CMTimeScale(part.sampleRate))
                    let inputStart = CMTimeAdd(sourceRange.start, CMTimeAdd(offset, time(skip)))
                    guard inputStart.seconds + duration <= sourceRange.end.seconds + 0.00001 else { throw problem("Audio PTS refers beyond stored samples") }
                    try destination.insertTimeRange(CMTimeRange(start: inputStart, duration: time(duration)), of: track, at: time(start))
                    end = start + duration
                }
            }
            if end < plan.durationSeconds { destination.insertEmptyTimeRange(CMTimeRange(start: time(end), duration: time(plan.durationSeconds - end))) }
            let params = AVMutableAudioMixInputParameters(track: destination); params.setVolume(plan.mixedAudioGainPerSource, at: .zero); inputParameters.append(params)
        }
        mix.inputParameters = inputParameters
        if composition.duration < total { composition.insertEmptyTimeRange(CMTimeRange(start: composition.duration, duration: CMTimeSubtract(total, composition.duration))) }
        if !plan.video.isEmpty {
            let video = AVMutableVideoComposition(); video.renderSize = canvas; video.frameDuration = CMTime(value: 1, timescale: 30); video.instructions = instructions
            guard video.isValid(for: try await composition.load(.tracks), assetDuration: total,
                                timeRange: CMTimeRange(start: .zero, duration: total), validationDelegate: nil) else { throw problem("Video composition timeline is invalid") }
            try await export(composition, preset: AVAssetExportPresetHighestQuality, name: "meeting.mp4", type: .mp4,
                             videoComposition: video, audioMix: mix, from: 0, to: plan.audio.isEmpty ? 1 : 0.8)
        }
        if !plan.audio.isEmpty {
            try await export(composition, preset: AVAssetExportPresetAppleM4A, name: "recording.m4a", type: .m4a,
                             videoComposition: nil, audioMix: mix, from: plan.video.isEmpty ? 0 : 0.8, to: 1)
        }
        try saveJSON(["schemaVersion": "meeting-export-report-1", "durationSeconds": plan.durationSeconds,
                      "files": files, "jitterToleranceMs": plan.jitterToleranceMs, "leadingTrimAdjustments": adjustments,
                      "audioSources": Array(Set(plan.audio.map { $0.source })).sorted(), "gainPerSource": plan.mixedAudioGainPerSource,
                      "gapPolicy": "preserve-time-black-video-silent-audio", "rawUnchanged": true], job.appendingPathComponent("export-report.json"))
        state["status"] = "ready"; try update(1, "Saved")
    }
}
@main struct Main {
    static func inspect(_ file: URL, at positions: [Double]) async throws -> [String: Any] {
        let asset = AVURLAsset(url: file), duration = try await asset.load(.duration).seconds
        let videoTracks = try await asset.loadTracks(withMediaType: .video), audioTracks = try await asset.loadTracks(withMediaType: .audio)
        func codecs(_ tracks: [AVAssetTrack]) async throws -> [String] {
            var result: [String] = []
            for track in tracks { for format in try await track.load(.formatDescriptions) {
                let code = CMFormatDescriptionGetMediaSubType(format)
                result.append(String(bytes: [UInt8((code >> 24) & 255), UInt8((code >> 16) & 255), UInt8((code >> 8) & 255), UInt8(code & 255)], encoding: .ascii) ?? String(code))
            } }; return result
        }
        var samples: [[String: Any]] = []
        for point in positions {
            var row: [String: Any] = ["seconds": point]
            if !videoTracks.isEmpty {
                let generator = AVAssetImageGenerator(asset: asset); generator.requestedTimeToleranceBefore = .zero; generator.requestedTimeToleranceAfter = .zero
                let result = try await generator.image(at: time(point)), image = result.image
                var pixels = [UInt8](repeating: 0, count: 32 * 32 * 4)
                pixels.withUnsafeMutableBytes { data in
                    let context = CGContext(data: data.baseAddress, width: 32, height: 32, bitsPerComponent: 8, bytesPerRow: 32 * 4,
                                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
                    context.draw(image, in: CGRect(x: 0, y: 0, width: 32, height: 32))
                }
                row["meanRGB"] = Double(pixels.enumerated().filter { $0.offset % 4 < 3 }.reduce(0) { $0 + Int($1.element) }) / Double(32 * 32 * 3)
                row["decodedFrameSeconds"] = result.actualTime.seconds
            }
            if let track = audioTracks.first {
                let reader = try AVAssetReader(asset: asset)
                reader.timeRange = CMTimeRange(start: time(point), duration: time(0.1))
                let output = AVAssetReaderTrackOutput(track: track, outputSettings: [AVFormatIDKey: kAudioFormatLinearPCM,
                    AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false])
                reader.add(output); guard reader.startReading() else { throw reader.error ?? problem("Cannot decode exported audio") }
                var energy = 0.0, count = 0
                while let sample = output.copyNextSampleBuffer() {
                    guard let block = CMSampleBufferGetDataBuffer(sample), let description = CMSampleBufferGetFormatDescription(sample),
                          let format = CMAudioFormatDescriptionGetStreamBasicDescription(description) else { continue }
                    var data = [Float](repeating: 0, count: CMBlockBufferGetDataLength(block) / 4)
                    data.withUnsafeMutableBytes { bytes in _ = CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: bytes.count, destination: bytes.baseAddress!) }
                    let pts = CMSampleBufferGetPresentationTimeStamp(sample).seconds, channels = Int(format.pointee.mChannelsPerFrame), rate = format.pointee.mSampleRate
                    for (index, value) in data.enumerated() {
                        let at = pts + Double(index / channels) / rate
                        if at >= point && at < point + 0.1 { energy += Double(value * value); count += 1 }
                    }
                }
                row["audioRMS"] = count > 0 ? sqrt(energy / Double(count)) : 0; row["audioValuesDecoded"] = count
            }
            samples.append(row)
        }
        return ["durationSeconds": duration, "videoTracks": videoTracks.count, "audioTracks": audioTracks.count,
                "videoCodecs": try await codecs(videoTracks), "audioCodecs": try await codecs(audioTracks), "samples": samples]
    }
    @MainActor static func main() async {
        var worker: ExportWorker?
        do {
            let args = CommandLine.arguments
            if args.count == 5, args[1] == "--inspect", args[3] == "--sample-times" {
                let report = try await inspect(URL(fileURLWithPath: args[2]), at: args[4].split(separator: ",").compactMap { Double($0) })
                print(String(data: try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), encoding: .utf8)!); exit(0)
            }
            guard args.count == 5, args[1] == "--archive", args[3] == "--job", UUID(uuidString: args[4]) != nil else { throw problem("Use --archive <meeting-directory> --job <uuid>") }
            let value = try ExportWorker(root: URL(fileURLWithPath: args[2]), jobId: args[4]); worker = value
            try await value.run(); exit(0)
        } catch {
            if let worker { worker.state["status"] = "failed"; worker.state["error"] = error.localizedDescription; try? worker.update(0, "Failed") }
            fputs(String(describing: error as NSError) + "\n", stderr); exit(2)
        }
    }
}
