# Third-party notices

## Upstream application

MinuteShelf began as a derivative of [clawd-scribe](https://github.com/clawdbotatg/clawd-scribe), licensed under MIT. Its copyright notice is retained in [LICENSE](LICENSE). The import recorded by this project is commit `8d048f7034b8ff75b04640f48cf0c4f569b3c274`.

The public source tree contains the current recorder, archive, and analysis implementation. Historical local diagnostics and unused upstream calendar/browser tools are not part of this publication.

## Optional downloaded runtimes

The Git repository does not include downloaded Node.js or Codex binaries. Explicit fetch scripts verify the versions and hashes in `tools/node-runtime.lock.json` and `tools/codex-runtime.lock.json`. Building a standalone app copies the accompanying Node LICENSE and Codex LICENSE/NOTICE into the app bundle. Retain those files when redistributing a build.

Claude Code, Python/MLX packages, Ollama, whisper.cpp, and model weights are installed or configured separately. They have their own licenses, terms, and hardware requirements. This repository's MIT license does not relicense those components or grant access to an AI provider's services.

## Apple frameworks and artwork

ScreenCaptureKit, AVFoundation, AppKit, Vision, and other Apple system frameworks remain subject to Apple's terms. They are not redistributed as open-source components of this repository.

The included MinuteShelf icon originated as generated artwork for this project under its earlier Meeting Archive name. Public UI screenshots use synthetic content; the diagram is editable SVG. See [asset provenance and reproduction](docs/assets/README.md).
