// Prints the text lines Vision finds in a PNG as JSON, with boxes in image
// pixels (top-left origin). Static text has no frame in cua-driver's tree.
import AppKit
import Vision

let image = NSImage(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))!
var rect = CGRect(origin: .zero, size: image.size)
let cg = image.cgImage(forProposedRect: &rect, context: nil, hints: nil)!
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
try VNImageRequestHandler(cgImage: cg).perform([request])
let w = Double(cg.width), h = Double(cg.height)
let lines: [[String: Any]] = (request.results ?? []).compactMap { o in
  guard let text = o.topCandidates(1).first?.string else { return nil }
  let b = o.boundingBox
  return ["text": text, "x": b.minX * w, "y": (1 - b.maxY) * h, "w": b.width * w, "h": b.height * h]
}
print(String(data: try JSONSerialization.data(withJSONObject: lines), encoding: .utf8)!)
