# Native iOS verification record

Verification date: 3 August 2026 (Asia/Dubai)  
Branch: `codex/native-ios`  
Native target: `apps/ios/NME.xcodeproj`, scheme `NME`

This record separates simulator/build evidence from checks that require a
signed build and physical iPhones. An unchecked device item is not implied to
pass because a simulator test passed.

## Toolchain

| Component | Verified version |
| --- | --- |
| Xcode | 26.6 (`17F113`) |
| Swift | 6.3.3 |
| XcodeGen | 2.45.4 |
| Node.js | 26.5.0 |
| npm | 11.17.0 |
| LiveKit Swift | 2.13.0, pinned in `Package.resolved` |
| Focused simulator | iPhone 17 Pro, iOS 26.5 (`3C14490E-D97F-43ED-9831-0D666E91C2F7`) |

## Fresh automated evidence

| Check | Result | Evidence |
| --- | --- | --- |
| Workspace type checking | Pass | `npm run typecheck`; core, server, web, and mobile exited 0 |
| JavaScript/TypeScript tests | Pass | `npm test`; 59 core + 54 server + 28 web + 8 mobile = 149 tests, 0 failures |
| Web/server production build | Pass | `npm run build`; core and server compiled, Vite built 73 modules |
| Native project generation | Pass | `npm run ios:generate`; XcodeGen recreated `apps/ios/NME.xcodeproj` |
| Distribution configuration tests | Pass | `xcodebuild test ... -only-testing:NMETests/ConfigurationTests`; 4 tests, 0 failures |
| Source App Store icon | Pass | `sips`: 1024×1024, `hasAlpha: no`; `file`: 8-bit RGB PNG |
| Plist/entitlement syntax | Pass | `plutil -lint` on `Info.plist` and `NME.entitlements` |
| Unsigned generic-iOS archive | Pass | `xcodebuild archive ... CODE_SIGNING_ALLOWED=NO`; archive at `/tmp/NME-native-ios-ipad.xcarchive` (60 MB) |
| Archive metadata | Pass | iOS 16.4 minimum, bundle `com.ctrlaltl.nme`, primary `AppIcon`, HTTPS deployment URLs, non-exempt encryption true, four iPad orientations |
| Live AASA response | Partial | HTTPS 200 and `application/json`, but the deployed body still contains `REPLACE_WITH_TEAM_ID.com.nmetalk.app` |

The archive emits one deliberate SDK deprecation warning. NME uses LiveKit's
`E2EEOptions` because it encrypts media only; the replacement also encrypts the
data channel and is not compatible with the current browser client. Chat data
is encrypted independently with NME's browser-compatible AES-GCM envelope.

## Full simulator build and test run (3 August 2026, follow-up session)

`npm run ios:build` and `npm run ios:test` were blocked in the prior session by
sandbox/approval-service limits (see below) and by the host disk filling with
stale `/tmp/NME*DerivedData*` caches from repeated partial runs. After clearing
~9 GB of rebuildable DerivedData/archive caches, both commands were run to
completion for the first time:

| Check | Result | Evidence |
| --- | --- | --- |
| `npm run ios:build` (generic iOS Simulator) | Pass | One expected `E2EEOptions` deprecation warning only |
| `npm run ios:test` (iPhone 17 Pro, iOS 26.5) | Pass | 72/72 tests, 0 failures |

This first full run surfaced defects in code that had never actually been
exercised end-to-end. All were fixed on this branch:

- **Browser↔iOS chat was silently dropped.** The web client
  (`apps/web/src/room/useMessaging.ts`) publishes chat data with no LiveKit
  topic, but `LiveKitMeetingEngine` required `topic == "nme-chat"` exactly to
  accept incoming data, so every browser-originated chat message was discarded
  on iOS. Extracted the wire contract into `LiveKitWireContract` (publish with
  no topic, accept `""` or `"nme-chat"` on receive) with dedicated tests in
  `LiveKitTransportContractTests.swift`.
- **Blocked participants could still push data.** Block only unsubscribed
  media tracks; the data-channel handler had no block check. Added
  `ParticipantAccessPolicy` and wired it into both the receive path and the
  participant-list filter.
- **No validation that the signaling URL is `wss://`.** Added
  `JoinCredentials.validatedSignalingURL()`, checked before `Room.connect`.
- **`MeetingSession` never tore down the engine on an unexpected disconnect**
  (state moved to `.failed` but `engine.disconnect()` was never called, so
  camera/mic/audio session stayed live). Fixed to run cleanup on that path.
- **`MeetingViewModel.leave()` was not idempotent** (toolbar tap +
  `.onDisappear` could both fire); added a `hasLeft` guard.
- **`PrivacyInfo.xcprivacy` was missing entirely.** A test asserting its
  contents existed, but the manifest itself was never created — an App Store
  submission blocker for apps using UserDefaults. Added the manifest
  (`NSPrivacyAccessedAPICategoryUserDefaults`, reason `CA92.1`) and registered
  it as a resource in `project.yml`.
- Two `NMEUITests` failures were test-synchronization gaps, not app bugs
  (XCUITest's idle-detection doesn't wait for an unstructured
  `Task { await viewModel... }` spawned by a button action to finish before
  the next assertion runs). Fixed the assertions to wait properly instead of
  checking `.exists` instantaneously.

## Security and scope audit

- Room encryption keys are held in memory and are not written to UserDefaults,
  files, or Keychain.
- Only creator host keys are stored, using a device-only Keychain accessibility
  class and the room ID as the account.
- App logging is allowlisted to event names, participant counts, HTTP status,
  retry count, and relay state. It does not log links, keys, tokens, names, or
  messages.
- App Transport Security disallows arbitrary loads; release origins are HTTPS
  and the LiveKit endpoint is WSS.
- Background execution declares audio only.
- The iOS bundle identifier is consistently `com.ctrlaltl.nme`. The remaining
  `com.nmetalk.app` association is Android-specific.
- Regenerating the Xcode project does not create a root `ios/` source tree.

## Physical-device acceptance matrix

These checks remain required before TestFlight or App Store submission:

- [ ] Signed archive validation with Apple team `WC955H63L3`
- [ ] Fresh install and first-launch camera/microphone permission flow
- [ ] Browser ↔ iPhone encrypted audio/video and encrypted chat
- [ ] iPhone ↔ iPhone encrypted audio/video and encrypted chat
- [ ] Direct connection plus forced relay fallback on a restrictive network
- [ ] Speaker, receiver, Bluetooth, mute, camera flip, interruption, and background-audio behavior
- [ ] Reconnect after Wi-Fi/cellular handoff and cleanup after leaving
- [ ] VoiceOver, Dynamic Type, landscape, and iPad layout pass on hardware
- [ ] Universal Link opening after the corrected AASA file is deployed and Apple CDN cache has refreshed
- [ ] Block/report email flow with the production mail account

The live AASA deployment and the physical-device matrix are release blockers,
not blockers to compiling or reviewing the native source.
