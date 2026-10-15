import Foundation

// No NSApplication, user archive, credential store, permission request, or
// network connection is opened. Compile the actual shell and its dependencies.
@main struct MeetingArchiveShellTests {
    static var checks = 0
    static func check(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        guard condition() else { throw NSError(domain: "MeetingArchiveShellTests", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
        checks += 1
    }
    static func main() throws {
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
}
