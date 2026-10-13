import Foundation
import Darwin
import Security

@main struct AnalysisCredentialsCLI {
    private struct Request: Decodable {
        let operation: String?
        let dataDirectory: String
        let task: String
        let provider: String
        let endpoint: String
        let authentication: String
    }
    static func main() {
        // kSecUseAuthenticationUI is not sufficient for every legacy Keychain
        // operation. This isolated reader must never spawn a hidden prompt.
        SecKeychainSetUserInteractionAllowed(false)
        do {
            // Secrets must only travel through the private child-process pipe,
            // never command arguments, environment, browser routes, or a TTY.
            func isPrivatePipe(_ descriptor: Int32) -> Bool {
                var info = stat()
                guard fstat(descriptor, &info) == 0 else { return false }
                let kind = info.st_mode & mode_t(S_IFMT)
                return kind == mode_t(S_IFIFO) || kind == mode_t(S_IFSOCK)
            }
            guard CommandLine.arguments.count == 1, isPrivatePipe(STDIN_FILENO), isPrivatePipe(STDOUT_FILENO) else { throw AnalysisCredentialError.invalidScope }
            var input = Data()
            while let chunk = try FileHandle.standardInput.read(upToCount: 4096), !chunk.isEmpty {
                input.append(chunk); guard input.count <= 32768 else { throw AnalysisCredentialError.invalidScope }
            }
            let request = try JSONDecoder().decode(Request.self, from: input)
            guard request.dataDirectory.hasPrefix("/") else { throw AnalysisCredentialError.invalidScope }
            let scope = try AnalysisCredentialScope(dataDirectory: URL(fileURLWithPath: request.dataDirectory), task: request.task, provider: request.provider, endpoint: request.endpoint, authentication: request.authentication)
            let store = AnalysisCredentialStore()
            let result: [String: Any]
            switch request.operation ?? "read" {
            case "read": result = ["key": try store.read(scope)]
            case "status": result = ["stored": try store.contains(scope)]
            default: throw AnalysisCredentialError.invalidScope
            }
            var data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]); data.append(0x0a)
            try FileHandle.standardOutput.write(contentsOf: data)
        } catch {
            let message = (error as? AnalysisCredentialError)?.localizedDescription ?? "Invalid credential request."
            try? FileHandle.standardError.write(contentsOf: Data((message + "\n").utf8)); exit(1)
        }
    }
}
