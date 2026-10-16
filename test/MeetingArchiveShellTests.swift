import Foundation
import AppKit
import WebKit

// Default checks do not open NSApplication. --settings-ui uses an isolated
// Settings window, temporary preferences, and a fake local status service;
// neither mode reads user archives/credentials or requests permissions/network.
@main struct MeetingArchiveShellTests {
    static var checks = 0
    static func check(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        guard condition() else { throw NSError(domain: "MeetingArchiveShellTests", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
        checks += 1
    }
    @MainActor static func main() async throws {
        if CommandLine.arguments.contains("--settings-ui") {
            do { try await settingsLifecycle() }
            catch { fputs("Settings lifecycle regression: \(error.localizedDescription)\n", stderr); exit(1) }
            return
        }
        try check(ArchiveMeetingTitle.normalized("  测试 meeting  ") == "测试 meeting", "Unicode names must be preserved and trimmed")
        try check(ArchiveMeetingTitle.normalized("Cafe\u{301}") == "Café", "Names must normalize to NFC")
        try check(ArchiveMeetingTitle.normalized("Family 👨‍👩‍👧‍👦") == "Family 👨‍👩‍👧‍👦", "Valid Unicode joiners must not be mistaken for forbidden control characters")
        for invalid in ["", " \n ", "line\nline", "a\tb", "bad\u{0}name", String(repeating: "x", count: 301)] {
            try check(ArchiveMeetingTitle.normalized(invalid) == nil, "Invalid title was accepted")
        }
        try check(ArchiveMeetingTitle.normalized(String(repeating: "会", count: 300)) != nil, "300 code points should be supported")
        try check(ArchiveMeetingTitle.normalized(String(repeating: "👨‍👩‍👧‍👦", count: 44)) == nil, "Title limit must match backend code points, not grapheme clusters")

        func row(_ status: String, blocked: Bool = false) -> ArchiveMeetingRow {
            ArchiveMeetingRow(id: "synthetic", title: "Meeting", createdAt: "", status: status, projectId: nil, notesPreview: "", mutationBlocked: blocked)
        }
        for status in ["starting", "recording", "paused", "finalizing", "processing", "queued"] {
            try check(!row(status).canChange, "Active or busy status \(status) must not be changed")
        }
        for status in ["recorded", "partial", "failed", "ready"] {
            try check(row(status).canChange, "Inactive meeting \(status) should support rename and delete")
        }
        try check(!row("recorded", blocked: true).canChange, "Backend busy state must override saved capture status")

        var value: [String: Any] = ["version": 1, "view": "home", "projects": [], "meetings": [
            ["id": "first", "title": "First meeting", "status": "recorded"],
            ["id": "second", "title": "Second meeting", "status": "recorded", "mutationBlocked": true]
        ]]
        let oldSnapshot = ArchiveShellSnapshot(value)
        try check(oldSnapshot?.deletedMeetings.isEmpty == true, "Older snapshots without trash must remain compatible")
        try check(oldSnapshot?.meetings.first?.canChange == true, "Saved meeting must remain actionable")
        try check(oldSnapshot?.meetings.last?.canChange == false, "Snapshot must propagate processing locks")
        value["deletedMeetings"] = [["id": "deleted", "title": "Restorable meeting"], ["title": "Invalid missing ID"]]
        let deleted = ArchiveShellSnapshot(value)?.deletedMeetings
        try check(deleted?.count == 1 && deleted?.first?.id == "deleted", "Recently Deleted must retain stable IDs and reject malformed rows")
        try check(deleted?.first?.title == "Restorable meeting", "Recently Deleted must display its own title")
        let childMeetings: [[String: Any]] = (0..<12).map { ["id": "note-\($0)", "title": "Note \($0)", "status": "recorded", "projectId": $0 == 11 ? "other" : "project"] }
        var treeValue: [String: Any] = ["version":1, "view":"meeting", "selectedMeetingId":"note-9", "selectedProjectId":"project",
            "projects":[["id":"project","name":"Research"],["id":"other","name":"Other project"]], "meetings":childMeetings]
        let tree = ArchiveShellSnapshot(treeValue)!
        let collapsed = ArchiveSidebarRow.build(tree, expanded: [])
        try check(!collapsed.contains(where: { $0.key.hasPrefix("project-note:") }), "Collapsed projects must hide their children")
        let expanded = ArchiveSidebarRow.build(tree, expanded: ["project"])
        try check(expanded.filter { $0.key.hasPrefix("project-note:project:") }.count == 11, "Project children must include notes beyond the Recent Meetings limit")
        try check(!expanded.contains(where: { $0.key == "project-note:project:note-11" }), "Notes from other projects must not leak into a folder")
        try check(ArchiveSidebarRow.selectedKey(tree, expanded: ["project"]) == "project-note:project:note-9", "Expanded projects must highlight the selected child")
        try check(Set(expanded.map(\.key)).count == expanded.count, "Project and recent rows need distinct stable keys")
        try check(expanded.first(where: { $0.key == "project-note:project:note-9" })?.meeting?.id == "note-9", "Child context menus must retain the meeting ID")
        var moved = childMeetings; moved[9]["projectId"] = "other"; moved[0]["title"] = "Renamed note"
        treeValue["meetings"] = moved
        let refreshed = ArchiveSidebarRow.build(ArchiveShellSnapshot(treeValue)!, expanded: ["project","other"])
        try check(!refreshed.contains(where: { $0.key == "project-note:project:note-9" }), "Reassignment must remove the old child row")
        try check(refreshed.contains(where: { $0.key == "project-note:other:note-9" }), "Reassignment must add the new child row")
        try check(refreshed.first(where: { $0.key == "project-note:project:note-0" })?.title == "Renamed note", "Polling must update child titles without changing stable IDs")
        print("MeetingArchiveShellTests: \(checks) checks passed (no UI, permissions, or user data opened).")
    }

    @MainActor static func settingsLifecycle() async throws {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.accessory)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("meeting-settings-lifecycle-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        _ = try AnalysisPreferencesStore(dataDirectory: directory).save(AnalysisPreferences())
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 600), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let configuration = WKWebViewConfiguration(); configuration.websiteDataStore = .nonPersistent()
        let shell = MeetingArchiveShell(web: WKWebView(frame: .zero, configuration: configuration), window: window)
        shell.setDataDirectory(directory)
        shell.apply(ArchiveShellSnapshot(["version": 1, "view": "home", "connected": true, "busy": false, "projects": [], "meetings": []])!)
        shell.setInteractionEnabled(true)
        var reads = 0, installs = 0
        var status: [String: Any] = [:]
        shell.localSTTRequest = { install in
            if install { installs += 1 }
            else { reads += 1 }
            return status
        }
        shell.showSettings(refresh: false)
        guard let panel = NSApp.windows.first(where: { $0.title == "MinuteShelf Settings" }),
              let content = panel.contentView else { throw failure("Settings window was not constructed") }
        defer { shell.stopCodexConnection(); panel.close(); window.close() }
        func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
        guard let tabs = descendants(content).compactMap({ $0 as? NSTabView }).first,
              let analysis = tabs.tabViewItems.first(where: { $0.identifier as? String == "analysis" }),
              let analysisView = analysis.view,
              let installButton = descendants(analysisView).compactMap({ $0 as? NSButton }).first(where: { $0.title == "Install / Update Local STT…" }) else {
            throw failure("Analysis controls were not constructed")
        }
        try check(tabs.selectedTabViewItem?.identifier as? String == "general", "Settings must initially show General")
        let cases: [(String, [String: Any], [String: Any])] = [
            ("recording", ["recording": true], ["recording": false]),
            ("export", ["busy": true], ["busy": false]),
            ("installation", ["busy": true, "installation": ["status": "installing", "message": "Fixture installing"]],
                ["busy": false, "installation": ["status": "ready", "message": "Fixture ready"]])
        ]
        for (name, active, finished) in cases {
            // Reproduce opening Settings on General while work is active.
            tabs.selectTabViewItem(withIdentifier: "general")
            status = active; let initialReads = reads
            shell.showSettings()
            try await eventually("\(name) must initially disable installation") { reads > initialReads && !installButton.isEnabled }
            try check(analysisView.window == nil, "General must detach the Analysis view to exercise the polling guard")
            try await Task.sleep(nanoseconds: 2_200_000_000)
            let hiddenReads = reads
            status = finished
            tabs.selectTabViewItem(analysis)
            try await eventually("Returning to Analysis after \(name) must fetch fresh status and re-enable installation") {
                reads > hiddenReads && installButton.isEnabled
            }

            // While Analysis stays visible, existing polling must also recover.
            tabs.selectTabViewItem(withIdentifier: "general")
            status = active; let visibleReads = reads
            tabs.selectTabViewItem(analysis)
            try await eventually("Visible \(name) must disable installation") { reads > visibleReads && !installButton.isEnabled }
            status = finished
            try await eventually("Visible polling must restore installation after \(name)") { installButton.isEnabled }
        }
        try check(installs == 0, "Tab activation and polling must only read status, never start installation")
        print("Settings lifecycle: \(checks) checks passed (recording/export/install recovery, isolated preferences, no model downloads).")
    }

    static func failure(_ message: String) -> NSError {
        NSError(domain: "MeetingArchiveShellTests", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
    @MainActor static func eventually(_ message: String, _ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(5)
        while !condition() {
            guard Date() < deadline else { throw failure(message) }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        checks += 1
    }
}
