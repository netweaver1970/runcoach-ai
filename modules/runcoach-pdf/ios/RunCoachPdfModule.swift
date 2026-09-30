import ExpoModulesCore
import PDFKit
import Vision
import UIKit

/// Text-layer extraction from a PDF. Digital lab reports (the kind a lab emails you) carry a real text
/// layer, so PDFKit can read them exactly — no OCR, no transcription errors in the numbers, which matters
/// when the payload is clinical values. A SCANNED/photographed report has no text layer: `pageCount` will
/// be > 0 while `text` comes back empty, and the caller must route those to vision/OCR instead.
public class RunCoachPdfModule: Module {
  public func definition() -> ModuleDefinition {
    Name("RunCoachPdf")

    // Returns { text, pageCount, hasTextLayer }. Never throws on an unreadable file — the caller gets
    // hasTextLayer=false and can fall back rather than crash mid-import.
    AsyncFunction("extractText") { (uri: String) -> [String: Any] in
      guard let url = URL(string: uri) ?? URL(fileURLWithPath: uri) as URL?,
            let doc = PDFDocument(url: url) else {
        return ["text": "", "pageCount": 0, "hasTextLayer": false]
      }
      var out = ""
      for i in 0..<doc.pageCount {
        // Per PAGE, not doc.string: a multi-page report keeps its page order, and one unreadable page
        // can't take the whole document down with it.
        if let page = doc.page(at: i), let s = page.string { out += s + "\n" }
      }
      let trimmed = out.trimmingCharacters(in: .whitespacesAndNewlines)
      return ["text": out, "pageCount": doc.pageCount, "hasTextLayer": trimmed.count >= 40]
    }

    // Product barcodes (EAN-13 / EAN-8 / UPC-E) in a PHOTO, decoded on-device by Vision — the food log's "Scan"
    // (photo-based, no camera library). Returns the payload strings, best first; [] when nothing is readable.
    // Never throws: an unreadable file or a Vision error yields [] so the caller can fall back to typed digits.
    AsyncFunction("detectBarcodes") { (uri: String) -> [String] in
      guard let url = URL(string: uri) ?? URL(fileURLWithPath: uri) as URL?,
            let data = try? Data(contentsOf: url), let img = UIImage(data: data), let cg = img.cgImage else { return [] }
      let req = VNDetectBarcodesRequest()
      req.symbologies = [.ean13, .ean8, .upce]
      let orientation = CGImagePropertyOrientation(rawValue: UInt32(Self.exif(img.imageOrientation))) ?? .up
      let handler = VNImageRequestHandler(cgImage: cg, orientation: orientation, options: [:])
      do { try handler.perform([req]) } catch { return [] }
      let obs = (req.results ?? []).sorted { $0.confidence > $1.confidence }
      var out: [String] = []
      for o in obs { if let p = o.payloadStringValue, !out.contains(p) { out.append(p) } }
      return out
    }
  }

  // UIImage.Orientation → EXIF orientation (what Vision expects)
  private static func exif(_ o: UIImage.Orientation) -> Int {
    switch o {
    case .up: return 1; case .upMirrored: return 2; case .down: return 3; case .downMirrored: return 4
    case .leftMirrored: return 5; case .right: return 6; case .rightMirrored: return 7; case .left: return 8
    @unknown default: return 1
    }
  }
}
