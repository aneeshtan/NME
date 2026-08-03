import LiveKit
import XCTest
@testable import NME

final class LiveKitTransportContractTests: XCTestCase {
    func testChatUsesReliableUntopicedPacketsCompatibleWithExistingClients() {
        let options = LiveKitWireContract.chatPublishOptions

        XCTAssertTrue(options.reliable)
        XCTAssertNil(options.topic)
        XCTAssertTrue(LiveKitWireContract.acceptsChat(topic: ""))
        XCTAssertTrue(LiveKitWireContract.acceptsChat(topic: "nme-chat"))
        XCTAssertFalse(LiveKitWireContract.acceptsChat(topic: "unrelated"))
    }

    func testBlockedParticipantsCannotDeliverData() {
        var policy = ParticipantAccessPolicy()

        XCTAssertTrue(policy.acceptsData(from: "participant-1"))
        policy.block("participant-1")

        XCTAssertFalse(policy.acceptsData(from: "participant-1"))
        XCTAssertTrue(policy.acceptsData(from: "participant-2"))
        XCTAssertTrue(policy.isBlocked("participant-1"))
    }

    func testSignalingCredentialsRequireWSSAndAHost() throws {
        let valid = credentials(url: "wss://sfu.nmetalk.com")
        XCTAssertEqual(
            try valid.validatedSignalingURL().absoluteString,
            "wss://sfu.nmetalk.com"
        )

        for value in [
            "ws://sfu.nmetalk.com",
            "https://sfu.nmetalk.com",
            "wss:///missing-host",
            "not a URL",
        ] {
            XCTAssertThrowsError(try credentials(url: value).validatedSignalingURL(), value) {
                XCTAssertEqual($0 as? SignalingURLValidationError, .insecureOrInvalid)
            }
        }
    }

    private func credentials(url: String) -> JoinCredentials {
        JoinCredentials(
            token: "token",
            url: url,
            identity: "participant-1",
            displayName: "Guest",
            iceServers: nil
        )
    }
}
