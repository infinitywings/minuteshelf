import Foundation
import Darwin

struct ModelCatalogEntry: Codable, Equatable {
    let id: String
    let displayName: String
    let inputModalities: [String]
}

struct ModelCatalogSnapshot: Codable {
    let source: String
    let fetchedAt: Date
    let models: [ModelCatalogEntry]
    var origin: String? = nil
    var includesPublishedModels: Bool { origin == "published" || origin == "combined" }

    func validated() throws -> Self {
        guard ["codex", "claude"].contains(source), !models.isEmpty, models.count <= 2000,
              fetchedAt.timeIntervalSince1970.isFinite,
              fetchedAt <= Date().addingTimeInterval(300),
              origin == nil || ["published", "runtime", "combined"].contains(origin!) else { throw ModelCatalogError.invalid }
        var seen = Set<String>()
        for model in models {
            guard !model.id.isEmpty, model.id.count <= 500, model.displayName.count <= 500,
                  model.inputModalities.count <= 10,
                  ([model.id, model.displayName] + model.inputModalities).allSatisfy({ value in
                      !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
                  }), seen.insert(model.id).inserted else { throw ModelCatalogError.invalid }
        }
        return self
    }
}

enum ModelCatalogError: LocalizedError {
    case invalid, storage
    var errorDescription: String? {
        switch self {
        case .invalid: return "The model list was empty or invalid. Your saved selection is unchanged."
        case .storage: return "The model list could not be cached on this Mac."
        }
    }
}

struct ModelCatalogStore {
    let dataDirectory: URL
    private var directory: URL { dataDirectory.appendingPathComponent("settings/model-catalogs", isDirectory: true) }

    private func file(for source: String) throws -> URL {
        guard ["codex", "claude"].contains(source) else { throw ModelCatalogError.invalid }
        // Never follow redirects within this app-owned cache namespace.
        for path in [dataDirectory.appendingPathComponent("settings"), directory] {
            if let type = try? FileManager.default.attributesOfItem(atPath: path.path)[.type] as? FileAttributeType,
               type != .typeDirectory { throw ModelCatalogError.storage }
        }
        return directory.appendingPathComponent(source + ".json")
    }

    func load(_ source: String) throws -> ModelCatalogSnapshot? {
        let url = try file(for: source), manager = FileManager.default
        guard manager.fileExists(atPath: url.path) else { return nil }
        let attributes = try manager.attributesOfItem(atPath: url.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              (attributes[.size] as? NSNumber)?.intValue ?? Int.max <= 1_048_576 else { throw ModelCatalogError.storage }
        let snapshot = try JSONDecoder().decode(ModelCatalogSnapshot.self, from: Data(contentsOf: url)).validated()
        guard snapshot.source == source else { throw ModelCatalogError.invalid }
        return snapshot
    }

    func save(_ snapshot: ModelCatalogSnapshot) throws {
        let value = try snapshot.validated(), url = try file(for: value.source), manager = FileManager.default
        try manager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        if manager.fileExists(atPath: url.path),
           try manager.attributesOfItem(atPath: url.path)[.type] as? FileAttributeType != .typeRegular { throw ModelCatalogError.storage }
        let data = try JSONEncoder().encode(value)
        guard data.count <= 1_048_576 else { throw ModelCatalogError.invalid }
        let temporary = directory.appendingPathComponent(".\(UUID().uuidString).tmp")
        defer { try? manager.removeItem(at: temporary) }
        guard manager.createFile(atPath: temporary.path, contents: data, attributes: [.posixPermissions: 0o600]) else { throw ModelCatalogError.storage }
        let handle = try FileHandle(forWritingTo: temporary); try handle.synchronize(); try handle.close()
        guard rename(temporary.path, url.path) == 0 else { throw ModelCatalogError.storage }
    }
}
