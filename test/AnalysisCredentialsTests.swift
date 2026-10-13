import Foundation

private final class MemoryCredentialBackend: AnalysisCredentialBackend {
    var data: [String: Data] = [:]
    var reads = 0
    func contains(_ scope: AnalysisCredentialScope) throws -> Bool { data[scope.account] != nil }
    func read(_ scope: AnalysisCredentialScope) throws -> Data { reads += 1; guard let value = data[scope.account] else { throw AnalysisCredentialError.missing }; return value }
    func save(_ value: Data, scope: AnalysisCredentialScope) throws { data[scope.account] = value }
    func delete(_ scope: AnalysisCredentialScope) throws { data.removeValue(forKey: scope.account) }
}

@main struct AnalysisCredentialsTests {
    static var checks = 0
    static func check(_ value: @autoclosure () throws -> Bool, _ message: String) throws {
        guard try value() else { throw NSError(domain: "CredentialTests", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }; checks += 1
    }
    static func rejects(_ body: () throws -> Void) throws {
        do { try body() } catch { checks += 1; return }
        throw NSError(domain: "CredentialTests", code: 1, userInfo: [NSLocalizedDescriptionKey: "Expected rejection"])
    }
    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("credential-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: root) }
        func scope(_ task: String = "vision", _ provider: String = "anthropic-api", _ endpoint: String = "https://api.anthropic.com/v1", _ auth: String = "api-key", _ directory: URL? = nil) throws -> AnalysisCredentialScope {
            try AnalysisCredentialScope(dataDirectory: directory ?? root, task: task, provider: provider, endpoint: endpoint, authentication: auth)
        }
        let first = try scope()
        try check(first == scope("vision", "anthropic-api", "https://API.ANTHROPIC.COM:443/v1/"), "Canonical endpoint should share a credential")
        try check(first.account != scope("summary").account, "Tasks must be isolated")
        try check(first.account != scope("vision", "openai-compatible").account, "Providers must be isolated")
        try check(first.account != scope("vision", "anthropic-api", "https://other.example/v1").account, "Hosts must be isolated")
        try check(first.account != scope("vision", "anthropic-api", "https://api.anthropic.com/other").account, "Paths must be isolated")
        try check(first.account != scope("vision", "anthropic-api", "https://api.anthropic.com/v1", "api-key", root.appendingPathComponent("other")).account, "Data directories must be isolated")
        let link = root.appendingPathComponent("alias")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: root)
        try check(first == scope("vision", "anthropic-api", "https://api.anthropic.com/v1", "api-key", link), "Resolved same data directory should share a key")
        let oauth = try scope("summary", "claude-agent-sdk", "", "claude-code-oauth-token")
        let api = try scope("summary", "claude-agent-sdk", "", "api-key")
        try check(oauth.account != api.account, "OAuth token must never be read as an API key")
        for endpoint in ["", "http://remote.example/v1", "https://user:secret@host.test", "https://host.test?key=secret", "https://host.test/#x", "https://host.test:0", "https://host.test/space here", "http://127.999.0.1"] {
            try rejects { _ = try scope("vision", "anthropic-api", endpoint) }
        }
        try rejects { _ = try scope("vision", "anthropic-api", "https://api.anthropic.com/v1", "claude-code-oauth-token") }
        try rejects { _ = try scope("transcription") }
        try rejects { _ = try scope("summary", "stt-api") }
        try rejects { _ = try scope("summary", "claude-agent-sdk", "https://proxy.example", "claude-code-oauth-token") }
        try rejects { _ = try scope("summary", "local-service", "https://remote.example") }
        _ = try scope("transcription", "stt-api", "https://speech.example/v1"); checks += 1
        _ = try scope("vision", "local-service", "http://[::1]:11434"); checks += 1
        let memory = MemoryCredentialBackend(), store = AnalysisCredentialStore(backend: MemoryCredentialBackend())
        let isolated = AnalysisCredentialStore(backend: memory)
        try check(!isolated.contains(first), "Missing key status")
        try isolated.save("test-synthetic-secret", scope: first)
        try check(isolated.contains(first), "Saved key status")
        try check(memory.reads == 0, "Status must never retrieve credential contents")
        try check(isolated.read(first) == "test-synthetic-secret", "Saved key round trip")
        try rejects { _ = try isolated.read(oauth) }
        try check(!store.contains(first), "Isolated storage")
        try isolated.save("replacement-synthetic-secret", scope: first)
        try check(isolated.read(first) == "replacement-synthetic-secret", "Updating changes exactly selected key")
        for key in ["", " key ", "key\n", "key\0", String(repeating: "x", count: 8193), "密钥"] {
            try rejects { try isolated.save(key, scope: first) }
        }
        try check(isolated.read(first) == "replacement-synthetic-secret", "Invalid key cannot overwrite previous key")
        try isolated.delete(first); try isolated.delete(first)
        try check(!isolated.contains(first), "Delete is idempotent")
        try check(first.account.count == 64 && !first.account.contains(root.lastPathComponent), "Keychain scope hides private directory")
        print("Analysis credentials: \(checks) checks passed; synthetic in-memory secrets only; no Keychain accessed.")
    }
}
