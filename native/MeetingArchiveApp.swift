// Standalone macOS app shell. Recorder hosts remain independent processes;
// quitting the app never kills a recorder or bypasses its safe-stop protocol.
import AppKit
import WebKit
import Foundation

func appFailure(_ message: String) -> NSError {
    NSError(domain: "MeetingArchiveApp", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}
struct LocalConnection {
    let url: URL
    let port: Int
    let token: String
    let nodeVersion: String?
    let nodeExecPath: String?
    func contains(_ candidate: URL?) -> Bool {
        guard let candidate else { return false }
        return candidate.scheme == "http" && candidate.host == "127.0.0.1" && candidate.port == port
            && candidate.user == nil && candidate.password == nil
    }
    func permitsDownload(_ candidate: URL?) -> Bool {
        if contains(candidate) { return true }
        guard let candidate, candidate.scheme == "blob" else { return false }
        return contains(URL(string: String(candidate.absoluteString.dropFirst(5))))
    }
    func isDownloadRoute(_ candidate: URL?) -> Bool {
        guard contains(candidate), let candidate else { return false }
        return candidate.path.range(of: "^/api/(meetings/[a-z0-9-]{1,100}/(artifact|manifest|analysis-context)|projects/[a-f0-9-]{36}/analysis-context)$", options: .regularExpression) != nil
    }
}
final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
@MainActor final class LocalServer {
    private var child: Process?
    private let input = Pipe(), output = Pipe(), errors = Pipe()
    private var pendingReady: CheckedContinuation<LocalConnection, Error>?
    private var pendingShutdown: CheckedContinuation<Void, Error>?
    private var readyTimer: Task<Void, Never>?, shutdownTimer: Task<Void, Never>?
    private var buffer = Data(), diagnostic = ""
    var connection: LocalConnection?
    var onUnexpectedExit: (() -> Void)?
    var isRunning: Bool { child?.isRunning == true }
    var launched = false
    func start(node: URL, entry: URL, dataDirectory: URL) async throws -> LocalConnection {
        guard child == nil else { throw appFailure("The local service is already running.") }
        guard FileManager.default.isExecutableFile(atPath: node.path) else {
            throw appFailure("MinuteShelf’s bundled runtime is missing or cannot be executed. Reinstall the app.")
        }
        let process = Process(); child = process
        process.executableURL = node; process.arguments = [entry.path]
        process.currentDirectoryURL = entry.deletingLastPathComponent().deletingLastPathComponent()
        // Pass only required OS context and explicit app overrides. Inheriting
        // a shell environment can inject Node preloads, loaders, or libraries.
        let inherited = ProcessInfo.processInfo.environment
        var environment = [
            "HOME": FileManager.default.homeDirectoryForCurrentUser.path,
            "USER": NSUserName(),
            "LOGNAME": NSUserName(),
            "TMPDIR": FileManager.default.temporaryDirectory.path,
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "MEETING_DATA": dataDirectory.path
        ]
        for key in ["LANG", "LC_ALL", "LC_CTYPE", "TZ", "MEETING_RKA_URL"] {
            if let value = inherited[key] { environment[key] = value }
        }
        process.environment = environment
        process.standardInput = input; process.standardOutput = output; process.standardError = errors
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if !data.isEmpty { Task { @MainActor in self?.receive(data) } }
        }
        errors.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if !data.isEmpty { Task { @MainActor in
                guard let self else { return }
                self.diagnostic = String((self.diagnostic + String(decoding: data, as: UTF8.self)).suffix(4000))
            } }
        }
        process.terminationHandler = { [weak self] _ in Task { @MainActor in self?.exited() } }
        return try await withCheckedThrowingContinuation { continuation in
            pendingReady = continuation
            do { try process.run(); launched = true }
            catch { pendingReady = nil; continuation.resume(throwing: error); return }
            readyTimer = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 25_000_000_000)
                guard !Task.isCancelled, let self, let pending = self.pendingReady else { return }
                self.pendingReady = nil
                pending.resume(throwing: appFailure("The local service timed out while starting. Restart MinuteShelf. If this continues, reinstall the app."))
            }
        }
    }
    private func receive(_ data: Data) {
        buffer.append(data)
        // stdout is a small, line-delimited control channel, never a log sink.
        if buffer.count > 65536 {
            pendingReady?.resume(throwing: appFailure("The local service returned an oversized startup response.")); pendingReady = nil; buffer.removeAll(); return
        }
        while let newline = buffer.firstIndex(of: 10) {
            let line = buffer.prefix(upTo: newline); buffer.removeSubrange(...newline)
            guard let value = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
            if value["event"] as? String == "shutdown", value["ok"] as? Bool == false {
                shutdownTimer?.cancel(); pendingShutdown?.resume(throwing: appFailure("A recording is still active, so quitting was cancelled. Stop and save the recording first.")); pendingShutdown = nil
                continue
            }
            guard connection == nil, let rawURL = value["url"] as? String, let url = URL(string: rawURL),
                  let port = value["port"] as? Int, (1...65535).contains(port), let token = value["token"] as? String,
                  token.range(of: "^[A-Za-z0-9_-]{32,256}$", options: .regularExpression) != nil,
                  url.scheme == "http", url.host == "127.0.0.1", url.port == port, url.path == "/",
                  url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else { continue }
            let ready = LocalConnection(url: url, port: port, token: token,
                nodeVersion: value["nodeVersion"] as? String, nodeExecPath: value["nodeExecPath"] as? String)
            connection = ready
            readyTimer?.cancel(); pendingReady?.resume(returning: ready); pendingReady = nil
        }
    }
    private func exited() {
        output.fileHandleForReading.readabilityHandler = nil; errors.fileHandleForReading.readabilityHandler = nil
        readyTimer?.cancel(); shutdownTimer?.cancel()
        if let pending = pendingReady {
            pendingReady = nil; pending.resume(throwing: appFailure("The local service could not start.\n\(diagnostic)")); return
        }
        if let pending = pendingShutdown { pendingShutdown = nil; pending.resume(); return }
        onUnexpectedExit?()
    }
    func shutdown() async throws {
        guard isRunning else { return }
        guard pendingShutdown == nil else { throw appFailure("The local service is shutting down.") }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            pendingShutdown = continuation
            do { try input.fileHandleForWriting.write(contentsOf: Data("{\"command\":\"shutdown\"}\n".utf8)) }
            catch { pendingShutdown = nil; continuation.resume(throwing: error); return }
            shutdownTimer = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                guard !Task.isCancelled, let self, let pending = self.pendingShutdown else { return }
                self.pendingShutdown = nil
                pending.resume(throwing: appFailure("The local service has not confirmed a safe shutdown. The app will stay open. No recording process was forcibly stopped."))
            }
        }
    }
}

@MainActor final class MeetingArchiveApplication: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler, NSMenuItemValidation {
    private let server = LocalServer()
    private var window: NSWindow!
    private var web: WKWebView!
    private var nativeShell: MeetingArchiveShell!
    private var connection: LocalConnection?
    private var launchTask: Task<Void, Never>?
    private var ready = false, closingWindow = false, quitting = false, allowTermination = false, smokeFinished = false
    private var searchNavigationInFlight = false
    private let smoke = CommandLine.arguments.contains("--smoke-test")
    func applicationWillTerminate(_ notification: Notification) {
        nativeShell?.stopCodexConnection()
    }
    func applicationDidBecomeActive(_ notification: Notification) {
        guard ready, !quitting, !closingWindow, !smoke else { return }
        nativeShell?.refreshPermissionsAfterActivation()
    }
    private let redirects = NoRedirects()
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 45
        configuration.connectionProxyDictionary = [:]
        return URLSession(configuration: configuration, delegate: redirects, delegateQueue: nil)
    }()
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        createWindow(); installMenus(); showWindow(nil)
        server.onUnexpectedExit = { [weak self] in
            guard let self, !self.quitting else { return }
            self.window.subtitle = "Local service stopped"
            self.nativeShell.setInteractionEnabled(false)
            self.alert("Local service stopped", "Recording status cannot be checked or stopped from this window. The independent recorder is unchanged. Use its menu bar controls to stop and save.\n\nUnsaved notes remain in this window but cannot currently be saved. When you choose Quit MinuteShelf, you can copy your notes or keep the window open.")
        }
        launchTask = Task { [weak self] in
            guard let self else { return }
            do {
                guard let resource = Bundle.main.resourceURL else {
                    throw appFailure("MinuteShelf is missing required resources. Reinstall the app.")
                }
                let node = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/node")
                let override = ProcessInfo.processInfo.environment["MEETING_DATA"]
                if self.smoke && override == nil { throw appFailure("--smoke-test requires a separate MEETING_DATA test directory.") }
                // Keep the pre-rebrand archive path: credential scopes also hash this directory.
                let directory = override.map { URL(fileURLWithPath: $0, isDirectory: true) }
                    ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Meeting Archive", isDirectory: true)
                self.nativeShell.setDataDirectory(directory)
                let value = try await self.server.start(node: node,
                    entry: resource.appendingPathComponent("runtime/tools/desktop-server.js"), dataDirectory: directory)
                self.connection = value
                var components = URLComponents(url: value.url, resolvingAgainstBaseURL: false)!
                components.fragment = "token=" + value.token
                self.web.load(URLRequest(url: components.url!))
                self.window.subtitle = ""
            } catch {
                self.window.subtitle = "Could not start the local service"
                if self.smoke { self.finishSmoke(error: error) }
                else { self.alert("Could not start MinuteShelf", error.localizedDescription) }
            }
        }
    }
    private func createWindow() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        // Session playback loads local segments and PTS indexes asynchronously
        // after the user's Play action. The controller owns pause/autoplay;
        // WebKit must not reject the following segment's audio as a new gesture.
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.userContentController.add(self, name: "meetingArchiveState")
        web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self; web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = false
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1120, height: 780),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "MinuteShelf"; window.subtitle = "Starting the local service…"
        window.contentMinSize = NSSize(width: 720, height: 500)
        window.isReleasedWhenClosed = false; window.delegate = self
        nativeShell = MeetingArchiveShell(web: web, window: window)
        nativeShell.onAction = { [weak self] action, payload in self?.perform(action, payload: payload) }
        nativeShell.onSettings = { [weak self] in self?.settings() }
        window.center()
        if !smoke { window.setFrameAutosaveName("MeetingArchiveMainWindow") }
    }
    @discardableResult
    private func item(_ menu: NSMenu, _ title: String, _ action: Selector?, _ key: String = "", target: AnyObject? = nil) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = target; menu.addItem(item); return item
    }
    private func installMenus() {
        let bar = NSMenu(); NSApp.mainMenu = bar
        func menu(_ title: String) -> NSMenu {
            let entry = NSMenuItem(title: title, action: nil, keyEquivalent: ""), submenu = NSMenu(title: title)
            entry.submenu = submenu; bar.addItem(entry); return submenu
        }
        let app = menu("MinuteShelf")
        item(app, "About MinuteShelf", #selector(about), target: self)
        app.addItem(.separator()); item(app, "Settings…", #selector(settings), ",", target: self)
        app.addItem(.separator())
        let services = NSMenu(title: "Services"), serviceItem = NSMenuItem(title: "Services", action: nil, keyEquivalent: "")
        serviceItem.submenu = services; app.addItem(serviceItem); NSApp.servicesMenu = services
        app.addItem(.separator())
        item(app, "Hide MinuteShelf", #selector(NSApplication.hide(_:)), "h", target: NSApp)
        item(app, "Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", target: NSApp).keyEquivalentModifierMask = [.command, .option]
        item(app, "Show All", #selector(NSApplication.unhideAllApplications(_:)), target: NSApp)
        app.addItem(.separator()); item(app, "Quit MinuteShelf", #selector(NSApplication.terminate(_:)), "q", target: NSApp)
        let file = menu("File")
        item(file, "New Meeting", #selector(newMeeting), "n", target: self)
        item(file, "Save Notes", #selector(save), "s", target: self)
        file.addItem(.separator()); item(file, "Close Window", #selector(NSWindow.performClose(_:)), "w")
        let edit = menu("Edit")
        item(edit, "Undo", Selector(("undo:")), "z")
        item(edit, "Redo", Selector(("redo:")), "z").keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        item(edit, "Cut", #selector(NSText.cut(_:)), "x"); item(edit, "Copy", #selector(NSText.copy(_:)), "c")
        item(edit, "Paste", #selector(NSText.paste(_:)), "v"); item(edit, "Select All", #selector(NSText.selectAll(_:)), "a")
        edit.addItem(.separator()); item(edit, "Find Meetings", #selector(search), "f", target: self)
        let recording = menu("Recording")
        item(recording, "Toggle Microphone Recording", #selector(toggleRecordingMic), "m", target: self).keyEquivalentModifierMask = [.option, .shift]
        item(recording, "Pause or Resume Recording", #selector(toggleRecordingPause), target: self)
        item(recording, "Stop and Save Recording", #selector(stopRecording), target: self)
        let windows = menu("Window"); NSApp.windowsMenu = windows
        item(windows, "Minimize", #selector(NSWindow.performMiniaturize(_:)), "m")
        item(windows, "Zoom", #selector(NSWindow.performZoom(_:)))
        item(windows, "Show MinuteShelf", #selector(showWindow(_:)), target: self)
        windows.addItem(.separator()); item(windows, "Bring All to Front", #selector(NSApplication.arrangeInFront(_:)), target: NSApp)
        let helpMenu = menu("Help"); NSApp.helpMenu = helpMenu
        item(helpMenu, "MinuteShelf Help", #selector(help), target: self)
    }
    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if menuItem.action == #selector(newMeeting) { return ready && !quitting && !closingWindow && nativeShell.snapshot?.activeRecording == nil && nativeShell.snapshot?.busy != true }
        if [#selector(toggleRecordingMic), #selector(toggleRecordingPause), #selector(stopRecording)].contains(menuItem.action) {
            guard ready, !quitting, !closingWindow, let snapshot = nativeShell.snapshot, snapshot.connected, !snapshot.busy,
                  let recording = snapshot.activeRecording, ["recording", "paused"].contains(recording.status) else { return false }
            return menuItem.action != #selector(toggleRecordingMic) || recording.microphoneSelected
        }
        if [#selector(newMeeting), #selector(save), #selector(search), #selector(settings)].contains(menuItem.action) { return ready && !quitting && !closingWindow }
        return true
    }
    private var distributionDescription: String {
        if Bundle.main.object(forInfoDictionaryKey: "MeetingArchiveDistribution") as? String == "developer-id" {
            return "Standalone app, signed with Developer ID."
        }
        return "Standalone app, ad hoc signed. Not notarized for distribution."
    }
    @objc private func about() {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        NSApp.orderFrontStandardAboutPanel(options: [.applicationName: "MinuteShelf", .applicationVersion: version,
            .credits: NSAttributedString(string: "Local meeting recording and archives\nThe runtime is included.\n" + distributionDescription)])
    }
    @objc private func help() {
        alert("MinuteShelf Help", "Choose Window or Entire display and confirm its preview before recording. Entire display includes other visible apps and notifications. When presenting in Zoom, choose the actual shared content window or the display; capture does not automatically follow Zoom's shared source. Closing this window keeps the menu bar recorder running. Quitting the app stops and safely saves the recording first.\n\nMicrophone recording is controlled separately from the meeting app’s mute setting. Use Settings → General to request and check access, including after updates. The runtime is included in the app.\n\nUpgrading from Meeting Archive preserves your local archive and connection settings. macOS may still show the former name and may require renewed screen, microphone, or Keychain consent when an ad hoc signature changes. Check access in this installed app before recording. MinuteShelf never resets system permissions automatically.\n\n" + distributionDescription)
    }
    @objc func showWindow(_ sender: Any?) { window?.makeKeyAndOrderFront(sender); NSApp.activate(ignoringOtherApps: true) }
    @objc private func newMeeting() { guard nativeShell.snapshot?.activeRecording == nil else { return }; perform("new") }
    @objc private func toggleRecordingMic() {
        guard let active = nativeShell.snapshot?.activeRecording, active.microphoneSelected, ["recording", "paused"].contains(active.status) else { return }
        perform("mic", payload: ["id": active.id, "enabled": !active.micEnabled])
    }
    @objc private func toggleRecordingPause() {
        guard let active = nativeShell.snapshot?.activeRecording, ["recording", "paused"].contains(active.status) else { return }
        perform(active.status == "paused" ? "resume" : "pause", payload: ["id": active.id])
    }
    @objc private func stopRecording() {
        guard let active = nativeShell.snapshot?.activeRecording, ["recording", "paused"].contains(active.status) else { return }
        perform("stop", payload: ["id": active.id])
    }
    @objc private func search() { perform("search") }
    @objc private func save() { perform("save") }
    @objc private func settings() {
        guard ready, !quitting, !closingWindow else { return }
        nativeShell.showSettings()
    }
    private func perform(_ action: String, payload: [String: Any] = [:]) {
        guard ready, !quitting, !closingWindow,
              ["library", "meeting", "meeting-rename", "meeting-trash", "meeting-restore", "project", "new-project", "new", "save", "search", "settings-refresh", "settings-request-permission", "settings-open-permission", "pause", "resume", "stop", "mic"].contains(action) else { return }
        // Typing can produce many text changes before draft saving/navigation
        // finishes. One transition to the native library is enough. Never
        // restore a caret captured before an asynchronous transition.
        if action == "search" && searchNavigationInFlight { return }
        if action == "search" { searchNavigationInFlight = true }
        let needsSearchFocus = action == "search" && !nativeShell.searchIsFocused
        if !action.hasPrefix("settings-") { showWindow(nil) }
        Task {
            defer { if action == "search" { searchNavigationInFlight = false } }
            do {
                let accepted = try await dispatch(action == "search" ? "library" : action, payload: payload)
                if accepted && needsSearchFocus { nativeShell.focusSearch() }
                if !accepted { nativeShell.restoreConfirmedSelection() }
            } catch { alert("Action not completed", error.localizedDescription) }
        }
    }
    private func dispatch(_ action: String, payload: [String: Any] = [:]) async throws -> Bool {
        try await web.callAsyncJavaScript("return !!(window.MeetingArchiveDesktop && await window.MeetingArchiveDesktop.dispatch(action, payload))",
            arguments: ["action": action, "payload": payload], in: nil, contentWorld: .page) as? Bool == true
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        // Capture metadata is untrusted display data. Only the main application
        // document at the exact authenticated loopback origin can drive UI.
        guard message.name == "meetingArchiveState", message.webView === web,
              message.frameInfo.isMainFrame, let connection,
              connection.contains(message.frameInfo.request.url), message.frameInfo.request.url?.path == "/",
              message.frameInfo.securityOrigin.protocol == "http", message.frameInfo.securityOrigin.host == "127.0.0.1",
              message.frameInfo.securityOrigin.port == connection.port,
              let body = message.body as? [String: Any], body["version"] as? Int == 1 else { return }
        if body["event"] as? String == "command" {
            guard ready, !quitting, !closingWindow else { return }
            if body["action"] as? String == "settings" { settings() }
            else if body["action"] as? String == "search" { search() }
            return
        }
        guard let snapshot = ArchiveShellSnapshot(body) else { return }
        nativeShell.apply(snapshot)
    }
    private func prepareToClose(notifyOnError: Bool = true) async -> Bool {
        guard ready else { return true }
        do { return try await web.callAsyncJavaScript("return !!(window.MeetingArchiveDesktop && await window.MeetingArchiveDesktop.prepareToClose())", arguments: [:], in: nil, contentWorld: .page) as? Bool == true }
        catch { if notifyOnError { alert("Notes have not been confirmed saved", "The window will stay open. Check the local service and try again.\n" + error.localizedDescription) }; return false }
    }
    private func prepareAndLockForQuit() async -> Bool {
        guard ready else { return true }
        nativeShell.beginQuitLock()
        do {
            // The flush and the lock run in one JS continuation. No user input
            // can land between the successful flush and locking the document.
            return try await web.callAsyncJavaScript("""
                if (!window.MeetingArchiveDesktop || !await window.MeetingArchiveDesktop.prepareToClose()) return false;
                if (!window.__meetingArchiveNativeQuitState) window.__meetingArchiveNativeQuitState = { focus: document.activeElement, wasInert: document.body.inert };
                document.body.inert = true;
                return true;
                """, arguments: [:], in: nil, contentWorld: .page) as? Bool == true
        } catch {
            if server.isRunning { alert("Notes have not been confirmed saved", "The app will stay open. Check the local service and try again.\n" + error.localizedDescription) }
            return false
        }
    }
    private func unlockAfterCancelledQuit() async {
        guard ready else { return }
        _ = try? await web.callAsyncJavaScript("""
            const state = window.__meetingArchiveNativeQuitState;
            if (state) {
                document.body.inert = state.wasInert;
                if (!state.wasInert && state.focus && state.focus.isConnected) state.focus.focus({ preventScroll: true });
                delete window.__meetingArchiveNativeQuitState;
            }
            """, arguments: [:], in: nil, contentWorld: .page)
        nativeShell.endQuitLock()
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard !quitting, !closingWindow else { return false }
        closingWindow = true
        nativeShell.beginQuitLock()
        Task {
            if await prepareToClose() { sender.orderOut(nil) }
            closingWindow = false; nativeShell.endQuitLock()
        }
        return false
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showWindow(nil); return true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if allowTermination { return .terminateNow }
        guard !quitting else { return .terminateCancel }
        quitting = true
        nativeShell.beginQuitLock()
        Task {
            let permitted = await quitSafely()
            if !permitted { await unlockAfterCancelledQuit() }
            allowTermination = permitted; quitting = false
            NSApp.reply(toApplicationShouldTerminate: permitted)
        }
        return .terminateLater
    }
    private func request(_ route: String, method: String = "GET") async throws -> [String: Any] {
        guard let connection else { throw appFailure("The local service is not ready.") }
        var request = URLRequest(url: connection.url.appendingPathComponent(route))
        request.httpMethod = method; request.setValue("Bearer " + connection.token, forHTTPHeaderField: "Authorization")
        if method == "POST" { request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.httpBody = Data("{}".utf8) }
        let (data, response) = try await session.data(for: request)
        guard data.count <= 8 * 1024 * 1024, let response = response as? HTTPURLResponse, connection.contains(response.url), response.statusCode == 200,
              let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw appFailure("The local service did not confirm that the request succeeded. The recording will not be forcibly stopped.") }
        return result
    }
    private func activeRecordings() async throws -> [[String: Any]] {
        guard let active = try await request("api/status")["active"] as? [[String: Any]] else { throw appFailure("Recording status could not be confirmed.") }
        return active
    }
    private func quitSafely() async -> Bool {
        await launchTask?.value
        if server.launched && !server.isRunning {
            let saved = await prepareToClose(notifyOnError: false)
            return await confirmQuitWithoutServer(notesSaved: saved)
        }
        guard await prepareAndLockForQuit() else {
            if server.launched && !server.isRunning { return await confirmQuitWithoutServer(notesSaved: false) }
            return false
        }
        do {
            if connection != nil {
                let active = try await activeRecordings()
                if !active.isEmpty {
                    showWindow(nil)
                    let prompt = NSAlert(); prompt.messageText = "Stop recording and quit?"
                    prompt.informativeText = "A meeting is recording or being saved. Quitting stops the recording and waits for the original audio and video to be saved safely. Choose Cancel to keep recording."
                    prompt.alertStyle = .warning; prompt.addButton(withTitle: "Stop and Quit"); prompt.addButton(withTitle: "Cancel")
                    prompt.buttons.last?.keyEquivalent = "\u{1b}"
                    guard prompt.runModal() == .alertFirstButtonReturn else { return false }
                    window.subtitle = "Stopping and saving the recording…"
                    for recording in active {
                        guard let id = recording["id"] as? String, id.range(of: "^[a-z0-9-]{1,100}$", options: .regularExpression) != nil else { throw appFailure("The recording ID is invalid.") }
                        _ = try await request("api/meetings/\(id)/stop", method: "POST")
                    }
                    let deadline = Date().addingTimeInterval(30)
                    while !(try await activeRecordings()).isEmpty {
                        guard Date() < deadline else { throw appFailure("The recording is still being saved. Try quitting again shortly.") }
                        try await Task.sleep(nanoseconds: 500_000_000)
                    }
                }
            }
            try await server.shutdown(); return true
        } catch {
            if server.launched && !server.isRunning { return await confirmQuitWithoutServer(notesSaved: true) }
            window.subtitle = ""; showWindow(nil)
            alert("The app is still open", error.localizedDescription + "\nThe independent recorder was not forcibly stopped.")
            return false
        }
    }
    private func confirmQuitWithoutServer(notesSaved: Bool) async -> Bool {
        // Recovery choices apply only to the already-exited child we own.
        // They never signal, stop, or terminate an independent recorder host.
        guard !server.isRunning else { return false }
        showWindow(nil); window.subtitle = "Local service stopped · Notes remain in this window"
        let prompt = NSAlert(); prompt.messageText = "The local service has stopped"; prompt.alertStyle = .warning
        prompt.informativeText = "Recording status cannot be checked or stopped automatically. Quit App Only leaves the independent recorder unchanged. If it is still recording, use its menu bar controls to stop and save.\n\n"
            + (notesSaved ? "The notes passed the save check. You can also copy the current notes and keep this window open." : "Unsaved notes cannot currently be written to the local archive. The text remains in this window. Quitting may lose unsaved changes; copy your notes first.")
        prompt.addButton(withTitle: "Keep Window Open")
        prompt.addButton(withTitle: "Copy Notes and Keep Open")
        prompt.addButton(withTitle: "Quit App Only")
        prompt.buttons[0].keyEquivalent = "\u{1b}"
        prompt.window.defaultButtonCell = prompt.buttons[0].cell as? NSButtonCell
        prompt.buttons[2].keyEquivalent = ""; prompt.buttons[2].hasDestructiveAction = !notesSaved
        let choice = prompt.runModal()
        if choice == .alertThirdButtonReturn { return true }
        if choice == .alertSecondButtonReturn {
            do {
                let text = try await web.callAsyncJavaScript("return document.getElementById('notes')?.value || ''", arguments: [:], in: nil, contentWorld: .page) as? String ?? ""
                if text.isEmpty { alert("No current notes to copy", "The window will stay open. Its contents have not been cleared.") }
                else {
                    NSPasteboard.general.clearContents()
                    guard NSPasteboard.general.setString(text, forType: .string) else { throw appFailure("Could not copy to the clipboard.") }
                    window.subtitle = "Notes copied · Window kept open"
                }
            } catch { alert("Notes were not copied", "The window will stay open.\n" + error.localizedDescription) }
        }
        return false
    }
    private func alert(_ title: String, _ text: String) { let dialog = NSAlert(); dialog.messageText = title; dialog.informativeText = text; dialog.addButton(withTitle: "OK"); dialog.runModal() }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Task {
            do {
                let enabled = try await web.callAsyncJavaScript("return !!(window.MeetingArchiveDesktop && window.MeetingArchiveDesktop.enableNativeShell())",
                    arguments: [:], in: nil, contentWorld: .page) as? Bool == true
                guard enabled else { throw appFailure("The native meeting interface could not connect to its local document.") }
                ready = true; nativeShell.setInteractionEnabled(true)
                if smoke && !smokeFinished {
                    smokeFinished = true
                    let deadline = Date().addingTimeInterval(15)
                    while !nativeShell.snapshotReceived || nativeShell.snapshot?.connected != true || nativeShell.snapshot?.busy == true {
                        guard Date() < deadline else { throw appFailure("The native shell did not receive a ready archive snapshot") }
                        try await Task.sleep(nanoseconds: 100_000_000)
                    }
                    guard try await activeRecordings().isEmpty else { throw appFailure("Smoke test refused an active archive") }
                    let bridge = try await web.callAsyncJavaScript("return !!(window.MeetingArchiveDesktop && typeof window.MeetingArchiveDesktop.dispatch === 'function' && typeof window.MeetingArchiveDesktop.prepareToClose === 'function')", arguments: [:], in: nil, contentWorld: .page) as? Bool == true
                    guard bridge else { throw appFailure("Desktop web bridge is unavailable") }
                    var shellReport = nativeShell.smokeStructure()
                    shellReport["webSidebarHidden"] = try await web.callAsyncJavaScript("return document.body.classList.contains('native-shell') && !!document.querySelector('aside') && getComputedStyle(document.querySelector('aside')).display === 'none'",
                        arguments: [:], in: nil, contentWorld: .page) as? Bool == true
                    shellReport["actionRoundTrip"] = try await dispatch("library")
                    nativeShell.focusSearch()
                    guard nativeShell.searchIsFocused else { throw appFailure("Native meeting search did not accept keyboard focus") }
                    guard await prepareAndLockForQuit(),
                          try await web.callAsyncJavaScript("return document.body.inert", arguments: [:], in: nil, contentWorld: .page) as? Bool == true else { throw appFailure("Quit did not lock the editor after saving") }
                    shellReport["quitControlsLocked"] = nativeShell.controlsAreLocked
                    await unlockAfterCancelledQuit()
                    shellReport["cancelRestoresNativeControls"] = nativeShell.controlsAreRestored
                    let documentUnlocked = try await web.callAsyncJavaScript("return !document.body.inert", arguments: [:], in: nil, contentWorld: .page) as? Bool == true
                    let restored = nativeShell.searchIsFocused && documentUnlocked
                    guard restored else { throw appFailure("Cancelled quit did not restore focus and editing") }
                    guard shellReport.values.allSatisfy({ $0 }) else { throw appFailure("A native shell smoke check failed: \(shellReport)") }
                    guard await quitSafely() else { throw appFailure("Safe app shutdown was not confirmed") }
                    var report: [String: Any] = ["launchReady": true, "desktopBridge": true, "quitEditorLock": true,
                        "cancelRestoresFocus": true, "safeQuit": true, "activeMeetings": 0, "requestedPermissions": false, "nativeShell": shellReport]
                    if let version = connection?.nodeVersion { report["nodeVersion"] = version }
                    if let path = connection?.nodeExecPath { report["nodeExecPath"] = path }
                    let reportData = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
                    print(String(decoding: reportData, as: UTF8.self))
                    allowTermination = true; NSApp.terminate(nil)
                }
            } catch {
                if smoke { finishSmoke(error: error) }
                else { alert("Could not open the native interface", error.localizedDescription) }
            }
        }
    }
    private func finishSmoke(error: Error) {
        smokeFinished = true
        Task { try? await server.shutdown(); fputs("MinuteShelf smoke test: \(error.localizedDescription)\n", stderr); exit(2) }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if smoke { finishSmoke(error: error) } else { alert("Could not open the meeting interface", error.localizedDescription) }
    }
    private func external(_ action: WKNavigationAction) {
        guard action.navigationType == .linkActivated, let url = action.request.url, ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return }
        NSWorkspace.shared.open(url)
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.shouldPerformDownload && connection?.permitsDownload(navigationAction.request.url) == true { decisionHandler(.download); return }
        guard connection?.contains(navigationAction.request.url) == true else { external(navigationAction); decisionHandler(.cancel); return }
        if connection?.isDownloadRoute(navigationAction.request.url) == true { decisionHandler(.download); return }
        // Keep the application document in place; JSON or a media resource must
        // not replace the note editor and its save/close bridge.
        guard navigationAction.request.url?.path == "/" else { decisionHandler(.cancel); return }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard connection?.contains(navigationResponse.response.url) == true else { decisionHandler(.cancel); return }
        if connection?.isDownloadRoute(navigationResponse.response.url) == true || !navigationResponse.canShowMIMEType { decisionHandler(.download); return }
        guard navigationResponse.response.url?.path == "/" else { decisionHandler(.cancel); return }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if connection?.contains(navigationAction.request.url) == true { webView.load(navigationAction.request) }
        else { external(navigationAction) }
        return nil
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard connection?.contains(frame.request.url) == true else { completionHandler(nil); return }
        let panel = NSOpenPanel(); panel.canChooseFiles = true; panel.canChooseDirectories = false; panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { response in completionHandler(response == .OK ? panel.urls : nil) }
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        guard connection?.permitsDownload(response.url) == true else { completionHandler(nil); return }
        let panel = NSSavePanel(); panel.nameFieldStringValue = suggestedFilename
        panel.beginSheetModal(for: window) { response in completionHandler(response == .OK ? panel.url : nil) }
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if (error as NSError).code != NSURLErrorCancelled { alert("The exported file was not saved", error.localizedDescription) }
    }
}
@main struct MeetingArchiveMain {
    @MainActor static func main() {
        let app = NSApplication.shared, delegate = MeetingArchiveApplication()
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
