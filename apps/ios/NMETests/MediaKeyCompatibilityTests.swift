import LiveKit
import XCTest
@testable import NME

final class MediaKeyCompatibilityTests: XCTestCase {
    private let encodedKey = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"

    func testMediaPassphraseUsesInvitationStringVerbatim() throws {
        let identity = try RoomIdentity(encodedKey: encodedKey)

        XCTAssertEqual(MediaEncryptionConfiguration.passphrase(for: identity), encodedKey)
        XCTAssertEqual(MediaEncryptionConfiguration.passphrase(for: identity).utf8.count, 43)
        XCTAssertNotEqual(
            Data(MediaEncryptionConfiguration.passphrase(for: identity).utf8),
            identity.rawKey,
            "LiveKit derives its media key from the UTF-8 passphrase, not the decoded 32 bytes."
        )
    }

    func testRoomOptionsUseSharedMediaOnlyEncryption() throws {
        let identity = try RoomIdentity(encodedKey: encodedKey)
        let options = MediaEncryptionConfiguration.makeRoomOptions(
            identity: identity,
            videoCodec: .vp8
        )

        XCTAssertTrue(options.adaptiveStream)
        XCTAssertTrue(options.dynacast)
        XCTAssertTrue(options.stopLocalTrackOnUnpublish)
        XCTAssertTrue(options.suspendLocalVideoTracksInBackground)
        XCTAssertEqual(options.e2eeOptions?.keyProvider.options.sharedKey, true)
        XCTAssertNil(
            options.encryptionOptions,
            "Chat retains the existing cross-platform encrypted envelope instead of LiveKit data encryption."
        )
    }

    func testInitialConnectionErrorsPreserveRelayAndTokenSemantics() {
        XCTAssertEqual(LiveKitErrorClassifier.connectionError(.timedOut), .mediaPath)
        XCTAssertEqual(LiveKitErrorClassifier.connectionError(.webRTC), .mediaPath)
        XCTAssertEqual(LiveKitErrorClassifier.connectionError(.network), .mediaPath)
        XCTAssertEqual(LiveKitErrorClassifier.connectionError(.serverPingTimedOut), .mediaPath)

        XCTAssertEqual(LiveKitErrorClassifier.connectionError(.validation), .tokenRejected)
        XCTAssertEqual(LiveKitErrorClassifier.connectionError(.joinFailure), .tokenRejected)
        XCTAssertEqual(LiveKitErrorClassifier.connectionError(.insufficientPermissions), .tokenRejected)
        XCTAssertEqual(LiveKitErrorClassifier.connectionError(.duplicateIdentity), .tokenRejected)

        XCTAssertEqual(LiveKitErrorClassifier.connectionError(.encryptionFailed), .connection)
    }

    func testDevicePermissionErrorsAreClassifiedByOperation() {
        XCTAssertEqual(
            LiveKitErrorClassifier.mediaError(.deviceAccessDenied, operation: .microphone),
            .microphonePermissionDenied
        )
        XCTAssertEqual(
            LiveKitErrorClassifier.mediaError(.deviceAccessDenied, operation: .camera),
            .cameraPermissionDenied
        )
        XCTAssertEqual(
            LiveKitErrorClassifier.mediaError(.audioEngine, operation: .microphone),
            .connection
        )
    }

    func testDirectConnectionUsesShortMediaPathBudgetWithoutCustomICE() throws {
        let request = try connectionRequest(relayed: false, iceServers: nil)

        let options = LiveKitConnectionConfiguration.makeConnectOptions(for: request)

        XCTAssertTrue(options.autoSubscribe)
        XCTAssertEqual(options.reconnectAttempts, 15)
        XCTAssertEqual(options.primaryTransportConnectTimeout, 8)
        XCTAssertEqual(options.publisherTransportConnectTimeout, 8)
        XCTAssertEqual(options.iceTransportPolicy, .all)
        XCTAssertTrue(options.iceServers.isEmpty)
        XCTAssertFalse(options.enableMicrophone)
    }

    func testRelayConnectionMapsCredentialsAndForcesRelayOnlyICE() throws {
        let servers = [
            IceServerConfiguration(
                urls: ["turns:turn.nmetalk.com:443?transport=tcp"],
                username: "relay-user",
                credential: "relay-secret"
            ),
        ]
        let request = try connectionRequest(relayed: true, iceServers: servers)

        let options = LiveKitConnectionConfiguration.makeConnectOptions(for: request)

        XCTAssertEqual(options.iceTransportPolicy, .relay)
        XCTAssertEqual(options.primaryTransportConnectTimeout, 15)
        XCTAssertEqual(options.publisherTransportConnectTimeout, 15)
        XCTAssertEqual(options.iceServers.first?.urls, servers[0].urls)
        XCTAssertEqual(options.iceServers.first?.username, servers[0].username)
        XCTAssertEqual(options.iceServers.first?.credential, servers[0].credential)
    }

    private func connectionRequest(
        relayed: Bool,
        iceServers: [IceServerConfiguration]?
    ) throws -> MeetingConnectionRequest {
        MeetingConnectionRequest(
            roomIdentity: try RoomIdentity(encodedKey: encodedKey),
            configuration: ClientConfiguration(
                livekitUrl: "wss://sfu.nmetalk.com",
                maxParticipants: 25,
                videoCodec: .vp8
            ),
            credentials: JoinCredentials(
                token: "token",
                url: "wss://sfu.nmetalk.com",
                identity: "participant",
                displayName: "Guest",
                iceServers: iceServers
            ),
            relayed: relayed,
            microphoneEnabled: true,
            cameraEnabled: true
        )
    }
}
