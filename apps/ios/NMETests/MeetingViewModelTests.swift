import Combine
import Foundation
import LiveKit
import XCTest
@testable import NME

@MainActor
final class MeetingViewModelTests: XCTestCase {
    private let encodedKey = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"

    func testTileOrderingColumnsMirroringAndLargeRoomSpeakerFeature() throws {
        let session = FakePresentationSession()
        let viewModel = try makeViewModel(session: session)
        session.updateParticipants([
            participant("z-local", "You", local: true, speaking: false, muted: true),
            participant("c", "Charlie"),
            participant("a", "Alpha"),
            participant("b", "Bravo"),
        ])

        XCTAssertEqual(viewModel.gridColumnCount, 2)
        XCTAssertEqual(viewModel.orderedParticipants.map(\.identity), ["z-local", "a", "b", "c"])
        XCTAssertTrue(viewModel.shouldMirror(participantIdentity: "z-local"))
        XCTAssertEqual(
            viewModel.accessibilityLabel(for: session.participants[0]),
            "You, you, microphone muted, camera off"
        )

        session.updateParticipants([
            participant("local", "You", local: true),
            participant("a", "Alpha"),
            participant("b", "Bravo"),
            participant("c", "Charlie", speaking: true),
            participant("d", "Delta"),
            participant("e", "Echo"),
            participant("f", "Foxtrot"),
        ])

        XCTAssertEqual(viewModel.featuredParticipant?.identity, "c")
        XCTAssertFalse(viewModel.gridParticipants.contains { $0.identity == "c" })
        XCTAssertEqual(viewModel.gridParticipants.first?.identity, "local")
    }

    func testEncryptedChatUnreadAndRetentionAreEphemeral() throws {
        let session = FakePresentationSession()
        let viewModel = try makeViewModel(session: session)
        let cipher = MessageCipher(roomKey: try RoomIdentity(encodedKey: encodedKey).rawKey)

        session.emitData(
            try cipher.seal(ChatMessage(at: 1, text: "First")),
            senderIdentity: "remote"
        )
        XCTAssertEqual(viewModel.messages.map(\.text), ["First"])
        XCTAssertEqual(viewModel.unreadCount, 1)

        viewModel.setChatPresented(true)
        XCTAssertEqual(viewModel.unreadCount, 0)
        session.emitData(
            try cipher.seal(ChatMessage(at: 2, text: "Visible")),
            senderIdentity: "remote"
        )
        XCTAssertEqual(viewModel.unreadCount, 0)

        viewModel.setChatPresented(false)
        for index in 3 ... 305 {
            session.emitData(
                try cipher.seal(ChatMessage(at: Int64(index), text: "Message \(index)")),
                senderIdentity: "remote"
            )
        }

        XCTAssertEqual(viewModel.messages.count, 300)
        XCTAssertEqual(viewModel.messages.first?.text, "Message 6")
        XCTAssertEqual(viewModel.messages.last?.text, "Message 305")
        XCTAssertEqual(viewModel.unreadCount, 303)
    }

    func testSendingChatPublishesReliableEncryptedEnvelopeAndAppendsLocalMessage() async throws {
        let session = FakePresentationSession()
        let viewModel = try makeViewModel(session: session)
        viewModel.composerText = "  Hello from iPhone  "

        await viewModel.sendMessage()

        let envelope = try XCTUnwrap(session.publishedData.first)
        let identity = try RoomIdentity(encodedKey: encodedKey)
        XCTAssertEqual(try MessageCipher(roomKey: identity.rawKey).open(envelope).text, "Hello from iPhone")
        XCTAssertEqual(viewModel.messages.last?.text, "Hello from iPhone")
        XCTAssertEqual(viewModel.messages.last?.isLocal, true)
        XCTAssertTrue(viewModel.composerText.isEmpty)
    }

    func testBlockUnsubscribesAndReportDraftNeverContainsSecrets() async throws {
        let session = FakePresentationSession()
        let viewModel = try makeViewModel(session: session)
        session.updateParticipants([
            participant("local", "You", local: true),
            participant("remote", "Troublemaker"),
        ])

        let report = await viewModel.block(participantIdentity: "remote", report: true)

        XCTAssertEqual(session.blockedIdentities, ["remote"])
        XCTAssertFalse(viewModel.orderedParticipants.contains { $0.identity == "remote" })
        let reportURL = try XCTUnwrap(report)
        let decoded = reportURL.absoluteString.removingPercentEncoding ?? reportURL.absoluteString
        XCTAssertTrue(decoded.contains("gqwm-kmxk-yvzm"))
        XCTAssertTrue(decoded.contains("Troublemaker"))
        XCTAssertFalse(decoded.contains(encodedKey))
        XCTAssertFalse(decoded.localizedCaseInsensitiveContains("host key"))
        XCTAssertFalse(decoded.localizedCaseInsensitiveContains("token"))
    }

    func testToggleFailureRollsBackAndLeaveClearsEphemeralState() async throws {
        let session = FakePresentationSession()
        session.microphoneEnabled = true
        session.cameraEnabled = true
        session.microphoneResult = .failure(.connection)
        let viewModel = try makeViewModel(session: session)
        let cipher = MessageCipher(roomKey: try RoomIdentity(encodedKey: encodedKey).rawKey)
        session.emitData(
            try cipher.seal(ChatMessage(at: 1, text: "Temporary")),
            senderIdentity: "remote"
        )

        await viewModel.toggleMicrophone()

        XCTAssertTrue(session.microphoneEnabled)
        XCTAssertNotNil(viewModel.controlIssue)

        await viewModel.leave()

        XCTAssertEqual(session.leaveCount, 1)
        XCTAssertTrue(viewModel.messages.isEmpty)
        XCTAssertEqual(viewModel.unreadCount, 0)
        XCTAssertFalse(viewModel.isChatPresented)
    }

    func testLeaveIsIdempotentForToolbarAndViewDisappearance() async throws {
        let session = FakePresentationSession()
        let viewModel = try makeViewModel(session: session)

        await viewModel.leave()
        await viewModel.leave()

        XCTAssertEqual(session.leaveCount, 1)
    }

    func testLobbyRequestsArePresentedAndResolutionIsForwarded() async throws {
        let session = FakePresentationSession()
        session.pendingKnocks = [
            PendingKnock(id: "later", displayName: "Taylor", createdAt: 20),
            PendingKnock(id: "first", displayName: "Jordan", createdAt: 10),
        ]
        let viewModel = try makeViewModel(session: session)

        XCTAssertEqual(viewModel.pendingKnocks.map(\.displayName), ["Taylor", "Jordan"])

        await viewModel.resolveLobbyRequest(id: "first", admit: true)

        XCTAssertEqual(session.lobbyResolutions, [.init(id: "first", admit: true)])
        XCTAssertEqual(viewModel.pendingKnocks.map(\.id), ["later"])
    }

    private func makeViewModel(session: FakePresentationSession) throws -> MeetingViewModel {
        MeetingViewModel(
            identity: try RoomIdentity(encodedKey: encodedKey),
            displayName: "You",
            initialCameraEnabled: true,
            session: session,
            nowMilliseconds: { 1_786_000_000_000 }
        )
    }

    private func participant(
        _ identity: String,
        _ name: String,
        local: Bool = false,
        speaking: Bool = false,
        muted: Bool = false,
        camera: Bool = false
    ) -> ParticipantSnapshot {
        ParticipantSnapshot(
            identity: identity,
            displayName: name,
            isLocal: local,
            isSpeaking: speaking,
            isMicrophoneMuted: muted,
            isCameraEnabled: camera,
            videoTrackID: camera ? "track-\(identity)" : nil
        )
    }
}

@MainActor
private final class FakePresentationSession: MeetingSessionProtocol {
    struct LobbyResolution: Equatable {
        let id: String
        let admit: Bool
    }

    var state: MeetingState = .connected(relayed: false)
    var participants: [ParticipantSnapshot] = []
    var pendingKnocks: [PendingKnock] = []
    var unreadCount = 0
    var microphoneEnabled = false
    var cameraEnabled = false
    private let changeSubject = PassthroughSubject<Void, Never>()
    var changes: AnyPublisher<Void, Never> { changeSubject.eraseToAnyPublisher() }

    var microphoneResult: Result<Void, MeetingEngineError> = .success(())
    var cameraResult: Result<Void, MeetingEngineError> = .success(())
    private var dataHandler: (@MainActor @Sendable (Data, String?) -> Void)?
    private(set) var publishedData: [Data] = []
    private(set) var blockedIdentities: [String] = []
    private(set) var leaveCount = 0
    private(set) var lobbyResolutions: [LobbyResolution] = []

    func join(identity _: RoomIdentity, displayName _: String, cameraEnabled _: Bool) async {}

    func leave() async {
        leaveCount += 1
        state = .ended
        changeSubject.send()
    }

    func setMicrophone(enabled: Bool) async throws {
        try microphoneResult.get()
        microphoneEnabled = enabled
        changeSubject.send()
    }

    func setCamera(enabled: Bool) async throws {
        try cameraResult.get()
        cameraEnabled = enabled
        changeSubject.send()
    }

    func flipCamera() async throws {}

    func publishData(_ data: Data) async throws {
        publishedData.append(data)
    }

    func blockParticipant(identity: String) async {
        blockedIdentities.append(identity)
    }

    func refreshPendingKnocks() async throws {}

    func resolveKnock(id: String, admit: Bool) async throws {
        lobbyResolutions.append(.init(id: id, admit: admit))
        pendingKnocks.removeAll { $0.id == id }
        changeSubject.send()
    }

    func videoTrack(for _: String) -> VideoTrack? { nil }

    func setDataHandler(
        _ handler: (@MainActor @Sendable (Data, String?) -> Void)?
    ) {
        dataHandler = handler
    }

    func updateParticipants(_ value: [ParticipantSnapshot]) {
        participants = value
        changeSubject.send()
    }

    func emitData(_ data: Data, senderIdentity: String?) {
        dataHandler?(data, senderIdentity)
    }
}
