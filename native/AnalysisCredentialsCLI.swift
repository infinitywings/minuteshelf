import Foundation

// Compatibility entry point. The installed app uses its own executable in
// --credential-helper mode so foreground and background Keychain identities match.
@main struct AnalysisCredentialsCLI {
    static func main() { AnalysisCredentialCommand.run(arguments: []) }
}
