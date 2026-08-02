import Foundation
import XCTest
@testable import NME

@MainActor
final class HomeViewModelTests: XCTestCase {
    private let encodedKey = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"

    func testCreatingMeetingGeneratesKeyLocallyAndStoresHostCredential() async throws {
        let expectedIdentity = try RoomIdentity(encodedKey: encodedKey)
        let api = RoomCreatorSpy(
            response: CreateRoomResponse(roomId: expectedIdentity.roomID, hostKey: "host-secret")
        )
        let credentials = CredentialStoreSpy()
        let model = HomeViewModel(
            api: api,
            credentials: credentials,
            generateIdentity: { expectedIdentity }
        )

        let result = await model.createMeeting()

        XCTAssertEqual(result, expectedIdentity)
        let request = await api.lastRequest
        XCTAssertEqual(request?.roomID, expectedIdentity.roomID)
        XCTAssertEqual(request?.lobby, true)
        XCTAssertEqual(credentials.hostKey(roomID: expectedIdentity.roomID), "host-secret")
        XCTAssertFalse(request?.roomID.contains(encodedKey) == true)
    }

    func testDuplicateCreateIsIgnoredWhileRequestIsRunning() async throws {
        let identity = try RoomIdentity(encodedKey: encodedKey)
        let api = RoomCreatorSpy(
            response: CreateRoomResponse(roomId: identity.roomID, hostKey: "host-secret"),
            suspended: true
        )
        let model = HomeViewModel(
            api: api,
            credentials: CredentialStoreSpy(),
            generateIdentity: { identity }
        )

        let first = Task { await model.createMeeting() }
        for _ in 0 ..< 20 where await api.callCount == 0 {
            await Task.yield()
        }

        XCTAssertTrue(model.isCreating)
        let duplicate = await model.createMeeting()
        XCTAssertNil(duplicate)
        let callCount = await api.callCount
        XCTAssertEqual(callCount, 1)

        await api.release()
        let result = await first.value
        XCTAssertEqual(result, identity)
        XCTAssertFalse(model.isCreating)
    }

    func testCreateFailureBecomesActionableInlineIssue() async throws {
        let identity = try RoomIdentity(encodedKey: encodedKey)
        let api = RoomCreatorSpy(
            response: CreateRoomResponse(roomId: identity.roomID, hostKey: nil),
            failure: APIError(code: "NETWORK", message: "Could not reach the server.", status: 0)
        )
        let model = HomeViewModel(
            api: api,
            credentials: CredentialStoreSpy(),
            generateIdentity: { identity }
        )

        let result = await model.createMeeting()
        XCTAssertNil(result)
        XCTAssertEqual(model.presentedIssue?.title, "Could not start the meeting")
        XCTAssertEqual(model.presentedIssue?.message, "Could not reach the server.")
    }
}

private actor RoomCreatorSpy: RoomCreating {
    struct Request: Equatable, Sendable {
        let roomID: String
        let lobby: Bool
    }

    let response: CreateRoomResponse
    let failure: Error?
    private let suspended: Bool
    private var requests: [Request] = []
    private var continuation: CheckedContinuation<Void, Never>?

    init(response: CreateRoomResponse, suspended: Bool = false, failure: Error? = nil) {
        self.response = response
        self.suspended = suspended
        self.failure = failure
    }

    var lastRequest: Request? { requests.last }
    var callCount: Int { requests.count }

    func createRoom(roomID: String, lobby: Bool) async throws -> CreateRoomResponse {
        requests.append(Request(roomID: roomID, lobby: lobby))
        if suspended {
            await withCheckedContinuation { continuation = $0 }
        }
        if let failure { throw failure }
        return response
    }

    func release() {
        continuation?.resume()
        continuation = nil
    }
}

private final class CredentialStoreSpy: CredentialStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var displayName = ""
    private var hostKeys: [String: String] = [:]

    func loadDisplayName() -> String {
        lock.withLock { displayName }
    }

    func saveDisplayName(_ value: String) {
        lock.withLock { displayName = value }
    }

    func loadHostKey(roomID: String) -> String? {
        hostKey(roomID: roomID)
    }

    func saveHostKey(_ value: String, roomID: String) throws {
        lock.withLock { hostKeys[roomID] = value }
    }

    func hostKey(roomID: String) -> String? {
        lock.withLock { hostKeys[roomID] }
    }
}
