import Foundation
import Darwin

private enum FakeClaudeCatalog {
    static func emit(_ object: [String: Any]) {
        var data = try! JSONSerialization.data(withJSONObject: object); data.append(10)
        try? FileHandle.standardOutput.write(contentsOf: data)
    }
    static func run(_ scenario: String, receipt: String) {
        if CommandLine.arguments.contains("--version") {
            print(scenario == "old-version" ? "2.1.177 (Claude Code)" : "2.1.178 (Claude Code)")
            return
        }
        guard let line = readLine(), let data = line.data(using: .utf8),
              let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let requestID = message["request_id"] as? String else { exit(3) }
        let environment = ProcessInfo.processInfo.environment
        let home = environment["HOME"] ?? ""
        let receiptObject: [String: Any] = ["message": message, "pid": getpid(), "arguments": Array(CommandLine.arguments.dropFirst(4)),
            "environmentKeys": Array(environment.keys), "home": home,
            "homeMode": (try? FileManager.default.attributesOfItem(atPath: home)[.posixPermissions] as? NSNumber) ?? 0]
        try! JSONSerialization.data(withJSONObject: receiptObject).write(to: URL(fileURLWithPath: receipt))
        if scenario == "timeout" { sleep(30); return }
        if scenario == "eof" { return }
        if scenario == "oversized" { print(String(repeating: "x", count: 1_048_577)); return }
        if scenario == "malformed" { print("not json"); return }
        if scenario == "tool-request" { emit(["type": "control_request", "request_id": "unexpected", "request": ["subtype": "can_use_tool"]]); sleep(1); return }
        if scenario == "error" {
            fputs("FAKE_SECRET", stderr)
            emit(["type": "control_response", "response": ["subtype": "error", "request_id": requestID, "error": "FAKE_SECRET"]]); return
        }
        if scenario == "stale" { emit(["type": "control_response", "response": ["subtype": "success", "request_id": "stale", "response": ["models": []]]]) }
        var models: [[String: Any]] = [["value": "sonnet", "displayName": "Sonnet"], ["value": "opus[1m]", "displayName": "Opus"]]
        if scenario == "duplicate" { models.append(models[0]) }
        if scenario == "empty" { models = [] }
        if scenario == "bad-name" { models[0]["displayName"] = "bad\nname" }
        emit(["type": "control_response", "response": ["subtype": "success", "request_id": requestID, "response": ["models": models]]])
        // The real streaming process stays open. Discovery must terminate it.
        while readLine() != nil {}
    }
}

@main struct ClaudeModelDiscoveryTests {
    @MainActor static var checks = 0
    @MainActor static func check(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
        guard try condition() else { throw NSError(domain: "ClaudeModelDiscoveryTests", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
        checks += 1
    }
    @MainActor static func checkChildStopped(_ receipt: URL) async throws {
        guard let data = try? Data(contentsOf: receipt),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let pid = object["pid"] as? Int32, let home = object["home"] as? String else { return }
        for _ in 0..<300 {
            if kill(pid, 0) != 0 && !FileManager.default.fileExists(atPath: home) { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        try check(kill(pid, 0) != 0, "Discovery must terminate its child")
        try check(!FileManager.default.fileExists(atPath: home), "Discovery must remove its temporary home after termination")
    }
    @MainActor static func fixture(_ scenario: String, timeout: Double = 0.35,
        body: (ClaudeModelDiscovery, URL) async throws -> Void) async throws {
        let directory = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent("meeting-claude-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        let receipt = directory.appendingPathComponent("receipt.json"), executable = directory.appendingPathComponent("claude")
        func quote(_ text: String) -> String { "'" + text.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        let script = "#!/bin/sh\nexec \(quote(URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.path)) --fixture \(quote(scenario)) \(quote(receipt.path)) \"$@\"\n"
        try script.write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
        let discovery = ClaudeModelDiscovery(executableURL: executable, requestTimeoutSeconds: timeout, verifySignature: false)
        defer { discovery.stop(); try? FileManager.default.removeItem(at: directory) }
        try await body(discovery, receipt)
    }
    @MainActor static func main() async throws {
        if CommandLine.arguments.count >= 4, CommandLine.arguments[1] == "--fixture" {
            FakeClaudeCatalog.run(CommandLine.arguments[2], receipt: CommandLine.arguments[3]); return
        }
        if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--probe-runtime" {
            let discovery = ClaudeModelDiscovery(executableURL: URL(fileURLWithPath: CommandLine.arguments[2]))
            let models = try await discovery.listModels()
            try check(!models.isEmpty && discovery.runtimeVersion != nil, "Official runtime must return version and models")
            print("Claude runtime \(discovery.runtimeVersion!): \(models.map(\.id).joined(separator: ", ")); initialization only, no credentials or prompt.")
            return
        }
        for scenario in ["success", "stale"] {
            try await fixture(scenario) { discovery, receipt in
                let models = try await discovery.listModels()
                try check(models.map(\.id) == ["sonnet", "opus[1m]"], "Metadata must retain exact model values")
                try check(discovery.runtimeVersion == "2.1.178", "Catalog provenance must retain verified runtime version")
                let value = try JSONSerialization.jsonObject(with: Data(contentsOf: receipt)) as! [String: Any]
                let message = value["message"] as! [String: Any], request = message["request"] as! [String: Any]
                try check(message["type"] as? String == "control_request" && request["subtype"] as? String == "initialize", "Only initialize may be sent")
                try check(Set(message.keys) == Set(["type", "request_id", "request"]), "No user prompt or account data may be sent")
                try check(value["arguments"] as? [String] == ClaudeModelProtocol.arguments, "All isolation flags must reach child")
                let keys = Set(value["environmentKeys"] as! [String])
                // The shell fixture and CoreFoundation add these process-local
                // bookkeeping keys after launch; none carry credentials.
                let allowed = Set(ClaudeModelProtocol.environment(root: URL(fileURLWithPath: "/tmp/example")).keys).union(["PWD", "SHLVL", "_", "__CF_USER_TEXT_ENCODING"])
                try check(keys.isSubset(of: allowed), "Unexpected child environment keys: \(keys.subtracting(allowed).sorted())")
                try check((value["homeMode"] as? NSNumber)?.intValue == 0o700, "Temporary home must be private")
                let home = value["home"] as! String
                for _ in 0..<100 {
                    if !FileManager.default.fileExists(atPath: home) { break }
                    try await Task.sleep(nanoseconds: 10_000_000)
                }
                try check(!FileManager.default.fileExists(atPath: home), "Child's temporary home must be removed after discovery")
            }
        }
        for scenario in ["duplicate", "empty", "bad-name", "old-version", "eof", "oversized", "malformed", "tool-request", "error", "timeout"] {
            try await fixture(scenario) { discovery, receipt in
                do { _ = try await discovery.listModels(); try check(false, "Malformed or unsafe metadata must fail: \(scenario)") }
                catch {
                    let expected: ClaudeModelDiscoveryError = scenario == "timeout" ? .timeout : scenario == "old-version" ? .outdated : .malformed
                    try check(error as? ClaudeModelDiscoveryError == expected, "Scenario must return its expected failure: \(scenario)")
                    try check(!error.localizedDescription.contains("FAKE_SECRET"), "Raw child errors/stderr must never be displayed")
                    try check(discovery.runtimeVersion == nil, "Failed catalog must not advertise successful provenance")
                }
                try await checkChildStopped(receipt)
            }
        }
        try await fixture("timeout", timeout: 10) { discovery, receipt in
            let task = Task { try await discovery.listModels() }
            for _ in 0..<100 {
                if FileManager.default.fileExists(atPath: receipt.path) { break }
                try await Task.sleep(nanoseconds: 10_000_000)
            }
            do { _ = try await discovery.listModels(); try check(false, "Concurrent enumeration must be rejected") }
            catch { try check(error as? ClaudeModelDiscoveryError == .busy, "Busy errors must be explicit") }
            task.cancel()
            do { _ = try await task.value; try check(false, "Cancelled enumeration must fail") }
            catch { try check(error is CancellationError, "Task cancellation must terminate the child and resume") }
            try await checkChildStopped(receipt)
        }
        try await fixture("timeout", timeout: 10) { discovery, receipt in
            let task = Task { try await discovery.listModels() }
            for _ in 0..<100 {
                if FileManager.default.fileExists(atPath: receipt.path) { break }
                try await Task.sleep(nanoseconds: 10_000_000)
            }
            discovery.stop()
            do { _ = try await task.value; try check(false, "Stopped enumeration must fail") }
            catch { try check(error as? ClaudeModelDiscoveryError == .stopped, "Explicit stop must resume pending work") }
            try await checkChildStopped(receipt)
        }
        let missing = ClaudeModelDiscovery(executableURL: URL(fileURLWithPath: "/nonexistent/claude"))
        do { _ = try await missing.listModels(); try check(false, "Absent CLI must fail") }
        catch { try check(error as? ClaudeModelDiscoveryError == .unavailable, "Absent CLI must have actionable error") }
        let unsigned = ClaudeModelDiscovery(executableURL: URL(fileURLWithPath: CommandLine.arguments[0]))
        do { _ = try await unsigned.listModels(); try check(false, "Untrusted CLI must fail before executing") }
        catch { try check(error as? ClaudeModelDiscoveryError == .untrusted, "CLI publisher validation must be enforced") }
        print("Claude model discovery: \(checks) checks passed.")
    }
}
