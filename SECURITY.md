# Security

MinuteShelf handles recordings, private documents, and optional provider credentials. Version 0.1.10 is a development preview; security reports are welcome.

Use this repository's **Security → Report a vulnerability** private reporting channel for suspected credential exposure, unauthorized capture, archive access, or remote-data disclosure. Do not put real recordings, tokens, private documents, or participant information into a public issue. A minimal synthetic reproduction is preferred.

The local server binds to loopback and requires authentication. Remote analysis is explicitly configured and started by the user. Screen contents, transcripts, and background documents are input data rather than instructions to execute tools. These controls do not make an authorized remote provider local or replace macOS recording consent.

Credential or recording data accidentally published elsewhere should be handled as an exposure: revoke affected credentials and assess any disclosed content. Do not rely on deleting a file from the current branch to remove it from Git history or existing copies.

The source repository intentionally excludes meeting archives, local configuration, model downloads, test reports, and build artifacts. See [Contributing](CONTRIBUTING.md) for the publishable-file list and review checks.
