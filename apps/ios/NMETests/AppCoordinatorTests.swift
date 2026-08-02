import XCTest
@testable import NME

@MainActor
final class AppCoordinatorTests: XCTestCase {
    private let encodedKey = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"

    func testValidIncomingLinkEntersPreJoin() throws {
        let coordinator = AppCoordinator()
        let identity = try RoomIdentity(encodedKey: encodedKey)

        coordinator.open("https://nmetalk.com/#\(encodedKey)")

        XCTAssertEqual(coordinator.route, .preJoin(identity))
        XCTAssertNil(coordinator.presentedIssue)
    }

    func testInvalidLinkStaysHomeAndExplainsMissingKey() {
        let coordinator = AppCoordinator()

        coordinator.open("https://nmetalk.com/")

        XCTAssertEqual(coordinator.route, .home)
        XCTAssertEqual(coordinator.presentedIssue, .invalidInvitation)
        XCTAssertTrue(coordinator.presentedIssue?.message.contains("encryption key") == true)
    }

    func testCancelAndJoinUseExplicitRouteTransitions() throws {
        let coordinator = AppCoordinator()
        let identity = try RoomIdentity(encodedKey: encodedKey)

        coordinator.open(identity)
        coordinator.cancelPreJoin()
        XCTAssertEqual(coordinator.route, .home)

        coordinator.open(identity)
        coordinator.join(displayName: "Guest", cameraEnabled: false)
        XCTAssertEqual(
            coordinator.route,
            .meeting(identity, displayName: "Guest", cameraEnabled: false)
        )

        coordinator.leaveMeeting()
        XCTAssertEqual(coordinator.route, .home)
    }
}
