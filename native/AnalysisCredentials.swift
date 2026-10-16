import Foundation
import Security
import CryptoKit
import Darwin

enum AnalysisCredentialError: Error, LocalizedError {
    case invalidScope, invalidKey, missing, unavailable, trustUnavailable, interactionRequired, userCancelled
    var code: String {
        switch self {
        case .invalidScope: return "credential_scope"
        case .invalidKey: return "credential_invalid"
        case .missing: return "credential_missing"
        case .unavailable: return "keychain_unavailable"
        case .trustUnavailable: return "credential_helper_trust"
        case .interactionRequired: return "keychain_authorization_required"
        case .userCancelled: return "keychain_cancelled"
        }
    }
    static func from(_ status: OSStatus) -> AnalysisCredentialError {
        switch status {
        case errSecItemNotFound: return .missing
        case errSecInteractionNotAllowed, errSecAuthFailed: return .interactionRequired
        case errSecUserCanceled: return .userCancelled
        default: return .unavailable
        }
    }
    var errorDescription: String? {
        switch self {
        case .invalidScope: return "Choose a supported provider and authentication method, with a valid endpoint where required."
        case .invalidKey: return "Enter an API key or Claude Code token without spaces or control characters (maximum 8 KB)."
        case .missing: return "No credential is saved for this task, provider, authentication, and endpoint. Save it in Settings → Analysis."
        case .unavailable: return "Keychain access failed. Unlock your login Keychain, then save the credential again in Settings → Analysis."
        case .trustUnavailable: return "The app's credential helper could not be trusted. Reinstall the complete app before saving a credential."
        case .interactionRequired: return "Keychain needs authorization for this version of MinuteShelf. Unlock your login Keychain, then choose Authorize Access in Settings → Analysis."
        case .userCancelled: return "Keychain authorization was cancelled. Your saved credential was preserved."
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
    func authorize(_ scope: AnalysisCredentialScope) throws
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
    func authorize(_ scope: AnalysisCredentialScope) throws { try backend.authorize(scope) }
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
        guard code == errSecSuccess else { throw AnalysisCredentialError.from(code) }; return true
    }
    func read(_ scope: AnalysisCredentialScope) throws -> Data {
        var request = query(scope); request[kSecReturnData as String] = true; request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let code = SecItemCopyMatching(request as CFDictionary, &result)
        guard code == errSecSuccess else { throw AnalysisCredentialError.from(code) }
        guard let data = result as? Data else { throw AnalysisCredentialError.unavailable }; return data
    }
    private func access() throws -> SecAccess {
        let bundle = Bundle.main.bundleURL
        guard bundle.pathExtension == "app", let mainExecutable = Bundle.main.executableURL else { throw AnalysisCredentialError.trustUnavailable }
        var applications: [SecTrustedApplication] = []
        for url in [mainExecutable] {
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
        // The background reader is this same signed executable. Never grant
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
            let added = SecItemAdd(request as CFDictionary, nil)
            guard added == errSecSuccess else { throw AnalysisCredentialError.from(added) }
        } else if updated != errSecSuccess { throw AnalysisCredentialError.from(updated) }
    }
    func delete(_ scope: AnalysisCredentialScope) throws {
        var request = query(scope); request[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIAllow
        let code = SecItemDelete(request as CFDictionary)
        guard code == errSecSuccess || code == errSecItemNotFound else { throw AnalysisCredentialError.from(code) }
    }
    func authorize(_ scope: AnalysisCredentialScope) throws {
        // Only the visible app may initiate this user-requested repair. Keep
        // the value in memory and restore trust to this app and its helper.
        _ = try access()
        var request = query(scope); request[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIAllow
        request[kSecReturnData as String] = true; request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let code = SecItemCopyMatching(request as CFDictionary, &result)
        guard code == errSecSuccess else { throw AnalysisCredentialError.from(code) }
        guard let data = result as? Data else { throw AnalysisCredentialError.unavailable }
        try save(data, scope: scope)
    }
}

struct AnalysisCredentialStatus: Decodable {
    let stored: Bool
    let readable: Bool
    let errorCode: String?
}

enum AnalysisCredentialProbe {
    static func status(_ scope: AnalysisCredentialScope, dataDirectory: URL) async throws -> AnalysisCredentialStatus {
        let executable = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/node")
        let module = Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/runtime/server/analysis-settings.js")
        // Exercise the exact backend -> reader route, returning status only.
        let script = "const r=JSON.parse(require('node:fs').readFileSync(0,'utf8'));require(process.argv[1]).readCredential({operation:'status',dataDirectory:r.dataDirectory,config:r}).then(v=>process.stdout.write(JSON.stringify(v))).catch(()=>{process.exitCode=1;});"
        let input = try JSONSerialization.data(withJSONObject: ["operation":"status", "dataDirectory":dataDirectory.path,
            "task":scope.task, "provider":scope.provider, "authentication":scope.authentication,
            "endpoint":scope.provider == "claude-agent-sdk" ? "" : scope.endpoint])
        return try await Task.detached(priority: .utility) {
            let child = Process(), stdin = Pipe(), stdout = Pipe()
            child.executableURL = executable; child.arguments = ["-e", script, module.path]; child.environment = ["PATH":"/usr/bin:/bin"]
            child.standardInput = stdin; child.standardOutput = stdout; child.standardError = FileHandle.nullDevice
            do { try child.run() } catch { throw AnalysisCredentialError.trustUnavailable }
            let timeout = DispatchWorkItem {
                if child.isRunning { child.terminate() }
                DispatchQueue.global().asyncAfter(deadline: .now() + 1) { if child.isRunning { kill(child.processIdentifier, SIGKILL) } }
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + 10, execute: timeout)
            defer {
                timeout.cancel(); try? stdin.fileHandleForWriting.close(); try? stdout.fileHandleForReading.close()
                if child.isRunning { child.terminate() }
            }
            try stdin.fileHandleForWriting.write(contentsOf: input); try stdin.fileHandleForWriting.close()
            child.waitUntilExit()
            let data = stdout.fileHandleForReading.readDataToEndOfFile()
            guard child.terminationStatus == 0, data.count <= 16384,
                  let value = try? JSONDecoder().decode(AnalysisCredentialStatus.self, from: data) else { throw AnalysisCredentialError.unavailable }
            return value
        }.value
    }
}

// The visible app and noninteractive reader use the same code identity.
// Separate ad-hoc helpers can fail Keychain authorization after an update.
enum AnalysisCredentialCommand {
    private static func codeMatches(_ pid: pid_t, executable: URL) -> Bool {
        var expected: SecStaticCode?, requirement: SecRequirement?, running: SecCode?
        guard SecStaticCodeCreateWithPath(executable as CFURL, [], &expected) == errSecSuccess, let expected,
              SecCodeCopyDesignatedRequirement(expected, [], &requirement) == errSecSuccess, let requirement,
              SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid: NSNumber(value: pid)] as CFDictionary, [], &running) == errSecSuccess,
              let running else { return false }
        return SecCodeCheckValidity(running, [], requirement) == errSecSuccess
    }
    private static func parent(of pid: pid_t) -> pid_t? {
        var info = kinfo_proc(), size = MemoryLayout<kinfo_proc>.size
        var query: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&query, u_int(query.count), &info, &size, nil, 0) == 0, size > 0 else { return nil }
        return info.kp_eproc.e_ppid
    }
    private static func trustedCaller() -> Bool {
        var bundle = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.resolvingSymlinksInPath()
        while bundle.pathExtension != "app" && bundle.path != "/" { bundle.deleteLastPathComponent() }
        guard bundle.pathExtension == "app" else { return false }
        let main = bundle.appendingPathComponent("Contents/MacOS/MeetingArchive"), caller = getppid()
        if codeMatches(caller, executable: main) { return true }
        // A signed interpreter alone is not enough: the bundled Node must
        // itself have been launched by this app, not an unrelated local script.
        guard codeMatches(caller, executable: bundle.appendingPathComponent("Contents/Helpers/node")),
              let owner = parent(of: caller) else { return false }
        return codeMatches(owner, executable: main)
    }
    private struct Request: Decodable {
        let operation: String?
        let dataDirectory: String
        let task: String
        let provider: String
        let endpoint: String
        let authentication: String
    }
    static func run(arguments: [String]) {
        // kSecUseAuthenticationUI is not sufficient for every legacy Keychain
        // operation. This isolated reader must never spawn a hidden prompt.
        SecKeychainSetUserInteractionAllowed(false)
        do {
            // Secrets must only travel through the private child-process pipe,
            // never command arguments, environment, browser routes, or a TTY.
            func isPrivatePipe(_ descriptor: Int32) -> Bool {
                var info = stat()
                guard fstat(descriptor, &info) == 0 else { return false }
                let kind = info.st_mode & mode_t(S_IFMT)
                return kind == mode_t(S_IFIFO) || kind == mode_t(S_IFSOCK)
            }
            guard Array(CommandLine.arguments.dropFirst()) == arguments, isPrivatePipe(STDIN_FILENO), isPrivatePipe(STDOUT_FILENO), trustedCaller() else { throw AnalysisCredentialError.invalidScope }
            var input = Data()
            while let chunk = try FileHandle.standardInput.read(upToCount: 4096), !chunk.isEmpty {
                input.append(chunk); guard input.count <= 32768 else { throw AnalysisCredentialError.invalidScope }
            }
            let request = try JSONDecoder().decode(Request.self, from: input)
            guard request.dataDirectory.hasPrefix("/") else { throw AnalysisCredentialError.invalidScope }
            let scope = try AnalysisCredentialScope(dataDirectory: URL(fileURLWithPath: request.dataDirectory), task: request.task, provider: request.provider, endpoint: request.endpoint, authentication: request.authentication)
            let store = AnalysisCredentialStore()
            let result: [String: Any]
            switch request.operation ?? "read" {
            case "read": result = ["key": try store.read(scope)]
            case "status":
                let stored = try store.contains(scope)
                var status: [String: Any] = ["stored": stored, "readable": false]
                if stored {
                    do { _ = try store.read(scope); status["readable"] = true }
                    catch { status["errorCode"] = (error as? AnalysisCredentialError ?? .unavailable).code }
                }
                result = status
            default: throw AnalysisCredentialError.invalidScope
            }
            var data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]); data.append(0x0a)
            try FileHandle.standardOutput.write(contentsOf: data)
        } catch {
            let failure = error as? AnalysisCredentialError ?? .unavailable
            if let data = try? JSONSerialization.data(withJSONObject: ["error": ["code":failure.code]]) {
                try? FileHandle.standardOutput.write(contentsOf: data)
            }
            let message = failure.localizedDescription
            try? FileHandle.standardError.write(contentsOf: Data((message + "\n").utf8)); exit(1)
        }
    }
}
