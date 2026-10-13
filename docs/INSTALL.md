# Install or update MinuteShelf

Version **0.1.10 development preview** supports Apple Silicon Macs running macOS 15 or later. Download the DMG, ZIP, installation notes, and SHA-256 file from the [GitHub release](https://github.com/infinitywings/minuteshelf/releases/tag/v0.1.10).

## New installation

1. Download `MinuteShelf-0.1.10-macOS-arm64.dmg`.
2. Open it and drag **MinuteShelf.app** to **Applications**.
3. Eject the disk image and open **MinuteShelf** from Applications.
4. Use **Settings → General → Permissions** to request access when needed. Grant Screen & System Audio Recording for screen capture, and Microphone if you enable that source. Accessibility is not required by the current recorder.

The ZIP contains the same app. Unzip it and move **MinuteShelf.app** to Applications. Do not run from inside the mounted DMG or keep editing the app bundle after installation.

Node.js and Codex are bundled. Optional local Qwen/MiMo transcription needs Python 3.11+ and an explicit model installation; Claude Code needs its own official native runtime. Cloud providers require your account and permission to send the selected content.

## Signing and first launch

This release is ad-hoc signed and **has not been notarized by Apple**. The signatures can detect bundle changes, but are not a Developer ID certificate or an Apple trust approval. A checksum verifies the file matches the published asset; it is not an independent security audit.

If macOS blocks the first launch and you trust this copy, attempt to open it once, then open **System Settings → Privacy & Security → Open Anyway** and follow macOS's confirmation. Do not disable Gatekeeper or clear quarantine recursively. Managed Macs may enforce a policy that does not permit this preview. See [Apple's instructions for opening apps safely](https://support.apple.com/102445).

For a terminal checksum check, put the downloaded assets and `.sha256` file in the same directory and run:

```sh
shasum -a 256 -c MinuteShelf-0.1.10-macOS-arm64.sha256
```

The checksum file lists both the DMG and ZIP; a missing-file message means the corresponding asset has not been downloaded.

## Upgrade from Meeting Archive

1. Stop and save any recordings and analysis/export work, then quit **Meeting Archive** normally.
2. Move the old **Meeting Archive.app** out of Applications before installing **MinuteShelf.app**. You may keep a zipped backup of the old app for rollback. Do not delete the archive data directory.
3. Install and launch MinuteShelf, then verify that your meetings appear.
4. In **Settings → General → Permissions**, check screen and microphone access. Use **Request Access** or **Open Settings…** as appropriate, and restart the app if macOS requests it.

The new app retains these compatibility identifiers:

| Item | Retained value |
| --- | --- |
| Bundle identifier | `local.meetingarchive.app` |
| Default data directory | `~/Library/Application Support/Meeting Archive` |
| API credential service | `org.meetingarchive.analysis-api-key.v1` |
| Codex connection scope | The existing `connections/codex` directory inside the selected data directory |

The app does not move or rewrite old meetings to perform the rename. `MEETING_DATA` overrides still refer to the same selected location. Keeping the credential scope does not bypass Keychain approval: macOS may ask you to authorize the updated app, and you can use the provider settings to reconnect if needed.

The old and new app names share a bundle identifier. Keeping both as launchable installed copies can confuse launch and permission attribution. Later MinuteShelf updates should replace the existing MinuteShelf.app after it has quit.

## Screen access still fails after an update

Ad-hoc rebuilds change the code hash used by macOS to identify the app. A stale grant can remain switched on in System Settings while the updated app reports no access. Renaming or signing the app again does not transfer that grant.

First quit/reopen the installed app and use its **Check Permissions**, **Request Access**, and **Open Settings…** controls. Check the **Screen & System Audio Recording** section, not only the separate **System Audio Recording Only** section. The entry may temporarily retain the old Meeting Archive name. See [Apple's screen and audio permission guide](https://support.apple.com/guide/mac-help/control-access-screen-system-audio-recording-mchld6aa7d23/mac).

If normal controls still fail and the problem is a stale grant, a user can choose this targeted repair after stopping all recordings and quitting both app names:

```sh
/usr/bin/tccutil reset ScreenCapture local.meetingarchive.app
```

This removes **only this app's screen grant** and requires new consent. Then reopen `/Applications/MinuteShelf.app`, request screen access, and complete the system authorization. Do not run a global reset or reset microphone access to repair a screen-only problem. MinuteShelf never runs this reset automatically.

After authorization, verify the app reports access and can preview the specific window/display you select. Leave the final signed app unchanged after granting permission. Compilation, checksum verification, or a successful signature check alone does not demonstrate capture permission or recording reliability.

## Release verification scope

The release is checked for bundled runtimes, declared files, intact signatures, isolated startup, and synthetic media handling. These checks do not record a real meeting, grant system consent, or validate every meeting platform and long-session scenario. See [capture support](CAPTURE_SUPPORT.md) for the separate real-capture evidence and known limitations.
