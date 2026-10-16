import Foundation
import Darwin

// The child is this test executable in fake-app-server mode. These checks never
// execute bundled Codex, open a browser, read real credentials, or use a network.
private enum FakeCodexServer {
    static func model(_ suffix: String, hidden: Bool = false) -> [String: Any] {
        ["id": "picker-\(suffix)", "model": "runtime-\(suffix)", "displayName": "Model \(suffix)",
         "hidden": hidden, "inputModalities": ["text", "image"], "isDefault": false,
         "description": "Fixture model", "defaultReasoningEffort": "medium", "supportedReasoningEfforts": []]
    }
    static func emit(_ object: [String: Any]) {
        guard var data = try? JSONSerialization.data(withJSONObject: object) else { exit(3) }
        data.append(10); try? FileHandle.standardOutput.write(contentsOf: data)
    }
    static func run() {
        guard let root = ProcessInfo.processInfo.environment["CODEX_HOME"],
              let scenario = try? String(contentsOfFile: root + "/scenario.txt", encoding: .utf8) else { exit(4) }
        let loginID = "fixture-login-current"
        var signedIn = ["connected", "malformed-after-connected"].contains(scenario) || scenario.hasPrefix("models-connected-")
        let modelScenario = scenario.replacingOccurrences(of: "models-connected-", with: "models-")
        var readCount = 0, modelCount = 0
        while let line = readLine() {
            guard let data = line.data(using: .utf8), let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let method = message["method"] as? String else { continue }
            guard let id = message["id"] else { continue }
            let receipt = Data((method + "\n").utf8)
            let receiptPath = root + "/requests.txt"
            if !FileManager.default.fileExists(atPath: receiptPath) { FileManager.default.createFile(atPath: receiptPath, contents: nil) }
            if let handle = FileHandle(forWritingAtPath: receiptPath) { _ = try? handle.seekToEnd(); try? handle.write(contentsOf: receipt); try? handle.close() }
            switch method {
            case "initialize":
                if scenario == "boolean-id" { emit(["id": true, "result": [:]]); continue }
                if scenario == "stale-response" { emit(["id": "old-generation", "result": ["account": ["type": "chatgpt", "email": "wrong@example.test"]]]) }
                emit(["id": id, "result": [:]])
            case "account/read":
                readCount += 1
                if scenario == "delayed-account" { usleep(200_000); signedIn = true }
                if scenario == "rpc-error" {
                    let secret = "FAKE_SECRET https://auth.openai.com/oauth/authorize?state=FAKE_STATE"
                    try? FileHandle.standardError.write(contentsOf: Data(secret.utf8))
                    emit(["id": id, "error": ["code": -32603, "message": secret]]); continue
                }
                if scenario == "stale-response" { emit(["id": 0, "result": ["account": ["type": "chatgpt", "email": "wrong@example.test"]]]) }
                if scenario == "api-key-account" { emit(["id": id, "result": ["account": ["type": "apiKey"]]]); continue }
                let account: Any = signedIn ? ["type": "chatgpt", "email": "fixture@example.test", "planType": "pro"] : NSNull()
                emit(["id": id, "result": ["account": account, "requiresOpenaiAuth": true]])
                if scenario == "malformed-after-connected" && readCount == 1 {
                    usleep(80_000); try? FileHandle.standardOutput.write(contentsOf: Data("not JSON\n".utf8))
                }
            case "account/login/start":
                let url = scenario == "unsafe-auth-url" ? "https://auth.openai.com.evil.test/authorize" : "https://auth.openai.com/oauth/authorize?state=FAKE_STATE"
                emit(["id": id, "result": ["type": "chatgpt", "loginId": loginID, "authUrl": url]])
                if scenario == "login-success" {
                    usleep(60_000); signedIn = true
                    emit(["method": "account/login/completed", "params": ["loginId": "stale-login", "success": true]])
                    emit(["method": "account/login/completed", "params": ["loginId": loginID, "success": true]])
                } else if scenario == "stale-login" {
                    usleep(60_000)
                    emit(["method": "account/login/completed", "params": ["loginId": "stale-login", "success": true]])
                    emit(["method": "account/updated", "params": ["authMode": "chatgpt", "planType": "pro"]])
                }
            case "account/login/cancel":
                // A success racing cancellation must not reconnect the UI.
                signedIn = true
                emit(["method": "account/login/completed", "params": ["loginId": loginID, "success": true]])
                emit(["method": "account/updated", "params": ["authMode": "chatgpt", "planType": "pro"]])
                emit(["id": id, "result": [:]])
            case "account/logout":
                signedIn = false
                emit(["id": id, "result": [:]])
                emit(["method": "account/updated", "params": ["authMode": NSNull(), "planType": NSNull()]])
            case "model/list":
                modelCount += 1
                let params = message["params"] as? [String: Any] ?? [:]
                guard params["limit"] as? Int == 100, params["includeHidden"] as? Bool == false else {
                    emit(["id": id, "error": ["code": -32602, "message": "Catalog params missing"]]); continue
                }
                if modelScenario == "models-delayed" { usleep(200_000) }
                if modelScenario == "models-timeout" { usleep(600_000) }
                if modelScenario == "models-exit" { exit(0) }
                if modelScenario == "models-invalid-json" {
                    try? FileHandle.standardOutput.write(contentsOf: Data("not JSON\n".utf8)); continue
                }
                if modelScenario == "models-rpc-error" || (modelScenario == "models-partial-error" && modelCount == 2) {
                    emit(["id": id, "error": ["code": -32603, "message": "FAKE_SECRET_CATALOG"]]); continue
                }
                var rows = [model("\(modelCount)")], next: Any = NSNull()
                switch modelScenario {
                case "models-paginated":
                    if modelCount == 1 {
                        guard params["cursor"] == nil else { exit(5) }
                        rows.append(model("hidden", hidden: true)); next = "second-page"
                    } else {
                        guard params["cursor"] as? String == "second-page" else { exit(6) }
                        rows[0].removeValue(forKey: "inputModalities")
                    }
                case "models-duplicate-model":
                    rows[0]["model"] = "runtime-duplicate"; if modelCount == 1 { next = "second-page" }
                case "models-duplicate-row":
                    rows[0]["id"] = "picker-duplicate"; if modelCount == 1 { next = "second-page" }
                case "models-cursor-loop": next = "same-cursor"
                case "models-endless": next = "page-\(modelCount)"
                case "models-partial-error": next = "second-page"
                case "models-oversized": rows = (0...100).map { model("\($0)") }
                case "models-missing-model": rows[0].removeValue(forKey: "model")
                case "models-control-id": rows[0]["model"] = "bad\nmodel"
                case "models-whitespace-id": rows[0]["model"] = "  "
                case "models-numeric-hidden": rows[0]["hidden"] = 0
                case "models-malformed-modalities": rows[0]["inputModalities"] = ["text", "unknown"]
                case "models-invalid-cursor": next = 42
                case "models-empty-cursor": next = ""
                case "models-empty-page": rows = []; next = "next"
                case "models-empty": rows = []
                case "models-missing-data": emit(["id": id, "result": [:]]); continue
                default: break
                }
                emit(["id": id, "result": ["data": rows, "nextCursor": next]])
            default: emit(["id": id, "error": ["code": -32601, "message": "Unexpected test method"]])
            }
        }
    }
}

@main struct CodexConnectionTests {
    @MainActor static var checks = 0
    @MainActor static func check(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
        guard try condition() else { throw NSError(domain: "CodexConnectionTests", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
        checks += 1
    }
    @MainActor static func wait(_ message: String, for condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(2)
        while !condition(), Date() < deadline { try await Task.sleep(nanoseconds: 10_000_000) }
        try check(condition(), message)
    }
    @MainActor static func expectFailure(_ message: String, action: () async throws -> Void) async throws -> Error {
        do { try await action() }
        catch { checks += 1; return error }
        throw NSError(domain: "CodexConnectionTests", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
    @MainActor static func fixture(_ scenario: String, loginTimeout: Double = 2,
                                   body: (CodexConnection, URL, () -> Int) async throws -> Void) async throws {
        let root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
            .appendingPathComponent("meeting-codex-test-\(UUID().uuidString)", isDirectory: true)
        let home = root.appendingPathComponent("connections/codex", isDirectory: true)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try scenario.write(to: home.appendingPathComponent("scenario.txt"), atomically: true, encoding: .utf8)
        var browserCount = 0
        let executable = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
        let connection = CodexConnection(dataDirectory: root, executableURL: executable, requestTimeoutSeconds: 0.3,
            loginTimeoutSeconds: loginTimeout, browserOpener: { _ in browserCount += 1; return true })
        defer { connection.stop(); try? FileManager.default.removeItem(at: root) }
        try await body(connection, home, { browserCount })
    }
    @MainActor static func runtimeProbe(_ executable: URL) async throws {
        let root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
            .appendingPathComponent("meeting-codex-runtime-probe-\(UUID().uuidString)", isDirectory: true)
        var validatedLoginURL = false
        let connection = CodexConnection(dataDirectory: root, executableURL: executable,
            requestTimeoutSeconds: 20, loginTimeoutSeconds: 60, browserOpener: { url in
                validatedLoginURL = CodexAuthProtocol.authorizationURL(url.absoluteString) != nil
                return true // Deliberately do not invoke NSWorkspace or open a browser.
            })
        defer { connection.stop(); try? FileManager.default.removeItem(at: root) }
        await connection.refresh()
        try check(connection.state == .idle && connection.accountEmail == nil, "Fresh runtime namespace must report no saved account: \(connection.detail)")
        await connection.connect()
        try check(connection.state == .awaitingBrowser && validatedLoginURL, "Official runtime must return a valid pending browser login: \(connection.detail)")
        await connection.cancelLogin()
        try check(connection.state == .idle && connection.accountEmail == nil && !connection.isBusy, "Runtime login cancellation must complete")
        print("{\"runtimeProbe\":true,\"initialized\":true,\"accountEmpty\":true,\"loginURLValidated\":true,\"loginCancelled\":true,\"browserOpened\":false,\"meetingContentSent\":false}")
    }
    @MainActor static func main() async throws {
        if CommandLine.arguments.dropFirst().first == "app-server" { FakeCodexServer.run(); return }
        if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--probe-runtime" {
            try await runtimeProbe(URL(fileURLWithPath: CommandLine.arguments[2])); return
        }
        for value in ["https://auth.openai.com/oauth/authorize?state=fixture", "https://chatgpt.com/codex/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback", "https://auth.openai.com:443/authorize"] {
            try check(CodexAuthProtocol.authorizationURL(value) != nil, "Official HTTPS authorization URL should be accepted")
        }
        for value in ["http://auth.openai.com/authorize", "https://evil.test/", "https://auth.openai.com.evil.test/", "https://sub.auth.openai.com/", "https://chatgpt.com.evil.test/", "https://auth.openai.com:444/", "https://user@auth.openai.com/", "https://user:password@chatgpt.com/", "https://@auth.openai.com/", "https://auth.openai.com/#secret", "https://auth.openai.com/#", "file:///tmp/authorize", "javascript:alert(1)", "https://auth.openai.com/\n", "https://auth.openai.com./", "https://auth.openai.com\\@evil.test/"] {
            try check(CodexAuthProtocol.authorizationURL(value) == nil, "Untrusted or ambiguous authorization URL must be rejected")
        }
        try check(CodexAuthProtocol.authorizationURL("https://auth.openai.com/?state=" + String(repeating: "x", count: 17000)) == nil, "Oversized authorization URL must be rejected")
        try check(CodexAuthProtocol.displayText("研究人员@example.test", limit: 320) == "研究人员@example.test", "Unicode account metadata should remain readable")
        for value: Any in ["bad\nname", "", String(repeating: "a", count: 321), 42] {
            try check(CodexAuthProtocol.displayText(value, limit: 320) == nil, "Invalid account metadata must not be displayed")
        }
        let typedJSON = try JSONSerialization.jsonObject(with: Data("{\"true\":true,\"false\":false,\"one\":1,\"zero\":0,\"text\":\"true\"}".utf8)) as! [String: Any]
        try check(CodexAuthProtocol.boolean(typedJSON["true"]) == true && CodexAuthProtocol.boolean(typedJSON["false"]) == false, "JSON booleans must retain their values")
        for key in ["one", "zero", "text"] { try check(CodexAuthProtocol.boolean(typedJSON[key]) == nil, "Numeric/string success values must not authenticate") }
        let environment = CodexAuthProtocol.environment(home: URL(fileURLWithPath: "/private/tmp/fixture-home"),
            temporary: URL(fileURLWithPath: "/private/tmp/fixture-tmp"), codexHome: URL(fileURLWithPath: "/private/tmp/fixture-codex"))
        try check(environment["CODEX_HOME"] == "/private/tmp/fixture-codex", "Child must use only the isolated Codex home")
        try check(environment["PATH"] == "/usr/bin:/bin:/usr/sbin:/sbin", "Child must not inherit developer tool paths")
        try check(Set(environment.keys) == Set(["HOME", "USER", "LOGNAME", "TMPDIR", "PATH", "LANG", "CODEX_HOME", "RUST_LOG"]), "Only the explicit child environment allowlist is permitted")
        for key in ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "ACCESS_TOKEN", "OPENAI_IDENTITY_TOKEN_FILE", "AWS_PROFILE", "HTTPS_PROXY", "NODE_OPTIONS", "DYLD_INSERT_LIBRARIES"] {
            try check(environment[key] == nil, "Credential/provider/loader environment must not be inherited")
        }
        try check(CodexAuthProtocol.methods.contains("model/list") && !CodexAuthProtocol.methods.contains("thread/start") && !CodexAuthProtocol.methods.contains("turn/start") && !CodexAuthProtocol.methods.contains("command/exec"), "Connection controller must allow catalogs without inference or tool execution")
        for feature in ["apps", "plugins", "remote_plugin", "hooks", "shell_tool", "unified_exec"] {
            try check(CodexAuthProtocol.arguments.contains("features.\(feature)=false"), "Account/catalog starts must not enable plugins or tools")
        }

        try await fixture("models-paginated") { connection, home, browsers in
            let originalDetail = connection.detail
            let models = try await connection.listModels()
            try check(models == [.init(id: "runtime-1", displayName: "Model 1", inputModalities: ["text", "image"]),
                                 .init(id: "runtime-2", displayName: "Model 2", inputModalities: [])],
                      "Catalog must follow cursors, use actual model IDs, filter hidden records, and not infer absent modalities")
            try check(connection.state == .idle && connection.detail == originalDetail && !connection.isBusy,
                      "Discovery without an account must preserve account state")
            let methods = try String(contentsOf: home.appendingPathComponent("requests.txt"), encoding: .utf8)
            try check(methods == "initialize\nmodel/list\nmodel/list\n", "Discovery must not read accounts, log in, or invoke models")
            try check(browsers() == 0, "Discovery must not open sign-in")
        }
        try await fixture("models-empty") { connection, _, _ in
            let models = try await connection.listModels()
            try check(models.isEmpty, "An empty completed catalog is valid")
        }
        for failure in ["duplicate-model", "duplicate-row", "cursor-loop", "endless", "partial-error", "oversized", "missing-model",
                        "control-id", "whitespace-id", "numeric-hidden", "malformed-modalities", "invalid-cursor", "empty-cursor", "empty-page",
                        "missing-data", "rpc-error", "invalid-json", "timeout", "exit"] {
            try await fixture("models-connected-\(failure)") { connection, home, browsers in
                await connection.refresh()
                let originalDetail = connection.detail
                let error = try await expectFailure("Invalid catalog must fail as a whole: \(failure)") { _ = try await connection.listModels() }
                try check(!error.localizedDescription.contains("FAKE_SECRET_CATALOG"), "Catalog errors must be sanitized")
                try check(!error.localizedDescription.contains("Connect Codex") && !error.localizedDescription.contains("Reconnect"),
                          "Catalog failure must not require a new login")
                try check(connection.state == .connected && connection.accountEmail == "fixture@example.test" &&
                          connection.planType == "pro" && connection.detail == originalDetail && !connection.isBusy,
                          "Catalog errors must preserve confirmed account UI: \(failure)")
                try check(browsers() == 0, "Catalog failures must not start sign-in")
                if failure == "endless" {
                    let methods = try String(contentsOf: home.appendingPathComponent("requests.txt"), encoding: .utf8)
                    try check(methods.components(separatedBy: "model/list\n").count - 1 == 20, "Pagination must stop at its page bound")
                }
            }
        }
        try await fixture("models-delayed") { connection, home, _ in
            let catalog = Task { try await connection.listModels() }
            try await wait("Model request must start", for: {
                (try? String(contentsOf: home.appendingPathComponent("requests.txt"), encoding: .utf8))?.contains("model/list\n") == true
            })
            _ = try await expectFailure("A second catalog request must be rejected while busy") { _ = try await connection.listModels() }
            try check(connection.isBusy, "Rejecting a concurrent catalog must not release the first operation")
            await connection.refresh(); await connection.connect(); await connection.disconnect()
            _ = try await catalog.value
            let methods = try String(contentsOf: home.appendingPathComponent("requests.txt"), encoding: .utf8)
            try check(methods == "initialize\nmodel/list\n", "Account actions must not overlap model discovery")
        }
        try await fixture("models-delayed") { connection, home, _ in
            let catalog = Task { try await connection.listModels() }
            try await wait("Model request must start before stopping", for: {
                (try? String(contentsOf: home.appendingPathComponent("requests.txt"), encoding: .utf8))?.contains("model/list\n") == true
            })
            connection.stop()
            _ = try await expectFailure("A stopped generation must not return its catalog") { _ = try await catalog.value }
            try check(connection.state == .idle && !connection.isBusy, "Stopping discovery must leave no busy operation")
            try "connected".write(to: home.appendingPathComponent("scenario.txt"), atomically: true, encoding: .utf8)
            await connection.refresh()
            try check(connection.state == .connected, "Account actions must work after stopped discovery")
        }
        try await fixture("no-account") { connection, home, _ in
            await connection.connect()
            _ = try await expectFailure("Discovery must not race a pending browser login") { _ = try await connection.listModels() }
            try check(connection.state == .awaitingBrowser, "Rejected discovery must preserve pending sign-in")
            let methods = try String(contentsOf: home.appendingPathComponent("requests.txt"), encoding: .utf8)
            try check(!methods.contains("model/list"), "Pending sign-in must not send catalog requests")
        }

        for scenario in ["no-account", "stale-response"] {
            try await fixture(scenario) { connection, home, browsers in
                await connection.refresh()
                try check(connection.state == .idle && connection.accountEmail == nil, "Absent account and stale replies must not become Connected (\(scenario): \(connection.state.rawValue), \(connection.detail))")
                try check(browsers() == 0, "Refreshing connection must not start browser sign-in")
                let permissions = try FileManager.default.attributesOfItem(atPath: home.path)[.posixPermissions] as? NSNumber
                try check(permissions?.intValue == 0o700, "Isolated credential namespace must be private")
            }
        }
        try await fixture("connected") { connection, home, browsers in
            await connection.refresh()
            try check(connection.state == .connected && connection.accountEmail == "fixture@example.test" && connection.planType == "pro", "Account read must populate confirmed metadata")
            try check(browsers() == 0, "Existing app-owned sign-in should not reopen OAuth")
            await connection.disconnect()
            try check(connection.state == .idle && connection.accountEmail == nil && connection.planType == nil, "Logout must clear displayed account only after confirmation")
            let methods = try String(contentsOf: home.appendingPathComponent("requests.txt"), encoding: .utf8)
            try check(methods.contains("account/logout\naccount/read\n"), "Disconnect must confirm account removal")
        }
        for scenario in ["rpc-error", "api-key-account", "boolean-id"] {
            try await fixture(scenario) { connection, _, browsers in
                await connection.refresh()
                try check(connection.state == .failed && connection.accountEmail == nil, "RPC failure, wrong auth mode, or invalid ID must fail closed")
                try check(!connection.detail.contains("FAKE_SECRET") && !connection.detail.contains("FAKE_STATE") && !connection.detail.contains("https://"), "Errors must not expose raw RPC/stderr/authorization details")
                try check(browsers() == 0, "Protocol failure must not open a browser")
            }
        }
        try await fixture("unsafe-auth-url") { connection, _, browsers in
            await connection.connect()
            try check(connection.state == .failed && browsers() == 0, "Untrusted authorization destination must never open")
        }
        try await fixture("login-success") { connection, _, browsers in
            await connection.connect()
            try check(connection.state == .awaitingBrowser && browsers() == 1, "Starting OAuth must wait for browser completion")
            try await wait("Matching completion must confirm the account", for: { connection.state == .connected })
            try check(connection.accountEmail == "fixture@example.test", "Completion alone must not supply account identity")
            await connection.reopenBrowser(); try check(browsers() == 1, "Completed OAuth URL must no longer reopen")
        }
        try await fixture("stale-login") { connection, _, browsers in
            await connection.connect(); try await Task.sleep(nanoseconds: 150_000_000)
            try check(connection.state == .awaitingBrowser && connection.accountEmail == nil, "Unmatched completion and account/updated cannot authenticate")
            await connection.cancelLogin(); try await Task.sleep(nanoseconds: 30_000_000)
            try check(connection.state == .idle && connection.accountEmail == nil, "A completion racing cancellation must not reconnect")
            await connection.reopenBrowser(); try check(browsers() == 1, "Cancelled OAuth URL must not reopen")
        }
        try await fixture("no-account", loginTimeout: 0.06) { connection, _, _ in
            await connection.connect()
            try await wait("Expired browser login must stop and clear its pending attempt", for: { connection.state == .idle && connection.detail.contains("expired") })
            try check(connection.accountEmail == nil && !connection.isBusy, "Timeout must leave a retryable disconnected state")
        }
        try await fixture("malformed-after-connected") { connection, _, _ in
            await connection.refresh()
            try check(connection.state == .connected, "Fixture must first establish an account")
            try await wait("Malformed helper output must clear stale Connected state", for: { connection.state == .failed })
            try check(connection.accountEmail == nil && connection.planType == nil, "Protocol failure must remove stale displayed account metadata")
        }
        try await fixture("delayed-account") { connection, home, browsers in
            let checking = Task { await connection.refresh() }
            try await wait("Fixture must have a pending account request before stopping", for: {
                (try? String(contentsOf: home.appendingPathComponent("requests.txt"), encoding: .utf8))?.contains("account/read\n") == true
            })
            _ = try await expectFailure("Catalog discovery must not race account refresh") { _ = try await connection.listModels() }
            try check(connection.state == .checking && connection.isBusy, "Rejected catalog discovery must preserve the account operation")
            connection.stop(); await checking.value
            try check(connection.state == .idle && connection.accountEmail == nil && !connection.isBusy, "Stopping an in-flight request must clear its state")
            try "connected".write(to: home.appendingPathComponent("scenario.txt"), atomically: true, encoding: .utf8)
            await connection.refresh()
            try check(connection.state == .connected && connection.accountEmail == "fixture@example.test", "A stopped controller must reconnect with a fresh helper generation")
            try check(browsers() == 0, "Stop and refresh must not open OAuth")
        }
        print("Codex connection: \(checks) checks passed; fake child process only, no real credentials, browser, Keychain, or network.")
    }
}
