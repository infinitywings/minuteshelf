# Contributing to MinuteShelf

MinuteShelf is a macOS development preview. Start with a focused issue or change and distinguish observed behavior from proposed capabilities. Use synthetic meeting content in demonstrations and tests.

## Development

Use Apple Silicon, macOS 15+, Xcode Command Line Tools, and Node.js 20+. The current JavaScript runtime uses Node's built-in modules. Follow the [README](README.md) to build the native helpers or packaged app.

```sh
npm run build:native
npm test
npm run check:publication
```

Native media cases are skipped when their compiled helper is absent. For capture or export changes, also run the relevant native scripts from `package.json`. Read scripts before execution: some launch visible apps, while the explicitly gated credential integration tests may invoke Keychain. Real capture permissions and remote model calls are separate from unit tests.

## Keep private data out of Git

`public-files.json` is the explicit list of publishable files. `.gitignore` denies other files by default, including local archives, model weights, installers, test outputs, credentials, and historical debugging materials. This is deliberate: the development workspace may also contain private local artifacts.

For a new source file, review it first, add its relative path to `public-files.json`, and add a matching exception to `.gitignore`. Do not use `git add -f` to bypass this policy. Run `npm run check:publication` to verify the working files, staged tree, and committed paths before publishing. It is a file-boundary check, not a substitute for a credential scanner or reviewing the diff.

Before committing:

- Keep recordings, transcript files, calendar/email snapshots, RKA records, access links, and credentials out of source and screenshots.
- Store local reports and synthetic generated media under `.build/`; do not commit them as documentation.
- Use placeholder domains and clearly fabricated names in tests. The four public screenshots in `docs/assets/` use the reproducible synthetic demo.
- Inspect `git diff --cached` and run a secret scanner, such as `gitleaks git --redact`, before pushing. Do not include raw scanner findings containing secrets in an issue.

## Review and validation

Explain the user-visible change, how it was tested, and what remains unverified. For recording bugs, include source type, presenting/receiving role, and application versions using a synthetic reproduction. Preserve raw recordings and correction provenance when investigating local failures.

Avoid changing the app's bundle identifier, Keychain scope, data directory, or signing identity as a cosmetic rename. Those changes need a migration plan and installed-app permission checks.

Contributions are distributed under the project's MIT license. Retain upstream notices and review any additional dependency or model license before bundling it.
