import ExpoModulesCore
import PDFKit
import Vision
import UIKit
import VisionKit
import AVFoundation

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

    // LIVE product-barcode scanner: Apple's VisionKit DataScannerViewController (iOS 16+, no camera library).
    // Point the camera at the barcode → resolves with its digits as soon as one is recognised; nil on Cancel.
    // Resolves "unsupported" when the device/OS can't run it (caller falls back to the photo path / typed digits).
    AsyncFunction("scanBarcodeLive") { (promise: Promise) in
      Task { @MainActor [weak self] in
        guard #available(iOS 16.0, *) else { promise.resolve("unsupported"); return }
        guard DataScannerViewController.isSupported else { promise.resolve("unsupported"); return }
        // isAvailable is false until camera access is GRANTED — ask first (the system prompt, once), then check.
        if AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined {
          _ = await AVCaptureDevice.requestAccess(for: .video)
        }
        guard DataScannerViewController.isAvailable else { promise.resolve("unavailable"); return }   // camera denied / restricted
        guard let top = Self.topViewController() else { promise.resolve("unsupported"); return }
        let scanner = LiveBarcodeScanner { code in
          self?.liveScanner = nil
          promise.resolve(code)
        }
        self?.liveScanner = scanner
        scanner.present(from: top)
      }
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

  // Live scanner state: the presented scanner + its delegate must stay alive until it resolves.
  private var liveScanner: AnyObject?          // a LiveBarcodeScanner (iOS 16+); AnyObject keeps the class iOS 15-safe

  @MainActor private static func topViewController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let root = scenes.flatMap { $0.windows }.first { $0.isKeyWindow }?.rootViewController
      ?? scenes.first?.windows.first?.rootViewController
    var top = root
    while let presented = top?.presentedViewController, !presented.isBeingDismissed { top = presented }
    return top
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


/// Presents VisionKit's live scanner for product barcodes in a nav controller with a Cancel button and resolves
/// exactly once: the first recognised EAN/UPC payload, or nil when cancelled / dismissed.
@available(iOS 16.0, *)
@MainActor
final class LiveBarcodeScanner: NSObject, DataScannerViewControllerDelegate, UIAdaptivePresentationControllerDelegate {
  private let done: (String?) -> Void
  private var finished = false
  private weak var nav: UINavigationController?
  private var scanner: DataScannerViewController?

  init(done: @escaping (String?) -> Void) { self.done = done }

  func present(from top: UIViewController) {
    let vc = DataScannerViewController(
      recognizedDataTypes: [.barcode(symbologies: [.ean13, .ean8, .upce])],
      qualityLevel: .balanced, recognizesMultipleItems: false,
      isHighFrameRateTrackingEnabled: false, isPinchToZoomEnabled: true,
      isGuidanceEnabled: true, isHighlightingEnabled: true)
    vc.delegate = self
    vc.title = "Scan barcode"
    vc.navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .cancel, target: self, action: #selector(cancel))
    let nav = UINavigationController(rootViewController: vc)
    nav.modalPresentationStyle = .fullScreen
    nav.presentationController?.delegate = self
    self.nav = nav; self.scanner = vc
    top.present(nav, animated: true) { [weak self] in
      do { try vc.startScanning() } catch { self?.finish("unavailable") }   // never leave a frozen camera behind
    }
    // present() silently does nothing if `top` is mid-transition → resolve instead of hanging the Scan button
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
      guard let self, !self.finished, self.nav?.presentingViewController == nil else { return }
      self.finish("unsupported")
    }
  }

  private func finish(_ code: String?) {
    guard !finished else { return }
    finished = true
    scanner?.stopScanning()
    let cb = done
    if let nav = nav, nav.presentingViewController != nil { nav.dismiss(animated: true) { cb(code) } } else { cb(code) }
  }

  @objc private func cancel() { finish(nil) }
  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { finish(nil) }

  func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
    for item in addedItems {
      if case .barcode(let b) = item, let p = b.payloadStringValue, !p.isEmpty {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        finish(p); return
      }
    }
  }
  func dataScanner(_ dataScanner: DataScannerViewController, becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) {
    finish("unavailable")                                  // camera became unavailable → the app explains it
  }
}
