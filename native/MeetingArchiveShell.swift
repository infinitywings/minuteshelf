// Native navigation and recording controls. The web document remains the sole
// owner of drafts/navigation, and the local service remains the archive owner.
// Views consume snapshots; every mutation goes through the guarded JS bridge.
import AppKit
import WebKit

struct ArchiveProjectRow: Equatable {
    let id: String
    let name: String
}
struct ArchiveMeetingRow: Equatable {
    let id: String
    let title: String
    let createdAt: String
    let status: String
    let projectId: String?
    let notesPreview: String
    let mutationBlocked: Bool
    var canChange: Bool {
        !mutationBlocked && !["starting", "recording", "paused", "finalizing", "processing", "queued"].contains(status)
    }
}
struct ArchiveDeletedMeetingRow: Equatable {
    let id: String
    let title: String
}
enum ArchiveMeetingTitle {
    static func normalized(_ value: String) -> String? {
        let title = value.precomposedStringWithCanonicalMapping.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, title.unicodeScalars.count <= 300,
              !title.unicodeScalars.contains(where: { $0.value <= 0x1f || (0x7f...0x9f).contains($0.value) }) else { return nil }
        return title
    }
}
struct ArchiveRecordingState: Equatable {
    let id: String
    let title: String
    let status: String
    let micEnabled: Bool
    let microphoneSelected: Bool
    let warning: String
}
struct ArchiveShellSnapshot {
    let view: String
    let selectedMeetingId: String?
    let selectedProjectId: String?
    let projects: [ArchiveProjectRow]
    let meetings: [ArchiveMeetingRow]
    let deletedMeetings: [ArchiveDeletedMeetingRow]
    let activeRecording: ArchiveRecordingState?
    let archivePath: String
    let freeBytes: Double?
    let connected: Bool
    let busy: Bool
    let notesDirty: Bool
    let message: String
    let permissions: [String: String]
    let settingsError: String
    let settingsChecking: Bool

    init?(_ value: [String: Any]) {
        guard value["version"] as? Int == 1,
              let view = value["view"] as? String, ["home", "setup", "meeting", "project"].contains(view),
              let rawProjects = value["projects"] as? [[String: Any]],
              let rawMeetings = value["meetings"] as? [[String: Any]] else { return nil }
        self.view = view
        selectedMeetingId = value["selectedMeetingId"] as? String
        selectedProjectId = value["selectedProjectId"] as? String
        projects = rawProjects.compactMap { row in
            guard let id = row["id"] as? String, let name = row["name"] as? String else { return nil }
            return ArchiveProjectRow(id: id, name: name)
        }
        meetings = rawMeetings.compactMap { row in
            guard let id = row["id"] as? String, let title = row["title"] as? String else { return nil }
            return ArchiveMeetingRow(id: id, title: title, createdAt: row["createdAt"] as? String ?? "",
                status: row["status"] as? String ?? "unavailable", projectId: row["projectId"] as? String,
                notesPreview: row["notesPreview"] as? String ?? "", mutationBlocked: row["mutationBlocked"] as? Bool ?? false)
        }
        deletedMeetings = (value["deletedMeetings"] as? [[String: Any]] ?? []).compactMap { row in
            guard let id = row["id"] as? String, let title = row["title"] as? String else { return nil }
            return ArchiveDeletedMeetingRow(id: id, title: title)
        }
        if let recording = value["activeRecording"] as? [String: Any], let id = recording["id"] as? String {
            activeRecording = ArchiveRecordingState(id: id, title: recording["title"] as? String ?? "Meeting",
                status: recording["status"] as? String ?? "starting", micEnabled: recording["micEnabled"] as? Bool ?? false,
                microphoneSelected: recording["microphoneSelected"] as? Bool ?? false, warning: recording["warning"] as? String ?? "")
        } else { activeRecording = nil }
        archivePath = value["archivePath"] as? String ?? ""
        freeBytes = (value["freeBytes"] as? NSNumber)?.doubleValue
        connected = value["connected"] as? Bool ?? false
        busy = value["busy"] as? Bool ?? false
        notesDirty = value["notesDirty"] as? Bool ?? false
        message = value["message"] as? String ?? ""
        let settings = value["settings"] as? [String: Any] ?? [:]
        permissions = settings["permissions"] as? [String: String] ?? [:]
        settingsError = settings["error"] as? String ?? ""
        settingsChecking = settings["checking"] as? Bool ?? false
    }
}

private enum ArchiveSidebarRow: Equatable {
    case library, heading(String), project(ArchiveProjectRow), meeting(ArchiveMeetingRow), deletedMeeting(ArchiveDeletedMeetingRow), newProject
    var key: String {
        switch self {
        case .library: return "library"
        case .heading(let text): return "heading:" + text
        case .project(let row): return "project:" + row.id
        case .meeting(let row): return "meeting:" + row.id
        case .deletedMeeting(let row): return "deleted:" + row.id
        case .newProject: return "new-project"
        }
    }
    var title: String {
        switch self {
        case .library: return "All Meetings"
        case .heading(let title): return title
        case .project(let row): return row.name
        case .meeting(let row): return row.title
        case .deletedMeeting(let row): return row.title
        case .newProject: return "New Project…"
        }
    }
    var symbol: String {
        switch self {
        case .library: return "tray.full"
        case .project: return "folder"
        case .meeting(let row): return ["starting", "recording", "paused", "finalizing"].contains(row.status) ? "record.circle" : "doc.text"
        case .deletedMeeting: return "trash"
        case .newProject: return "plus"
        case .heading: return ""
        }
    }
}

private final class ArchiveContentViewController: NSViewController {
    override func loadView() { view = NSView() }
}
private final class ArchiveNavigationTableView: NSTableView {
    var contextMenuForRow: ((Int) -> NSMenu?)?
    override func menu(for event: NSEvent) -> NSMenu? {
        // A secondary click can target a different row from the open meeting.
        // Capture that row now; menu actions must never consult selectedRow.
        let row = row(at: convert(event.locationInWindow, from: nil))
        guard isEnabled, row >= 0 else { return nil }
        return contextMenuForRow?(row)
    }
    override func keyDown(with event: NSEvent) {
        if isEnabled, selectedRow >= 0, [36, 49, 76].contains(event.keyCode), let action {
            NSApp.sendAction(action, to: target, from: self)
        } else { super.keyDown(with: event) }
    }
}

@MainActor final class MeetingArchiveShell: NSObject, NSTableViewDataSource, NSTableViewDelegate, NSSearchFieldDelegate, NSToolbarDelegate {
    let split = NSSplitViewController()
    private let sidebarController = ArchiveContentViewController()
    private let contentController = ArchiveContentViewController()
    private let web: WKWebView
    private weak var window: NSWindow?
    var onAction: ((String, [String: Any]) -> Void)?
    var onSettings: (() -> Void)?
    private(set) var snapshot: ArchiveShellSnapshot?
    private(set) var snapshotReceived = false
    private var interactionEnabled = false
    private var meetingSheetOpen = false
    private weak var renameTitleField: NSTextField?
    private weak var renameSaveButton: NSButton?
    private var quitLocked = false
    private var searchFocusedBeforeQuit = false
    private var searchSelectionBeforeQuit: NSRange?
    private var updatingSelection = false
    private var confirmedSelectionKey = ""
    private var rows: [ArchiveSidebarRow] = []
    private var visibleMeetings: [ArchiveMeetingRow] = []
    private let sidebar = ArchiveNavigationTableView()
    private let library = ArchiveNavigationTableView()
    private let searchField = NSSearchField()
    private let libraryView = NSView()
    private let libraryCount = NSTextField(labelWithString: "Loading your meetings…")
    private let emptyTitle = NSTextField(labelWithString: "Your meetings, together")
    private let emptySubtitle = NSTextField(wrappingLabelWithString: "Record a meeting to keep its video, audio, notes, and context in one place.")
    private let emptyView = NSStackView()
    private let errorLabel = NSTextField(wrappingLabelWithString: "")
    private let storageLabel = NSTextField(labelWithString: "Local archive")
    private let connectionLabel = NSTextField(labelWithString: "Connecting…")
    private let recordingBar = NSView()
    private let recordingTitle = NSTextField(labelWithString: "")
    private let recordingStatus = NSTextField(labelWithString: "")
    private let recordingWarning = NSTextField(labelWithString: "")
    private let recordingHeight: NSLayoutConstraint
    private let pauseButton = NSButton(title: "Pause", target: nil, action: nil)
    private let stopButton = NSButton(title: "Stop & Save", target: nil, action: nil)
    private let micButton = NSButton(title: "Mic Off", target: nil, action: nil)
    private let newButton = NSButton(title: "New Meeting", target: nil, action: nil)
    private let settingsButton = NSButton(title: "Settings", target: nil, action: nil)
    private let sidebarButton = NSButton(title: "Sidebar", target: nil, action: nil)
    private let emptyNewButton = NSButton(title: "New Meeting", target: nil, action: nil)
    private var toolbar: NSToolbar!
    private var settingsWindow: NSWindow?
    private var dataDirectory: URL?
    private var analysisPreferences: AnalysisPreferencesViewController?
    private let settingsPath = NSTextField(wrappingLabelWithString: "Loading archive location…")
    private let settingsSpace = NSTextField(labelWithString: "")
    private let settingsScreen = NSTextField(labelWithString: "Not checked")
    private let settingsMic = NSTextField(labelWithString: "Not checked")
    private let settingsAccessibility = NSTextField(labelWithString: "Not required")
    private let settingsError = NSTextField(wrappingLabelWithString: "")
    private let settingsRefresh = NSButton(title: "Check Permissions", target: nil, action: nil)
    private let settingsScreenRequest = NSButton(title: "Request Access", target: nil, action: nil)
    private let settingsScreenOpen = NSButton(title: "Open Settings…", target: nil, action: nil)
    private let settingsMicRequest = NSButton(title: "Request Access", target: nil, action: nil)
    private let settingsMicOpen = NSButton(title: "Open Settings…", target: nil, action: nil)
    private let revealFolder = NSButton(title: "Show in Finder", target: nil, action: nil)

    init(web: WKWebView, window: NSWindow) {
        self.web = web; self.window = window
        recordingHeight = recordingBar.heightAnchor.constraint(equalToConstant: 0)
        super.init()
        buildSidebar(); buildContent(); buildToolbar()
        let sidebarItem = NSSplitViewItem(sidebarWithViewController: sidebarController)
        sidebarItem.minimumThickness = 180; sidebarItem.maximumThickness = 280
        sidebarItem.preferredThicknessFraction = 0.20
        sidebarItem.canCollapse = true
        split.addSplitViewItem(sidebarItem)
        let detail = NSSplitViewItem(viewController: contentController)
        detail.minimumThickness = 460
        split.addSplitViewItem(detail)
        split.splitView.autosaveName = "MeetingArchiveNativeSidebar"
        window.contentViewController = split
        libraryView.isHidden = false; web.isHidden = true
        setInteractionEnabled(false)
    }
    private func pin(_ view: NSView, to container: NSView, inset: CGFloat = 0) {
        view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([view.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: inset),
            view.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -inset),
            view.topAnchor.constraint(equalTo: container.topAnchor, constant: inset),
            view.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -inset)])
    }
    private func configureTable(_ table: NSTableView, name: String) -> NSScrollView {
        table.headerView = nil; table.focusRingType = .default
        table.selectionHighlightStyle = .regular; table.allowsEmptySelection = true
        table.allowsMultipleSelection = false; table.dataSource = self; table.delegate = self
        table.setAccessibilityLabel(name)
        table.addTableColumn(NSTableColumn(identifier: NSUserInterfaceItemIdentifier("title")))
        table.columnAutoresizingStyle = .lastColumnOnlyAutoresizingStyle
        let scroll = NSScrollView(); scroll.documentView = table; scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true; scroll.drawsBackground = false
        return scroll
    }
    private func buildSidebar() {
        sidebar.style = .sourceList
        sidebar.contextMenuForRow = { [weak self] row in self?.meetingMenu(inSidebar: true, row: row) }
        sidebar.target = self; sidebar.action = #selector(sidebarClicked)
        let scroll = configureTable(sidebar, name: "Projects and recent meetings")
        let footer = NSStackView(views: [connectionLabel, storageLabel]); footer.orientation = .vertical
        footer.alignment = .leading; footer.spacing = 4
        connectionLabel.font = .systemFont(ofSize: 12, weight: .medium)
        storageLabel.font = .systemFont(ofSize: 12); storageLabel.textColor = .secondaryLabelColor
        storageLabel.lineBreakMode = .byTruncatingMiddle
        let view = sidebarController.view
        view.addSubview(scroll); view.addSubview(footer)
        scroll.translatesAutoresizingMaskIntoConstraints = false; footer.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([scroll.topAnchor.constraint(equalTo: view.topAnchor, constant: 10),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 6),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -6),
            scroll.bottomAnchor.constraint(equalTo: footer.topAnchor, constant: -12),
            footer.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 18),
            footer.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
            footer.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -16)])
        rows = [.library, .heading("Projects"), .newProject]; sidebar.reloadData()
    }
    private func buildContent() {
        let view = contentController.view, body = NSView()
        view.addSubview(recordingBar); view.addSubview(body)
        recordingBar.translatesAutoresizingMaskIntoConstraints = false; body.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([recordingBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            recordingBar.trailingAnchor.constraint(equalTo: view.trailingAnchor), recordingBar.topAnchor.constraint(equalTo: view.topAnchor), recordingHeight,
            body.topAnchor.constraint(equalTo: recordingBar.bottomAnchor), body.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            body.trailingAnchor.constraint(equalTo: view.trailingAnchor), body.bottomAnchor.constraint(equalTo: view.bottomAnchor)])
        body.addSubview(web); pin(web, to: body)
        body.addSubview(libraryView); pin(libraryView, to: body)
        buildRecordingBar(); buildLibrary()
    }
    private func buildLibrary() {
        let title = NSTextField(labelWithString: "Meetings")
        title.font = .systemFont(ofSize: 29, weight: .bold)
        libraryCount.font = .systemFont(ofSize: 13); libraryCount.textColor = .secondaryLabelColor
        let header = NSStackView(views: [title, libraryCount]); header.orientation = .vertical; header.alignment = .leading; header.spacing = 6
        let scroll = configureTable(library, name: "Meeting library")
        library.style = .fullWidth; library.rowHeight = 88; library.intercellSpacing = NSSize(width: 0, height: 4)
        library.target = self; library.action = #selector(libraryClicked)
        library.contextMenuForRow = { [weak self] row in self?.meetingMenu(inSidebar: false, row: row) }
        errorLabel.textColor = .systemRed; errorLabel.font = .systemFont(ofSize: 12); errorLabel.isSelectable = true
        libraryView.addSubview(header); libraryView.addSubview(errorLabel); libraryView.addSubview(scroll)
        [header, errorLabel, scroll].forEach { $0.translatesAutoresizingMaskIntoConstraints = false }
        NSLayoutConstraint.activate([header.leadingAnchor.constraint(equalTo: libraryView.leadingAnchor, constant: 30),
            header.topAnchor.constraint(equalTo: libraryView.topAnchor, constant: 30),
            header.trailingAnchor.constraint(lessThanOrEqualTo: libraryView.trailingAnchor, constant: -30),
            errorLabel.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 10),
            errorLabel.leadingAnchor.constraint(equalTo: header.leadingAnchor),
            errorLabel.trailingAnchor.constraint(equalTo: libraryView.trailingAnchor, constant: -30),
            errorLabel.heightAnchor.constraint(lessThanOrEqualToConstant: 80),
            scroll.topAnchor.constraint(equalTo: errorLabel.bottomAnchor, constant: 12),
            scroll.leadingAnchor.constraint(equalTo: libraryView.leadingAnchor, constant: 14),
            scroll.trailingAnchor.constraint(equalTo: libraryView.trailingAnchor, constant: -14),
            scroll.bottomAnchor.constraint(equalTo: libraryView.bottomAnchor, constant: -16)])
        emptyTitle.font = .systemFont(ofSize: 21, weight: .semibold)
        emptySubtitle.textColor = .secondaryLabelColor; emptySubtitle.alignment = .center
        emptyNewButton.bezelStyle = .rounded; emptyNewButton.target = self; emptyNewButton.action = #selector(newMeeting)
        emptyView.orientation = .vertical; emptyView.alignment = .centerX; emptyView.spacing = 14
        emptyView.addArrangedSubview(emptyTitle); emptyView.addArrangedSubview(emptySubtitle); emptyView.addArrangedSubview(emptyNewButton)
        libraryView.addSubview(emptyView); emptyView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([emptyView.centerXAnchor.constraint(equalTo: libraryView.centerXAnchor),
            emptyView.centerYAnchor.constraint(equalTo: libraryView.centerYAnchor),
            emptyView.widthAnchor.constraint(lessThanOrEqualToConstant: 380),
            emptyView.leadingAnchor.constraint(greaterThanOrEqualTo: libraryView.leadingAnchor, constant: 35),
            emptyView.trailingAnchor.constraint(lessThanOrEqualTo: libraryView.trailingAnchor, constant: -35)])
    }
    private func buildRecordingBar() {
        recordingBar.wantsLayer = true; recordingBar.layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
        recordingTitle.font = .systemFont(ofSize: 12, weight: .semibold); recordingTitle.lineBreakMode = .byTruncatingTail
        recordingStatus.font = .systemFont(ofSize: 11); recordingStatus.textColor = .secondaryLabelColor
        recordingWarning.font = .systemFont(ofSize: 10); recordingWarning.textColor = .systemOrange; recordingWarning.lineBreakMode = .byTruncatingTail
        let text = NSStackView(views: [recordingTitle, recordingStatus, recordingWarning]); text.orientation = .vertical; text.alignment = .leading; text.spacing = 2
        pauseButton.target = self; pauseButton.action = #selector(togglePause)
        stopButton.target = self; stopButton.action = #selector(stopRecording)
        micButton.target = self; micButton.action = #selector(toggleMic)
        for button in [pauseButton, stopButton, micButton] { button.bezelStyle = .rounded; button.controlSize = .regular }
        stopButton.contentTintColor = .systemRed
        micButton.toolTip = "Controls this app’s microphone capture independently of your meeting app."
        let controls = NSStackView(views: [micButton, pauseButton, stopButton]); controls.orientation = .horizontal; controls.spacing = 6
        recordingBar.addSubview(text); recordingBar.addSubview(controls)
        text.translatesAutoresizingMaskIntoConstraints = false; controls.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([text.leadingAnchor.constraint(equalTo: recordingBar.leadingAnchor, constant: 16),
            text.centerYAnchor.constraint(equalTo: recordingBar.centerYAnchor),
            text.trailingAnchor.constraint(lessThanOrEqualTo: controls.leadingAnchor, constant: -12),
            text.widthAnchor.constraint(greaterThanOrEqualToConstant: 100),
            controls.centerYAnchor.constraint(equalTo: recordingBar.centerYAnchor),
            controls.trailingAnchor.constraint(equalTo: recordingBar.trailingAnchor, constant: -14)])
        text.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        recordingTitle.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        recordingWarning.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    }
    private func buildToolbar() {
        toolbar = NSToolbar(identifier: "MeetingArchiveNativeToolbar"); toolbar.delegate = self
        toolbar.displayMode = .iconOnly; toolbar.allowsUserCustomization = false
        searchField.placeholderString = "Search meetings"; searchField.delegate = self
        searchField.setAccessibilityLabel("Search meetings")
        searchField.sendsSearchStringImmediately = true; searchField.sendsWholeSearchString = false
        searchField.controlSize = .regular
        searchField.widthAnchor.constraint(equalToConstant: 220).isActive = true
        for button in [newButton, settingsButton, sidebarButton] { button.bezelStyle = .texturedRounded }
        newButton.image = NSImage(systemSymbolName: "plus", accessibilityDescription: nil); newButton.imagePosition = .imageLeading
        newButton.target = self; newButton.action = #selector(newMeeting); newButton.toolTip = "New Meeting (⌘N)"
        settingsButton.image = NSImage(systemSymbolName: "gearshape", accessibilityDescription: "Settings")
        settingsButton.imagePosition = .imageOnly; settingsButton.target = self; settingsButton.action = #selector(openSettings)
        settingsButton.toolTip = "Settings (⌘,)"
        sidebarButton.image = NSImage(systemSymbolName: "sidebar.left", accessibilityDescription: "Toggle Sidebar")
        sidebarButton.imagePosition = .imageOnly; sidebarButton.target = self; sidebarButton.action = #selector(toggleSidebar)
        sidebarButton.toolTip = "Toggle Sidebar"
        window?.toolbar = toolbar; window?.toolbarStyle = .unified
    }
    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { toolbarDefaultItemIdentifiers(toolbar) }
    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [NSToolbarItem.Identifier("sidebar"), .flexibleSpace, NSToolbarItem.Identifier("search"), NSToolbarItem.Identifier("new"), NSToolbarItem.Identifier("settings")]
    }
    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier identifier: NSToolbarItem.Identifier, willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        let item = NSToolbarItem(itemIdentifier: identifier)
        switch identifier.rawValue {
        case "sidebar": item.view = sidebarButton; item.label = "Toggle Sidebar"
        case "search": item.view = searchField; item.label = "Search Meetings"
        case "new": item.view = newButton; item.label = "New Meeting"
        case "settings": item.view = settingsButton; item.label = "Settings"
        default: return nil
        }
        return item
    }
    func apply(_ snapshot: ArchiveShellSnapshot) {
        self.snapshot = snapshot; snapshotReceived = true
        var newRows: [ArchiveSidebarRow] = [.library, .heading("Projects")]
            + snapshot.projects.map(ArchiveSidebarRow.project) + [.newProject, .heading("Recent Meetings")]
            + snapshot.meetings.prefix(8).map(ArchiveSidebarRow.meeting)
        if !snapshot.deletedMeetings.isEmpty {
            newRows += [.heading("Recently Deleted")] + snapshot.deletedMeetings.map(ArchiveSidebarRow.deletedMeeting)
        }
        let highlightedKey = rows.indices.contains(sidebar.selectedRow) ? rows[sidebar.selectedRow].key : nil
        if rows != newRows {
            rows = newRows; sidebar.reloadData()
            if let highlightedKey, let row = rows.firstIndex(where: { $0.key == highlightedKey }) {
                sidebar.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
            }
        }
        updatingSelection = true
        let selectedKey = snapshot.view == "home" ? "library" : snapshot.view == "project"
            ? "project:" + (snapshot.selectedProjectId ?? "") : "meeting:" + (snapshot.selectedMeetingId ?? "")
        if selectedKey != confirmedSelectionKey {
            confirmedSelectionKey = selectedKey
            if let index = rows.firstIndex(where: { $0.key == selectedKey }) {
                if sidebar.selectedRow != index { sidebar.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false) }
            } else { sidebar.deselectAll(nil) }
        }
        updatingSelection = false
        libraryView.isHidden = snapshot.view != "home"; web.isHidden = snapshot.view == "home"
        connectionLabel.stringValue = snapshot.connected ? "On this Mac" : "Local service disconnected"
        connectionLabel.textColor = snapshot.connected ? .secondaryLabelColor : .systemOrange
        storageLabel.stringValue = snapshot.freeBytes.map { ByteCountFormatter.string(fromByteCount: Int64(max(0, $0)), countStyle: .file) + " available" } ?? "Local archive"
        storageLabel.toolTip = snapshot.archivePath
        errorLabel.stringValue = snapshot.message.isEmpty && !snapshot.connected ? "The local service is disconnected. Your saved recordings remain on this Mac." : snapshot.message
        updateLibrary(); updateRecordingBar(); updateSettings(); refreshControls()
    }
    private var canAct: Bool { interactionEnabled && !quitLocked && !meetingSheetOpen && snapshot?.connected == true && snapshot?.busy != true }
    func setInteractionEnabled(_ enabled: Bool) { interactionEnabled = enabled; refreshControls() }
    func setDataDirectory(_ directory: URL) { dataDirectory = directory }
    func beginQuitLock() {
        if !quitLocked { searchFocusedBeforeQuit = searchIsFocused; searchSelectionBeforeQuit = searchSelection }
        quitLocked = true; refreshControls()
    }
    func endQuitLock() {
        quitLocked = false; refreshControls()
        if searchFocusedBeforeQuit { focusSearch(selection: searchSelectionBeforeQuit) }
        searchFocusedBeforeQuit = false; searchSelectionBeforeQuit = nil
    }
    var searchIsFocused: Bool {
        guard let editor = searchField.currentEditor() else { return window?.firstResponder === searchField }
        return window?.firstResponder === editor
    }
    var searchSelection: NSRange? { (searchField.currentEditor() as? NSTextView)?.selectedRange() }
    var controlsAreLocked: Bool { quitLocked && !searchField.isEnabled && !newButton.isEnabled && !settingsButton.isEnabled && !stopButton.isEnabled }
    var controlsAreRestored: Bool { !quitLocked && searchField.isEnabled && settingsButton.isEnabled }
    func focusSearch(selection: NSRange? = nil) {
        guard interactionEnabled, !quitLocked else { return }
        // A queued navigation must not move the caret backwards while the
        // user is still typing in an already-focused native search field.
        if searchIsFocused { return }
        window?.makeFirstResponder(searchField)
        if let selection, let editor = searchField.currentEditor() as? NSTextView {
            let length = (searchField.stringValue as NSString).length
            let start = min(selection.location, length)
            editor.setSelectedRange(NSRange(location: start, length: min(selection.length, length - start)))
        }
    }
    private func refreshControls() {
        searchField.isEnabled = interactionEnabled && !quitLocked
        sidebar.isEnabled = canAct; library.isEnabled = canAct
        newButton.isEnabled = canAct && snapshot?.activeRecording == nil; emptyNewButton.isEnabled = newButton.isEnabled
        settingsButton.isEnabled = interactionEnabled && !quitLocked
        sidebarButton.isEnabled = !quitLocked
        let active = snapshot?.activeRecording
        let controllable = canAct && active.map { ["recording", "paused"].contains($0.status) } == true
        pauseButton.isEnabled = controllable; stopButton.isEnabled = controllable
        micButton.isEnabled = controllable && active?.microphoneSelected == true
        let permissionsEnabled = canAct && snapshot?.settingsChecking != true
        settingsRefresh.isEnabled = permissionsEnabled
        settingsScreenOpen.isEnabled = permissionsEnabled; settingsMicOpen.isEnabled = permissionsEnabled
        settingsScreenRequest.isEnabled = permissionsEnabled && snapshot?.permissions["screenCapture"] != "granted"
        settingsMicRequest.isEnabled = permissionsEnabled && !["granted", "denied", "restricted"].contains(snapshot?.permissions["microphone"] ?? "")
        revealFolder.isEnabled = !quitLocked && !(snapshot?.archivePath.isEmpty ?? true)
        analysisPreferences?.setInteractionEnabled(!quitLocked)
    }
    private func updateLibrary() {
        guard let snapshot else { return }
        let query = searchField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let filtered = snapshot.meetings.filter { meeting in
            query.isEmpty || meeting.title.localizedStandardContains(query) || meeting.notesPreview.localizedStandardContains(query)
                || snapshot.projects.first(where: { $0.id == meeting.projectId })?.name.localizedStandardContains(query) == true
        }
        if filtered != visibleMeetings {
            let highlightedID = visibleMeetings.indices.contains(library.selectedRow) ? visibleMeetings[library.selectedRow].id : nil
            visibleMeetings = filtered; library.reloadData()
            if let highlightedID, let row = visibleMeetings.firstIndex(where: { $0.id == highlightedID }) {
                library.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
            }
        }
        libraryCount.stringValue = query.isEmpty ? "\(snapshot.meetings.count) \(snapshot.meetings.count == 1 ? "meeting" : "meetings") · Your local archive"
            : "\(filtered.count) \(filtered.count == 1 ? "result" : "results")"
        emptyView.isHidden = !filtered.isEmpty
        emptyTitle.stringValue = query.isEmpty ? "Your meetings, together" : "No matching meetings"
        emptySubtitle.stringValue = query.isEmpty ? "Record a meeting to keep its video, audio, notes, and context in one place." : "Try another title, project, or phrase from your notes."
        emptyNewButton.isHidden = !query.isEmpty
    }
    private func updateRecordingBar() {
        guard let active = snapshot?.activeRecording else { recordingBar.isHidden = true; recordingHeight.constant = 0; return }
        recordingBar.isHidden = false; recordingHeight.constant = active.warning.isEmpty ? 62 : 78
        recordingTitle.stringValue = active.title
        let status = statusLabel(active.status)
        recordingStatus.stringValue = status + (active.microphoneSelected ? " · Microphone " + (active.micEnabled ? "on" : "off") : " · Microphone not recorded")
        recordingStatus.textColor = active.status == "recording" ? .systemRed : .secondaryLabelColor
        recordingWarning.stringValue = active.warning; recordingWarning.isHidden = active.warning.isEmpty; recordingWarning.toolTip = active.warning
        micButton.title = active.micEnabled ? "Mute Mic" : "Enable Mic"; micButton.isHidden = !active.microphoneSelected
        micButton.image = NSImage(systemSymbolName: active.micEnabled ? "mic.fill" : "mic.slash", accessibilityDescription: nil)
        micButton.imagePosition = .imageLeading
        micButton.setAccessibilityLabel(active.micEnabled ? "Stop recording microphone" : "Record microphone")
        pauseButton.title = active.status == "paused" ? "Resume" : "Pause"
        stopButton.title = active.status == "finalizing" ? "Saving…" : "Stop & Save"
    }
    private func statusLabel(_ status: String) -> String {
        ["starting": "Preparing", "recording": "Recording", "paused": "Paused", "finalizing": "Saving",
         "recorded": "Saved", "partial": "Partially saved · Gaps detected", "failed": "Recording failed", "unavailable": "Unavailable"][status] ?? status.capitalized
    }
    func numberOfRows(in tableView: NSTableView) -> Int { tableView === sidebar ? rows.count : visibleMeetings.count }
    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
        if tableView === library { return 88 }
        if case .heading = rows[row] { return 28 }
        return 32
    }
    func tableView(_ tableView: NSTableView, isGroupRow row: Int) -> Bool {
        guard tableView === sidebar else { return false }
        if case .heading = rows[row] { return true }; return false
    }
    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool {
        guard canAct else { return false }
        if tableView === sidebar, case .heading = rows[row] { return false }
        return true
    }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        if tableView === sidebar {
            let row = rows[row], cell = NSTableCellView()
            let label = NSTextField(labelWithString: row.title); label.lineBreakMode = .byTruncatingTail
            label.font = .systemFont(ofSize: 13); cell.textField = label
            if case .heading = row {
                label.font = .systemFont(ofSize: 11, weight: .semibold); label.textColor = .secondaryLabelColor
                cell.addSubview(label); label.translatesAutoresizingMaskIntoConstraints = false
                NSLayoutConstraint.activate([label.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 8), label.centerYAnchor.constraint(equalTo: cell.centerYAnchor), label.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -5)])
            } else {
                let icon = NSImageView(image: NSImage(systemSymbolName: row.symbol, accessibilityDescription: nil) ?? NSImage())
                icon.contentTintColor = .secondaryLabelColor
                let stack = NSStackView(views: [icon, label]); stack.spacing = 9; stack.orientation = .horizontal
                cell.addSubview(stack); pin(stack, to: cell, inset: 6)
                icon.widthAnchor.constraint(equalToConstant: 17).isActive = true
            }
            // Tooltips are resolved from the current row by the delegate.
            // A cached cell tooltip can otherwise show the prior meeting after
            // a rename, insertion, deletion, or a snapshot reload.
            cell.toolTip = nil; cell.setAccessibilityLabel(row.title); return cell
        }
        let meeting = visibleMeetings[row], cell = NSTableCellView()
        let title = NSTextField(labelWithString: meeting.title); title.font = .systemFont(ofSize: 15, weight: .semibold); title.lineBreakMode = .byTruncatingTail
        let date = displayDate(meeting.createdAt)
        let project = snapshot?.projects.first(where: { $0.id == meeting.projectId })?.name
        let detail = NSTextField(labelWithString: [date, project, statusLabel(meeting.status)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
        detail.font = .systemFont(ofSize: 11); detail.textColor = .secondaryLabelColor; detail.lineBreakMode = .byTruncatingTail
        let preview = NSTextField(labelWithString: meeting.notesPreview.isEmpty ? "Open meeting notes and recordings" : meeting.notesPreview)
        preview.font = .systemFont(ofSize: 12); preview.textColor = .secondaryLabelColor; preview.lineBreakMode = .byTruncatingTail
        let stack = NSStackView(views: [title, detail, preview]); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 7
        cell.addSubview(stack); stack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 16), stack.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -16), stack.centerYAnchor.constraint(equalTo: cell.centerYAnchor)])
        cell.textField = title; cell.toolTip = nil; cell.setAccessibilityLabel(meeting.title + ", " + detail.stringValue)
        return cell
    }
    func tableView(_ tableView: NSTableView, toolTipFor cell: NSCell, rect: NSRectPointer, tableColumn: NSTableColumn?, row: Int, mouseLocation: NSPoint) -> String {
        if tableView === sidebar { return rows.indices.contains(row) ? rows[row].title : "" }
        return visibleMeetings.indices.contains(row) ? visibleMeetings[row].title : ""
    }
    private func canChangeMeeting(_ id: String) -> Bool {
        canAct && snapshot?.activeRecording?.id != id && snapshot?.meetings.first(where: { $0.id == id })?.canChange == true
    }
    private func meetingMenu(inSidebar: Bool, row: Int) -> NSMenu? {
        guard canAct else { return nil }
        if inSidebar {
            guard rows.indices.contains(row) else { return nil }
            if case .deletedMeeting(let meeting) = rows[row] {
                let menu = NSMenu(); menu.autoenablesItems = false
                let restore = NSMenuItem(title: "Restore", action: #selector(restoreMeeting(_:)), keyEquivalent: "")
                restore.target = self; restore.representedObject = meeting.id; menu.addItem(restore)
                return menu
            }
            guard case .meeting(let meeting) = rows[row] else { return nil }
            return meetingMenu(meeting)
        }
        guard visibleMeetings.indices.contains(row) else { return nil }
        return meetingMenu(visibleMeetings[row])
    }
    private func meetingMenu(_ meeting: ArchiveMeetingRow) -> NSMenu {
        let menu = NSMenu(); menu.autoenablesItems = false
        for (title, action) in [("Rename…", #selector(renameMeeting(_:))), ("Delete…", #selector(deleteMeeting(_:)))] {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
            item.target = self; item.representedObject = meeting.id; item.isEnabled = canChangeMeeting(meeting.id)
            if !item.isEnabled { item.toolTip = "Stop recording or wait for this meeting’s processing to finish first." }
            menu.addItem(item)
        }
        return menu
    }
    @objc private func renameMeeting(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String, canChangeMeeting(id),
              let meeting = snapshot?.meetings.first(where: { $0.id == id }), let window else { return }
        let alert = NSAlert(); alert.messageText = "Rename meeting"
        alert.informativeText = "Enter a name for “\(meeting.title)”. Use up to 300 characters without line breaks."
        let save = alert.addButton(withTitle: "Rename"); alert.addButton(withTitle: "Cancel")
        let field = NSTextField(string: meeting.title); field.frame = NSRect(x: 0, y: 0, width: 360, height: 24)
        field.placeholderString = "Meeting name"; field.setAccessibilityLabel("Meeting name"); field.delegate = self
        alert.accessoryView = field; alert.window.initialFirstResponder = field
        renameTitleField = field; renameSaveButton = save
        save.isEnabled = ArchiveMeetingTitle.normalized(field.stringValue) != nil
        meetingSheetOpen = true; refreshControls()
        alert.beginSheetModal(for: window) { [weak self] response in
            guard let self else { return }
            self.meetingSheetOpen = false; self.renameTitleField = nil; self.renameSaveButton = nil; self.refreshControls()
            guard response == .alertFirstButtonReturn, self.canChangeMeeting(id),
                  let title = ArchiveMeetingTitle.normalized(field.stringValue) else { return }
            self.onAction?("meeting-rename", ["id": id, "title": title])
        }
    }
    @objc private func deleteMeeting(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String, canChangeMeeting(id),
              let meeting = snapshot?.meetings.first(where: { $0.id == id }), let window else { return }
        let alert = NSAlert(); alert.messageText = "Delete “\(meeting.title)”?"
        alert.informativeText = "This meeting and its recordings, documents, and generated files will move to Recently Deleted in MinuteShelf. You can restore them from the sidebar. Nothing is permanently erased."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Move to Recently Deleted"); alert.addButton(withTitle: "Cancel")
        // Return should keep the archive; deleting remains an explicit click.
        alert.buttons[0].keyEquivalent = ""; alert.buttons[1].keyEquivalent = "\r"
        meetingSheetOpen = true; refreshControls()
        alert.beginSheetModal(for: window) { [weak self] response in
            guard let self else { return }
            self.meetingSheetOpen = false; self.refreshControls()
            guard response == .alertFirstButtonReturn, self.canChangeMeeting(id) else { return }
            self.onAction?("meeting-trash", ["id": id])
        }
    }
    @objc private func restoreMeeting(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        restoreMeeting(id: id)
    }
    private func restoreMeeting(id: String) {
        guard canAct, let meeting = snapshot?.deletedMeetings.first(where: { $0.id == id }), let window else { return }
        let alert = NSAlert(); alert.messageText = "Restore “\(meeting.title)”?"
        alert.informativeText = "The meeting and all its saved files will return to your meeting library."
        alert.addButton(withTitle: "Restore"); alert.addButton(withTitle: "Cancel")
        meetingSheetOpen = true; refreshControls()
        alert.beginSheetModal(for: window) { [weak self] response in
            guard let self else { return }
            self.meetingSheetOpen = false; self.refreshControls(); self.restoreConfirmedSelection()
            guard response == .alertFirstButtonReturn, self.canAct,
                  self.snapshot?.deletedMeetings.contains(where: { $0.id == id }) == true else { return }
            self.onAction?("meeting-restore", ["id": id])
        }
    }
    private func displayDate(_ value: String) -> String {
        let format = ISO8601DateFormatter(); format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var date = format.date(from: value)
        if date == nil { format.formatOptions = [.withInternetDateTime]; date = format.date(from: value) }
        guard let date else { return value }
        let display = DateFormatter(); display.dateStyle = .medium; display.timeStyle = .short
        return display.string(from: date)
    }
    func tableViewSelectionDidChange(_ notification: Notification) {
        // Selection is visual feedback only until the bridge confirms draft
        // saving and publishes navigation. Keyboard selection remains useful.
        guard !updatingSelection, canAct else { return }
    }
    @objc private func sidebarClicked() {
        guard canAct, sidebar.selectedRow >= 0 else { return }
        switch rows[sidebar.selectedRow] {
        case .library: onAction?("library", [:])
        case .project(let project): onAction?("project", ["id": project.id])
        case .meeting(let meeting): onAction?("meeting", ["id": meeting.id])
        case .deletedMeeting(let meeting): restoreMeeting(id: meeting.id)
        case .newProject: onAction?("new-project", [:])
        case .heading: break
        }
    }
    @objc private func libraryClicked() {
        guard canAct, library.selectedRow >= 0, visibleMeetings.indices.contains(library.selectedRow) else { return }
        onAction?("meeting", ["id": visibleMeetings[library.selectedRow].id])
    }
    func restoreConfirmedSelection() {
        guard let snapshot else { return }
        updatingSelection = true
        let key = snapshot.view == "home" ? "library" : snapshot.view == "project" ? "project:" + (snapshot.selectedProjectId ?? "") : "meeting:" + (snapshot.selectedMeetingId ?? "")
        if let row = rows.firstIndex(where: { $0.key == key }) { sidebar.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false) }
        else { sidebar.deselectAll(nil) }
        updatingSelection = false
    }
    func controlTextDidChange(_ obj: Notification) {
        if let field = obj.object as? NSTextField, field === renameTitleField {
            renameSaveButton?.isEnabled = ArchiveMeetingTitle.normalized(field.stringValue) != nil
            return
        }
        guard obj.object as? NSSearchField === searchField, !quitLocked else { return }
        updateLibrary()
        if snapshot?.view != "home" { onAction?("search", [:]) }
    }
    @objc private func newMeeting() { guard canAct, snapshot?.activeRecording == nil else { return }; onAction?("new", [:]) }
    @objc private func openSettings() { guard interactionEnabled, !quitLocked else { return }; onSettings?() }
    @objc private func toggleSidebar() { guard !quitLocked else { return }; split.toggleSidebar(nil) }
    @objc private func togglePause() {
        guard canAct, let active = snapshot?.activeRecording, ["paused", "recording"].contains(active.status) else { return }
        onAction?(active.status == "paused" ? "resume" : "pause", ["id": active.id])
    }
    @objc private func toggleMic() {
        guard canAct, let active = snapshot?.activeRecording, active.microphoneSelected, ["paused", "recording"].contains(active.status) else { return }
        onAction?("mic", ["id": active.id, "enabled": !active.micEnabled])
    }
    @objc private func stopRecording() {
        guard canAct, let active = snapshot?.activeRecording, ["paused", "recording"].contains(active.status) else { return }
        onAction?("stop", ["id": active.id])
    }
    func showSettings(refresh: Bool = true) {
        constructSettings(); updateSettings(); refreshControls()
        settingsWindow?.makeKeyAndOrderFront(nil)
        if refresh && canAct {
            onAction?("settings-refresh", [:])
            analysisPreferences?.refreshModelCatalogsIfNeeded()
        }
    }
    func refreshPermissionsAfterActivation() {
        // Returning from System Settings only rechecks access; it never prompts
        // or refreshes model catalogs. Permission requests remain user actions.
        guard settingsWindow?.isVisible == true, canAct, snapshot?.settingsChecking != true else { return }
        onAction?("settings-refresh", [:])
    }
    func stopCodexConnection() { analysisPreferences?.stopCodexConnection() }
    private func constructSettings() {
        guard settingsWindow == nil else { return }
        let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 700, height: 570), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        panel.title = "MinuteShelf Settings"; panel.isReleasedWhenClosed = false; panel.center()
        panel.contentMinSize = NSSize(width: 660, height: 520)
        let tabs = NSTabView(); tabs.tabViewType = .topTabsBezelBorder
        let general = NSTabViewItem(identifier: "general"); general.label = "General"; general.view = NSView()
        tabs.addTabViewItem(general)
        if let dataDirectory {
            let analysis = AnalysisPreferencesViewController(dataDirectory: dataDirectory)
            analysisPreferences = analysis
            let item = NSTabViewItem(identifier: "analysis"); item.label = "Analysis"; item.view = analysis.view
            tabs.addTabViewItem(item)
        }
        if let content = panel.contentView { content.addSubview(tabs); pin(tabs, to: content, inset: 16) }
        let body = NSStackView(); body.orientation = .vertical; body.alignment = .leading; body.spacing = 14
        let storageTitle = NSTextField(labelWithString: "Archive Storage"); storageTitle.font = .systemFont(ofSize: 15, weight: .semibold)
        settingsPath.font = .systemFont(ofSize: 12); settingsPath.isSelectable = true; settingsPath.lineBreakMode = .byTruncatingMiddle
        settingsSpace.font = .systemFont(ofSize: 12); settingsSpace.textColor = .secondaryLabelColor
        revealFolder.bezelStyle = .rounded; revealFolder.target = self; revealFolder.action = #selector(revealArchive)
        let permissionTitle = NSTextField(labelWithString: "Permissions"); permissionTitle.font = .systemFont(ofSize: 15, weight: .semibold)
        for (button, scope, label, request) in [
            (settingsScreenRequest, 0, "Request screen and system audio access", true),
            (settingsScreenOpen, 0, "Open screen and system audio settings", false),
            (settingsMicRequest, 1, "Request microphone access", true),
            (settingsMicOpen, 1, "Open microphone settings", false)
        ] {
            button.bezelStyle = .rounded; button.controlSize = .small
            button.target = self; button.tag = scope
            button.action = request ? #selector(requestPermission(_:)) : #selector(openPermissionSettings(_:))
            button.setAccessibilityLabel(label)
        }
        settingsScreenRequest.toolTip = "Ask macOS for screen and system audio access. If a prompt does not appear, use Open Settings."
        settingsMicRequest.toolTip = "Ask macOS for microphone access. Previously denied access must be changed in System Settings."
        let screenActions = NSStackView(views: [settingsScreenRequest, settingsScreenOpen]); screenActions.spacing = 6
        let micActions = NSStackView(views: [settingsMicRequest, settingsMicOpen]); micActions.spacing = 6
        let grid = NSGridView(views: [[NSTextField(labelWithString: "Screen & System Audio"), settingsScreen, screenActions],
            [NSTextField(labelWithString: "Microphone"), settingsMic, micActions],
            [NSTextField(labelWithString: "Accessibility"), settingsAccessibility, NSGridCell.emptyContentView]])
        grid.columnSpacing = 14; grid.rowSpacing = 12
        grid.rowAlignment = .firstBaseline
        for field in [settingsScreen, settingsMic, settingsAccessibility] { field.font = .systemFont(ofSize: 12); field.textColor = .secondaryLabelColor }
        settingsRefresh.bezelStyle = .rounded; settingsRefresh.target = self; settingsRefresh.action = #selector(checkPermissions)
        let hint = NSTextField(wrappingLabelWithString: "Choose Request Access to show the macOS prompt, or Open Settings to enable MinuteShelf. After an update, check access again: macOS may retain the old Meeting Archive name or require renewed consent for this ad hoc signed build. An enabled switch alone does not confirm access. Restart if macOS asks, then check again. Microphone recording is separate from your meeting app’s mute control. Accessibility access is not needed.")
        hint.font = .systemFont(ofSize: 11); hint.textColor = .secondaryLabelColor
        settingsError.font = .systemFont(ofSize: 11); settingsError.textColor = .systemRed; settingsError.isSelectable = true
        for item in [storageTitle, settingsPath, settingsSpace, revealFolder, permissionTitle, grid, settingsRefresh, hint, settingsError] { body.addArrangedSubview(item) }
        general.view?.addSubview(body); body.translatesAutoresizingMaskIntoConstraints = false
        if let view = general.view {
            NSLayoutConstraint.activate([body.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 26),
                body.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -26), body.topAnchor.constraint(equalTo: view.topAnchor, constant: 24),
                body.bottomAnchor.constraint(lessThanOrEqualTo: view.bottomAnchor, constant: -20)])
            settingsPath.widthAnchor.constraint(equalTo: body.widthAnchor).isActive = true
            hint.widthAnchor.constraint(equalTo: body.widthAnchor).isActive = true
            settingsError.widthAnchor.constraint(equalTo: body.widthAnchor).isActive = true
        }
        settingsWindow = panel
    }
    private func updateSettings() {
        guard let snapshot else { return }
        settingsPath.stringValue = snapshot.archivePath.isEmpty ? "Archive location unavailable" : snapshot.archivePath
        settingsPath.toolTip = snapshot.archivePath
        settingsSpace.stringValue = snapshot.freeBytes.map { ByteCountFormatter.string(fromByteCount: Int64(max(0, $0)), countStyle: .file) + " available on the archive volume" } ?? ""
        let labels = ["granted": "Allowed", "not-granted": "Not allowed", "not-determined": "Not requested", "denied": "Denied", "restricted": "Restricted by macOS", "not-required": "Not required"]
        settingsScreen.stringValue = labels[snapshot.permissions["screenCapture"] ?? ""] ?? "Not checked"
        settingsMic.stringValue = labels[snapshot.permissions["microphone"] ?? ""] ?? "Not checked"
        settingsAccessibility.stringValue = labels[snapshot.permissions["accessibility"] ?? ""] ?? "Not required"
        settingsRefresh.title = snapshot.settingsChecking ? "Checking…" : "Check Permissions"
        settingsError.stringValue = snapshot.settingsError
    }
    @objc private func checkPermissions() { guard canAct, snapshot?.settingsChecking != true else { return }; onAction?("settings-refresh", [:]) }
    @objc private func requestPermission(_ sender: NSButton) {
        guard canAct, sender.isEnabled, snapshot?.settingsChecking != true else { return }
        onAction?("settings-request-permission", ["permission": sender.tag == 0 ? "screen" : "microphone"])
    }
    @objc private func openPermissionSettings(_ sender: NSButton) {
        guard canAct, sender.isEnabled, snapshot?.settingsChecking != true else { return }
        onAction?("settings-open-permission", ["permission": sender.tag == 0 ? "screen" : "microphone"])
    }
    @objc private func revealArchive() {
        guard !quitLocked, let path = snapshot?.archivePath, path.hasPrefix("/"), FileManager.default.fileExists(atPath: path) else { return }
        NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: path)
    }
    func smokeStructure() -> [String: Bool] {
        constructSettings() // No show, refresh, API calls, or permission prompts.
        return ["sidebar": sidebar.window === window && split.splitViewItems.count == 2,
            "toolbar": window?.toolbar === toolbar && toolbar.items.count >= 4,
            "nativeSearch": searchField.window === window,
            "stateSnapshot": snapshotReceived, "nativeLibrary": library.window === window && !libraryView.isHidden,
            "nativeSettings": settingsWindow?.title == "MinuteShelf Settings"]
    }
}
