import Foundation
import Security

// Run only from an isolated signed .app. A second process uses the same
// signed executable as the foreground credential owner. All values are
// synthetic. Creating a temporary Keychain may show a macOS authorization
// dialog even when interaction is disabled. Never run this in normal CI or
// without a human explicitly agreeing to the interactive integration check.
@main struct AnalysisCredentialsKeychainTests {
    static let synthetic = "synthetic-test-key-never-a-real-credential"
    static func main() throws {
        SecKeychainSetUserInteractionAllowed(false)
        let arguments = CommandLine.arguments
        if arguments.count == 3 && arguments[1] == "--read-test-keychain" {
            let path = arguments[2]
            var keychain: SecKeychain?
            guard SecKeychainOpen(path, &keychain) == errSecSuccess, let keychain else { throw AnalysisCredentialError.unavailable }
            let scope = try AnalysisCredentialScope(dataDirectory: URL(fileURLWithPath: path).deletingLastPathComponent(), task: "vision", provider: "anthropic-api", endpoint: "https://example.test/v1", authentication: "api-key")
            let store = AnalysisCredentialStore(backend: AnalysisKeychainBackend(keychain: keychain))
            guard try store.read(scope) == synthetic else { throw AnalysisCredentialError.unavailable }
            print("helper verified synthetic credential"); return
        }
        guard arguments == [arguments[0], "--allow-keychain-dialog"] else {
            print("SKIPPED: interactive Keychain integration requires --allow-keychain-dialog and explicit human consent.")
            return
        }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("meeting-keychain-integration-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent("test.keychain-db").path
        let password = "temporary-integration-keychain"
        var keychain: SecKeychain?
        let result = password.withCString { SecKeychainCreate(path, UInt32(password.utf8.count), $0, false, nil, &keychain) }
        guard result == errSecSuccess, let keychain else { throw NSError(domain: "KeychainCreate", code: Int(result)) }
        defer { SecKeychainDelete(keychain) }
        let scope = try AnalysisCredentialScope(dataDirectory: directory, task: "vision", provider: "anthropic-api", endpoint: "https://example.test/v1", authentication: "api-key")
        let store = AnalysisCredentialStore(backend: AnalysisKeychainBackend(keychain: keychain))
        print("temporary Keychain created")
        guard try !store.contains(scope) else { throw AnalysisCredentialError.unavailable }
        print("empty status checked")
        try store.save(synthetic, scope: scope)
        print("synthetic item saved")
        guard try store.contains(scope), try store.read(scope) == synthetic else { throw AnalysisCredentialError.unavailable }
        let child = Process(), output = Pipe()
        child.executableURL = Bundle.main.executableURL
        child.arguments = ["--read-test-keychain", path]; child.standardOutput = output
        try child.run(); child.waitUntilExit()
        guard child.terminationStatus == 0,
              String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) == "helper verified synthetic credential\n" else { throw AnalysisCredentialError.unavailable }
        try store.save("replacement-synthetic-key", scope: scope)
        guard try store.read(scope) == "replacement-synthetic-key" else { throw AnalysisCredentialError.unavailable }
        try store.delete(scope)
        guard try !store.contains(scope) else { throw AnalysisCredentialError.unavailable }
        print("Keychain integration passed: scoped save/status/read, same-identity background reader, update, delete. Only a temporary Keychain was used.")
    }
}
