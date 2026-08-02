# Native iOS Redevelopment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a functional native SwiftUI NME Talk client that interoperates with the existing server and browser for encrypted meetings and chat.

**Architecture:** A single SwiftUI application target uses focused protocol-backed services for room identity, API access, secure persistence, preview capture, and a LiveKit-backed meeting state machine. The app retains the existing link, lobby, relay, and encryption contracts while removing Expo and React Native from the iOS build.

**Tech Stack:** Swift 6, SwiftUI, CryptoKit, Security, URLSession, OSLog, XCTest, XCUITest, XcodeGen, LiveKit Swift SDK 2.13.0 through Swift Package Manager.

---

## File Map

The plan creates these groups of files:

- `apps/ios/project.yml`: deterministic XcodeGen project definition.
- `apps/ios/Configuration/*.xcconfig`: deployment-specific values without link-controlled configuration.
- `apps/ios/NME/App/*`: app entry point, environment, and explicit route coordinator.
- `apps/ios/NME/Domain/*`: validated room identity and immutable meeting presentation models.
- `apps/ios/NME/Crypto/*`: compatible room identity and chat cryptography.
- `apps/ios/NME/Infrastructure/*`: HTTPS API client, Keychain/defaults storage, and redacted logging.
- `apps/ios/NME/Meeting/*`: preview and LiveKit room lifecycle.
- `apps/ios/NME/Features/*`: SwiftUI Home, Pre-join, Meeting, and Chat screens.
- `apps/ios/NMETests/*`: domain, crypto, API, storage, and state-machine tests.
- `apps/ios/NMEUITests/*`: launch and navigation acceptance tests.
- `packages/core/test-fixtures/native-compatibility.json`: shared deterministic compatibility vectors.

## Task 1: Deterministic Native Project Scaffold

**Files:**
- Create: `apps/ios/project.yml`
- Create: `apps/ios/Configuration/Shared.xcconfig`
- Create: `apps/ios/Configuration/Debug.xcconfig`
- Create: `apps/ios/Configuration/Release.xcconfig`
- Create: `apps/ios/NME/Resources/Info.plist`
- Create: `apps/ios/NME/Resources/NME.entitlements`
- Create: `apps/ios/NME/App/NMEApp.swift`
- Create: `apps/ios/NME/Features/Home/HomeView.swift`
- Create: `apps/ios/NMETests/AppLaunchTests.swift`
- Create: `apps/ios/NMEUITests/NMEUITests.swift`

- [ ] **Step 1: Define the project and configurations**

Create an XcodeGen application with bundle identifier `com.ctrlaltl.nme`, iOS
16.4 deployment, Swift 6 strict concurrency, an application target, unit-test
target, UI-test target, and a shared `NME` scheme. Pin LiveKit to 2.13.0:

```yaml
name: NME
options:
  deploymentTarget:
    iOS: "16.4"
packages:
  LiveKit:
    url: https://github.com/livekit/client-sdk-swift.git
    exactVersion: 2.13.0
targets:
  NME:
    type: application
    platform: iOS
    sources: [NME]
    configFiles:
      Debug: Configuration/Debug.xcconfig
      Release: Configuration/Release.xcconfig
    dependencies:
      - package: LiveKit
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: com.ctrlaltl.nme
        DEVELOPMENT_TEAM: WC955H63L3
        INFOPLIST_FILE: NME/Resources/Info.plist
        CODE_SIGN_ENTITLEMENTS: NME/Resources/NME.entitlements
        SWIFT_VERSION: 6.0
        SWIFT_STRICT_CONCURRENCY: complete
  NMETests:
    type: bundle.unit-test
    platform: iOS
    sources: [NMETests]
    dependencies: [{target: NME}]
  NMEUITests:
    type: bundle.ui-testing
    platform: iOS
    sources: [NMEUITests]
    dependencies: [{target: NME}]
schemes:
  NME:
    build:
      targets:
        NME: all
        NMETests: [test]
        NMEUITests: [test]
    test:
      targets: [NMETests, NMEUITests]
```

`Shared.xcconfig` defines `NME_ORIGIN = https:/$()/nmetalk.com`,
`PRODUCT_NAME = NME Talk`, and the semantic/build versions. Debug and Release
include Shared. Release sets `SWIFT_OPTIMIZATION_LEVEL = -O` and Debug sets
`SWIFT_OPTIMIZATION_LEVEL = -Onone`.

- [ ] **Step 2: Write the failing launch test**

```swift
import XCTest
@testable import NME

final class AppLaunchTests: XCTestCase {
    func testProductIdentity() {
        XCTAssertEqual(AppConfiguration.productName, "NME Talk")
        XCTAssertEqual(AppConfiguration.origin, URL(string: "https://nmetalk.com")!)
    }
}
```

- [ ] **Step 3: Generate the project and verify the test target initially fails**

Run:

```bash
cd apps/ios
xcodegen generate
xcodebuild build-for-testing -project NME.xcodeproj -scheme NME \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5' \
  -derivedDataPath /tmp/NMEDerivedData CODE_SIGNING_ALLOWED=NO
```

Expected: compilation fails because `AppConfiguration` does not yet exist.

- [ ] **Step 4: Add the minimum app entry point and configuration**

```swift
import Foundation

enum AppConfiguration {
    static let productName = "NME Talk"
    static let origin = URL(string: Bundle.main.object(forInfoDictionaryKey: "NMEOrigin") as? String ?? "https://nmetalk.com")!
}
```

```swift
import SwiftUI

@main
struct NMEApp: App {
    var body: some Scene {
        WindowGroup { HomeView() }
    }
}
```

`HomeView` renders the product name and a native navigation-safe background.
The Info plist defines `NMEOrigin`, camera/microphone usage descriptions,
background audio, export compliance, and the `nmetalk` scheme. Entitlements
contain `applinks:nmetalk.com`.

- [ ] **Step 5: Build and run the launch tests**

Run the same `build-for-testing` command, then:

```bash
xcodebuild test-without-building -project apps/ios/NME.xcodeproj -scheme NME \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5' \
  -derivedDataPath /tmp/NMEDerivedData
```

Expected: `AppLaunchTests` and the UI launch test pass.

- [ ] **Step 6: Commit the scaffold**

```bash
git add apps/ios
git commit -m "Build the native iOS project scaffold"
```

## Task 2: Shared Compatibility Fixtures and Room Identity

**Files:**
- Create: `packages/core/test-fixtures/native-compatibility.json`
- Create: `apps/ios/NME/Domain/RoomIdentity.swift`
- Create: `apps/ios/NME/Crypto/RoomCrypto.swift`
- Create: `apps/ios/NMETests/RoomIdentityTests.swift`
- Modify: `packages/core/src/e2ee.test.ts`

- [ ] **Step 1: Add a deterministic cross-platform fixture**

Use raw bytes `00` through `1f` and record:

```json
{
  "encodedRoomKey": "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  "roomId": "gqwm-kmxk-yvzm",
  "safetyNumber": "91597 13284 68593 01224",
  "chat": {
    "nonceHex": "000102030405060708090a0b",
    "at": 1700000000000,
    "text": "hello",
    "envelopeHex": "000102030405060708090a0b3c68c4e1fe37703e96d95c5bc3330125384f69edc829e54b401771dd06cf3b81f8afac7fe3e77b7cb95e30709edbb198096a7a776512e385b8a2997a7e5e0d4aa8"
  }
}
```

- [ ] **Step 2: Write failing Swift room-identity tests**

Cover bare keys, short links, legacy `#k=` links, custom schemes, whitespace,
missing fragments, invalid alphabet, wrong lengths, room ID, and safety number:

```swift
func testFixtureDerivesBrowserCompatibleIdentity() throws {
    let identity = try RoomIdentity(encodedKey: fixture.encodedRoomKey)
    XCTAssertEqual(identity.roomID, "gqwm-kmxk-yvzm")
    XCTAssertEqual(identity.safetyNumber, "91597 13284 68593 01224")
    XCTAssertEqual(identity.rawKey, Data((0...31).map(UInt8.init)))
}
```

- [ ] **Step 3: Verify the tests fail**

Run:

```bash
xcodebuild test -project apps/ios/NME.xcodeproj -scheme NME \
  -only-testing:NMETests/RoomIdentityTests \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5' \
  -derivedDataPath /tmp/NMEDerivedData
```

Expected: compilation fails because `RoomIdentity` does not exist.

- [ ] **Step 4: Implement validated identity derivation**

`RoomIdentity` stores `encodedKey` and `rawKey`. It uses a strict Base64URL
decoder, checks exactly 43 encoded characters and 32 decoded bytes, computes
SHA-256 with CryptoKit, and derives the room ID and safety number exactly as the
fixture specifies. `init(linkOrKey:)` extracts only the fragment or bare key and
does not trust the URL host.

```swift
struct RoomIdentity: Equatable, Sendable {
    let encodedKey: String
    let rawKey: Data
    let roomID: String
    let safetyNumber: String

    init(encodedKey: String) throws {
        let raw = try RoomCrypto.decodeBase64URLKey(encodedKey)
        self.encodedKey = encodedKey
        rawKey = raw
        let digest = Data(SHA256.hash(data: raw))
        roomID = RoomCrypto.roomID(from: digest)
        safetyNumber = RoomCrypto.safetyNumber(from: digest)
    }
}
```

- [ ] **Step 5: Add TypeScript fixture assertions and run both suites**

The existing core test imports the JSON fixture and asserts `deriveRoomId` and
`safetyNumber` against it. Run:

```bash
npm run test -w @nme/core
xcodebuild test -project apps/ios/NME.xcodeproj -scheme NME \
  -only-testing:NMETests/RoomIdentityTests \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5' \
  -derivedDataPath /tmp/NMEDerivedData
```

Expected: both suites pass.

- [ ] **Step 6: Commit identity parity**

```bash
git add packages/core/test-fixtures packages/core/src/e2ee.test.ts apps/ios
git commit -m "Match native room identity with the web client"
```

## Task 3: Compatible Ephemeral Chat Cryptography

**Files:**
- Create: `apps/ios/NME/Crypto/MessageCipher.swift`
- Create: `apps/ios/NME/Domain/ChatMessage.swift`
- Create: `apps/ios/NMETests/MessageCipherTests.swift`
- Modify: `packages/core/src/messaging.test.ts`

- [ ] **Step 1: Write failing fixture and tamper tests**

```swift
func testOpensTypeScriptFixture() throws {
    let identity = try RoomIdentity(encodedKey: fixture.encodedRoomKey)
    let message = try MessageCipher(roomKey: identity.rawKey)
        .open(Data(hex: fixture.chat.envelopeHex))
    XCTAssertEqual(message, ChatMessage(at: 1_700_000_000_000, text: "hello"))
}

func testRejectsTamperedCiphertext() throws {
    var envelope = Data(hex: fixture.chat.envelopeHex)
    envelope[20] ^= 1
    XCTAssertThrowsError(try MessageCipher(roomKey: Data((0...31).map(UInt8.init))).open(envelope))
}
```

Also cover empty messages, the 2,000-character cap, and the 16-KiB envelope
limit.

- [ ] **Step 2: Run and confirm failure**

Run the native test target filtered to `MessageCipherTests`.
Expected: compilation fails because `MessageCipher` is absent.

- [ ] **Step 3: Implement HKDF and AES-GCM envelope compatibility**

```swift
struct MessageCipher: Sendable {
    private let key: SymmetricKey

    init(roomKey: Data) {
        key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: roomKey),
            salt: Data(),
            info: Data("nme-chat-v1".utf8),
            outputByteCount: 32
        )
    }

    func open(_ envelope: Data) throws -> ChatMessage {
        guard envelope.count > 28, envelope.count <= 16 * 1024 else {
            throw MessageCipherError.invalidEnvelope
        }
        let nonce = try AES.GCM.Nonce(data: envelope.prefix(12))
        let body = envelope.dropFirst(12)
        let box = try AES.GCM.SealedBox(
            nonce: nonce,
            ciphertext: body.dropLast(16),
            tag: body.suffix(16)
        )
        return try ChatMessage.decode(AES.GCM.open(box, using: key))
    }
}
```

`seal` accepts an injectable nonce in tests and uses a random `AES.GCM.Nonce()`
in production. It serializes keys in sorted order so deterministic fixtures are
stable; the browser accepts JSON fields in any order.

- [ ] **Step 4: Add a TypeScript assertion that opens the Swift fixture**

The TypeScript messaging test decodes the fixture envelope and asserts the same
chat object. This verifies the fixture in both directions.

- [ ] **Step 5: Run native and core crypto tests**

Expected: all room and message compatibility tests pass.

- [ ] **Step 6: Commit chat compatibility**

```bash
git add apps/ios packages/core
git commit -m "Add browser-compatible native chat encryption"
```

## Task 4: Typed HTTPS API Client

**Files:**
- Create: `apps/ios/NME/Infrastructure/APIModels.swift`
- Create: `apps/ios/NME/Infrastructure/APIClient.swift`
- Create: `apps/ios/NME/Domain/MeetingError.swift`
- Create: `apps/ios/NMETests/APIClientTests.swift`
- Create: `apps/ios/NMETests/URLProtocolStub.swift`

- [ ] **Step 1: Write failing request-contract tests**

Test exact paths and bodies for configuration, room creation, join, claim,
knock listing/resolution, and reporting. Assert that host keys use
`X-Host-Key`, cookies are disabled, an HTTPS origin is required, bodyless
requests omit `Content-Type`, JSON requests set it, and timeout/network/server
errors map to stable codes.

```swift
func testJoinSendsHostKeyOnlyInHeader() async throws {
    let client = makeClient(response: joinCredentialsJSON)
    _ = try await client.join(roomID: "gqwm-kmxk-yvzm", name: "Farshad", hostKey: "host-secret", relay: false)
    XCTAssertEqual(URLProtocolStub.lastRequest?.url?.path, "/api/rooms/gqwm-kmxk-yvzm/join")
    XCTAssertEqual(URLProtocolStub.lastRequest?.value(forHTTPHeaderField: "X-Host-Key"), "host-secret")
    XCTAssertFalse(String(data: URLProtocolStub.lastBody!, encoding: .utf8)!.contains("host-secret"))
}
```

- [ ] **Step 2: Run and confirm compilation failure**

Expected: `APIClient` and response models are missing.

- [ ] **Step 3: Implement Sendable Codable models and API client**

Create `ClientConfiguration`, `IceServerConfiguration`, `JoinCredentials`,
`JoinResult`, `PendingKnock`, and `AdmissionResult`. `APIClient.request` uses a
ten-second timeout, validates HTTPS at initialization, decodes the server error
shape, and never logs request bodies or authorization material.

```swift
struct APIClient: Sendable {
    let origin: URL
    let session: URLSession

    func join(roomID: String, name: String, hostKey: String?, relay: Bool) async throws -> JoinResult {
        let body = JoinRequest(displayName: name, relay: relay ? true : nil)
        return try await request(
            path: "/rooms/\(roomID)/join",
            method: "POST",
            body: body,
            headers: hostKey.map { ["X-Host-Key": $0] } ?? [:]
        )
    }
}
```

- [ ] **Step 4: Run API tests and the server route tests**

```bash
xcodebuild test -project apps/ios/NME.xcodeproj -scheme NME \
  -only-testing:NMETests/APIClientTests \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5' \
  -derivedDataPath /tmp/NMEDerivedData
npm run test -w @nme/server
```

Expected: native request-contract tests and existing server tests pass.

- [ ] **Step 5: Commit the control-plane client**

```bash
git add apps/ios
git commit -m "Add the native meeting API client"
```

## Task 5: Secure Persistence and Redacted Logging

**Files:**
- Create: `apps/ios/NME/Infrastructure/CredentialStore.swift`
- Create: `apps/ios/NME/Infrastructure/KeychainClient.swift`
- Create: `apps/ios/NME/Infrastructure/AppLogger.swift`
- Create: `apps/ios/NMETests/CredentialStoreTests.swift`

- [ ] **Step 1: Write failing persistence tests**

Verify a 60-character display-name cap, host-key lookup by room ID, device-only
Keychain accessibility, graceful storage failures, and the absence of any API
that persists a room key.

- [ ] **Step 2: Implement protocol-backed defaults and Keychain storage**

```swift
protocol CredentialStoring: Sendable {
    func loadDisplayName() -> String
    func saveDisplayName(_ value: String)
    func loadHostKey(roomID: String) -> String?
    func saveHostKey(_ value: String, roomID: String) throws
}
```

Use `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, generic-password class,
service `com.ctrlaltl.nme.host-keys`, and room ID as the account. `AppLogger`
accepts only stable event codes and redacted scalar metadata; it exposes no
method taking raw URLs, tokens, keys, names, or message bodies.

- [ ] **Step 3: Run tests and commit**

Expected: persistence tests pass.

```bash
git add apps/ios
git commit -m "Store native host credentials securely"
```

## Task 6: Coordinator, Home, and Pre-join Flow

**Files:**
- Create: `apps/ios/NME/App/AppEnvironment.swift`
- Create: `apps/ios/NME/App/AppCoordinator.swift`
- Create: `apps/ios/NME/Features/Home/HomeViewModel.swift`
- Modify: `apps/ios/NME/Features/Home/HomeView.swift`
- Create: `apps/ios/NME/Features/PreJoin/PreJoinViewModel.swift`
- Create: `apps/ios/NME/Features/PreJoin/PreJoinView.swift`
- Create: `apps/ios/NME/Meeting/PreviewController.swift`
- Create: `apps/ios/NMETests/AppCoordinatorTests.swift`
- Create: `apps/ios/NMETests/HomeViewModelTests.swift`

- [ ] **Step 1: Write failing coordinator and creation tests**

Verify that incoming/pasted links enter pre-join, invalid links retain home with
an actionable error, creating a meeting generates a random key locally, sends
only the derived room ID to the server, stores the returned host key, and enters
pre-join.

- [ ] **Step 2: Implement explicit route state and dependency environment**

```swift
@MainActor
final class AppCoordinator: ObservableObject {
    enum Route: Equatable { case home, preJoin(RoomIdentity), meeting(RoomIdentity, String) }
    @Published private(set) var route: Route = .home

    func open(_ linkOrKey: String) {
        do { route = .preJoin(try RoomIdentity(linkOrKey: linkOrKey)) }
        catch { presentedError = .invalidInvitation }
    }
}
```

`AppEnvironment` constructs the production API, storage, preview, and meeting
factories once. Tests inject fakes.

- [ ] **Step 3: Build the Home screen**

Implement native controls for New meeting, pasted link, Join, privacy, and
support. Disable duplicate submissions, make errors accessible, and use the
existing dark palette and icon asset. Share URLs use
`https://nmetalk.com/#<encoded-key>`.

- [ ] **Step 4: Build pre-join preview and choices**

`PreviewController` wraps a LiveKit `LocalVideoTrack`; it starts a local camera
track only after permission, exposes it to `SwiftUIVideoView`, stops it when
camera is disabled or the view disappears, and always stops before joining.
Camera denial keeps Join enabled for audio-only use. The view includes display
name, camera toggle, share sheet, safety number, Join, and Cancel.

- [ ] **Step 5: Run unit and UI navigation tests**

Expected: create, paste, invalid-link, cancel, and audio-only navigation tests
pass without contacting production.

- [ ] **Step 6: Commit the first functional flow**

```bash
git add apps/ios
git commit -m "Build native home and pre-join flows"
```

## Task 7: Testable Meeting State Machine

**Files:**
- Create: `apps/ios/NME/Domain/MeetingModels.swift`
- Create: `apps/ios/NME/Meeting/MeetingSessionProtocol.swift`
- Create: `apps/ios/NME/Meeting/MeetingSession.swift`
- Create: `apps/ios/NMETests/MeetingSessionTests.swift`

- [ ] **Step 1: Write failing lifecycle tests**

Cover idle-to-connected, lobby polling every two seconds, denial, five-minute
timeout, direct failure to fresh relay join, relay absence, non-media failure
without relay, reconnecting, leave, cancellation, and cleanup. Use an injected
clock so tests do not sleep.

```swift
func testDirectMediaFailureRequestsFreshRelayCredentials() async throws {
    let engine = FakeMeetingEngine(outcomes: [.failure(.mediaPath), .connected])
    let api = FakeAPI(joinResults: [.credentials(direct), .credentials(relay)])
    let session = MeetingSession(api: api, engine: engine, clock: .immediate)
    await session.join(identity: fixtureIdentity, displayName: "Guest")
    XCTAssertEqual(api.joinRelayFlags, [false, true])
    XCTAssertEqual(engine.tokens, [direct.token, relay.token])
    XCTAssertEqual(session.state, .connected(relayed: true))
}
```

- [ ] **Step 2: Implement the observable state machine**

The `@MainActor` session exposes state, participants, unread count, mic/camera
flags, and async actions. It owns exactly one engine at a time and uses a
generation identifier so late callbacks from a cancelled attempt cannot mutate
a new meeting.

- [ ] **Step 3: Run state-machine tests**

Expected: all lifecycle and cleanup paths pass deterministically.

- [ ] **Step 4: Commit the meeting orchestration**

```bash
git add apps/ios
git commit -m "Model the native meeting lifecycle"
```

## Task 8: LiveKit Media Engine and Cross-client E2EE

**Files:**
- Create: `apps/ios/NME/Meeting/LiveKitMeetingEngine.swift`
- Create: `apps/ios/NME/Meeting/AudioLifecycle.swift`
- Create: `apps/ios/NMETests/MediaKeyCompatibilityTests.swift`
- Modify: `apps/web/src/room/connect.ts`
- Modify: `apps/mobile/src/room/connect.ts`
- Modify: `README.md`

- [ ] **Step 1: Write failing media-key contract tests**

Assert all clients use the same 43-character room-key passphrase for LiveKit
media encryption. The room key remains 256 random bits; its base64url form is
the cross-SDK passphrase because the current Swift SDK's public provider accepts
a string and LiveKit documents string keys as the maximum-compatibility path.
Room IDs and chat continue to derive from the decoded raw bytes.

- [ ] **Step 2: Update web and React Native media setup to the shared passphrase**

Change the web call from `setKey(decodeRoomKey(roomKey))` to `setKey(roomKey)`
and the React Native call from raw bytes to `setSharedKey(roomKey)`. Update the
outdated unverified comments and README explanation. Do not change room-ID or
chat derivation.

- [ ] **Step 3: Implement the LiveKit engine against version 2.13.0 APIs**

```swift
let provider = BaseKeyProvider(isSharedKey: true, sharedKey: identity.encodedKey)
let options = RoomOptions(
    adaptiveStream: true,
    dynacast: true,
    stopLocalTrackOnUnpublish: true,
    suspendLocalVideoTracksInBackground: true,
    e2eeOptions: E2EEOptions(keyProvider: provider)
)
let room = Room(delegate: delegate, roomOptions: options)
try await room.connect(
    url: credentials.url,
    token: credentials.token,
    connectOptions: ConnectOptions(
        autoSubscribe: true,
        reconnectAttempts: 15,
        primaryTransportConnectTimeout: timeout,
        publisherTransportConnectTimeout: timeout,
        iceServers: iceServers,
        iceTransportPolicy: relayed ? .relay : .all
    )
)
```

After connection, enable microphone and camera from pre-join choices. Translate
RoomDelegate callbacks onto `@MainActor`, rebuild immutable tile models, deliver
data payloads to chat, and classify permission/token/media-path failures.

- [ ] **Step 4: Implement audio lifecycle and cleanup**

Leave automatic LiveKit audio-session configuration enabled. Observe route
changes, interruptions, and media-service reset notifications. Leaving always
disables microphone/camera, disconnects, removes delegates, clears strong SDK
references, and updates the session to ended.

- [ ] **Step 5: Run native, web, and mobile tests and builds**

```bash
npm run test -w @nme/core
npm run test -w @nme/mobile
npm run typecheck -w @nme/web
xcodebuild build -project apps/ios/NME.xcodeproj -scheme NME \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/NMEDerivedData CODE_SIGNING_ALLOWED=NO
```

Expected: TypeScript suites and native build pass. Record physical browser ↔
iPhone media as a required manual acceptance item rather than simulating camera
support that the iOS Simulator does not provide.

- [ ] **Step 6: Commit the media engine**

```bash
git add apps/ios apps/web/src/room/connect.ts apps/mobile/src/room/connect.ts README.md
git commit -m "Connect the native client with LiveKit"
```

## Task 9: Native Meeting, Chat, and Moderation UI

**Files:**
- Create: `apps/ios/NME/Features/Meeting/MeetingView.swift`
- Create: `apps/ios/NME/Features/Meeting/ParticipantTile.swift`
- Create: `apps/ios/NME/Features/Meeting/MeetingToolbar.swift`
- Create: `apps/ios/NME/Features/Chat/ChatView.swift`
- Create: `apps/ios/NME/Features/Meeting/MeetingViewModel.swift`
- Create: `apps/ios/NMETests/MeetingViewModelTests.swift`
- Modify: `apps/ios/NME/App/AppCoordinator.swift`

- [ ] **Step 1: Write failing presentation-model tests**

Verify tile ordering, local mirroring, muted labels, one/two-column rules,
active-speaker selection above six participants, unread counts, 300-message
retention, block unsubscribe, report payload, toggle rollback on SDK failure,
and leave cleanup.

- [ ] **Step 2: Implement participant grid and video tiles**

Use `LazyVGrid`, `SwiftUIVideoView`, aspect-safe tile sizing, initials when no
video is active, and explicit accessibility labels. Retain only weak/room-owned
LiveKit objects and render immutable tile snapshots.

- [ ] **Step 3: Implement controls and meeting states**

Add microphone, camera, flip, chat, and Leave controls with 44-point minimum
targets. Render waiting, connecting, relaying, reconnecting, failure, and ended
states. Disable concurrent toggle tasks and restore the prior visible state when
the SDK rejects an operation.

- [ ] **Step 4: Implement encrypted ephemeral chat**

Seal outgoing messages with `MessageCipher`, publish reliable data, decrypt
incoming data, cap messages at 300, increment unread only while the sheet is
closed, and clear everything at meeting end.

- [ ] **Step 5: Implement block and report**

Long-pressing a remote tile presents Block and Block & Report. Blocking calls
`set(subscribed: false)` for each remote publication and removes the tile.
Reporting submits the existing report endpoint without room keys or chat data.

- [ ] **Step 6: Run view-model and UI tests**

Expected: controls, state presentation, chat, block/report, and leave tests
pass on the iPhone 17 Pro simulator.

- [ ] **Step 7: Commit the complete meeting experience**

```bash
git add apps/ios
git commit -m "Build the native meeting experience"
```

## Task 10: Capabilities, Assets, Universal Links, and Store Metadata

**Files:**
- Modify: `apps/ios/NME/Resources/Info.plist`
- Modify: `apps/ios/NME/Resources/NME.entitlements`
- Create: `apps/ios/NME/Resources/Assets.xcassets/Contents.json`
- Create: `apps/ios/NME/Resources/Assets.xcassets/AppIcon.appiconset/Contents.json`
- Create: `apps/ios/NME/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png`
- Create: `apps/ios/NMETests/ConfigurationTests.swift`
- Modify: `docs/store-submission.md`
- Modify: `README.md`

- [ ] **Step 1: Write failing configuration assertions**

Load the built plist and entitlements and assert bundle identity, scheme,
privacy strings, background audio, encryption declaration, associated domain,
HTTPS origin, and support/privacy URLs.

- [ ] **Step 2: Import native assets and finalize metadata**

Reuse the existing opaque 1024-pixel app icon, add the asset catalog, define a
dark launch screen through `UILaunchScreen`, retain the existing camera and
microphone wording, set `ITSAppUsesNonExemptEncryption` to true, and include only
the audio background mode.

- [ ] **Step 3: Verify domain association files**

Confirm `apps/web/public/.well-known/apple-app-site-association` lists
`WC955H63L3.com.ctrlaltl.nme` and that the deployed HTTPS file has the correct
content type. Update the source file only if the identifier differs.

- [ ] **Step 4: Update build and submission documentation**

Document XcodeGen generation, package resolution, simulator tests, device run,
archive, privacy/export values, and the requirement for physical encrypted-call
acceptance. Remove claims that the generated root `ios` directory is the native
source of truth.

- [ ] **Step 5: Run configuration tests and archive build**

```bash
xcodebuild archive -project apps/ios/NME.xcodeproj -scheme NME \
  -archivePath /tmp/NME.xcarchive -destination 'generic/platform=iOS' \
  CODE_SIGNING_ALLOWED=NO
```

Expected: unsigned archive compiles successfully; signed validation remains a
device/team credential check.

- [ ] **Step 6: Commit production configuration**

```bash
git add apps/ios README.md docs/store-submission.md apps/web/public/.well-known/apple-app-site-association
git commit -m "Prepare the native iOS app for distribution"
```

## Task 11: Full Verification and Completion Audit

**Files:**
- Create: `docs/native-ios-verification.md`
- Modify: `package.json`

- [ ] **Step 1: Add repository-level native scripts**

Add `ios:generate`, `ios:build`, and `ios:test` scripts that call XcodeGen and
the exact simulator/build commands used above. Scripts must use an explicit
DerivedData path under `/tmp` and never clean unrelated user state.

- [ ] **Step 2: Run all automated verification from a clean generated project**

```bash
npm run typecheck
npm test
npm run build
npm run ios:generate
npm run ios:test
npm run ios:build
git diff --check
```

Expected: all TypeScript checks, native tests, native simulator build, web/server
builds, and whitespace checks pass.

- [ ] **Step 3: Run focused security and scope checks**

Search release sources and generated settings for persisted room keys, secret
logging, arbitrary HTTP allowances, unexpected background modes, stray bundle
identifiers, and references to the obsolete generated root project:

```bash
rg -n "com\.anonymous|NSAllowsArbitraryLoads.*true|UIBackgroundModes|roomKey|hostKey|token|message" apps/ios README.md docs
```

Review each match; keep only intentional in-memory use, Keychain host-key use,
redacted identifiers, and documented configuration.

- [ ] **Step 4: Record evidence and remaining physical checks**

`docs/native-ios-verification.md` records command outputs, tested simulator,
package version, build artifact path, and the physical-device matrix. Automated
items are marked with evidence. Device-only items remain explicitly unverified
until run on an iPhone; they are not reported as passing based on simulator
evidence.

- [ ] **Step 5: Request final code review and address findings**

Use the requesting-code-review workflow, fix every validated blocking finding,
and rerun the affected verification plus the full native build.

- [ ] **Step 6: Commit the verified handoff**

```bash
git add package.json package-lock.json docs/native-ios-verification.md
git commit -m "Verify the native iOS redevelopment"
```
