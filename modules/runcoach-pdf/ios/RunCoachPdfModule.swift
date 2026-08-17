import ExpoModulesCore
import PDFKit

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
  }
}
