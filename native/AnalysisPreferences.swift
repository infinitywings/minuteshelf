import AppKit
import Foundation
import Darwin

// Non-secret task preferences. Credentials live only in the macOS Keychain;
// saving settings or signing in never starts meeting analysis.
enum AnalysisTask: String, CaseIterable, Codable {
    case transcription, vision, summary
    var title: String {
        switch self { case .transcription: return "Speech recognition"; case .vision: return "Screen understanding"; case .summary: return "Meeting summaries" }
    }
    var providers: [AnalysisProvider] {
        switch self {
        case .transcription: return [.disabled, .localQwen, .localMiMo, .localWhisper, .speechAPI, .importedTranscript]
        case .vision, .summary: return [.disabled, .chatGPTPlan, .openAICompatible, .anthropicAPI, .claudeAgentSDK, .localService]
        }
    }
}

enum AnalysisProvider: String, Codable {
    case disabled, localWhisper = "local-whisper", speechAPI = "stt-api", importedTranscript = "imported-transcript"
    case localQwen = "local-qwen", localMiMo = "local-mimo"
    case chatGPTPlan = "chatgpt-plan", openAICompatible = "openai-compatible", anthropicAPI = "anthropic-api", localService = "local-service"
    case claudeAgentSDK = "claude-agent-sdk"
    var title: String {
        switch self {
        case .disabled: return "Disabled"
        case .localQwen: return "Local Qwen3-ASR"
        case .localMiMo: return "Local MiMo V2.5-ASR"
        case .localWhisper: return "Local Whisper"
        case .speechAPI: return "Speech-to-text API"
        case .importedTranscript: return "Existing transcript"
        case .chatGPTPlan: return "Codex / ChatGPT plan"
        case .openAICompatible: return "OpenAI-compatible Chat Completions"
        case .anthropicAPI: return "Claude / Anthropic API"
        case .claudeAgentSDK: return "Claude Code / Agent SDK"
        case .localService: return "Local model service"
        }
    }
    var acceptsEndpoint: Bool { [.speechAPI, .openAICompatible, .anthropicAPI, .localService].contains(self) }
    var acceptsModel: Bool { acceptsEndpoint || [.localQwen, .localMiMo, .localWhisper, .claudeAgentSDK, .chatGPTPlan].contains(self) }
    var catalogSource: String? {
        switch self { case .chatGPTPlan: return "codex"; case .claudeAgentSDK, .anthropicAPI: return "claude"; default: return nil }
    }
    var supportsCredential: Bool { acceptsEndpoint || self == .claudeAgentSDK }
    var defaultModel: String {
        switch self {
        case .localQwen: return "mlx-community/Qwen3-ASR-1.7B-4bit"
        case .localMiMo: return "mlx-community/MiMo-V2.5-ASR-MLX"
        case .localWhisper: return "large-v3-turbo"
        default: return ""
        }
    }

    // Suggestions only: selection does not assert that a model is installed or
    // available to the account. Custom IDs and local paths remain valid.
    func modelPresets(for task: AnalysisTask) -> [String] {
        switch self {
        case .localQwen, .localMiMo: return [defaultModel]
        case .localWhisper: return ["large-v3-turbo", "large-v3", "medium", "small"]
        case .claudeAgentSDK: return ["sonnet", "opus", "haiku"]
        case .anthropicAPI: return ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5-20251001"]
        case .localService: return task == .vision ? ["qwen3-vl:4b"] : ["qwen3:8b"]
        // Generic endpoints can serve arbitrary models. Keep their custom input
        // rather than implying that one vendor's model catalog applies to all.
        default: return []
        }
    }
}

enum AnalysisAuthentication: String, Codable { case none, apiKey = "api-key", subscriptionOAuthToken = "subscription-oauth-token", claudeCodeOAuthToken = "claude-code-oauth-token" }
enum AnalysisNetworkPolicy: String, Codable { case localOnly = "local-only", selectedRemoteAllowed = "selected-remote-allowed" }

struct AnalysisTaskPreferences: Codable, Equatable {
    var provider: AnalysisProvider
    var endpoint: String
    var model: String
    var authentication: AnalysisAuthentication
    var usesRemoteEndpoint: Bool {
        if provider == .chatGPTPlan || provider == .claudeAgentSDK { return true }
        guard provider.acceptsEndpoint, let host = URLComponents(string: endpoint.trimmingCharacters(in: .whitespacesAndNewlines))?.host else { return false }
        return !AnalysisPreferences.isLoopbackHost(host)
    }
    static func initial(_ provider: AnalysisProvider) -> Self {
        .init(provider: provider,
              endpoint: provider == .localService ? "http://127.0.0.1:11434" : provider == .anthropicAPI ? "https://api.anthropic.com/v1" : "",
              model: provider.defaultModel,
              authentication: provider == .chatGPTPlan ? .subscriptionOAuthToken : provider == .claudeAgentSDK ? .claudeCodeOAuthToken
                : provider.supportsCredential && provider != .localService ? .apiKey : .none)
    }
}

struct AnalysisTaskRouting: Codable, Equatable {
    // Applies to new preferences only. Decoding preserves an existing explicit
    // Whisper/API/disabled selection and its model, endpoint, and auth choices.
    var transcription = AnalysisTaskPreferences.initial(.localQwen)
    var vision = AnalysisTaskPreferences.initial(.disabled)
    var summary = AnalysisTaskPreferences.initial(.disabled)
    subscript(task: AnalysisTask) -> AnalysisTaskPreferences {
        get { switch task { case .transcription: return transcription; case .vision: return vision; case .summary: return summary } }
        set { switch task { case .transcription: transcription = newValue; case .vision: vision = newValue; case .summary: summary = newValue } }
    }
}

struct AnalysisUploadPreferences: Codable, Equatable {
    var images = false
    var audio = false
    var transcriptsAndNotes = false
    var contextDocuments = false
}

struct AnalysisPreferences: Codable, Equatable {
    var schemaVersion = 1
    var tasks = AnalysisTaskRouting()
    var networkPolicy = AnalysisNetworkPolicy.localOnly
    var uploads = AnalysisUploadPreferences()
    var manualAnalysisStart = true
    var pauseDuringRecording = true
    var automaticFallback = false

    func validated() throws -> Self {
        guard schemaVersion == 1 else { throw analysisPreferenceError("This settings version is not supported. The original file has been preserved.") }
        guard manualAnalysisStart && pauseDuringRecording && !automaticFallback else {
            throw analysisPreferenceError("Analysis must start manually, pause during recording, and use no automatic provider fallback.")
        }
        var result = self
        for task in AnalysisTask.allCases {
            var value = result.tasks[task]
            guard task.providers.contains(value.provider) else { throw analysisPreferenceError("The selected provider is not supported for \(task.title.lowercased()).") }
            value.endpoint = value.endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
            value.model = value.model.trimmingCharacters(in: .whitespacesAndNewlines)
            guard value.endpoint.count <= 2048 && value.model.count <= 500 else { throw analysisPreferenceError("An endpoint or model name is too long.") }
            guard !value.model.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw analysisPreferenceError("Model names cannot contain control characters.") }
            if !value.provider.acceptsEndpoint && !value.endpoint.isEmpty { throw analysisPreferenceError("\(task.title) does not use an API endpoint with this provider.") }
            if !value.provider.acceptsModel && !value.model.isEmpty { throw analysisPreferenceError("\(task.title) does not use a model field with this provider.") }
            if value.provider == .chatGPTPlan {
                guard value.authentication == .subscriptionOAuthToken else { throw analysisPreferenceError("The Codex / ChatGPT plan connection requires ChatGPT sign-in, not an API key.") }
            } else if value.authentication == .subscriptionOAuthToken {
                throw analysisPreferenceError("ChatGPT sign-in applies only to the Codex / ChatGPT plan connection.")
            } else if value.authentication == .claudeCodeOAuthToken && value.provider != .claudeAgentSDK {
                throw analysisPreferenceError("Claude Code OAuth tokens apply only to the Claude Code / Agent SDK provider. They are not API keys.")
            } else if !value.provider.supportsCredential && value.authentication != .none { throw analysisPreferenceError("This provider does not accept an API key.") }
            if value.provider == .claudeAgentSDK && ![.apiKey, .claudeCodeOAuthToken].contains(value.authentication) { throw analysisPreferenceError("Claude Code requires its own OAuth token or an Anthropic API key.") }
            if value.provider == .anthropicAPI && value.authentication != .apiKey { throw analysisPreferenceError("This API provider requires API-key authentication.") }
            if !value.endpoint.isEmpty { _ = try Self.validatedEndpoint(value.endpoint, localService: value.provider == .localService) }
            result.tasks[task] = value
        }
        return result
    }

    static func isLoopbackHost(_ host: String) -> Bool {
        let value = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if value == "localhost" || value == "::1" { return true }
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        return parts.count == 4 && parts[0] == "127" && parts.allSatisfy { part in
            !part.isEmpty && part.allSatisfy(\.isNumber) && Int(part).map { (0...255).contains($0) } == true
        }
    }

    static func validatedEndpoint(_ text: String, localService: Bool = false) throws -> URL {
        guard !text.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.contains($0) || CharacterSet.controlCharacters.contains($0) }),
              let components = URLComponents(string: text), let scheme = components.scheme?.lowercased(),
              ["https", "http"].contains(scheme), let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil, components.query == nil, components.fragment == nil,
              let url = components.url else {
            throw analysisPreferenceError("Use an HTTP or HTTPS endpoint without a username, password, query, or fragment. Credentials do not belong in this field.")
        }
        if let port = components.port, !(1...65535).contains(port) { throw analysisPreferenceError("The endpoint port must be between 1 and 65535.") }
        let loopback = isLoopbackHost(host)
        guard scheme == "https" || loopback else { throw analysisPreferenceError("Remote endpoints require HTTPS. HTTP is allowed only for a loopback address on this Mac.") }
        guard !localService || loopback else { throw analysisPreferenceError("A local model service must use localhost or a loopback IP address.") }
        return url
    }
}

private func analysisPreferenceError(_ message: String) -> NSError {
    NSError(domain: "MeetingArchive.AnalysisPreferences", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}

struct AnalysisPreferencesStore {
    let dataDirectory: URL
    var directory: URL { dataDirectory.appendingPathComponent("settings", isDirectory: true) }
    var file: URL { directory.appendingPathComponent("analysis-preferences.json") }

    func load() throws -> AnalysisPreferences {
        let manager = FileManager.default
        guard manager.fileExists(atPath: file.path) else { return AnalysisPreferences() }
        let attributes = try manager.attributesOfItem(atPath: file.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              (attributes[.size] as? NSNumber)?.intValue ?? Int.max <= 65536 else { throw analysisPreferenceError("Analysis settings must be a regular file smaller than 64 KB.") }
        let value = try JSONDecoder().decode(AnalysisPreferences.self, from: Data(contentsOf: file))
        return try value.validated()
    }

    @discardableResult func save(_ preferences: AnalysisPreferences) throws -> AnalysisPreferences {
        let value = try preferences.validated(), manager = FileManager.default
        try manager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        guard try manager.attributesOfItem(atPath: directory.path)[.type] as? FileAttributeType == .typeDirectory else {
            throw analysisPreferenceError("The settings directory must not be a symbolic link.")
        }
        if manager.fileExists(atPath: file.path), try manager.attributesOfItem(atPath: file.path)[.type] as? FileAttributeType != .typeRegular {
            throw analysisPreferenceError("The settings file must not be a symbolic link or a directory.")
        }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        var data = try encoder.encode(value); data.append(0x0a)
        let temporary = directory.appendingPathComponent(".analysis-preferences-\(UUID().uuidString).tmp")
        defer { try? manager.removeItem(at: temporary) }
        guard manager.createFile(atPath: temporary.path, contents: data, attributes: [.posixPermissions: 0o600]) else { throw analysisPreferenceError("Could not write the analysis settings.") }
        let handle = try FileHandle(forWritingTo: temporary); try handle.synchronize(); try handle.close()
        guard rename(temporary.path, file.path) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        return value
    }
}

@MainActor private func analysisLabel(_ text: String, secondary: Bool = false) -> NSTextField {
    let label = NSTextField(wrappingLabelWithString: text)
    label.font = .systemFont(ofSize: secondary ? 11 : 13)
    label.textColor = secondary ? .secondaryLabelColor : .labelColor
    label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    return label
}

@MainActor private final class AnalysisPreferencesDocumentView: NSView {
    // A scroll view starts at y=0. A flipped document makes that the top of this
    // long form rather than its bottom when the Settings tab first appears.
    override var isFlipped: Bool { true }
}

@MainActor private final class AnalysisTaskPreferenceEditor: NSView, NSComboBoxDelegate {
    let task: AnalysisTask
    let provider = NSPopUpButton(frame: .zero, pullsDown: false)
    let endpoint = NSTextField(string: "")
    let model = NSComboBox(frame: .zero)
    let authentication = NSPopUpButton(frame: .zero, pullsDown: false)
    private let credentials = analysisLabel("", secondary: true)
    private let credentialInput = NSSecureTextField(string: "")
    private let saveCredential = NSButton(title: "Save Key", target: nil, action: nil)
    private let deleteCredential = NSButton(title: "Delete Key", target: nil, action: nil)
    private let authorizeCredential = NSButton(title: "Authorize Access…", target: nil, action: nil)
    private let codexShortcut = NSButton(title: "Connect Codex…", target: nil, action: nil)
    private let codexAuthenticationLabel = analysisLabel("ChatGPT sign-in")
    private let credentialRow = NSStackView()
    private let credentialStore = AnalysisCredentialStore()
    private let dataDirectory: URL
    private var checkedScope: AnalysisCredentialScope?
    private var checkedScopeID = ""
    private var hasSavedCredential = false
    private var credentialReadable = false
    private var credentialStatusKnown = true
    private var credentialBusy = false
    private var credentialProbeGeneration = UUID()
    private let status = analysisLabel("", secondary: true)
    private let catalogStatus = analysisLabel("", secondary: true)
    private let refreshModels = NSButton(title: "Refresh Models", target: nil, action: nil)
    private var interactionEnabled = true
    private var applyingValue = false
    private var catalogLoading = false
    private var discoveredModels: [String: [ModelCatalogEntry]] = [:]
    private var catalogMessages: [String: String] = [:]
    var onChange: (() -> Void)?
    var onRequestModels: ((Bool) -> Void)?
    var onConnectCodex: (() -> Void)?
    init(task: AnalysisTask, dataDirectory: URL) {
        self.task = task; self.dataDirectory = dataDirectory; super.init(frame: .zero)
        for value in task.providers { provider.addItem(withTitle: value.title); provider.lastItem?.representedObject = value.rawValue }
        provider.target = self; provider.action = #selector(providerChanged)
        for (title, value) in [("None", AnalysisAuthentication.none), ("API key", .apiKey), ("ChatGPT sign-in", .subscriptionOAuthToken), ("Claude Code OAuth token", .claudeCodeOAuthToken)] {
            authentication.addItem(withTitle: title); authentication.lastItem?.representedObject = value.rawValue
        }
        authentication.target = self; authentication.action = #selector(changed)
        endpoint.placeholderString = "https://your-provider.example/v1"; endpoint.delegate = self
        model.placeholderString = "Choose or enter a model"; model.delegate = self
        model.isEditable = true; model.completes = false; model.numberOfVisibleItems = 6
        model.target = self; model.action = #selector(changed)
        model.toolTip = "Choose a preset or enter a custom model ID or local path. Presets do not confirm installation or account access."
        model.setContentHuggingPriority(.defaultLow, for: .horizontal)
        model.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        endpoint.setAccessibilityLabel("\(task.title) endpoint"); model.setAccessibilityLabel("\(task.title) model")
        provider.setAccessibilityLabel("\(task.title) provider"); authentication.setAccessibilityLabel("\(task.title) authentication")
        credentialInput.placeholderString = "Enter API key"; credentialInput.delegate = self
        credentialInput.setAccessibilityLabel("\(task.title) credential")
        credentialInput.setContentHuggingPriority(.defaultLow, for: .horizontal)
        credentialInput.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        credentialRow.orientation = .horizontal; credentialRow.spacing = 8; credentialRow.alignment = .centerY
        for item in [credentialInput, saveCredential, deleteCredential, authorizeCredential] { credentialRow.addArrangedSubview(item) }
        saveCredential.target = self; saveCredential.action = #selector(saveCredentialPressed)
        deleteCredential.target = self; deleteCredential.action = #selector(deleteCredentialPressed)
        authorizeCredential.target = self; authorizeCredential.action = #selector(authorizeCredentialPressed)
        authorizeCredential.toolTip = "Ask macOS to allow this version of MinuteShelf and its background helper to use the saved credential. The token stays in Keychain."
        codexShortcut.target = self; codexShortcut.action = #selector(connectCodexPressed)
        for button in [saveCredential, deleteCredential, authorizeCredential, codexShortcut] { button.bezelStyle = .rounded }
        let authRow = NSStackView(views: [authentication, codexAuthenticationLabel, codexShortcut]); authRow.orientation = .horizontal; authRow.spacing = 8
        authentication.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let grid = NSGridView(views: [
            [analysisLabel("Provider"), provider], [analysisLabel("Endpoint"), endpoint],
            [analysisLabel("Model"), model], [analysisLabel("Authentication"), authRow]
        ])
        grid.rowSpacing = 8; grid.columnSpacing = 12
        grid.column(at: 0).xPlacement = .trailing; grid.column(at: 1).xPlacement = .fill
        grid.column(at: 0).width = 98
        refreshModels.bezelStyle = .rounded; refreshModels.target = self; refreshModels.action = #selector(refreshModelList)
        let catalogRow = NSStackView(views: [refreshModels, catalogStatus]); catalogRow.orientation = .horizontal; catalogRow.alignment = .centerY; catalogRow.spacing = 10
        catalogStatus.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let stack = NSStackView(views: [grid, credentialRow, credentials, catalogRow, status]); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 8
        addSubview(stack); stack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([stack.topAnchor.constraint(equalTo: topAnchor), stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor), stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            grid.widthAnchor.constraint(equalTo: stack.widthAnchor), credentialRow.widthAnchor.constraint(equalTo: stack.widthAnchor), catalogRow.widthAnchor.constraint(equalTo: stack.widthAnchor), credentials.widthAnchor.constraint(equalTo: stack.widthAnchor), status.widthAnchor.constraint(equalTo: stack.widthAnchor)])
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    var value: AnalysisTaskPreferences {
        .init(provider: AnalysisProvider(rawValue: provider.selectedItem?.representedObject as? String ?? "") ?? .disabled,
              endpoint: endpoint.stringValue, model: model.stringValue,
              authentication: AnalysisAuthentication(rawValue: authentication.selectedItem?.representedObject as? String ?? "") ?? .none)
    }
    func set(_ value: AnalysisTaskPreferences) {
        applyingValue = true
        defer { applyingValue = false }
        provider.selectItem(at: task.providers.firstIndex(of: value.provider) ?? 0)
        endpoint.stringValue = value.endpoint
        populateModels(provider: value.provider, preserving: value.model)
        authentication.selectItem(at: authentication.itemArray.firstIndex(where: { $0.representedObject as? String == value.authentication.rawValue }) ?? 0)
        updateControls()
    }
    private func populateModels(provider: AnalysisProvider, preserving current: String) {
        model.removeAllItems()
        let presets = provider.catalogSource.flatMap { discoveredModels[$0] }?.filter {
            (provider != .anthropicAPI || $0.id.hasPrefix("claude-")) &&
            (task != .vision || $0.inputModalities.isEmpty || $0.inputModalities.contains("image"))
        }.map(\.id) ?? provider.modelPresets(for: task)
        model.addItems(withObjectValues: presets)
        if !current.isEmpty && !presets.contains(current) { model.addItem(withObjectValue: current) }
        model.stringValue = current
        model.placeholderString = presets.isEmpty ? "Enter your provider's model ID" : "Choose or enter a model"
    }
    func setCatalog(source: String, models: [ModelCatalogEntry]?, message: String, loading: Bool) {
        if let models { discoveredModels[source] = models }
        catalogMessages[source] = message
        guard value.provider.catalogSource == source else { return }
        applyingValue = true
        defer { applyingValue = false }
        catalogLoading = loading
        let current = model.stringValue
        populateModels(provider: value.provider, preserving: current)
        updateControls()
    }
    private func updateControls() {
        let selected = value.provider
        let available = interactionEnabled && !credentialBusy
        provider.isEnabled = available
        endpoint.isEnabled = available && selected.acceptsEndpoint; model.isEnabled = available && selected.acceptsModel
        authentication.isEnabled = available && selected.supportsCredential
        authentication.isHidden = selected == .chatGPTPlan; codexAuthenticationLabel.isHidden = selected != .chatGPTPlan
        authentication.item(at: 2)?.isHidden = selected != .chatGPTPlan
        authentication.item(at: 3)?.isHidden = selected != .claudeAgentSDK
        authentication.item(at: 0)?.isHidden = [.claudeAgentSDK, .anthropicAPI].contains(selected)
        codexShortcut.isHidden = selected != .chatGPTPlan; codexShortcut.isEnabled = available
        let needsCredential = selected.supportsCredential && value.authentication != .none
        credentialRow.isHidden = !needsCredential; credentials.isHidden = !needsCredential
        let token = value.authentication == .claudeCodeOAuthToken
        credentialInput.placeholderString = token ? "Enter Claude Code OAuth token" : "Enter API key"
        saveCredential.title = token ? "Save Token" : "Save Key"; deleteCredential.title = token ? "Delete Token" : "Delete Key"
        refreshCredentialState()
        credentialInput.isEnabled = available && checkedScope != nil
        saveCredential.isEnabled = available && checkedScope != nil && !credentialInput.stringValue.isEmpty
        deleteCredential.isEnabled = available && checkedScope != nil && hasSavedCredential
        authorizeCredential.isHidden = credentialReadable || (!hasSavedCredential && credentialStatusKnown)
        authorizeCredential.isEnabled = available && checkedScope != nil
        refreshModels.isHidden = selected.catalogSource == nil
        catalogStatus.isHidden = selected.catalogSource == nil
        refreshModels.isEnabled = available && !catalogLoading
        refreshModels.title = catalogLoading ? "Refreshing…" : "Refresh Models"
        catalogStatus.stringValue = selected.catalogSource.flatMap { catalogMessages[$0] } ?? "Model names load automatically. No meeting content is sent."
    }
    private func refreshCredentialState(force: Bool = false) {
        let current = value
        let id = [current.provider.rawValue, current.authentication.rawValue, current.endpoint].joined(separator: "\n")
        guard force || id != checkedScopeID else { return }
        checkedScopeID = id; checkedScope = nil; hasSavedCredential = false; credentialReadable = false; credentialStatusKnown = true
        credentialProbeGeneration = UUID(); let generation = credentialProbeGeneration
        // Never carry a typed secret across provider/auth/endpoint changes.
        credentialInput.stringValue = ""
        guard current.provider.supportsCredential, current.authentication != .none else { return }
        do {
            let scope = try AnalysisCredentialScope(dataDirectory: dataDirectory, task: task.rawValue,
                provider: current.provider.rawValue, endpoint: current.endpoint, authentication: current.authentication.rawValue)
            checkedScope = scope
            hasSavedCredential = try credentialStore.contains(scope)
            credentials.stringValue = hasSavedCredential
                ? "Saved in macOS Keychain. Checking background access…"
                : current.authentication == .claudeCodeOAuthToken
                    ? "No token saved. Use a Claude Code OAuth token from the official Claude Code login flow; this is separate from an API key."
                    : "No key saved for this task and endpoint. Keys are stored in macOS Keychain, never in the preferences file."
            if hasSavedCredential {
                Task { [weak self] in
                    guard let self else { return }
                    do {
                        let state = try await AnalysisCredentialProbe.status(scope, dataDirectory: self.dataDirectory)
                        guard self.credentialProbeGeneration == generation else { return }
                        self.hasSavedCredential = state.stored; self.credentialReadable = state.readable
                        self.credentials.stringValue = state.readable
                            ? "Saved in macOS Keychain. Background access verified for this version of MinuteShelf."
                            : state.stored
                                ? "Saved, but background access is unavailable. Unlock your login Keychain and choose Authorize Access."
                                : "No credential is saved for this task and provider."
                    } catch {
                        guard self.credentialProbeGeneration == generation else { return }
                        self.credentialStatusKnown = false; self.credentials.stringValue = error.localizedDescription
                    }
                    self.updateControls()
                }
            }
        } catch { credentialStatusKnown = false; credentials.stringValue = error.localizedDescription }
    }
    @objc private func saveCredentialPressed() {
        guard interactionEnabled, let scope = checkedScope else { return }
        do {
            try credentialStore.save(credentialInput.stringValue, scope: scope)
            credentialInput.stringValue = ""; refreshCredentialState(force: true); updateControls()
        } catch { credentials.stringValue = error.localizedDescription }
    }
    @objc private func deleteCredentialPressed() {
        guard interactionEnabled, let scope = checkedScope else { return }
        do { try credentialStore.delete(scope); refreshCredentialState(force: true); updateControls() }
        catch { credentials.stringValue = error.localizedDescription }
    }
    @objc private func authorizeCredentialPressed() {
        guard interactionEnabled, !credentialBusy, let scope = checkedScope else { return }
        credentialBusy = true; credentialProbeGeneration = UUID(); updateControls()
        credentials.stringValue = "Complete the macOS Keychain prompt to authorize this app version."
        Task { [weak self] in
            guard let self else { return }
            do {
                let store = self.credentialStore
                try await Task.detached(priority: .userInitiated) { try store.authorize(scope) }.value
                self.credentialBusy = false; self.refreshCredentialState(force: true); self.updateControls()
            } catch {
                self.credentialBusy = false; self.updateControls(); self.credentials.stringValue = error.localizedDescription
            }
        }
    }
    @objc private func connectCodexPressed() { onConnectCodex?() }
    func setInteractionEnabled(_ enabled: Bool) { interactionEnabled = enabled; updateControls() }
    func updateStatus(policy: AnalysisNetworkPolicy) {
        let current = value
        switch current.provider {
        case .disabled: status.stringValue = "Disabled. No analysis runs for this task."
        case .chatGPTPlan: status.stringValue = "Uses the Codex account connection above. Choose Analyze in a saved meeting to begin. Connecting does not upload meeting content."
        case .claudeAgentSDK: status.stringValue = "Uses the official local Claude Code runtime with its own OAuth token or an Anthropic API key. Install Claude Code first. Meeting content is sent only when you start analysis and allow the selected sources."
        case .importedTranscript: status.stringValue = "Paste transcript text or JSON segments in the saved meeting's Analysis panel before starting. Plain text uses the whole meeting as its evidence time range."
        case .localQwen: status.stringValue = "Default local option for Chinese and English transcription. Requires the local MLX runtime and model. Saving preferences does not download models or start analysis."
        case .localMiMo: status.stringValue = "Optional local transcription model. Requires the local MLX runtime and model. Saving preferences does not download models or start analysis."
        case .localWhisper: status.stringValue = "Uses the local whisper.cpp runtime and model. Install both before starting analysis."
        default:
            status.stringValue = current.endpoint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || current.model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? "Add an endpoint and model before starting analysis."
                : "Use Save Preferences to keep these choices, then choose Analyze in a saved meeting."
        }
        if policy == .localOnly && current.usesRemoteEndpoint { status.stringValue += " Remote use is blocked by the local-only preference." }
    }
    @objc private func providerChanged() { catalogLoading = false; set(.initial(value.provider)); onChange?(); onRequestModels?(false) }
    @objc private func refreshModelList() { onRequestModels?(true) }
    @objc private func changed() { updateControls(); onChange?() }
    func controlTextDidChange(_ obj: Notification) {
        if obj.object as? NSSecureTextField === credentialInput { updateControls(); return }
        onChange?()
    }
    func comboBoxSelectionDidChange(_ notification: Notification) {
        guard !applyingValue else { return }
        // Selection notifications may precede the field editor's text commit.
        // Apply the chosen value before validation reads the current settings.
        if let selected = model.objectValueOfSelectedItem as? String { model.stringValue = selected }
        onChange?()
    }
}

@MainActor final class AnalysisPreferencesViewController: NSViewController {
    private let store: AnalysisPreferencesStore
    private let catalogStore: ModelCatalogStore
    private let codex: CodexConnection
    private let claudeModels = ClaudeModelDiscovery()
    private var catalogs: [String: ModelCatalogSnapshot] = [:]
    private var catalogTasks: [String: Task<Void, Never>] = [:]
    private var publishedCatalogTask: Task<[ModelCatalogEntry], Error>?
    private var catalogAttempts: [String: Date] = [:]
    private var catalogMessages: [String: String] = [:]
    private var lastCatalogAccount: String?
    private let codexStatus = analysisLabel("Not connected")
    private let codexAccount = analysisLabel("", secondary: true)
    private let codexDetail = analysisLabel("Sign in with ChatGPT to connect your Codex subscription.", secondary: true)
    private let connectCodex = NSButton(title: "Connect Codex", target: nil, action: nil)
    private let cancelCodex = NSButton(title: "Cancel Sign-In", target: nil, action: nil)
    private let openCodexBrowser = NSButton(title: "Open Browser", target: nil, action: nil)
    private let refreshCodex = NSButton(title: "Check Connection", target: nil, action: nil)
    private let disconnectCodex = NSButton(title: "Disconnect", target: nil, action: nil)
    private let codexPrimaryActions = NSStackView()
    private var codexRequestInFlight = false
    private var codexStopped = false
    private var codexActionTask: Task<Void, Never>?
    private var editors: [AnalysisTask: AnalysisTaskPreferenceEditor] = [:]
    private let policy = NSPopUpButton(frame: .zero, pullsDown: false)
    private let images = NSButton(checkboxWithTitle: "Allow selected screen images", target: nil, action: nil)
    private let audio = NSButton(checkboxWithTitle: "Allow selected audio", target: nil, action: nil)
    private let transcripts = NSButton(checkboxWithTitle: "Allow selected transcripts and notes", target: nil, action: nil)
    private let context = NSButton(checkboxWithTitle: "Allow selected context documents", target: nil, action: nil)
    private let save = NSButton(title: "Save Preferences", target: nil, action: nil)
    private let message = analysisLabel("Choose providers, save credentials, and start analysis from a saved meeting.", secondary: true)
    private var loadFailed = false
    private var interactionEnabled = true
    var settingsFile: URL { store.file }
    var localSTTRequest: ((Bool) async throws -> [String: Any])?
    private let installLocalSTT = NSButton(title: "Install / Update Local STT…", target: nil, action: nil)
    private let speechSetupStatus = analysisLabel("Install the saved speech model separately from meeting analysis.", secondary: true)
    private let speechSetupRow = NSStackView()
    private var speechSetupBusy = false
    private var speechSetupBlocked = false
    private var speechSetupPoll: Task<Void, Never>?
    init(dataDirectory: URL) {
        store = AnalysisPreferencesStore(dataDirectory: dataDirectory)
        catalogStore = ModelCatalogStore(dataDirectory: dataDirectory)
        codex = CodexConnection(dataDirectory: dataDirectory,
            executableURL: Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/codex"))
        super.init(nibName: nil, bundle: nil)
        // Constructing Settings neither starts Codex nor checks account state.
        codex.onChange = { [weak self] in self?.updateCodexConnection() }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func loadView() {
        view = NSView(frame: NSRect(x: 0, y: 0, width: 640, height: 570))
        let scroll = NSScrollView(); scroll.hasVerticalScroller = true; scroll.drawsBackground = false
        let document = AnalysisPreferencesDocumentView(); document.translatesAutoresizingMaskIntoConstraints = false; scroll.documentView = document
        let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 16
        document.addSubview(stack); stack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor), stack.topAnchor.constraint(equalTo: document.topAnchor, constant: 18),
            stack.leadingAnchor.constraint(equalTo: document.leadingAnchor, constant: 18), stack.trailingAnchor.constraint(equalTo: document.trailingAnchor, constant: -18),
            stack.bottomAnchor.constraint(equalTo: document.bottomAnchor, constant: -18)])
        func add(_ child: NSView) { stack.addArrangedSubview(child); child.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
        func section(_ title: String, content: NSView) -> NSStackView {
            let heading = analysisLabel(title); heading.font = .systemFont(ofSize: 14, weight: .semibold)
            let group = NSStackView(views: [heading, content]); group.orientation = .vertical; group.alignment = .leading; group.spacing = 10
            // NSBox does not infer its height from a custom content view's
            // internal constraints. Ordinary section stacks let every field
            // contribute to the document height and prevent overlapping forms.
            NSLayoutConstraint.activate([heading.widthAnchor.constraint(equalTo: group.widthAnchor), content.widthAnchor.constraint(equalTo: group.widthAnchor)])
            return group
        }
        let intro = analysisLabel("Connect your Codex account and choose a provider for each task. Saving preferences does not start analysis or upload meeting content.")
        add(intro)
        add(section("Codex Account", content: buildCodexConnection()))
        for task in AnalysisTask.allCases {
            let editor = AnalysisTaskPreferenceEditor(task: task, dataDirectory: store.dataDirectory); editors[task] = editor
            editor.onChange = { [weak self] in self?.changed() }
            editor.onConnectCodex = { [weak self, weak scroll] in
                guard let self else { return }
                scroll?.contentView.scroll(to: .zero)
                if let scroll { scroll.reflectScrolledClipView(scroll.contentView) }
                if self.codex.state == .connected { self.performCodexAction(.refresh) }
                else { self.performCodexAction(.connect) }
            }
            editor.onRequestModels = { [weak self, weak editor] force in
                guard let self, let editor else { return }
                self.refreshCatalog(for: editor.value.provider, force: force)
            }
            if task == .transcription {
                installLocalSTT.bezelStyle = .rounded; installLocalSTT.target = self; installLocalSTT.action = #selector(installSpeechRuntime)
                speechSetupRow.orientation = .vertical; speechSetupRow.alignment = .leading; speechSetupRow.spacing = 8
                speechSetupRow.addArrangedSubview(installLocalSTT); speechSetupRow.addArrangedSubview(speechSetupStatus)
                let speech = NSStackView(views: [editor, speechSetupRow]); speech.orientation = .vertical; speech.alignment = .leading; speech.spacing = 10
                editor.widthAnchor.constraint(equalTo: speech.widthAnchor).isActive = true
                speechSetupRow.widthAnchor.constraint(equalTo: speech.widthAnchor).isActive = true
                speechSetupStatus.widthAnchor.constraint(equalTo: speechSetupRow.widthAnchor).isActive = true
                add(section(task.title, content: speech))
            } else { add(section(task.title, content: editor)) }
        }
        policy.addItems(withTitles: ["Local only", "Allow selected remote providers"])
        policy.target = self; policy.action = #selector(preferenceChanged)
        for button in [images, audio, transcripts, context] { button.target = self; button.action = #selector(preferenceChanged) }
        let manual = NSButton(checkboxWithTitle: "Start analysis manually", target: nil, action: nil); manual.state = .on; manual.isEnabled = false
        let pause = NSButton(checkboxWithTitle: "Pause analysis during a new recording", target: nil, action: nil); pause.state = .on; pause.isEnabled = false
        let fallback = NSButton(checkboxWithTitle: "Automatically fall back to another provider", target: nil, action: nil); fallback.state = .off; fallback.isEnabled = false
        let uploadHint = analysisLabel("These choices do not upload anything. Analysis honors the selected sources and network policy when you start it from a saved meeting.", secondary: true)
        let privacy = NSStackView(views: [policy, images, audio, transcripts, context, uploadHint, manual, pause, fallback])
        privacy.orientation = .vertical; privacy.alignment = .leading; privacy.spacing = 8
        uploadHint.widthAnchor.constraint(equalTo: privacy.widthAnchor).isActive = true
        add(section("Privacy and scheduling", content: privacy))
        add(analysisLabel("API keys and Claude Code OAuth tokens are stored in macOS Keychain. Each task, provider, authentication method, and endpoint has its own credential. Codex uses a separate ChatGPT account connection.", secondary: true))
        let location = analysisLabel("Saved on this Mac: \(store.file.path)", secondary: true); location.isSelectable = true; add(location)
        let footer = NSStackView(views: [message, save]); footer.orientation = .horizontal; footer.spacing = 16; footer.alignment = .centerY
        message.setContentHuggingPriority(.defaultLow, for: .horizontal)
        save.target = self; save.action = #selector(savePreferences)
        view.addSubview(scroll); view.addSubview(footer)
        scroll.translatesAutoresizingMaskIntoConstraints = false; footer.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([scroll.topAnchor.constraint(equalTo: view.topAnchor), scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor), scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: footer.topAnchor, constant: -10), footer.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 18),
            footer.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -18), footer.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -14)])
        do { apply(try store.load()) }
        catch { loadFailed = true; apply(AnalysisPreferences()); save.isEnabled = false; message.stringValue = "Could not read saved preferences. Existing file preserved. \(error.localizedDescription)" }
        for source in ["codex", "claude"] {
            if let snapshot = try? catalogStore.load(source) {
                catalogs[source] = snapshot
                catalogMessages[source] = "Saved \(snapshot.origin ?? "runtime") catalog from \(catalogDate(snapshot.fetchedAt)). Account access is not verified."
            }
            renderCatalog(source)
        }
        scroll.contentView.scroll(to: .zero); scroll.reflectScrolledClipView(scroll.contentView)
    }
    private func apply(_ value: AnalysisPreferences) {
        for task in AnalysisTask.allCases { editors[task]?.set(value.tasks[task]) }
        policy.selectItem(at: value.networkPolicy == .localOnly ? 0 : 1)
        images.state = value.uploads.images ? .on : .off; audio.state = value.uploads.audio ? .on : .off
        transcripts.state = value.uploads.transcriptsAndNotes ? .on : .off; context.state = value.uploads.contextDocuments ? .on : .off
        updateStatus()
    }
    private var selectedPolicy: AnalysisNetworkPolicy { policy.indexOfSelectedItem == 0 ? .localOnly : .selectedRemoteAllowed }
    private func updateStatus() {
        for editor in editors.values { editor.updateStatus(policy: selectedPolicy); editor.setInteractionEnabled(interactionEnabled) }
        policy.isEnabled = interactionEnabled; save.isEnabled = interactionEnabled && !loadFailed
        for button in [images, audio, transcripts, context] { button.isEnabled = interactionEnabled && selectedPolicy == .selectedRemoteAllowed }
        updateCodexConnection()
        updateSpeechSetupControls()
    }
    func setInteractionEnabled(_ enabled: Bool) { interactionEnabled = enabled; if isViewLoaded { updateStatus() } }
    private func changed() { updateStatus(); if !loadFailed { message.stringValue = "Unsaved preferences. Saving does not start meeting analysis." } }
    private func catalogDate(_ date: Date) -> String {
        DateFormatter.localizedString(from: date, dateStyle: .short, timeStyle: .short)
    }
    private func renderCatalog(_ source: String) {
        for editor in editors.values {
            editor.setCatalog(source: source, models: catalogs[source]?.models,
                message: catalogMessages[source] ?? "Model names load automatically. No meeting content is sent.",
                loading: catalogTasks[source] != nil)
        }
    }
    func refreshModelCatalogsIfNeeded() {
        guard isViewLoaded else { return }
        refreshSpeechSetup()
        for editor in editors.values { refreshCatalog(for: editor.value.provider, force: false) }
    }
    private func refreshCatalog(for provider: AnalysisProvider, force: Bool) {
        guard interactionEnabled, !codexStopped, let source = provider.catalogSource else { return }
        if catalogTasks[source] != nil { renderCatalog(source); return }
        if !force, let attempt = catalogAttempts[source], Date().timeIntervalSince(attempt) < 60 { return }
        if source == "codex", codex.isBusy || codexRequestInFlight || codex.state == .awaitingBrowser {
            catalogMessages[source] = "Finish the Codex connection first, then refresh the model list."
            renderCatalog(source); return
        }
        catalogAttempts[source] = Date()
        catalogMessages[source] = "Refreshing model names only. No meeting content is sent."
        catalogTasks[source] = Task { [weak self] in
            guard let self else { return }
            do {
                let entries: [ModelCatalogEntry]
                let provenance: String
                let origin: String
                if source == "codex" {
                    entries = try await self.codex.listModels().map {
                        ModelCatalogEntry(id: $0.id, displayName: $0.displayName, inputModalities: $0.inputModalities)
                    }
                    provenance = "Codex runtime catalog (may be cached by Codex)"
                    origin = "runtime"
                } else {
                    // The public official catalog supplies newly published IDs
                    // even when this Mac's Claude Code alias catalog is older.
                    let published = Task { try await ClaudePublishedModels.fetch() }
                    self.publishedCatalogTask = published
                    defer { published.cancel(); self.publishedCatalogTask = nil }
                    var runtime: [ModelCatalogEntry] = []
                    do {
                        runtime = try await self.claudeModels.listModels().map {
                            ModelCatalogEntry(id: $0.id, displayName: $0.displayName, inputModalities: [])
                        }
                    } catch { /* Public metadata can still be used without an installed CLI. */ }
                    guard !self.codexStopped, !Task.isCancelled else { return }
                    do {
                        var combined = try await published.value
                        let ids = Set(combined.map(\.id))
                        combined.append(contentsOf: runtime.filter { !ids.contains($0.id) })
                        entries = combined
                        provenance = runtime.isEmpty ? "Anthropic published model catalog" : "Anthropic published catalog + Claude Code aliases"
                        origin = runtime.isEmpty ? "published" : "combined"
                    } catch {
                        // Keep a prior published catalog during an outage. A
                        // successful local lookup must not silently replace it.
                        if self.catalogs[source]?.includesPublishedModels == true || runtime.isEmpty { throw error }
                        entries = runtime
                        provenance = "Local Claude Code catalog only; published catalog unavailable. Update Claude Code for newer aliases"
                        origin = "runtime"
                    }
                }
                guard !self.codexStopped, !Task.isCancelled else { return }
                let snapshot = try ModelCatalogSnapshot(source: source, fetchedAt: Date(), models: entries, origin: origin).validated()
                self.catalogs[source] = snapshot
                var note = "\(provenance). Read \(self.catalogDate(snapshot.fetchedAt)). Account access is not verified."
                do { try self.catalogStore.save(snapshot) }
                catch { note += " Could not save the offline cache." }
                self.catalogMessages[source] = note
            } catch {
                guard !self.codexStopped, !Task.isCancelled else { return }
                let fallback = self.catalogs[source].map { "Keeping the previous \($0.origin ?? "runtime") catalog from \(self.catalogDate($0.fetchedAt))." }
                    ?? "Showing presets; you can enter a custom model ID."
                self.catalogMessages[source] = "Could not refresh models. \(fallback) Account access is not verified. Check your connection or runtime, then retry."
            }
            guard !self.codexStopped else { return }
            self.catalogTasks[source] = nil; self.renderCatalog(source)
        }
        renderCatalog(source)
    }
    @objc private func preferenceChanged() { changed() }
    @objc private func savePreferences() {
        guard !loadFailed, interactionEnabled else { return }
        var value = AnalysisPreferences()
        for task in AnalysisTask.allCases { if let editor = editors[task] { value.tasks[task] = editor.value } }
        value.networkPolicy = selectedPolicy
        value.uploads = .init(images: images.state == .on, audio: audio.state == .on, transcriptsAndNotes: transcripts.state == .on, contextDocuments: context.state == .on)
        do { apply(try store.save(value)); message.stringValue = "Saved on this Mac. No meeting analysis has started." }
        catch { message.stringValue = "Not saved: \(error.localizedDescription)" }
    }
    private var speechPreferencesSaved: Bool {
        guard FileManager.default.fileExists(atPath: store.file.path), let current = editors[.transcription]?.value, let saved = try? store.load().tasks.transcription else { return false }
        return current.provider == saved.provider && current.model == saved.model && current.endpoint == saved.endpoint && current.authentication == saved.authentication
    }
    private func updateSpeechSetupControls() {
        let local = editors[.transcription].map { [.localQwen, .localMiMo].contains($0.value.provider) } ?? false
        speechSetupRow.isHidden = !local
        installLocalSTT.isEnabled = interactionEnabled && !loadFailed && !speechSetupBusy && !speechSetupBlocked && speechPreferencesSaved
        if local && !speechPreferencesSaved { speechSetupStatus.stringValue = "Save Preferences before installing the selected speech model." }
    }
    private func displaySpeechSetup(_ value: [String: Any]) {
        speechSetupBlocked = value["busy"] as? Bool == true || value["recording"] as? Bool == true
        let state = value["installation"] as? [String: Any] ?? (value["status"] == nil ? nil : value)
        speechSetupBusy = state?["status"] as? String == "installing"
        speechSetupStatus.stringValue = (state?["message"] as? String).map { String($0.prefix(1000)) }
            ?? (speechSetupBlocked ? "Wait for recording or analysis to finish before installing a model." : "Install or update the saved speech model. No meeting audio is uploaded.")
        updateSpeechSetupControls()
        if speechSetupBusy || speechSetupBlocked {
            speechSetupPoll?.cancel()
            speechSetupPoll = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                guard let self, !Task.isCancelled, !self.codexStopped, self.view.window?.isVisible == true else { return }
                self.refreshSpeechSetup()
            }
        }
    }
    func refreshSpeechSetup() {
        guard interactionEnabled, !codexStopped, let request = localSTTRequest else { return }
        Task { [weak self] in
            do { let state = try await request(false); guard let self, !self.codexStopped else { return }; self.displaySpeechSetup(state) }
            catch { self?.speechSetupStatus.stringValue = error.localizedDescription }
        }
    }
    @objc private func installSpeechRuntime() {
        guard installLocalSTT.isEnabled, let window = view.window, let request = localSTTRequest,
              let config = editors[.transcription]?.value else { return }
        let alert = NSAlert(); alert.messageText = "Install local speech recognition?"
        alert.informativeText = "Download the private Python/MLX runtime and \(config.model). Model files may take several GB. Python 3.11 or later is required. No meeting audio is uploaded, and installation pauses for a new recording."
        alert.addButton(withTitle: "Download & Install"); alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { [weak self] response in
            guard let self, response == .alertFirstButtonReturn, self.interactionEnabled, self.speechPreferencesSaved,
                  self.editors[.transcription]?.value.model == config.model else { return }
            self.speechSetupBusy = true; self.updateSpeechSetupControls()
            Task {
                do { self.displaySpeechSetup(try await request(true)) }
                catch { self.speechSetupBusy = false; self.updateSpeechSetupControls(); self.speechSetupStatus.stringValue = error.localizedDescription }
            }
        }
    }
    private func buildCodexConnection() -> NSView {
        codexStatus.font = .systemFont(ofSize: 13, weight: .semibold)
        codexAccount.isSelectable = true; codexDetail.isSelectable = true
        connectCodex.target = self; connectCodex.action = #selector(connectCodexAccount)
        cancelCodex.target = self; cancelCodex.action = #selector(cancelCodexSignIn)
        openCodexBrowser.target = self; openCodexBrowser.action = #selector(reopenCodexBrowser)
        refreshCodex.target = self; refreshCodex.action = #selector(checkCodexConnection)
        disconnectCodex.target = self; disconnectCodex.action = #selector(disconnectCodexAccount)
        for button in [connectCodex, cancelCodex, openCodexBrowser, refreshCodex, disconnectCodex] { button.bezelStyle = .rounded }
        codexPrimaryActions.orientation = .horizontal; codexPrimaryActions.alignment = .centerY; codexPrimaryActions.spacing = 8
        for button in [connectCodex, openCodexBrowser, cancelCodex] { codexPrimaryActions.addArrangedSubview(button) }
        let secondary = NSStackView(views: [refreshCodex, disconnectCodex]); secondary.orientation = .horizontal; secondary.spacing = 8
        let scope = analysisLabel("No recordings, notes, or context documents are submitted when you connect. Start analysis from a saved meeting after selecting the sources you allow.", secondary: true)
        let stack = NSStackView(views: [codexStatus, codexAccount, codexDetail, codexPrimaryActions, secondary, scope])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 8
        for label in [codexStatus, codexAccount, codexDetail, scope] { label.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
        updateCodexConnection()
        return stack
    }
    private func updateCodexConnection() {
        guard isViewLoaded else { return }
        let awaitingBrowser = codex.state == .awaitingBrowser, connected = codex.state == .connected
        switch codex.state {
        case .idle: codexStatus.stringValue = "Not connected"
        case .checking: codexStatus.stringValue = "Checking Codex connection…"
        case .awaitingBrowser: codexStatus.stringValue = "Complete sign-in in your browser"
        case .connected: codexStatus.stringValue = "Connected to Codex"
        case .failed: codexStatus.stringValue = "Codex connection unavailable"
        }
        codexStatus.textColor = connected ? .systemGreen : codex.state == .failed ? .systemRed : .labelColor
        codexDetail.stringValue = codex.detail
        codexAccount.stringValue = connected
            ? [codex.accountEmail, codex.planType.map { "Plan: " + $0 }].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ") : ""
        codexAccount.isHidden = codexAccount.stringValue.isEmpty
        connectCodex.isHidden = connected || awaitingBrowser
        openCodexBrowser.isHidden = !awaitingBrowser; cancelCodex.isHidden = !awaitingBrowser
        codexPrimaryActions.isHidden = connected
        disconnectCodex.isHidden = !connected
        let available = interactionEnabled && !codexStopped && !codexRequestInFlight && !codex.isBusy
        connectCodex.isEnabled = available && !connected && !awaitingBrowser
        refreshCodex.isEnabled = available && !awaitingBrowser
        openCodexBrowser.isEnabled = available && awaitingBrowser
        cancelCodex.isEnabled = interactionEnabled && !codexStopped && !codexRequestInFlight && awaitingBrowser
        disconnectCodex.isEnabled = available && connected
        if available, connected, let account = codex.accountEmail, account != lastCatalogAccount {
            lastCatalogAccount = account
            if editors.values.contains(where: { $0.value.provider == .chatGPTPlan }) {
                refreshCatalog(for: .chatGPTPlan, force: true)
            }
        } else if !connected && !codex.isBusy { lastCatalogAccount = nil }
    }
    private enum CodexAction { case connect, cancel, openBrowser, refresh, disconnect }
    private func performCodexAction(_ action: CodexAction) {
        guard interactionEnabled, !codexStopped, !codexRequestInFlight else { return }
        if action != .cancel && codex.isBusy { return }
        codexRequestInFlight = true; updateCodexConnection()
        codexActionTask = Task { [weak self] in
            guard let self, !self.codexStopped, !Task.isCancelled else { return }
            switch action {
            case .connect: await self.codex.connect()
            case .cancel: await self.codex.cancelLogin()
            case .openBrowser: await self.codex.reopenBrowser()
            case .refresh: await self.codex.refresh()
            case .disconnect: await self.codex.disconnect()
            }
            self.codexRequestInFlight = false; self.codexActionTask = nil
            self.updateCodexConnection()
        }
    }
    @objc private func connectCodexAccount() { performCodexAction(.connect) }
    @objc private func cancelCodexSignIn() { performCodexAction(.cancel) }
    @objc private func reopenCodexBrowser() { performCodexAction(.openBrowser) }
    @objc private func checkCodexConnection() { performCodexAction(.refresh) }
    @objc private func disconnectCodexAccount() { performCodexAction(.disconnect) }
    func stopCodexConnection() {
        speechSetupPoll?.cancel(); speechSetupPoll = nil
        codexStopped = true; codexActionTask?.cancel(); codexActionTask = nil
        for task in catalogTasks.values { task.cancel() }; catalogTasks.removeAll()
        publishedCatalogTask?.cancel(); publishedCatalogTask = nil
        claudeModels.stop()
        codex.onChange = nil; codex.stop()
        if isViewLoaded { updateCodexConnection() }
    }
}
