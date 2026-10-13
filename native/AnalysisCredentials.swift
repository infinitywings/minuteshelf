import Foundation
import Security
import CryptoKit

enum AnalysisCredentialError: Error, LocalizedError {
    case invalidScope, invalidKey, missing, unavailable, trustUnavailable
    var errorDescription: String? {
        switch self {
        case .invalidScope: return "Choose a supported provider and authentication method, with a valid endpoint where required."
        case .invalidKey: return "Enter an API key or Claude Code token without spaces or control characters (maximum 8 KB)."
        case .missing: return "No credential is saved for this task, provider, authentication, and endpoint. Save it in Settings → Analysis."
        case .unavailable: return "Keychain access failed. Unlock your login Keychain, then save the credential again in Settings → Analysis."
        case .trustUnavailable: return "The app's credential helper could not be trusted. Reinstall the complete app before saving a credential."
        }
    }
}

struct AnalysisCredentialScope: Equatable {
    // Stable storage identity: rebranding must not disconnect saved credentials.
    static let service = "org.meetingarchive.analysis-api-key.v1"
    let account: String
    let endpoint: String
    let task: String
    let provider: String
    let authentication: String
    init(dataDirectory: URL, task: String, provider: String, endpoint: String, authentication: String) throws {
        guard dataDirectory.isFileURL, dataDirectory.path.hasPrefix("/"),
              ["transcription", "vision", "summary"].contains(task),
              ["stt-api", "openai-compatible", "anthropic-api", "local-service", "claude-agent-sdk"].contains(provider),
              (task == "transcription") == (provider == "stt-api") else { throw AnalysisCredentialError.invalidScope }
        guard authentication == "api-key" || (provider == "claude-agent-sdk" && authentication == "claude-code-oauth-token") else { throw AnalysisCredentialError.invalidScope }
        let text = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        let canonicalEndpoint: String
        if provider == "claude-agent-sdk" {
            guard text.isEmpty else { throw AnalysisCredentialError.invalidScope }
            canonicalEndpoint = "claude-code-official-runtime"
        } else {
        guard text.utf8.count <= 2048,
              !text.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.contains($0) || CharacterSet.controlCharacters.contains($0) }),
              var parts = URLComponents(string: text), let scheme = parts.scheme?.lowercased(), ["https", "http"].contains(scheme),
              let host = parts.host?.lowercased(), !host.isEmpty, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil, parts.port.map({ (1...65535).contains($0) }) != false else { throw AnalysisCredentialError.invalidScope }
        let ip = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        let octets = ip.split(separator: ".", omittingEmptySubsequences: false)
        let loopback = ip == "localhost" || ip == "::1" || (octets.count == 4 && octets[0] == "127" && octets.allSatisfy { !$0.isEmpty && $0.allSatisfy(\.isNumber) && Int($0).map { (0...255).contains($0) } == true })
        guard scheme == "https" || loopback, provider != "local-service" || loopback else { throw AnalysisCredentialError.invalidScope }
        parts.scheme = scheme; parts.host = host
        if parts.port == (scheme == "https" ? 443 : 80) { parts.port = nil }
        while parts.path.hasSuffix("/") { parts.path.removeLast() }
        guard let parsedEndpoint = parts.string else { throw AnalysisCredentialError.invalidScope }
        canonicalEndpoint = parsedEndpoint
        }
        let directory = dataDirectory.standardizedFileURL.resolvingSymlinksInPath().path
        guard directory.utf8.count <= 16384, !directory.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw AnalysisCredentialError.invalidScope }
        // Length-delimited JSON avoids scope collisions. The directory isn't
        // exposed in the Keychain item label or account name.
        let input = try JSONEncoder().encode(["v1", directory, task, provider, authentication, canonicalEndpoint])
        account = SHA256.hash(data: input).map { String(format: "%02x", $0) }.joined()
        self.endpoint = canonicalEndpoint; self.task = task; self.provider = provider; self.authentication = authentication
    }
}

protocol AnalysisCredentialBackend {
    func contains(_ scope: AnalysisCredentialScope) throws -> Bool
    func read(_ scope: AnalysisCredentialScope) throws -> Data
    func save(_ data: Data, scope: AnalysisCredentialScope) throws
    func delete(_ scope: AnalysisCredentialScope) throws
}

struct AnalysisCredentialStore {
    var backend: any AnalysisCredentialBackend = AnalysisKeychainBackend()
    func contains(_ scope: AnalysisCredentialScope) throws -> Bool { try backend.contains(scope) }
    func read(_ scope: AnalysisCredentialScope) throws -> String {
        guard let key = String(data: try backend.read(scope), encoding: .utf8) else { throw AnalysisCredentialError.unavailable }
        try Self.validate(key); return key
    }
    func save(_ key: String, scope: AnalysisCredentialScope) throws { try Self.validate(key); try backend.save(Data(key.utf8), scope: scope) }
    func delete(_ scope: AnalysisCredentialScope) throws { try backend.delete(scope) }
    static func validate(_ key: String) throws {
        guard !key.isEmpty, key.utf8.count <= 8192, key.unicodeScalars.allSatisfy({ (0x21...0x7e).contains($0.value) }) else { throw AnalysisCredentialError.invalidKey }
    }
}

struct AnalysisKeychainBackend: AnalysisCredentialBackend {
    // Tests can select a temporary keychain without modifying the login
    // keychain, its search list, or the user's default keychain.
    var keychain: SecKeychain? = nil
    private func query(_ scope: AnalysisCredentialScope) -> [String: Any] {
        var value: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: AnalysisCredentialScope.service,
         kSecAttrAccount as String: scope.account, kSecUseDataProtectionKeychain as String: false,
         kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail]
        if let keychain { value[kSecMatchSearchList as String] = [keychain] }
        return value
    }
    func contains(_ scope: AnalysisCredentialScope) throws -> Bool {
        var request = query(scope); request[kSecMatchLimit as String] = kSecMatchLimitOne
        let code = SecItemCopyMatching(request as CFDictionary, nil)
        if code == errSecItemNotFound { return false }
        guard code == errSecSuccess else { throw AnalysisCredentialError.unavailable }; return true
    }
    func read(_ scope: AnalysisCredentialScope) throws -> Data {
        var request = query(scope); request[kSecReturnData as String] = true; request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let code = SecItemCopyMatching(request as CFDictionary, &result)
        if code == errSecItemNotFound { throw AnalysisCredentialError.missing }
        guard code == errSecSuccess, let data = result as? Data else { throw AnalysisCredentialError.unavailable }; return data
    }
    private func access() throws -> SecAccess {
        let bundle = Bundle.main.bundleURL
        guard bundle.pathExtension == "app", let mainExecutable = Bundle.main.executableURL else { throw AnalysisCredentialError.trustUnavailable }
        let helper = bundle.appendingPathComponent("Contents/Helpers/analysis-credentials")
        var applications: [SecTrustedApplication] = []
        for url in [mainExecutable, helper] {
            guard FileManager.default.isExecutableFile(atPath: url.path) else { throw AnalysisCredentialError.trustUnavailable }
            var application: SecTrustedApplication?
            guard SecTrustedApplicationCreateFromPath(url.path, &application) == errSecSuccess, let application else { throw AnalysisCredentialError.trustUnavailable }
            applications.append(application)
        }
        var access: SecAccess?
        guard SecAccessCreate("MinuteShelf API credentials" as CFString, applications as CFArray, &access) == errSecSuccess, let access else { throw AnalysisCredentialError.trustUnavailable }
        return access
    }
    func save(_ data: Data, scope: AnalysisCredentialScope) throws {
        // Give only the signed app and its bundled reader access. Never grant
        // an empty/all-applications ACL to work around local signing changes.
        let trustedAccess = try access()
        var request = query(scope); request[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIAllow
        let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccess as String: trustedAccess]
        let updated = SecItemUpdate(request as CFDictionary, attributes as CFDictionary)
        if updated == errSecItemNotFound {
            request.removeValue(forKey: kSecUseAuthenticationUI as String)
            request.removeValue(forKey: kSecMatchSearchList as String)
            if let keychain { request[kSecUseKeychain as String] = keychain }
            request.merge(attributes) { _, new in new }
            request[kSecAttrLabel as String] = "MinuteShelf · \(scope.task) · \(scope.provider)"
            guard SecItemAdd(request as CFDictionary, nil) == errSecSuccess else { throw AnalysisCredentialError.unavailable }
        } else if updated != errSecSuccess { throw AnalysisCredentialError.unavailable }
    }
    func delete(_ scope: AnalysisCredentialScope) throws {
        var request = query(scope); request[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIAllow
        let code = SecItemDelete(request as CFDictionary)
        guard code == errSecSuccess || code == errSecItemNotFound else { throw AnalysisCredentialError.unavailable }
    }
}
