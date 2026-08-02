# Native iOS Redevelopment Design

**Date:** 2026-08-02  
**Status:** Approved  
**Product:** NME Talk

## Summary

NME Talk's iOS client will be rebuilt as a native SwiftUI application. The new
client will use the LiveKit Swift SDK directly through Swift Package Manager and
will not depend on Expo, React Native, Metro, Node.js, or CocoaPods at build or
runtime.

The existing server, LiveKit deployment, web application, link format, lobby
protocol, relay fallback, and encryption model remain authoritative. The native
app is a new client of those contracts rather than a server rewrite.

Development will happen beside the existing mobile client under `apps/ios`.
The current client remains available until the native app passes the complete
acceptance matrix, after which the native target becomes the App Store build.

## Goals

- Deliver a functional, production-oriented iPhone and iPad app built in Swift.
- Preserve meetings between the native app and the existing browser client.
- Preserve end-to-end encryption for media and chat.
- Provide reliable camera, microphone, audio-route, interruption, background
  audio, reconnection, and cleanup behavior on iOS.
- Preserve room creation, link sharing, pasted links, Universal Links, lobby
  admission, relay fallback, participant blocking/reporting, and ephemeral chat.
- Keep secrets out of logs and persistent storage unless persistence is
  explicitly required.
- Produce deterministic builds and automated unit, integration, and UI tests.

## Non-goals

- Rewriting the server, web client, LiveKit deployment, or TURN service.
- Adding accounts, meeting history, recording, screen sharing, CallKit, push
  notifications, or server-side message storage in the first native release.
- Replacing the Android client.
- Carrying React Native code or a JavaScript runtime inside the native app.

## Supported Platform and Dependencies

- Swift 6 language mode with strict concurrency enabled.
- SwiftUI application lifecycle.
- Minimum deployment target: iOS 16.4, matching the repository's current mobile
  target while retaining broad device coverage.
- LiveKit Swift SDK 2.x, resolved and pinned by `Package.resolved`.
- Apple frameworks only for networking, cryptography, persistence, logging,
  camera permissions, sharing, and application lifecycle.
- No third-party analytics, advertising, crash-reporting, or tracking SDKs.

## Project Structure

The project will live at `apps/ios` and contain one application target, one unit
test target, and one UI test target. The codebase is small enough that multiple
local packages would add ceremony without useful isolation. Boundaries are
enforced with focused types and protocols instead.

```text
apps/ios/
  NME.xcodeproj
  NME/
    App/
      NMEApp.swift
      AppCoordinator.swift
      AppEnvironment.swift
    Domain/
      RoomIdentity.swift
      MeetingModels.swift
      MeetingError.swift
    Infrastructure/
      APIClient.swift
      APIModels.swift
      CredentialStore.swift
      AppLogger.swift
    Crypto/
      RoomCrypto.swift
      MessageCipher.swift
    Meeting/
      MeetingSession.swift
      MeetingSessionProtocol.swift
      LiveKitMeetingSession.swift
      AudioLifecycle.swift
    Features/
      Home/
      PreJoin/
      Meeting/
      Chat/
    Resources/
      Assets.xcassets
      Info.plist
      NME.entitlements
  NMETests/
  NMEUITests/
```

## Architecture

### Application coordination

`AppCoordinator` owns a small explicit route state:

- `home`
- `preJoin(MeetingIntent)`
- `meeting(MeetingIntent, displayName)`

It receives cold-start and in-process Universal Links, custom-scheme URLs, and
pasted links. Navigation is driven from this route state rather than a generic
navigation framework because the product has a single linear flow.

`AppEnvironment` constructs and owns long-lived services. Feature views receive
protocol-backed dependencies or focused view models, allowing previews and
tests to run without network, camera, Keychain, or LiveKit access.

### Room identity and links

`RoomIdentity` is a value type that validates and contains exactly 32 bytes of
room-key material. It accepts all formats already supported by the TypeScript
client:

- `https://nmetalk.com/#<43-character-base64url-key>`
- `https://nmetalk.com/r/<room-id>#k=<key>`
- `nmetalk://...#<key>` or `#k=<key>`
- a bare 43-character key pasted by the user

The URL host is never used to select a deployment. The app always contacts the
HTTPS origin compiled into its build configuration. This prevents an invitation
from selecting an attacker-controlled admission server.

The room ID is derived exactly as the existing client does:

1. SHA-256 of the raw 32-byte room key.
2. Map the first 12 digest bytes into
   `abcdefghjkmnpqrstuvwxyz23456789` using byte modulo alphabet length.
3. Format as `xxxx-xxxx-xxxx`.

The safety number is derived from the same SHA-256 digest and formatted as four
five-digit groups using the existing algorithm. Golden vectors generated by the
TypeScript implementation prove byte-for-byte parity.

### API client

`APIClient` uses an ephemeral `URLSession` configuration with cookies disabled
and a ten-second request timeout. It models the existing endpoints for:

- runtime configuration;
- room creation with lobby enabled;
- initial join;
- lobby claim polling;
- listing and resolving knocks;
- relay credential retry.

Participant reporting remains a local mail-composition flow, matching the
existing mobile client. No report body is sent to the control-plane API.

The origin is HTTPS-only and compiled into the build. Host credentials are sent
only through `X-Host-Key`. API failures are converted into typed `MeetingError`
values with user-facing recovery guidance. Response bodies, tokens, host keys,
room keys, and complete invitation URLs are never logged.

### Persistence

- Display name: `UserDefaults`, capped at 60 characters.
- Host key by derived room ID: Keychain, accessible after first unlock on this
  device only.
- Room key: memory only for the active flow; never Keychain, `UserDefaults`,
  files, diagnostics, state restoration, or analytics.
- Chat: memory only, capped at the most recent 300 messages.

### Pre-join camera

`PreviewController` owns the preview capture lifecycle. It requests camera
permission only when preview is enabled, shows a clear permission-denied state,
and permits audio-only joining. Preview capture is stopped before LiveKit
publishes a camera track so two owners never compete for the same device.

Microphone permission is requested at join time, immediately before LiveKit
needs it. A denial produces an explicit audio-disabled state rather than a
crash or indefinite connection attempt.

### Meeting session

`MeetingSession` is a `@MainActor` observable state machine with these states:

- idle
- preparing
- waitingForAdmission
- connectingDirect
- connectingRelay
- connected
- reconnecting
- failed
- ended

`LiveKitMeetingSession` wraps the SDK `Room` and converts SDK callbacks into
immutable participant and track presentation models on the main actor. UI code
does not retain mutable LiveKit participant or publication objects beyond their
valid room lifecycle.

Connection order is fixed:

1. Validate the room identity and load any host key.
2. Fetch runtime configuration and request a join token concurrently.
3. Poll every two seconds for up to five minutes when lobby admission is
   required.
4. Configure every LiveKit client with the same 43-character room-key
   passphrase, while retaining the decoded 32 bytes for identity and chat
   derivation.
5. Attempt a direct connection with an eight-second peer-connection budget.
6. If and only if the failure is a media-path failure, request a fresh token and
   relay credentials, then retry in relay-only mode.
7. Publish microphone and camera according to pre-join choices.

The first token is never reused for relay fallback because the server's replay
defense consumes participant identity on the first connection.

Leaving, failure, or view teardown disconnects the room, stops local tracks,
releases key providers, deactivates the meeting audio lifecycle, and discards
the room key from the coordinator.

### End-to-end encryption

Media uses the LiveKit Swift SDK's native frame encryption. Inspection of the
pinned Swift 2.13.0 API established that its public shared-key provider accepts
a string, while the JavaScript SDK documents that form as the
maximum-compatibility path across SDKs. All NME clients therefore pass the same
43-character base64url room-key string to LiveKit. The string still contains
256 random bits; the decoded raw bytes remain authoritative for room IDs,
safety numbers, and chat derivation. A compatibility milestone must prove
browser-to-iPhone and iPhone-to-iPhone media before feature work proceeds past
the meeting shell.

Chat preserves the existing application envelope for compatibility:

- HKDF-SHA256 from the raw room key;
- empty salt;
- UTF-8 info string `nme-chat-v1`;
- AES-256-GCM;
- random 12-byte nonce;
- wire format `[nonce][ciphertext-and-tag]`.

Incoming payloads larger than 16 KiB, unauthenticated payloads, unknown message
types, and invalid fields are discarded. Chat text is trimmed and capped at
2,000 characters. The first release implements the current native feature set:
chat messages. The wire parser remains forward-compatible by ignoring known
future message types it does not display.

### Audio and application lifecycle

The LiveKit SDK manages `AVAudioSession` initially because it already coordinates
the audio engine with track publication. The app observes route changes,
interruptions, media-services resets, and app scene changes to keep presentation
state accurate and to surface recovery when needed.

The app enables the audio background mode so an active meeting continues when
the screen locks or the user switches applications. Camera publication follows
iOS background policy and UI state reflects when video is suspended. CallKit is
deferred because meetings are link-initiated rather than incoming telephone
calls; it can be added later behind `AudioLifecycle` without changing features.

## User Interface

### Home

- NME Talk identity and privacy explanation.
- Primary action to create a lobby-enabled meeting.
- Paste field accepting all compatible link/key formats.
- Join action with an actionable malformed-link error.
- In-app Privacy and Support links.

### Pre-join

- Mirrored local camera preview.
- Camera on/off control and audio-only fallback.
- Remembered display name.
- Share sheet for the short invitation URL.
- Safety number.
- Join and cancel actions.

### Meeting

- One-column layout for one participant and two-column grid for small rooms.
- Adaptive active-speaker layout for larger rooms.
- Native LiveKit video rendering, mirrored locally.
- Participant name and microphone state.
- Controls for microphone, camera, camera flip, chat, and leave.
- Reconnecting and relay indicators.
- Long-press participant actions for local block and block/report.
- Blocking unsubscribes the remote participant's tracks instead of merely
  hiding the tile.

### Chat

- Native sheet or full-height compact presentation depending on size class.
- Ephemeral encrypted messages, unread count, 2,000-character composer limit,
  and a clear no-history explanation.
- Dynamic Type, VoiceOver labels, minimum 44-point targets, sufficient contrast,
  reduced-motion behavior, and keyboard-safe layout across all screens.

## Error Handling and Diagnostics

Every failure maps to a stable code and a user action. Primary cases include:

- incomplete or malformed invitation;
- camera or microphone permission denied;
- server timeout or unreachable server;
- admission denied or unanswered;
- invalid/expired join token;
- direct connection blocked and relay unavailable;
- reconnect budget exhausted;
- incompatible encryption or decryption failure;
- unsupported server configuration.

Operational diagnostics use unified logging with privacy redaction. Debug builds
may enable detailed LiveKit logging, but release logs must not contain room keys,
host keys, tokens, chat plaintext, display names, full URLs, or message bodies.

## Testing Strategy

### Unit tests

- Link parsing for every supported form and malformed input.
- Base64url validation and decoding.
- Room ID and safety-number golden vectors shared with TypeScript.
- Chat HKDF/AES-GCM seal/open vectors shared with TypeScript.
- Message validation, size limits, and tamper rejection.
- API request paths, headers, JSON decoding, timeouts, and error mapping with a
  custom `URLProtocol`.
- Keychain and defaults behavior through protocol-backed fakes.
- Meeting state transitions, lobby polling, direct-to-relay fallback, cleanup,
  interruption, and reconnection using a fake meeting engine.

### UI tests

- Create meeting and reach pre-join.
- Join using a pasted link.
- Invalid link feedback.
- Permission-denied audio-only flow.
- Waiting, denial, failed, reconnecting, and relay presentation.
- Meeting controls, chat, block/report, leave, and relaunch behavior.

### Device compatibility matrix

- Browser host to iPhone joiner.
- iPhone host to browser joiner.
- iPhone to iPhone.
- Same key and deliberately different key.
- Wi-Fi, cellular, network handoff, and relay-only network.
- Speaker, earpiece, wired headset, Bluetooth headset, interruption, lock screen,
  foreground/background, and camera flip.
- Small phone, current large phone, and iPad size classes.

Simulator tests may verify non-camera flows, but a physical-device call is
required for media acceptance.

## Build, Signing, and Distribution

- Bundle identifier: `com.ctrlaltl.nme`.
- Development team: `WC955H63L3` where local signing is available.
- Universal Link entitlement: `applinks:nmetalk.com`.
- Custom URL scheme: `nmetalk`.
- Camera and microphone usage descriptions retain the existing privacy wording.
- Background mode: audio.
- Non-exempt encryption declaration remains enabled.
- App icon and launch assets use the existing approved artwork where suitable,
  imported into the native asset catalog.
- Debug, staging, and release origins are supplied through `.xcconfig` files;
  incoming links can never override them.

## Migration and Cutover

1. Create the native project beside the React Native client.
2. Establish domain, crypto, and API parity through automated vectors.
3. Prove a minimal encrypted browser-to-iPhone call on physical hardware.
4. Build complete Home, Pre-join, Meeting, Chat, lobby, and moderation flows.
5. Run the device compatibility matrix and TestFlight testing.
6. Archive and validate an App Store build using `com.ctrlaltl.nme`.
7. Make `apps/ios` the documented iOS source of truth.
8. Remove the generated root `ios` project and obsolete iOS-specific React
   Native instructions only after native acceptance succeeds.

The React Native Android client remains intact. Shared server and web contracts
continue to be maintained in TypeScript, with golden compatibility fixtures
consumed by both TypeScript and Swift tests.

## Acceptance Criteria

The redevelopment is complete only when all of the following are true:

- The native project builds successfully for an iOS simulator with no signing.
- Unit and UI test suites pass.
- A signed development build launches on a physical iPhone.
- Users can create, share, paste, and open meetings through Universal Links.
- Lobby admission and host-key behavior match the browser client.
- Browser and iPhone participants exchange encrypted audio and video.
- Browser and iPhone participants exchange encrypted chat messages.
- Direct failure performs one relay-only retry with fresh credentials.
- Microphone, camera, flip, block/report, chat, and leave controls work.
- Active audio survives lock/background operation as permitted by iOS.
- Audio routes and interruptions recover without leaving the device in call mode.
- Room keys, host keys, tokens, and message plaintext do not appear in release
  logs or persistent room history.
- The bundle identifier, capabilities, permissions, privacy links, support link,
  export declaration, icons, and launch assets are ready for App Store archive.
