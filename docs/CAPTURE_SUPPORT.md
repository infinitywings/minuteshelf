# Capture support and share following

Status: **0.1.9 development preview**, reviewed October 13, 2026. This page separates observed capture results from features proposed for future implementation.

## What the current recorder selects

The user selects either a window or a display, previews it, and confirms that exact source. The preview permission is bound to both its source type and ID. The recorder does not infer that source from Zoom's share dialog, the foreground application, or a window title.

The existing controls support stop, pause, resume, microphone control, and bookmarks. They do not support changing the video source during a recording. To change sources, stop and save, then select and preview the new source.

When the selected window becomes unavailable, the archive records the gap and continues available audio. It never silently records the whole display instead.

## Controlled tests

These are individual tests, not guarantees for every Zoom layout or meeting. Both used synthetic documents with recognizable changing content.

| Scenario | Observation | Limits |
| --- | --- | --- |
| Receive another participant's share in the Zoom desktop window | 610.827 seconds, 61 segments, no positive segment gaps or reported suspension. Sampled frames showed the expected slides, code, and small highlight changes; playback and seeks were checked. | Browser sender and desktop receiver were on the same Mac. No audio was recorded. Frame inspection was sampled. |
| Record the actual document window while sharing that document through Zoom | 265.789 seconds, 27 segments, no reported gaps or suspension. Changing document content and playback were checked. | One window and one controlled setup; not a long-session or audio/video-sync test. |
| Record Zoom's original meeting window while presenting locally | Repeated tests found the selected Zoom window suspended/off-screen during sharing, then available after sharing stopped. | This does not establish that Zoom's formal screen-capture protection caused it. It does not imply receiving someone else's share has the same failure. |

For local presenting, explicitly choose the actual shared window or its display. A display recording includes other visible applications and notifications. Protected content remains subject to the meeting platform and macOS restrictions.

Cross-device receiving, presenter handoffs, simultaneous audio/video synchronization, 120-minute sessions, and broader failure recovery still need acceptance tests.

## Can the app discover what Zoom is sharing?

**Not in the current implementation.** Detecting that sharing started is different from identifying the exact window, display, or region being shared.

The public interfaces reviewed on October 13, 2026 provide different pieces of information:

| Interface | What is documented | Implication for this app |
| --- | --- | --- |
| Apple's ScreenCaptureKit content picker | Lets a person choose content for the requesting app's capture streams. | It is not documented as a way to query a separate app's chosen capture source. |
| Zoom Apps `onShareScreen` | Participant ID, start/stop action, timestamp, and whether sound is shared. | That event alone supplies no macOS window or display ID. A Zoom App integration would also need its own setup. |
| Zoom Meeting SDK `ZoomSDKSharingSourceInfo` | Shared window and display IDs. | The Meeting SDK embeds a Zoom meeting experience in an application. These APIs do not establish a supported way for this recorder to attach to an independent Zoom desktop client's session. |

No documented external-client interface supplying the exact target was found in this review. That is a bounded research conclusion, not proof that no integration is possible.

Zoom UI accessibility information may supply useful clues. Whether it exposes the selected source reliably across versions, languages, and sharing modes remains untested. Window titles, foreground focus, and green sharing borders should be treated as candidate evidence, not an exact source identity.

## Proposed implementation

This is a development plan, not an available setting.

1. **Make source switching work within one recording.** Preview and confirm the replacement source, close the current video segment, preserve the session clock and audio, and begin a segment with the new source's geometry. Record source changes and any real gaps in the timeline. If switching fails, retain the previous source where possible and show the actual state.
2. **Add optional Zoom sharing suggestions.** Test a narrow, local adapter for sharing state and source hints. Request Accessibility only if the implementation needs it. Show the matched candidate and a preview; use the normal picker when the source is ambiguous.
3. **Consider opt-in automatic following only after validation.** Require an explicit allowed scope and a reliable source identity. A window-to-display change needs separate approval to broaden the recording scope. Unknown, regional, multi-window, browser-tab, whiteboard, and video-file sharing must not be forced into a guessed single-window selection.

The practical first experience should be: **“Sharing detected → choose/confirm the source → keep recording in the same meeting.”** Where source hints are reliable, the app can preselect the candidate. Fully automatic following is a later, conditional capability.

## Acceptance cases for source switching

- Start and stop sharing without changing source, then change to another window.
- Identical window titles, multiple displays, full-screen windows, minimized windows, and a closed source.
- Share an entire display, a region, multiple windows, a browser tab, and a Zoom whiteboard where supported.
- Preserve audio, bookmarks, clock continuity, segment dimensions, and correct playback around each switch.
- Revoke adapter permission or change the Zoom UI layout; retain manual selection and show uncertainty.
- Verify that no unconfirmed display or unrelated application is captured during a transition.

## Sources

- [Apple: SCContentSharingPicker](https://developer.apple.com/documentation/screencapturekit/sccontentsharingpicker)
- [Zoom Apps: OnShareScreenEvent](https://appssdk.zoom.us/types/ZoomSdkTypes.OnShareScreenEvent.html)
- [Zoom Meeting SDK for macOS](https://developers.zoom.us/docs/meeting-sdk/macos/)
- [Zoom Meeting SDK: ZoomSDKSharingSourceInfo](https://marketplacefront.zoom.us/sdk/meeting/macos/interface_zoom_s_d_k_sharing_source_info.html)

Implementation entry points: [capture and source enumeration](../native/ArchiveCapture.swift), [preview confirmation and session control](../server/archive-session.js), and [recording setup UI](../web/recorder.html).
