import Foundation
import XCTest
@testable import NME

@MainActor
final class PreJoinViewModelTests: XCTestCase {
    func testDeniedCameraPreparesAnAudioOnlyJoinAndStopsPreview() async throws {
        let identity = try RoomIdentity(
            encodedKey: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
        )
        let credentials = PreJoinCredentialSpy()
        let preview = PreviewController(requestAuthorization: { false })
        let model = PreJoinViewModel(identity: identity, credentials: credentials)

        await preview.setCameraEnabled(true)
        XCTAssertEqual(preview.status, .denied)

        let result = await model.prepareToJoin(preview: preview)

        XCTAssertEqual(result?.displayName, "Guest")
        XCTAssertEqual(result?.cameraEnabled, false)
        XCTAssertEqual(preview.status, .off)
        XCTAssertEqual(credentials.loadDisplayName(), "Guest")
    }
}

private final class PreJoinCredentialSpy: CredentialStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var name = ""

    func loadDisplayName() -> String {
        lock.withLock { name }
    }

    func saveDisplayName(_ value: String) {
        lock.withLock { name = value }
    }

    func loadHostKey(roomID _: String) -> String? { nil }

    func saveHostKey(_: String, roomID _: String) throws {}
}
