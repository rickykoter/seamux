// winrec — record one window to an H.264 .mp4 with ScreenCaptureKit.
//
//   swiftc -O winrec.swift -o winrec
//   ./winrec WINDOW_ID out.mp4 [WINDOW_ID out.mp4 ...]   records until SIGINT or SIGTERM
//
// Only those windows' pixels are captured (desktopIndependentWindow), at
// their backing scale, 30 fps; several windows are recorded by one process
// (two recorders at once interrupt each other). Prints "recording <epoch>
// <file>" once a window's first frame is written, and "saved" when all files
// are closed.
import AppKit
import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

final class Rec: NSObject, SCStreamOutput, SCStreamDelegate {
  var writer: AVAssetWriter!
  var input: AVAssetWriterInput!
  var stream: SCStream!
  var started = false
  var name = ""
  let q = DispatchQueue(label: "rec")

  func start(id: CGWindowID, out: URL) async throws {
    name = out.lastPathComponent
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    guard let win = content.windows.first(where: { $0.windowID == id }) else {
      FileHandle.standardError.write("winrec: no window \(id)\n".data(using: .utf8)!); exit(2)
    }
    let filter = SCContentFilter(desktopIndependentWindow: win)
    let cfg = SCStreamConfiguration()
    let scale = CGFloat(filter.pointPixelScale)
    cfg.width = Int(win.frame.width * scale) & ~1
    cfg.height = Int(win.frame.height * scale) & ~1
    cfg.minimumFrameInterval = CMTime(value: 1, timescale: 30)
    cfg.showsCursor = false
    cfg.pixelFormat = kCVPixelFormatType_32BGRA
    cfg.queueDepth = 6
    try? FileManager.default.removeItem(at: out)
    writer = try AVAssetWriter(outputURL: out, fileType: .mp4)
    input = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: cfg.width, AVVideoHeightKey: cfg.height,
      AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 24_000_000, AVVideoMaxKeyFrameIntervalKey: 30],
    ])
    input.expectsMediaDataInRealTime = true
    writer.add(input)
    stream = SCStream(filter: filter, configuration: cfg, delegate: self)
    try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: q)
    try await stream.startCapture()
  }

  func stream(_ s: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, sb.isValid,
      let att = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
      let raw = att.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete else { return }
    if !started {
      writer.startWriting()
      writer.startSession(atSourceTime: sb.presentationTimeStamp)
      started = true
      print("recording \(Date().timeIntervalSince1970) \(name)"); fflush(stdout)
    }
    if input.isReadyForMoreMediaData { input.append(sb) }
  }

  func stream(_ s: SCStream, didStopWithError e: Error) {
    FileHandle.standardError.write("winrec: stopped: \(e)\n".data(using: .utf8)!)
  }

  func stop() async {
    try? await stream?.stopCapture()
    q.sync {}
    guard started, writer.status == .writing else { return }
    input.markAsFinished()
    await writer.finishWriting()
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let args = CommandLine.arguments
guard args.count >= 3, args.count % 2 == 1 else { print("usage: winrec WINDOW_ID out.mp4 [WINDOW_ID out.mp4 ...]"); exit(2) }
var recs: [Rec] = []
for i in stride(from: 1, to: args.count, by: 2) {
  guard let id = UInt32(args[i]) else { print("winrec: not a window id: \(args[i])"); exit(2) }
  let rec = Rec(); recs.append(rec)
  let url = URL(fileURLWithPath: args[i + 1])
  Task { do { try await rec.start(id: id, out: url) } catch { print("winrec: \(error)"); exit(1) } }
}
for sig in [SIGINT, SIGTERM] {
  signal(sig, SIG_IGN)
  let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
  src.setEventHandler { Task { for r in recs { await r.stop() }; print("saved"); fflush(stdout); exit(0) } }
  src.resume()
  _ = Unmanaged.passRetained(src)
}
app.run()
