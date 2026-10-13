import Foundation

@main struct ModelCatalogTests {
    static var checks = 0
    static func check(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
        guard try condition() else { throw NSError(domain: "ModelCatalogTests", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
        checks += 1
    }
    static func rejects(_ action: () throws -> Void) throws {
        do { try action() } catch { checks += 1; return }
        throw NSError(domain: "ModelCatalogTests", code: 1, userInfo: [NSLocalizedDescriptionKey: "Expected invalid catalog rejection"])
    }
    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("meeting-catalog-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = ModelCatalogStore(dataDirectory: root)
        try check(try store.load("codex") == nil, "Missing cache should not invent a catalog")
        try check(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty, "Read must not create cache files")
        let entry = ModelCatalogEntry(id: "future-model", displayName: "Future Model", inputModalities: ["text", "image"])
        let snapshot = ModelCatalogSnapshot(source: "codex", fetchedAt: Date(), models: [entry], origin: "runtime")
        try store.save(snapshot)
        let loaded = try store.load("codex")!
        try check(loaded.models == snapshot.models && loaded.fetchedAt == snapshot.fetchedAt, "Cache should preserve actual IDs, modalities and read time")
        try check(loaded.origin == "runtime" && !loaded.includesPublishedModels, "A runtime-only catalog must not become published metadata after reload")
        try check(ModelCatalogSnapshot(source: "claude", fetchedAt: Date(), models: [entry], origin: "combined").includesPublishedModels, "Published catalogs must survive a temporary published-source outage")
        let file = root.appendingPathComponent("settings/model-catalogs/codex.json")
        let original = try Data(contentsOf: file)
        let mode = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber
        try check(mode?.intValue == 0o600, "Catalog cache should be owner-readable only")
        for bad in [
            ModelCatalogSnapshot(source: "../escape", fetchedAt: Date(), models: [entry]),
            ModelCatalogSnapshot(source: "codex", fetchedAt: Date(), models: []),
            ModelCatalogSnapshot(source: "codex", fetchedAt: Date(), models: [entry, entry]),
            ModelCatalogSnapshot(source: "codex", fetchedAt: Date(), models: [entry], origin: "unknown-source"),
            ModelCatalogSnapshot(source: "codex", fetchedAt: Date().addingTimeInterval(600), models: [entry]),
            ModelCatalogSnapshot(source: "codex", fetchedAt: Date(), models: [.init(id: "bad\nmodel", displayName: "Model", inputModalities: [])])
        ] { try rejects { try store.save(bad) } }
        try check(try Data(contentsOf: file) == original, "Rejected updates must retain the last valid catalog")
        try rejects { _ = try store.load("../../outside") }
        try Data("invalid cache".utf8).write(to: file)
        try rejects { _ = try store.load("codex") }
        try check(try String(contentsOf: file, encoding: .utf8) == "invalid cache", "Malformed cache should remain untouched")
        try original.write(to: file)
        let redirected = root.appendingPathComponent("redirected")
        try FileManager.default.createDirectory(at: redirected, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: redirected.appendingPathComponent("settings"), withDestinationURL: root.appendingPathComponent("settings"))
        let unsafe = ModelCatalogStore(dataDirectory: redirected)
        try rejects { _ = try unsafe.load("codex") }
        try rejects { try unsafe.save(snapshot) }
        try check(try Data(contentsOf: file) == original, "Symlink rejection must leave existing catalogs alone")
        print("Model catalog: \(checks) checks passed; temporary fixtures only.")
    }
}
