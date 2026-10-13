// Offline media preparation. This helper has no capture or network APIs.
import Foundation
import AVFoundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import PDFKit
import Darwin

private struct VideoPart: Decodable { let path: String; let startSeconds: Double; let durationSeconds: Double }
private struct AudioSpan: Decodable { let startSeconds: Double; let frameOffset: Int64; let frames: Int64 }
private struct AudioPart: Decodable { let path: String; let source: String; let sampleRate: Double; let spans: [AudioSpan] }
private struct MediaPlan: Decodable { let durationSeconds: Double; let video: [VideoPart]; let audio: [AudioPart] }
private struct Request: Decodable {
    let meetingRoot: String; let outputRoot: String; let mediaPlan: MediaPlan?
    let chunkSeconds: Int?; let frameBudget: Int?; let sampleSeconds: Double?; let bookmarks: [Double]?
    let documents: [String]?
}
private func failure(_ text: String) -> Error { NSError(domain: "AnalysisMedia", code: 1, userInfo: [NSLocalizedDescriptionKey: text]) }
private func watchParent() -> DispatchSourceTimer? {
    guard let value = ProcessInfo.processInfo.environment["MEETING_ANALYSIS_PARENT_PID"], let parent = Int32(value), parent > 1 else { return nil }
    let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
    timer.schedule(deadline: .now(), repeating: .milliseconds(500))
    timer.setEventHandler {
        if getppid() != parent || (kill(parent, 0) != 0 && errno == ESRCH) {
            // Never target a caller-supplied process group. Only our own group
            // can contain decoders started for this worker.
            if getpgrp() == getpid() { kill(-getpid(), SIGTERM) }
            _exit(125)
        }
    }
    timer.resume(); return timer
}
private func scoped(_ relative: String, root: URL) throws -> URL {
    guard !relative.isEmpty, !relative.hasPrefix("/"), !relative.contains("\\"), !relative.split(separator: "/").contains("..") else { throw failure("Invalid relative media path") }
    let file = root.appendingPathComponent(relative).resolvingSymlinksInPath()
    guard file.path.hasPrefix(root.path + "/"), (try file.resourceValues(forKeys: [.isRegularFileKey])).isRegularFile == true else { throw failure("Media is outside the meeting folder") }
    return file
}
private func save(_ object: [String: Any], to file: URL) throws {
    try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .prettyPrinted]).write(to: file, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
}

private final class AudioChunks {
    let root: URL; let source: String; let limit: Int
    var samples: [Float] = []; var start = 0.0; var expectedEnd: Double?
    var result: [[String: Any]] = []; var maps: [[String: Any]] = []
    init(root: URL, source: String, seconds: Int) { self.root = root; self.source = source; limit = seconds * 16000; samples.reserveCapacity(limit) }
    func append(_ values: UnsafeBufferPointer<Float>, at seconds: Double, original: String, frameOffset: Int64, rate: Double) throws {
        if let end = expectedEnd, abs(seconds - end) > 0.002 { try flush() }
        var offset = 0
        while offset < values.count {
            if samples.isEmpty { start = seconds + Double(offset) / 16000; maps = [] }
            let count = min(limit - samples.count, values.count - offset)
            maps.append(["derivedStartFrame": samples.count, "frames": count, "sessionStartMs": (seconds + Double(offset) / 16000) * 1000,
                         "sourcePath": original, "sourceFrameOffset": frameOffset + Int64((Double(offset) * rate / 16000).rounded()), "sourceSampleRate": rate])
            samples.append(contentsOf: values[offset..<(offset + count)]); offset += count
            expectedEnd = seconds + Double(offset) / 16000
            if samples.count == limit { try flush() }
        }
    }
    func flush() throws {
        guard !samples.isEmpty else { return }
        let relative = "audio/\(source)-\(String(format: "%06d", result.count)).wav", url = root.appendingPathComponent(relative)
        guard url.resolvingSymlinksInPath().path.hasPrefix(root.path + "/audio/"), !FileManager.default.fileExists(atPath: url.path) else { throw failure("Audio output already exists or leaves the analysis folder") }
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)), let ptr = buffer.floatChannelData?[0] else { throw failure("Cannot allocate audio chunk") }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { ptr.update(from: $0.baseAddress!, count: $0.count) }
        let settings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false]
        // Scope closes AVAudioFile and finalizes its WAV header before publishing metadata.
        do { let writer = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false); try writer.write(from: buffer) }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        result.append(["path": relative, "source": source, "startMs": start * 1000, "endMs": (start + Double(samples.count) / 16000) * 1000,
                       "sampleRate": 16000, "frames": samples.count, "timeline": maps])
        samples.removeAll(keepingCapacity: true)
    }
}

private func audio(_ plan: MediaPlan, root: URL, output: URL, seconds: Int) throws -> [[String: Any]] {
    var result: [[String: Any]] = []
    for source in Set(plan.audio.map { $0.source }).sorted() {
        guard ["microphone", "system"].contains(source) else { throw failure("Unknown audio source") }
        let chunks = AudioChunks(root: output, source: source, seconds: seconds)
        var previousEnd: Double?
        for part in plan.audio.filter({ $0.source == source }).sorted(by: { ($0.spans.first?.startSeconds ?? 0) < ($1.spans.first?.startSeconds ?? 0) }) {
            let file = try AVAudioFile(forReading: scoped(part.path, root: root), commonFormat: .pcmFormatFloat32, interleaved: false)
            let inputFormat = file.processingFormat
            guard part.sampleRate >= 8000, part.sampleRate <= 384000, abs(inputFormat.sampleRate - part.sampleRate) < 0.01, inputFormat.channelCount <= 8 else { throw failure("Source audio format does not match its timeline") }
            for span in part.spans {
                guard span.startSeconds.isFinite, span.startSeconds >= 0, span.frames > 0, span.frameOffset >= 0,
                      span.frameOffset <= file.length, span.frames <= file.length - span.frameOffset,
                      span.startSeconds + Double(span.frames) / part.sampleRate <= plan.durationSeconds + 0.1 else { throw failure("Invalid audio sample span") }
                if let end = previousEnd, span.startSeconds < end - 0.002 { throw failure("Overlapping audio timeline requires review") }
                file.framePosition = span.frameOffset
                guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false),
                      let converter = AVAudioConverter(from: inputFormat, to: format),
                      let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4096) else { throw failure("Cannot create audio converter") }
                converter.primeMethod = .none
                var remaining = span.frames, produced: Int64 = 0, readError: Error?
                let expected = Int64((Double(span.frames) * 16000 / part.sampleRate).rounded())
                while produced < expected {
                    var conversionError: NSError?
                    let status = converter.convert(to: converted, error: &conversionError) { requested, state in
                        if remaining <= 0 { state.pointee = .endOfStream; return nil }
                        let count = AVAudioFrameCount(min(remaining, Int64(min(requested, 8192))))
                        guard let input = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: count) else { state.pointee = .endOfStream; return nil }
                        do { try file.read(into: input, frameCount: count) }
                        catch { readError = error; state.pointee = .endOfStream; return nil }
                        remaining -= Int64(input.frameLength)
                        if input.frameLength == 0 { remaining = 0; state.pointee = .endOfStream; return nil }
                        state.pointee = .haveData; return input
                    }
                    if let error = readError ?? conversionError { throw error }
                    let count = min(Int64(converted.frameLength), expected - produced)
                    if count > 0, let ptr = converted.floatChannelData?[0] {
                        try chunks.append(UnsafeBufferPointer(start: ptr, count: Int(count)), at: span.startSeconds + Double(produced) / 16000,
                                          original: part.path, frameOffset: span.frameOffset + Int64((Double(produced) * part.sampleRate / 16000).rounded()), rate: part.sampleRate)
                        produced += count
                    }
                    if status == .endOfStream || (count == 0 && status == .inputRanDry) { break }
                    if status == .error { throw failure("Audio conversion failed") }
                }
                guard abs(produced - expected) <= 2 else { throw failure("Converted audio duration does not match media PTS") }
                previousEnd = span.startSeconds + Double(span.frames) / part.sampleRate
            }
        }
        try chunks.flush(); result += chunks.result
    }
    return result.sorted { ($0["startMs"] as! Double) < ($1["startMs"] as! Double) }
}

private func signature(_ image: CGImage) -> [UInt8] {
    var values = [UInt8](repeating: 0, count: 96 * 54)
    values.withUnsafeMutableBytes { bytes in
        if let ctx = CGContext(data: bytes.baseAddress, width: 96, height: 54, bitsPerComponent: 8, bytesPerRow: 96, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: 0) {
            ctx.interpolationQuality = .low; ctx.draw(image, in: CGRect(x: 0, y: 0, width: 96, height: 54))
        }
    }
    return values
}
private func difference(_ a: [UInt8], _ b: [UInt8]) -> Double {
    zip(a, b).reduce(0.0) { $0 + Double(abs(Int($1.0) - Int($1.1))) } / Double(a.count * 255)
}
private func imageData(_ image: CGImage) throws -> Data {
    let bytes = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(bytes, UTType.jpeg.identifier as CFString, 1, nil) else { throw failure("Cannot encode keyframe") }
    CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.86] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { throw failure("Cannot encode keyframe") }
    return bytes as Data
}
private func video(_ plan: MediaPlan, root: URL, output: URL, budget: Int, interval: Double, bookmarks: [Double]) async throws -> ([ [String: Any] ], [String: Any]) {
    var frames: [[String: Any]] = [], scanned = 0, changed = 0, skipped = 0
    var previous: [UInt8]?, previousEnd = -1.0
    // Scan uniformly, but reserve slots throughout the session: a busy first minute
    // cannot consume all image tokens. User bookmarks take priority in each bucket.
    let bucketSeconds = max(interval, plan.durationSeconds / Double(budget))
    var usedBuckets = Set<Int>(), cache: [String: (AVAssetImageGenerator, Double)] = [:]
    let firstVideo = plan.video.map { $0.startSeconds }.min().map { [$0] } ?? []
    let times = Array(Set(stride(from: 0.0, to: plan.durationSeconds, by: interval).map { $0 } + firstVideo + bookmarks.filter { $0.isFinite && $0 >= 0 && $0 < plan.durationSeconds })).sorted()
    for seconds in times {
        guard let part = plan.video.first(where: { seconds >= $0.startSeconds && seconds < $0.startSeconds + $0.durationSeconds }) else { previous = nil; continue }
        let generator: AVAssetImageGenerator, sourceOrigin: Double
        if let existing = cache[part.path] { generator = existing.0; sourceOrigin = existing.1 }
        else {
            // Only one decoder is retained; archives may contain thousands of fragments.
            cache.removeAll()
            let asset = AVURLAsset(url: try scoped(part.path, root: root))
            guard let track = try await asset.loadTracks(withMediaType: .video).first else { skipped += 1; continue }
            sourceOrigin = try await track.load(.timeRange).start.seconds
            generator = AVAssetImageGenerator(asset: asset)
            generator.appliesPreferredTrackTransform = true; generator.maximumSize = CGSize(width: 1600, height: 1600)
            generator.requestedTimeToleranceBefore = .zero; generator.requestedTimeToleranceAfter = CMTime(seconds: 0.2, preferredTimescale: 600)
            cache[part.path] = (generator, sourceOrigin)
        }
        let requested = CMTime(seconds: seconds - part.startSeconds + sourceOrigin, preferredTimescale: 1_000_000)
        do {
            let (image, actual) = try await generator.image(at: requested)
            let sample = signature(image), bookmark = bookmarks.contains { abs($0 - seconds) < 0.001 }
            scanned += 1
            let isChanged = previous == nil || difference(previous!, sample) > 0.012 || seconds - previousEnd > interval * 1.5
            let bucket = Int(seconds / bucketSeconds)
            if isChanged || bookmark {
                changed += 1
                if frames.count < budget && (!usedBuckets.contains(bucket) || bookmark) {
                    let name = "frames/frame-\(String(format: "%06d", frames.count)).jpg"
                    try imageData(image).write(to: output.appendingPathComponent(name), options: .atomic)
                    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: output.appendingPathComponent(name).path)
                    frames.append(["path": name, "startMs": seconds * 1000, "endMs": min(seconds + interval, part.startSeconds + part.durationSeconds) * 1000,
                                   "sourceMs": (part.startSeconds + actual.seconds - sourceOrigin) * 1000, "sourcePath": part.path, "bookmark": bookmark])
                    usedBuckets.insert(bucket); previous = sample
                } else { skipped += 1 }
            } else if !frames.isEmpty, seconds - (frames[frames.count - 1]["endMs"] as! Double) / 1000 <= interval * 0.5 {
                frames[frames.count - 1]["endMs"] = min(seconds + interval, part.startSeconds + part.durationSeconds) * 1000
            }
            previousEnd = seconds
        } catch { skipped += 1; previous = nil }
    }
    return (frames, ["sampleIntervalSeconds": interval, "samplesDecoded": scanned, "changedCandidates": changed, "selectedFrames": frames.count,
                     "frameBudget": budget, "skippedCandidatesOrUnreadableFrames": skipped, "allFramesAnalyzed": false,
                     "limitations": ["Sparse sampling may miss brief changes, small cursor motions, and speaker highlights.", "Intervals describe sampled similarity, not proof that every intervening frame is identical."]])
}

@main private struct Main {
    static func main() async {
        let parentWatch = watchParent(); defer { parentWatch?.cancel() }
        do {
            guard CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--plan" else { throw failure("Usage: analysis-media --plan request.json") }
            let requestFile = URL(fileURLWithPath: CommandLine.arguments[2])
            guard (try requestFile.resourceValues(forKeys: [.fileSizeKey])).fileSize ?? 0 <= 16 * 1024 * 1024 else { throw failure("Media plan is too large") }
            let request = try JSONDecoder().decode(Request.self, from: Data(contentsOf: requestFile))
            let root = URL(fileURLWithPath: request.meetingRoot).resolvingSymlinksInPath(), output = URL(fileURLWithPath: request.outputRoot).resolvingSymlinksInPath()
            guard output.path.hasPrefix(root.path + "/outputs/") || output.path.hasPrefix(root.path + "/derived/") else { throw failure("Analysis output must be inside this meeting's outputs folder") }
            try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            var result: [String: Any] = ["schemaVersion": 1]
            if let plan = request.mediaPlan {
                guard plan.durationSeconds.isFinite, plan.durationSeconds > 0, plan.durationSeconds <= 86400,
                      plan.audio.count <= 50000, plan.video.count <= 50000,
                      plan.video.allSatisfy({ $0.startSeconds.isFinite && $0.startSeconds >= 0 && $0.durationSeconds.isFinite && $0.durationSeconds > 0 }) else { throw failure("Invalid media plan") }
                for name in ["audio", "frames"] {
                    let folder = output.appendingPathComponent(name)
                    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                    guard folder.resolvingSymlinksInPath().path == folder.path else { throw failure("Analysis output folders cannot be symbolic links") }
                }
                result["audio"] = try audio(plan, root: root, output: output, seconds: min(30, max(5, request.chunkSeconds ?? 30)))
                let (frames, coverage) = try await video(plan, root: root, output: output, budget: min(240, max(1, request.frameBudget ?? 60)), interval: max(1, request.sampleSeconds ?? 5), bookmarks: request.bookmarks ?? [])
                result["frames"] = frames; result["coverage"] = coverage
            }
            if let documents = request.documents {
                guard documents.count <= 100 else { throw failure("Too many context documents") }
                result["documents"] = try documents.map { relative -> [String: Any] in
                    let file = try scoped(relative, root: root)
                    guard (try file.resourceValues(forKeys: [.fileSizeKey])).fileSize ?? 0 <= 25 * 1024 * 1024 else { throw failure("Context document is too large") }
                    let text: String
                    if file.pathExtension.lowercased() == "pdf" { text = PDFDocument(url: file)?.string ?? "" }
                    else { text = String(data: try Data(contentsOf: file), encoding: .utf8) ?? "" }
                    return ["path": relative, "text": String(text.prefix(100000)), "truncated": text.count > 100000, "textUnavailable": text.isEmpty]
                }
            }
            try save(result, to: output.appendingPathComponent(request.mediaPlan == nil ? "prepared-documents.json" : "prepared-media.json"))
            print("{\"ok\":true,\"result\":\"prepared-media.json\"}")
        } catch { FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8)); exit(1) }
    }
}
