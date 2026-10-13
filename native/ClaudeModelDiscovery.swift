import Foundation
import Security
import Darwin

struct ClaudeModelDescriptor: Equatable {
    let id: String
    let displayName: String
}

enum ClaudeModelDiscoveryError: LocalizedError {
    case unavailable, untrusted, outdated, busy, stopped, timeout, malformed, launch
    var errorDescription: String? {
        switch self {
        case .unavailable: return "Claude Code is not installed in a supported location. Install its official native CLI to load its model catalog."
        case .untrusted: return "The installed Claude Code executable could not be verified. Install the official native CLI to load its model catalog."
        case .outdated: return "Update Claude Code to load its model catalog safely. This feature requires version 2.1.178 or later."
        case .busy: return "Claude model discovery is already running."
        case .stopped: return "Claude model discovery was stopped. Try refreshing the models again."
        case .timeout: return "Claude Code did not return its model catalog in time. Try refreshing again."
        case .malformed: return "Claude Code returned an unsupported model catalog. Update the CLI and try again."
        case .launch: return "Claude Code could not start. Check its installation and try again."
        }
    }
}

// Uses the same initialize metadata as Agent SDK supportedModels(). This is a
// catalog from the installed runtime, not a fresh account-authorized API list.
// No user prompt, credentials, account RPC, model invocation, or tools are sent.
enum ClaudeModelProtocol {
    static let arguments = ["--bare", "--safe-mode", "--print", "--input-format", "stream-json",
        "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--setting-sources=",
        "--settings", "{\"disableAllHooks\":true}", "--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}",
        "--tools", "", "--disable-slash-commands", "--no-chrome", "--permission-mode", "dontAsk", "--system-prompt", ""]

    static func environment(root: URL) -> [String: String] {
        // --bare skips keychain/OAuth reads. Do not inherit tokens, helpers,
        // proxy/provider overrides, SDK settings, or dynamic-loader settings.
        ["HOME": root.path, "CLAUDE_CONFIG_DIR": root.appendingPathComponent("config").path,
         "TMPDIR": root.path, "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8",
         "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "DISABLE_AUTOUPDATER": "1"]
    }
    static func text(_ value: Any?, limit: Int) -> String? {
        guard let text = value as? String, !text.isEmpty, text.count <= limit,
              text == text.trimmingCharacters(in: .whitespacesAndNewlines),
              !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }
        return text
    }
    static func version(_ data: Data) throws -> String {
        guard let output = String(data: data, encoding: .utf8), output.utf8.count <= 128 else {
            throw ClaudeModelDiscoveryError.outdated
        }
        let value = output.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.range(of: #"^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6} \(Claude Code\)$"#, options: .regularExpression) != nil,
              let version = value.split(separator: " ").first else { throw ClaudeModelDiscoveryError.outdated }
        let parts = version.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 3, !parts.lexicographicallyPrecedes([2, 1, 178]) else { throw ClaudeModelDiscoveryError.outdated }
        return String(version)
    }
    static func models(_ value: Any?) throws -> [ClaudeModelDescriptor] {
        guard let records = value as? [[String: Any]], !records.isEmpty, records.count <= 2000 else {
            throw ClaudeModelDiscoveryError.malformed
        }
        var seen = Set<String>()
        return try records.map { record in
            guard let id = text(record["value"], limit: 500), let name = text(record["displayName"], limit: 300),
                  seen.insert(id).inserted else { throw ClaudeModelDiscoveryError.malformed }
            return ClaudeModelDescriptor(id: id, displayName: name)
        }
    }
}

@MainActor final class ClaudeModelDiscovery {
    private(set) var runtimeVersion: String?
    private let executableOverride: URL?
    private let verifySignature: Bool
    private let timeoutSeconds: Double
    private var operation = UUID()
    private var busy = false
    private var runner: ClaudeCatalogProcess?

    // Signature verification is disabled only by the synthetic protocol tests.
    init(executableURL: URL? = nil, requestTimeoutSeconds: Double = 20, verifySignature: Bool = true) {
        executableOverride = executableURL; timeoutSeconds = requestTimeoutSeconds; self.verifySignature = verifySignature
    }
    func listModels() async throws -> [ClaudeModelDescriptor] {
        guard !busy else { throw ClaudeModelDiscoveryError.busy }
        busy = true; runtimeVersion = nil
        let token = UUID(); operation = token
        defer { if operation == token { busy = false; runner = nil } }
        do {
            try Task.checkCancellation()
            let supplied = executableOverride, verify = verifySignature
            let executable = try await Task.detached { try Self.locateExecutable(supplied, verifySignature: verify) }.value
            guard operation == token else { throw ClaudeModelDiscoveryError.stopped }
            try Task.checkCancellation()
            let versionRun = ClaudeCatalogProcess(executable: executable, timeout: timeoutSeconds)
            runner = versionRun
            let version = try ClaudeModelProtocol.version(try await versionRun.run(versionOnly: true))
            guard operation == token else { throw ClaudeModelDiscoveryError.stopped }
            try Task.checkCancellation()
            let catalogRun = ClaudeCatalogProcess(executable: executable, timeout: timeoutSeconds)
            runner = catalogRun
            let data = try await catalogRun.run(versionOnly: false)
            guard operation == token else { throw ClaudeModelDiscoveryError.stopped }
            try Task.checkCancellation()
            guard let reply = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let response = reply["response"] as? [String: Any],
                  let payload = response["response"] as? [String: Any] else { throw ClaudeModelDiscoveryError.malformed }
            let models = try ClaudeModelProtocol.models(payload["models"])
            runtimeVersion = version
            return models
        } catch {
            if operation == token { runner?.stop() }
            if error is CancellationError { throw error }
            throw (error as? ClaudeModelDiscoveryError) ?? ClaudeModelDiscoveryError.malformed
        }
    }
    func stop() {
        operation = UUID(); runner?.stop(); runner = nil; busy = false
    }

    nonisolated private static func locateExecutable(_ override: URL?, verifySignature: Bool) throws -> URL {
        let candidates = override.map { [$0] } ?? [
            FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin/claude"),
            URL(fileURLWithPath: "/opt/homebrew/bin/claude"), URL(fileURLWithPath: "/usr/local/bin/claude")]
        guard let candidate = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0.path) }) else {
            throw ClaudeModelDiscoveryError.unavailable
        }
        let path = candidate.resolvingSymlinksInPath()
        guard verifySignature else { return path }
        // Do not execute shell aliases, wrappers, or an arbitrary PATH entry.
        // Validate the official native macOS CLI before even invoking --version.
        var code: SecStaticCode?, requirement: SecRequirement?
        let rule = #"anchor apple generic and identifier "com.anthropic.claude-code" and certificate leaf[subject.OU] = "Q6L2SF6YDW""#
        guard SecStaticCodeCreateWithPath(path as CFURL, [], &code) == errSecSuccess, let code,
              SecRequirementCreateWithString(rule as CFString, [], &requirement) == errSecSuccess,
              SecStaticCodeCheckValidity(code, [], requirement) == errSecSuccess else { throw ClaudeModelDiscoveryError.untrusted }
        return path
    }
}

@MainActor private final class ClaudeCatalogProcess {
    private let executable: URL, timeout: Double
    private let requestID = UUID().uuidString
    private var process: Process?, input: Pipe?, output: Pipe?
    private var root: URL?, timer: Task<Void, Never>?
    private var continuation: CheckedContinuation<Data, Error>?
    private var versionOnly = false, eof = false
    private var exitStatus: Int32?
    private var buffer = Data(), byteCount = 0

    init(executable: URL, timeout: Double) { self.executable = executable; self.timeout = timeout }
    func run(versionOnly: Bool) async throws -> Data {
        self.versionOnly = versionOnly
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
                do { try start() } catch { finish(.failure(ClaudeModelDiscoveryError.launch)) }
            }
        } onCancel: { Task { @MainActor [weak self] in self?.finish(.failure(CancellationError())) } }
    }
    func stop() { finish(.failure(ClaudeModelDiscoveryError.stopped)) }
    private func start() throws {
        let directory = FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
            .appendingPathComponent("meeting-claude-catalog-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        root = directory
        let child = Process(), stdin = Pipe(), stdout = Pipe()
        process = child; input = stdin; output = stdout
        child.executableURL = executable; child.currentDirectoryURL = directory
        child.environment = ClaudeModelProtocol.environment(root: directory)
        child.arguments = versionOnly ? ["--version"] : ClaudeModelProtocol.arguments
        child.standardInput = stdin; child.standardOutput = stdout; child.standardError = FileHandle.nullDevice
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let bytes = handle.availableData
            Task { @MainActor in self?.receive(bytes) }
        }
        child.terminationHandler = { [weak self] child in
            // These directories contain only this discovery process's temporary
            // state. Never remove or read the user's Claude configuration.
            try? FileManager.default.removeItem(at: directory)
            Task { @MainActor in self?.exited(child.terminationStatus) }
        }
        try child.run()
        timer = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(max(0.01, self?.timeout ?? 20) * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.finish(.failure(ClaudeModelDiscoveryError.timeout))
        }
        if versionOnly { try stdin.fileHandleForWriting.close() }
        else {
            let message: [String: Any] = ["type": "control_request", "request_id": requestID,
                "request": ["subtype": "initialize", "hooks": [:], "agents": [:], "skills": []]]
            var bytes = try JSONSerialization.data(withJSONObject: message); bytes.append(10)
            try stdin.fileHandleForWriting.write(contentsOf: bytes)
        }
    }
    private func receive(_ bytes: Data) {
        guard continuation != nil else { return }
        if bytes.isEmpty { eof = true; completeExit(); return }
        byteCount += bytes.count
        guard byteCount <= (versionOnly ? 128 : 1_048_576) else { finish(.failure(ClaudeModelDiscoveryError.malformed)); return }
        buffer.append(bytes)
        guard !versionOnly else { return }
        while let newline = buffer.firstIndex(of: 10) {
            let line = Data(buffer.prefix(upTo: newline)); buffer.removeSubrange(...newline)
            guard let message = try? JSONSerialization.jsonObject(with: line) as? [String: Any], let type = message["type"] as? String else {
                finish(.failure(ClaudeModelDiscoveryError.malformed)); return
            }
            if type == "control_response" {
                guard let response = message["response"] as? [String: Any], response["request_id"] as? String == requestID else { continue }
                guard response["subtype"] as? String == "success" else { finish(.failure(ClaudeModelDiscoveryError.malformed)); return }
                finish(.success(line)); return
            }
            // No callback or tool execution is part of catalog enumeration.
            if type != "system" { finish(.failure(ClaudeModelDiscoveryError.malformed)); return }
        }
    }
    private func exited(_ status: Int32) { exitStatus = status; completeExit() }
    private func completeExit() {
        guard eof, let exitStatus else { return }
        if versionOnly, exitStatus == 0 { finish(.success(buffer)) }
        else { finish(.failure(ClaudeModelDiscoveryError.malformed)) }
    }
    private func finish(_ result: Result<Data, Error>) {
        guard let waiting = continuation else { return }
        continuation = nil; timer?.cancel(); timer = nil
        output?.fileHandleForReading.readabilityHandler = nil
        try? input?.fileHandleForWriting.close()
        let child = process, directory = root
        process = nil; input = nil; output = nil; root = nil; buffer.removeAll()
        if let child, child.isRunning {
            child.terminate()
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                if child.isRunning { kill(child.processIdentifier, SIGKILL) }
            }
        } else if let directory { try? FileManager.default.removeItem(at: directory) }
        waiting.resume(with: result)
    }
}
