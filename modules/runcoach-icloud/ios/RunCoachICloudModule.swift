import ExpoModulesCore
import Foundation

/// Minimal bridge to the app's iCloud **ubiquity Documents container** — the user's own private, encrypted
/// iCloud space. We store ONE file (the same JSON `exportAllSettings` already produces) so a fresh install on
/// a new phone can pull it back with no manual export/import. Reads are NSFileCoordinator-coordinated so a
/// not-yet-downloaded file is fetched before we read it. Everything returns a result dictionary rather than
/// throwing, so the JS side degrades to "iCloud unavailable" instead of crashing when the user isn't signed
/// into iCloud (or on a build where the entitlement isn't provisioned yet).
public class RunCoachICloudModule: Module {
  private func container() -> URL? {
    FileManager.default.url(forUbiquityContainerIdentifier: nil)   // nil = first configured container
  }
  private func docURL(_ name: String) -> URL? {
    guard let base = container() else { return nil }
    let docs = base.appendingPathComponent("Documents", isDirectory: true)
    try? FileManager.default.createDirectory(at: docs, withIntermediateDirectories: true)
    return docs.appendingPathComponent(name)
  }

  public func definition() -> ModuleDefinition {
    Name("RunCoachICloud")

    // Is an iCloud container reachable? (User signed into iCloud + entitlement provisioned.)
    Function("available") { () -> Bool in
      self.container() != nil
    }

    // Overwrite the single backup file. Returns { ok, modifiedAt } (ISO8601) or { ok:false, error }.
    AsyncFunction("writeBackup") { (name: String, contents: String) -> [String: Any] in
      guard let fileURL = self.docURL(name) else { return ["ok": false, "error": "iCloud unavailable"] }
      var failure: String?
      var savedAt = ""
      var coordErr: NSError?
      NSFileCoordinator().coordinate(writingItemAt: fileURL, options: .forReplacing, error: &coordErr) { url in
        do {
          try (contents.data(using: .utf8) ?? Data()).write(to: url, options: .atomic)
          if let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
             let d = attrs[.modificationDate] as? Date { savedAt = ISO8601DateFormatter().string(from: d) }
        } catch { failure = error.localizedDescription }
      }
      if let e = coordErr?.localizedDescription ?? failure { return ["ok": false, "error": e] }
      return ["ok": true, "modifiedAt": savedAt]
    }

    // Read the backup file, downloading it from iCloud first if it isn't local yet. Returns
    // { contents, modifiedAt } — contents is nil when there's no backup or iCloud is unavailable.
    AsyncFunction("readBackup") { (name: String) -> [String: Any?] in
      guard let fileURL = self.docURL(name) else { return ["contents": nil, "error": "iCloud unavailable"] }
      try? FileManager.default.startDownloadingUbiquitousItem(at: fileURL)   // no-op if already local
      var result: [String: Any?] = ["contents": nil]
      var coordErr: NSError?
      NSFileCoordinator().coordinate(readingItemAt: fileURL, options: [], error: &coordErr) { url in
        guard let data = try? Data(contentsOf: url), let s = String(data: data, encoding: .utf8) else { return }
        var modifiedAt = ""
        if let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
           let d = attrs[.modificationDate] as? Date { modifiedAt = ISO8601DateFormatter().string(from: d) }
        result = ["contents": s, "modifiedAt": modifiedAt]
      }
      return result
    }
  }
}
