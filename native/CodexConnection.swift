import AppKit
import Foundation
import CoreFoundation
import Darwin

enum CodexConnectionState: String { case idle, checking, awaitingBrowser, connected, failed }

// Authentication and read-only catalog discovery. No thread, inference, or
// filesystem-tool methods are exposed. Codex owns OAuth and its Keychain entry.
enum CodexAuthProtocol {
    static let methods: Set<String> = ["initialize", "account/read", "account/login/start", "account/login/cancel", "account/logout", "model/list"]
    static func authorizationURL(_ text: String) -> URL? {
        guard text.utf8.count <= 16384, let parts = URLComponents(string: text),
              parts.scheme == "https", let host = parts.host?.lowercased(),
              ["auth.openai.com", "chatgpt.com"].contains(host),
              parts.user == nil, parts.password == nil, parts.fragment == nil,
              parts.port == nil || parts.port == 443,
              !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }
        return parts.url
    }
    static func displayText(_ value: Any?, limit: Int) -> String? {
        guard let text = value as? String, !text.isEmpty, text.count <= limit,
              !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }
        return text
    }
    static func boolean(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }
    static func environment(home: URL, temporary: URL, codexHome: URL) -> [String: String] {
        // In particular do not inherit API keys, tokens, provider overrides,
        // proxy credentials, DYLD settings, or the user's global CODEX_HOME.
        ["HOME": home.path, "USER": NSUserName(), "LOGNAME": NSUserName(),
         "TMPDIR": temporary.path, "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
         "LANG": "en_US.UTF-8", "CODEX_HOME": codexHome.path, "RUST_LOG": "off"]
    }
}

// This is a runtime catalog, not proof of account entitlement. `id` is the
// actual model value accepted by the runtime, not its separate picker row ID.
struct CodexModelDescriptor: Equatable {
    let id: String
    let displayName: String
    let inputModalities: [String]
}

private enum CodexConnectionError: LocalizedError {
    case unavailable, storage, launch, stopped, timeout, protocolError, rejected, browser, catalogBusy, catalogMalformed, catalogUnavailable
    var errorDescription: String? {
        switch self {
        case .unavailable: return "The bundled Codex runtime is missing. Reinstall MinuteShelf."
        case .storage: return "Codex needs a private local settings folder. Check this app's storage permissions."
        case .launch: return "Codex could not start. Reinstall MinuteShelf and try again."
        case .stopped: return "The Codex connection stopped. Try Connect Codex again."
        case .timeout: return "Codex did not respond in time. Check your connection and try again."
        case .protocolError: return "Codex returned an unexpected response. Reconnect or update MinuteShelf."
        case .rejected: return "Codex could not complete this request. Check your connection and macOS Keychain access, then retry."
        case .browser: return "The sign-in browser could not open. Use Open Browser to try again."
        case .catalogBusy: return "Wait for the current Codex account or model request to finish, then refresh models."
        case .catalogMalformed: return "Codex returned an invalid or incomplete model catalog. Try refreshing models again."
        case .catalogUnavailable: return "Codex could not refresh its model catalog. Try refreshing models again."
        }
    }
}

@MainActor final class CodexConnection {
    private(set) var state: CodexConnectionState = .idle
    private(set) var detail = "Not connected. Sign in with ChatGPT to connect your Codex subscription."
    private(set) var accountEmail: String?
    private(set) var planType: String?
    private(set) var isBusy = false
    var onChange: (() -> Void)?

    private let executable: URL
    private let dataRoot: URL
    let codexHome: URL
    private let openBrowser: (URL) -> Bool
    private let requestTimeout: Double
    private let loginTimeout: Double
    private var child: Process?
    private var input: Pipe?, output: Pipe?, errors: Pipe?
    private var buffer = Data()
    private var generation = UUID(), operation = UUID()
    private var nextID = 0
    private struct Pending {
        let continuation: CheckedContinuation<[String: Any], Error>
        let timer: Task<Void, Never>
    }
    private var pending: [String: Pending] = [:]
    private var loginID: String?, authURL: URL?
    private var earlyCompletions: [String: Bool] = [:]
    private var loginTimer: Task<Void, Never>?
    private var listingModels = false

    init(dataDirectory: URL, executableURL: URL? = nil,
         requestTimeoutSeconds: Double = 20, loginTimeoutSeconds: Double = 300,
         browserOpener: @escaping (URL) -> Bool = { NSWorkspace.shared.open($0) }) {
        executable = executableURL ?? Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/codex")
        dataRoot = dataDirectory.resolvingSymlinksInPath()
        codexHome = dataRoot.appendingPathComponent("connections/codex", isDirectory: true)
        requestTimeout = requestTimeoutSeconds; loginTimeout = loginTimeoutSeconds; openBrowser = browserOpener
    }

    func refresh() async {
        guard !isBusy, loginID == nil else { return }
        await run {
            let token = self.operation
            try await self.startIfNeeded()
            try self.ensureActive(token)
            let result = try await self.request("account/read", ["refreshToken": true])
            try self.ensureActive(token)
            try self.applyAccount(result)
        }
    }
    func connect() async {
        guard !isBusy, loginID == nil else { return }
        await run {
            let token = self.operation
            try await self.startIfNeeded()
            try self.ensureActive(token)
            let current = try await self.request("account/read", ["refreshToken": true])
            try self.ensureActive(token)
            if let account = current["account"] as? [String: Any], account["type"] as? String == "chatgpt" {
                try self.applyAccount(current); return
            }
            self.earlyCompletions.removeAll()
            let result = try await self.request("account/login/start", ["type": "chatgpt"])
            try self.ensureActive(token)
            guard result["type"] as? String == "chatgpt",
                  let id = CodexAuthProtocol.displayText(result["loginId"], limit: 256),
                  let raw = result["authUrl"] as? String, let url = CodexAuthProtocol.authorizationURL(raw) else {
                // Terminating our helper closes any callback created by a
                // malformed response. Never open an unvalidated destination.
                self.closeProcess(); throw CodexConnectionError.protocolError
            }
            self.loginID = id; self.authURL = url
            self.state = .awaitingBrowser
            self.detail = "Finish signing in to ChatGPT in your browser. This connects your account; it does not upload meeting content."
            if let success = self.earlyCompletions.removeValue(forKey: id) {
                try await self.finishLogin(success: success); return
            }
            self.earlyCompletions.removeAll()
            let epoch = self.generation
            self.loginTimer = Task { [weak self] in
                guard let self else { return }
                try? await Task.sleep(nanoseconds: UInt64(max(0.01, self.loginTimeout) * 1_000_000_000))
                guard !Task.isCancelled, self.generation == epoch, self.loginID == id else { return }
                await self.cancelLogin()
                if self.state == .idle { self.detail = "Sign-in expired. Choose Connect Codex to try again."; self.changed() }
            }
            if !self.openBrowser(url) { self.detail = CodexConnectionError.browser.localizedDescription }
        }
    }
    func reopenBrowser() async {
        guard !isBusy, state == .awaitingBrowser, let url = authURL else { return }
        if !openBrowser(url) { detail = CodexConnectionError.browser.localizedDescription; changed() }
    }
    func cancelLogin() async {
        guard !isBusy, let id = loginID else { return }
        // Invalidate first: completion notifications racing cancellation must
        // never re-connect the UI. Stop the owned callback even on RPC failure.
        clearLogin()
        await run {
            let token = self.operation
            _ = try? await self.request("account/login/cancel", ["loginId": id])
            try self.ensureActive(token)
            self.closeProcess()
            self.clearAccount(); self.state = .idle; self.detail = "Sign-in cancelled."
        }
    }
    func disconnect() async {
        guard !isBusy else { return }
        clearLogin()
        await run {
            let token = self.operation
            try await self.startIfNeeded()
            try self.ensureActive(token)
            _ = try await self.request("account/logout", [:])
            try self.ensureActive(token)
            let result = try await self.request("account/read", ["refreshToken": false])
            try self.ensureActive(token)
            guard result["account"] is NSNull else { throw CodexConnectionError.protocolError }
            self.clearAccount(); self.state = .idle
            self.detail = "Disconnected from MinuteShelf. Your other Codex apps are unchanged."
            self.closeProcess()
        }
    }
    func stop() {
        operation = UUID(); listingModels = false; clearLogin(); closeProcess(); isBusy = false
        // A cached account is never asserted live across a process restart.
        clearAccount(); state = .idle; detail = "Connection closed. Choose Check Connection to read your saved sign-in."; changed()
    }

    func listModels() async throws -> [CodexModelDescriptor] {
        guard !isBusy, loginID == nil else { throw CodexConnectionError.catalogBusy }
        let token = UUID(); operation = token; isBusy = true; listingModels = true
        changed()
        defer {
            if operation == token { listingModels = false; isBusy = false; changed() }
        }
        do {
            try Task.checkCancellation()
            // model/list can return the runtime's cached catalog without a new
            // sign-in. Do not perform account/read, login, or an inference call.
            try await startIfNeeded()
            try ensureActive(token)
            var models: [CodexModelDescriptor] = []
            var recordIDs = Set<String>(), modelIDs = Set<String>(), cursors = Set<String>()
            var cursor: String?
            for _ in 0..<20 {
                try Task.checkCancellation()
                var params: [String: Any] = ["limit": 100, "includeHidden": false]
                if let cursor { params["cursor"] = cursor }
                let result = try await request("model/list", params)
                try ensureActive(token)
                try Task.checkCancellation()
                guard let records = result["data"] as? [[String: Any]], records.count <= 100 else {
                    throw CodexConnectionError.catalogMalformed
                }
                for record in records {
                    guard let recordID = CodexAuthProtocol.displayText(record["id"], limit: 500),
                          let model = CodexAuthProtocol.displayText(record["model"], limit: 500),
                          let name = CodexAuthProtocol.displayText(record["displayName"], limit: 300),
                          let hidden = CodexAuthProtocol.boolean(record["hidden"]),
                          model == model.trimmingCharacters(in: .whitespacesAndNewlines),
                          recordIDs.insert(recordID).inserted, modelIDs.insert(model).inserted else {
                        throw CodexConnectionError.catalogMalformed
                    }
                    var modalities: [String] = []
                    if let raw = record["inputModalities"] {
                        guard let values = raw as? [String], values.count <= 3,
                              Set(values).count == values.count,
                              values.allSatisfy({ ["text", "image", "audio"].contains($0) }) else {
                            throw CodexConnectionError.catalogMalformed
                        }
                        modalities = values
                    }
                    if !hidden { models.append(.init(id: model, displayName: name, inputModalities: modalities)) }
                }
                guard let next = result["nextCursor"], !(next is NSNull) else { return models }
                guard !records.isEmpty, let nextCursor = CodexAuthProtocol.displayText(next, limit: 4096),
                      cursors.insert(nextCursor).inserted else { throw CodexConnectionError.catalogMalformed }
                cursor = nextCursor
            }
            throw CodexConnectionError.catalogMalformed
        } catch {
            guard operation == token else { throw CodexConnectionError.stopped }
            // Discard the catalog as a unit. A catalog failure does not log out
            // the app's saved account or overwrite the existing account UI.
            closeProcess()
            if error is CancellationError { throw error }
            switch error as? CodexConnectionError {
            case .stopped, .protocolError, .rejected, nil: throw CodexConnectionError.catalogUnavailable
            default: throw error
            }
        }
    }

    private func run(_ body: () async throws -> Void) async {
        let token = UUID(); operation = token; isBusy = true
        if state != .awaitingBrowser { state = .checking }
        changed()
        do { try await body() }
        catch {
            guard operation == token else { return }
            clearLogin(); closeProcess(); clearAccount(); state = .failed
            // Never surface raw JSON-RPC error.message, stderr, callback URLs,
            // or Foundation error details that could contain credentials.
            detail = (error as? CodexConnectionError)?.localizedDescription ?? CodexConnectionError.rejected.localizedDescription
        }
        guard operation == token else { return }
        isBusy = false; changed()
        if let id = loginID, let success = earlyCompletions.removeValue(forKey: id) {
            await run { try await self.finishLogin(success: success) }
        }
    }
    private func clearAccount() { accountEmail = nil; planType = nil }
    private func ensureActive(_ token: UUID) throws {
        // Login expiry calls cancelLogin from the timer task; clearLogin then
        // cancels that same timer. The operation token, not Task cancellation,
        // is the authoritative invalidation boundary for controller state.
        guard operation == token else { throw CodexConnectionError.stopped }
    }
    private func clearLogin() { loginTimer?.cancel(); loginTimer = nil; loginID = nil; authURL = nil; earlyCompletions.removeAll() }
    private func changed() { onChange?() }
    private func applyAccount(_ response: [String: Any]) throws {
        if response["account"] is NSNull {
            clearAccount(); state = .idle; detail = "Not connected. Choose Connect Codex to sign in with ChatGPT."; return
        }
        guard let account = response["account"] as? [String: Any], account["type"] as? String == "chatgpt" else { throw CodexConnectionError.protocolError }
        accountEmail = CodexAuthProtocol.displayText(account["email"], limit: 320)
        planType = CodexAuthProtocol.displayText(account["planType"], limit: 64)
        state = .connected
        detail = "Signed in with ChatGPT. Account connection is ready; meeting analysis is not connected yet."
    }
    private func finishLogin(success: Bool) async throws {
        let token = operation
        clearLogin()
        guard success else { throw CodexConnectionError.rejected }
        let result = try await request("account/read", ["refreshToken": false])
        try ensureActive(token)
        try applyAccount(result)
        guard state == .connected else { throw CodexConnectionError.protocolError }
    }
    private func privateDirectory() throws {
        let manager = FileManager.default
        // The user-selected data root may itself have system aliases (/var).
        // Reject redirects within our owned connection namespace only.
        var ancestor = codexHome
        while ancestor.path != dataRoot.path && ancestor.path != "/" {
            if let type = try? manager.attributesOfItem(atPath: ancestor.path)[.type] as? FileAttributeType,
               type == .typeSymbolicLink { throw CodexConnectionError.storage }
            ancestor.deleteLastPathComponent()
        }
        do {
            try manager.createDirectory(at: codexHome, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: codexHome.path)
        } catch { throw CodexConnectionError.storage }
    }
    private func startIfNeeded() async throws {
        if child?.isRunning == true { return }
        guard FileManager.default.isExecutableFile(atPath: executable.path) else { throw CodexConnectionError.unavailable }
        try privateDirectory()
        let process = Process(), stdin = Pipe(), stdout = Pipe(), stderr = Pipe()
        generation = UUID(); let epoch = generation
        child = process; input = stdin; output = stdout; errors = stderr; buffer.removeAll()
        process.executableURL = executable
        process.arguments = ["app-server", "--listen", "stdio://", "-c", "cli_auth_credentials_store=\"keyring\"", "-c", "forced_login_method=\"chatgpt\""]
        process.currentDirectoryURL = codexHome
        process.environment = CodexAuthProtocol.environment(home: FileManager.default.homeDirectoryForCurrentUser,
                                                            temporary: FileManager.default.temporaryDirectory, codexHome: codexHome)
        process.standardInput = stdin; process.standardOutput = stdout; process.standardError = stderr
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let bytes = handle.availableData
            guard !bytes.isEmpty else { return }
            Task { @MainActor in guard let self, self.generation == epoch else { return }; self.receive(bytes) }
        }
        stderr.fileHandleForReading.readabilityHandler = { handle in _ = handle.availableData }
        process.terminationHandler = { [weak self] _ in Task { @MainActor in
            guard let self, self.generation == epoch else { return }
            if self.listingModels { self.closeProcess(); return }
            self.closeProcess(); self.clearLogin(); self.clearAccount()
            self.state = .failed; self.detail = CodexConnectionError.stopped.localizedDescription; self.changed()
        } }
        do { try process.run() } catch { closeProcess(); throw CodexConnectionError.launch }
        _ = try await request("initialize", ["clientInfo": ["name": "meeting_archive", "title": "MinuteShelf", "version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.2"], "capabilities": ["experimentalApi": false]])
        try send(["method": "initialized"])
    }
    private func request(_ method: String, _ params: [String: Any]) async throws -> [String: Any] {
        guard CodexAuthProtocol.methods.contains(method), child?.isRunning == true else { throw CodexConnectionError.stopped }
        let epoch = generation, token = operation
        nextID += 1; let id = "meeting-auth-\(nextID)"
        let result: [String: Any] = try await withCheckedThrowingContinuation { continuation in
            let timer = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(max(0.01, self?.requestTimeout ?? 20) * 1_000_000_000))
                guard !Task.isCancelled, let value = self?.pending.removeValue(forKey: id) else { return }
                value.continuation.resume(throwing: CodexConnectionError.timeout)
            }
            pending[id] = Pending(continuation: continuation, timer: timer)
            do { try send(["method": method, "id": id, "params": params]) }
            catch { pending.removeValue(forKey: id)?.timer.cancel(); continuation.resume(throwing: CodexConnectionError.stopped) }
        }
        try ensureActive(token)
        guard generation == epoch else { throw CodexConnectionError.stopped }
        return result
    }
    private func send(_ value: [String: Any]) throws {
        guard let input else { throw CodexConnectionError.stopped }
        var bytes = try JSONSerialization.data(withJSONObject: value); bytes.append(10)
        try input.fileHandleForWriting.write(contentsOf: bytes)
    }
    private func receive(_ bytes: Data) {
        buffer.append(bytes)
        guard buffer.count <= 1_048_576 else { protocolFailed(); return }
        while let newline = buffer.firstIndex(of: 10) {
            let line = buffer.prefix(upTo: newline); buffer.removeSubrange(...newline)
            guard let value = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { protocolFailed(); return }
            if let method = value["method"] as? String {
                if let id = value["id"] {
                    // Catalog discovery never enables agent/tool requests.
                    try? send(["id": id, "error": ["code": -32601, "message": "Account and catalog client only"]])
                } else if method == "account/login/completed", let id = value["params"] as? [String: Any],
                          let key = id["loginId"] as? String, let success = CodexAuthProtocol.boolean(id["success"]) {
                    if key == loginID, !isBusy {
                        loginTimer?.cancel()
                        Task { [weak self] in
                            guard let self, self.loginID == key, !self.isBusy else { return }
                            await self.run { try await self.finishLogin(success: success) }
                        }
                    } else if isBusy, (loginID == nil || loginID == key), earlyCompletions.count < 8 {
                        earlyCompletions[key] = success
                    }
                }
                // account/updated alone is not proof of a completed login.
            } else if let id = value["id"] as? String, let waiting = pending.removeValue(forKey: id) {
                waiting.timer.cancel()
                if value["error"] != nil { waiting.continuation.resume(throwing: CodexConnectionError.rejected) }
                else if let result = value["result"] as? [String: Any] { waiting.continuation.resume(returning: result) }
                else { waiting.continuation.resume(throwing: CodexConnectionError.protocolError) }
            }
        }
    }
    private func protocolFailed() {
        if listingModels { closeProcess(); return }
        closeProcess(); clearLogin(); clearAccount(); state = .failed
        detail = CodexConnectionError.protocolError.localizedDescription; changed()
    }
    private func closeProcess() {
        generation = UUID()
        let process = child; child = nil
        output?.fileHandleForReading.readabilityHandler = nil; errors?.fileHandleForReading.readabilityHandler = nil
        try? input?.fileHandleForWriting.close(); input = nil; output = nil; errors = nil; buffer.removeAll()
        let requests = pending; pending.removeAll()
        for value in requests.values { value.timer.cancel(); value.continuation.resume(throwing: CodexConnectionError.stopped) }
        if let process, process.isRunning {
            process.terminate()
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            }
        }
    }
}
