import Foundation

// Pure settings tests: no NSApplication, network, permission request, model,
// credential, or real meeting directory is used.
@main struct AnalysisPreferencesTests {
    static var checks = 0
    static func check(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
        guard try condition() else { throw NSError(domain: "AnalysisPreferencesTests", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
        checks += 1
    }
    static func rejects(_ message: String, _ action: () throws -> Void) throws {
        do { try action() }
        catch { checks += 1; return }
        throw NSError(domain: "AnalysisPreferencesTests", code: 1, userInfo: [NSLocalizedDescriptionKey: "Expected rejection: \(message)"])
    }
    static func main() throws {
        let defaults = try AnalysisPreferences().validated()
        try check(defaults.networkPolicy == .localOnly, "Default must remain local-only")
        try check(defaults.tasks.transcription.provider == .localQwen, "Qwen must be the default local transcription provider")
        try check(defaults.tasks.vision.provider == .disabled && defaults.tasks.summary.provider == .disabled, "Cloud tasks must default to disabled")
        try check(!defaults.uploads.images && !defaults.uploads.audio && !defaults.uploads.transcriptsAndNotes && !defaults.uploads.contextDocuments, "Uploads must default off")
        try check(defaults.manualAnalysisStart && defaults.pauseDuringRecording && !defaults.automaticFallback, "Scheduling constraints must remain conservative")

        for endpoint in ["https://api.example.test/v1", "http://127.0.0.1:11434", "http://127.1.2.3:8080/v1", "http://localhost:9000", "http://[::1]:11434"] {
            _ = try AnalysisPreferences.validatedEndpoint(endpoint); checks += 1
        }
        for endpoint in ["http://api.example.test/v1", "http://127.0.0.1.example.test", "http://127.999.0.1", "http://localhost.example.test", "https://user:password@api.example.test/v1", "https://user@api.example.test", "https://api.example.test/v1?key=secret", "https://api.example.test/#fragment", "https://api.example.test/#", "ftp://localhost/file", "file:///tmp/provider", "https://", "http://localhost:0", "http://localhost:65536", "https://api.example.test/a b", "https://api.example.test/\n"] {
            try rejects(endpoint) { _ = try AnalysisPreferences.validatedEndpoint(endpoint) }
        }
        try rejects("Local service cannot name a remote host") { _ = try AnalysisPreferences.validatedEndpoint("https://api.example.test", localService: true) }
        _ = try AnalysisPreferences.validatedEndpoint("https://localhost:11434", localService: true); checks += 1

        var configured = defaults
        configured.networkPolicy = .selectedRemoteAllowed
        configured.tasks.vision = .init(provider: .openAICompatible, endpoint: "  https://api.example.test/v1  ", model: "  vision-model  ", authentication: .apiKey)
        configured.tasks.summary = .initial(.anthropicAPI) // Incomplete drafts may be saved; no connector becomes ready.
        configured.uploads.images = true
        let normalized = try configured.validated()
        try check(normalized.tasks.vision.usesRemoteEndpoint, "An API with a remote endpoint requires remote permission")
        let localAPI = AnalysisTaskPreferences(provider: .openAICompatible, endpoint: "http://127.0.0.1:8000/v1", model: "model", authentication: .none)
        try check(!localAPI.usesRemoteEndpoint, "An OpenAI-compatible loopback API must be recognized as local")
        var localSpeech = defaults
        localSpeech.tasks.transcription = .init(provider: .speechAPI, endpoint: "http://127.0.0.1:8000/v1", model: "local-speech-model", authentication: .none)
        _ = try localSpeech.validated(); checks += 1
        try check(!localSpeech.tasks.transcription.usesRemoteEndpoint, "Dedicated loopback STT can use no key")
        let subscription = AnalysisTaskPreferences.initial(.chatGPTPlan)
        try check(subscription.usesRemoteEndpoint, "ChatGPT subscription requires remote permission")
        try check(subscription.authentication == .subscriptionOAuthToken, "Codex / ChatGPT plan must identify subscription OAuth separately from API keys")
        var oauthDraft = defaults; oauthDraft.tasks.summary = subscription
        _ = try oauthDraft.validated(); checks += 1
        oauthDraft.tasks.summary.authentication = .apiKey
        try rejects("Subscription authorization is not API-key authentication") { _ = try oauthDraft.validated() }
        oauthDraft.tasks.summary = .initial(.anthropicAPI); oauthDraft.tasks.summary.authentication = .subscriptionOAuthToken
        try rejects("Subscription tokens cannot be used by an API connector") { _ = try oauthDraft.validated() }
        oauthDraft.tasks.summary = subscription
        oauthDraft.tasks.summary.model = "future-codex-model"
        _ = try oauthDraft.validated(); checks += 1
        let agentSDK = AnalysisTaskPreferences.initial(.claudeAgentSDK)
        try check(AnalysisTask.vision.providers.contains(.claudeAgentSDK) && AnalysisTask.summary.providers.contains(.claudeAgentSDK), "Claude Agent SDK should be a distinct vision and summary option")
        try check(!AnalysisTask.transcription.providers.contains(.claudeAgentSDK), "Claude Agent SDK is not a transcription provider")
        try check(agentSDK.authentication == .claudeCodeOAuthToken && agentSDK.usesRemoteEndpoint, "Claude Code defaults to its own OAuth token and requires remote permission")
        var sdkDraft = defaults; sdkDraft.tasks.summary = agentSDK
        sdkDraft.tasks.summary.model = "claude-model"
        _ = try sdkDraft.validated(); checks += 1
        sdkDraft.tasks.summary.authentication = .apiKey
        _ = try sdkDraft.validated(); checks += 1
        sdkDraft.tasks.summary.authentication = .none
        try rejects("Claude Agent SDK cannot use unauthenticated or subscription access") { _ = try sdkDraft.validated() }
        sdkDraft.tasks.summary = agentSDK; sdkDraft.tasks.summary.endpoint = "https://api.example.test"
        try rejects("Claude Agent SDK endpoint plumbing is not available in this editor") { _ = try sdkDraft.validated() }
        try check(normalized.tasks.vision.endpoint == "https://api.example.test/v1" && normalized.tasks.vision.model == "vision-model", "Saved fields should be trimmed")
        try check(normalized.tasks.summary.endpoint == "https://api.anthropic.com/v1" && normalized.tasks.summary.model.isEmpty, "Anthropic starts with its official endpoint while leaving model selection explicit")
        var wrongToken = defaults; wrongToken.tasks.summary = .initial(.anthropicAPI)
        wrongToken.tasks.summary.authentication = .claudeCodeOAuthToken
        try rejects("Claude Code OAuth token must never be used as an API key") { _ = try wrongToken.validated() }
        wrongToken.tasks.summary = .initial(.chatGPTPlan); wrongToken.tasks.summary.authentication = .claudeCodeOAuthToken
        try rejects("Claude token must not authenticate Codex") { _ = try wrongToken.validated() }
        sdkDraft.tasks.summary = agentSDK
        _ = try sdkDraft.validated(); checks += 1
        var invalid = configured; invalid.tasks.summary.provider = .localWhisper
        try rejects("Task provider mismatch") { _ = try invalid.validated() }
        invalid = configured; invalid.tasks.vision.endpoint = "https://api.example.test?token=secret"
        try rejects("Credential-like query in endpoint") { _ = try invalid.validated() }
        invalid = defaults; invalid.tasks.summary.authentication = .apiKey
        try rejects("Unsupported provider auth") { _ = try invalid.validated() }
        invalid = defaults; invalid.tasks.transcription.model = "model\nname"
        try rejects("Control character in model") { _ = try invalid.validated() }
        invalid = defaults; invalid.automaticFallback = true
        try rejects("Automatic provider fallback") { _ = try invalid.validated() }
        invalid = defaults; invalid.schemaVersion = 2
        try rejects("Unknown schema") { _ = try invalid.validated() }

        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("meeting-analysis-preferences-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = AnalysisPreferencesStore(dataDirectory: directory)
        let missing = try store.load()
        try check(missing == defaults, "Missing preferences should load safe defaults")
        try check(!FileManager.default.fileExists(atPath: store.file.path), "Reading defaults must not create a settings file")
        // A changed default must not silently replace an existing user's choice.
        for provider in [AnalysisProvider.localQwen, .localMiMo, .localWhisper, .speechAPI, .disabled] {
            var stt = defaults
            stt.tasks.transcription = .initial(provider)
            if provider == .localWhisper { stt.tasks.transcription.model = "/models/custom-whisper.bin" }
            if provider == .speechAPI {
                stt.tasks.transcription.endpoint = "https://speech.example.test/v1"
                stt.tasks.transcription.model = "custom-stt"
            }
            _ = try store.save(stt)
            try check(try store.load() == stt, "Explicit STT choices and models must survive loading after the default changes")
        }
        for provider in [AnalysisProvider.localQwen, .localMiMo] {
            var stt = defaults; stt.tasks.transcription = .initial(provider)
            stt.tasks.transcription.authentication = .apiKey
            try rejects("Local STT cannot accept API credentials") { _ = try stt.validated() }
            stt.tasks.transcription = .initial(provider)
            stt.tasks.transcription.endpoint = "https://speech.example.test/v1"
            try rejects("Local STT cannot silently route through a remote endpoint") { _ = try stt.validated() }
            stt.tasks.transcription = .initial(provider); stt.tasks.vision = .initial(provider)
            try rejects("Local STT cannot be selected for visual analysis") { _ = try stt.validated() }
        }
        _ = try store.save(oauthDraft)
        let oauthLoaded = try store.load()
        try check(oauthLoaded.tasks.summary.authentication == .subscriptionOAuthToken, "Subscription OAuth preference must round-trip without token material")
        try check(oauthLoaded.tasks.summary.model == "future-codex-model", "A discovered or custom Codex model choice must survive saving and reloading")
        let saved = try store.save(configured), loaded = try store.load()
        try check(saved == normalized && loaded == normalized, "Preferences should round-trip through the isolated data directory")
        let attributes = try FileManager.default.attributesOfItem(atPath: store.file.path)
        try check((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600, "Settings file should be private to its owner")
        let original = try Data(contentsOf: store.file)
        let object = try JSONSerialization.jsonObject(with: original) as! [String: Any]
        try check(object["apiKey"] == nil && object["credentials"] == nil, "Store must not add credential material")
        try rejects("Invalid settings must not replace previous settings") { _ = try store.save(invalid) }
        try check(try Data(contentsOf: store.file) == original, "Rejected save must preserve the previous file")
        let corrupt = Data("not JSON\n".utf8); try corrupt.write(to: store.file)
        try rejects("Corrupted settings must report an error") { _ = try store.load() }
        try check(try Data(contentsOf: store.file) == corrupt, "Reading corrupt settings must preserve the file")
        let children = try FileManager.default.contentsOfDirectory(atPath: store.directory.path)
        try check(children == ["analysis-preferences.json"], "No temporary files should remain after save")
        print("Analysis preferences: \(checks) checks passed; temporary files only, no permissions or network.")
    }
}
