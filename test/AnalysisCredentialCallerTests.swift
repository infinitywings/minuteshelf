import Foundation

// Signed fixture host for the production reader. Requests use an unsupported
// operation, so an accepted caller reaches validation but never Keychain I/O.
@main struct AnalysisCredentialCallerTests {
    static func main() throws {
        if CommandLine.arguments.dropFirst().first == "--credential-helper" {
            AnalysisCredentialCommand.run(arguments: ["--credential-helper"])
            return
        }
        let mode = CommandLine.arguments.dropFirst().first
        guard ["--direct", "--node", "--node-spoof"].contains(mode ?? ""), let executable = Bundle.main.executableURL else { exit(2) }
        if mode == "--node-spoof" && CommandLine.arguments.count != 3 { exit(2) }
        let child = Process(), input = Pipe(), output = Pipe()
        if mode == "--node" || mode == "--node-spoof" {
            child.executableURL = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/node")
            child.arguments = ["-e", "const r=require('node:child_process').spawnSync(process.argv[1],['--credential-helper'],{argv0:process.argv[2]||process.argv[1],input:require('node:fs').readFileSync(0),env:{PATH:'/usr/bin:/bin'},timeout:5000});if(r.error)process.exit(2);process.stdout.write(r.stdout);", executable.path]
            if mode == "--node-spoof" { child.arguments?.append(CommandLine.arguments[2]) }
        } else {
            child.executableURL = executable; child.arguments = ["--credential-helper"]
        }
        child.environment = ["PATH": "/usr/bin:/bin"]
        child.standardInput = input; child.standardOutput = output; child.standardError = FileHandle.nullDevice
        try child.run()
        try input.fileHandleForWriting.write(contentsOf: FileHandle.standardInput.readDataToEndOfFile())
        try input.fileHandleForWriting.close()
        child.waitUntilExit()
        try FileHandle.standardOutput.write(contentsOf: output.fileHandleForReading.readDataToEndOfFile())
    }
}
