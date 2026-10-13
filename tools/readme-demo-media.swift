// Fabricated slides for public documentation. No capture, microphone or AI.
// Compile: swiftc tools/readme-demo-media.swift -o .build/readme-demo-media
import AppKit
import AVFoundation
import CoreVideo

let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
let width = 1280, height = 720
let ink = NSColor(calibratedRed: 0.14, green: 0.20, blue: 0.15, alpha: 1)
let olive = NSColor(calibratedRed: 0.37, green: 0.44, blue: 0.24, alpha: 1)
let cream = NSColor(calibratedRed: 0.97, green: 0.97, blue: 0.92, alpha: 1)
func label(_ text: String, _ x: CGFloat, _ y: CGFloat, _ size: CGFloat, bold: Bool = false, color: NSColor = ink) {
    (text as NSString).draw(at: NSPoint(x: x, y: y), withAttributes: [.font: bold ? NSFont.boldSystemFont(ofSize: size) : NSFont.systemFont(ofSize: size), .foregroundColor: color])
}
func panel(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, color: NSColor) {
    color.setFill(); NSBezierPath(roundedRect: NSRect(x: x, y: y, width: w, height: h), xRadius: 22, yRadius: 22).fill()
}
func slide(_ index: Int) throws -> (CGImage, CVPixelBuffer) {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: width * 4, bitsPerPixel: 32)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    cream.setFill(); NSRect(x: 0, y: 0, width: width, height: height).fill()
    label("PROJECT ATLAS", 64, 645, 17, bold: true, color: olive)
    label("SYNTHETIC DEMO  /  NOT A REAL MEETING", 740, 645, 15, bold: true, color: olive)
    if index == 0 {
        label("Experiment review", 64, 540, 54, bold: true)
        label("The result improved. What should we validate next?", 66, 485, 25)
        panel(64, 160, 550, 270, color: .white)
        panel(642, 160, 574, 270, color: NSColor(calibratedRed: 0.89, green: 0.92, blue: 0.79, alpha: 1))
        label("BASELINE  /  F1", 96, 358, 19, bold: true, color: olive)
        label("0.81", 96, 225, 100, bold: true)
        label("PROPOSED  /  F1", 674, 358, 19, bold: true, color: olive)
        label("0.92", 674, 225, 100, bold: true)
        label("Values shown for illustration only.", 64, 93, 18, color: olive)
    } else if index == 1 {
        label("Look beyond the headline", 64, 540, 50, bold: true)
        label("Before the next pilot, check the failure cases.", 66, 485, 25)
        let labels = ["False positives", "Mixed-language audio", "Overlapping speakers"]
        for (i, text) in labels.enumerated() {
            let y = CGFloat(350 - i * 95)
            panel(64, y, 1152, 76, color: .white)
            label(String(format: "%02d", i + 1), 90, y + 22, 23, bold: true, color: olive)
            label(text, 170, y + 21, 27, bold: true)
        }
    } else {
        label("Decisions need evidence", 64, 540, 52, bold: true)
        label("Keep observations, decisions and open questions separate.", 66, 485, 24)
        panel(64, 194, 1152, 220, color: .white)
        label("NEXT STEP", 96, 355, 18, bold: true, color: olive)
        label("Review false positives before extending the pilot.", 96, 292, 30, bold: true)
        label("Owner: Alex   /   Due: Friday   /   Confirmed in the discussion", 96, 236, 21)
    }
    label("Research review  ·  13 October 2026", 64, 38, 16, color: olive)
    label("0\(index + 1) / 03", 1120, 38, 16, bold: true, color: olive)
    NSGraphicsContext.restoreGraphicsState()
    let image = rep.cgImage!
    try rep.representation(using: .png, properties: [:])!.write(to: output.appendingPathComponent("slide-\(index + 1).png"))
    var buffer: CVPixelBuffer?
    CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32ARGB, [kCVPixelBufferCGImageCompatibilityKey: true, kCVPixelBufferCGBitmapContextCompatibilityKey: true] as CFDictionary, &buffer)
    let pixelBuffer = buffer!
    CVPixelBufferLockBaseAddress(pixelBuffer, [])
    let context = CGContext(data: CVPixelBufferGetBaseAddress(pixelBuffer), width: width, height: height, bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer), space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue)!
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    CVPixelBufferUnlockBaseAddress(pixelBuffer, [])
    return (image, pixelBuffer)
}
let slides = try (0..<3).map(slide)
let video = output.appendingPathComponent("demo.mp4")
if FileManager.default.fileExists(atPath: video.path) {
    try FileManager.default.moveItem(at: video, to: output.appendingPathComponent("demo-interrupted-\(UUID().uuidString).mp4"))
}
let writer = try AVAssetWriter(outputURL: video, fileType: .mp4)
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height, AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 2_000_000]])
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB, kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height])
writer.add(input)
guard writer.startWriting() else { throw writer.error! }
writer.startSession(atSourceTime: .zero)
for frame in 0..<1350 {
    while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.002) }
    guard adaptor.append(slides[frame / 450].1, withPresentationTime: CMTime(value: Int64(frame), timescale: 15)) else { throw writer.error! }
}
writer.endSession(atSourceTime: CMTime(value: 90, timescale: 1))
input.markAsFinished()
let finished = DispatchSemaphore(value: 0)
writer.finishWriting { finished.signal() }
finished.wait()
guard writer.status == .completed else { throw writer.error! }
try Data("{\"syntheticOnly\":true,\"durationSeconds\":90,\"complete\":true}\n".utf8).write(to: output.appendingPathComponent("media-ready.json"), options: .atomic)
print(video.path)
