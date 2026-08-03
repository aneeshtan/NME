import Foundation
import LiveKit
import XCTest
@testable import NME

@MainActor
final class MeetingSessionTests: XCTestCase {
    func testDirectJoinTransitionsToConnected() async throws {
        let fixture = try Fixture()
        let API = FakeMeetingAPI(joinResults: [.credentials(fixture.direct)])
        let engine = FakeMeetingEngine(outcomes: [.success(())])
        let session = makeSession(API: API, engine: engine)

        await session.join(identity: fixture.identity, displayName: "Guest", cameraEnabled: true)

        XCTAssertEqual(session.state, .connected(relayed: false))
        XCTAssertEqual(engine.requests.map(\.credentials.token), ["direct-token"])
        XCTAssertEqual(engine.requests.map(\.relayed), [false])
        XCTAssertTrue(session.microphoneEnabled)
        XCTAssertTrue(session.cameraEnabled)
    }

    func testLobbyPollsUntilAdmission() async throws {
        let fixture = try Fixture()
        let API = FakeMeetingAPI(
            joinResults: [.waiting(knockID: "knock-1")],
            claimResults: [.waiting, .admitted(fixture.direct)]
        )
        let engine = FakeMeetingEngine(outcomes: [.success(())])
        let sleeper = SleepRecorder()
        let session = makeSession(API: API, engine: engine, clock: sleeper.clock)

        await session.join(identity: fixture.identity, displayName: "Guest", cameraEnabled: false)

        XCTAssertEqual(session.state, .connected(relayed: false))
        let claimCount = await API.claimCount
        XCTAssertEqual(claimCount, 2)
        XCTAssertEqual(sleeper.count, 2)
        XCTAssertFalse(session.cameraEnabled)
    }

    func testLobbyDenialNeverStartsMediaEngine() async throws {
        let fixture = try Fixture()
        let API = FakeMeetingAPI(
            joinResults: [.waiting(knockID: "knock-1")],
            claimResults: [.denied]
        )
        let engine = FakeMeetingEngine()
        let session = makeSession(API: API, engine: engine)

        await session.join(identity: fixture.identity, displayName: "Guest", cameraEnabled: false)

        XCTAssertEqual(session.state, .failed(.denied))
        XCTAssertTrue(engine.requests.isEmpty)
    }

    func testLobbyTimesOutAfterConfiguredFiveMinuteBudget() async throws {
        let fixture = try Fixture()
        let API = FakeMeetingAPI(
            joinResults: [.waiting(knockID: "knock-1")],
            claimResults: [.waiting, .waiting, .waiting]
        )
        let engine = FakeMeetingEngine()
        let timing = MeetingTiming(pollInterval: .seconds(2), maximumPollAttempts: 3)
        let session = makeSession(API: API, engine: engine, timing: timing)

        await session.join(identity: fixture.identity, displayName: "Guest", cameraEnabled: false)

        XCTAssertEqual(session.state, .failed(.noAnswer))
        let claimCount = await API.claimCount
        XCTAssertEqual(claimCount, 3)
        XCTAssertEqual(MeetingTiming.live.maximumWait, .seconds(300))
    }

    func testDirectMediaFailureRequestsFreshRelayCredentials() async throws {
        let fixture = try Fixture()
        let API = FakeMeetingAPI(joinResults: [
            .credentials(fixture.direct),
            .credentials(fixture.relay),
        ])
        let engine = FakeMeetingEngine(outcomes: [
            .failure(.mediaPath),
            .success(()),
        ])
        let session = makeSession(API: API, engine: engine)

        await session.join(identity: fixture.identity, displayName: "Guest", cameraEnabled: true)

        let relayFlags = await API.joinRelayFlags
        XCTAssertEqual(relayFlags, [false, true])
        XCTAssertEqual(engine.requests.map(\.credentials.token), ["direct-token", "relay-token"])
        XCTAssertEqual(engine.disconnectCount, 1)
        XCTAssertEqual(session.state, .connected(relayed: true))
    }

    func testMissingRelayCredentialsProducesDistinctFailure() async throws {
        let fixture = try Fixture()
        let noRelay = JoinCredentials(
            token: "relay-token",
            url: fixture.direct.url,
            identity: "p-relay",
            displayName: "Guest",
            iceServers: nil
        )
        let API = FakeMeetingAPI(joinResults: [
            .credentials(fixture.direct),
            .credentials(noRelay),
        ])
        let engine = FakeMeetingEngine(outcomes: [.failure(.mediaPath)])
        let session = makeSession(API: API, engine: engine)

        await session.join(identity: fixture.identity, displayName: "Guest", cameraEnabled: false)

        XCTAssertEqual(session.state, .failed(.relayUnavailable))
        XCTAssertEqual(engine.requests.count, 1)
    }

    func testNonMediaFailureDoesNotRequestRelay() async throws {
        let fixture = try Fixture()
        let API = FakeMeetingAPI(joinResults: [.credentials(fixture.direct)])
        let engine = FakeMeetingEngine(outcomes: [.failure(.tokenRejected)])
        let session = makeSession(API: API, engine: engine)

        await session.join(identity: fixture.identity, displayName: "Guest", cameraEnabled: false)

        let relayFlags = await API.joinRelayFlags
        XCTAssertEqual(relayFlags, [false])
        XCTAssertEqual(session.state, .failed(.tokenRejected))
    }

    func testEngineReconnectionEventsPreserveRelayMode() async throws {
        let fixture = try Fixture()
        let API = FakeMeetingAPI(joinResults: [.credentials(fixture.direct)])
        let engine = FakeMeetingEngine(outcomes: [.success(())])
        let session = makeSession(API: API, engine: engine)
        await session.join(identity: fixture.identity, displayName: "Guest", cameraEnabled: false)

        engine.emit(.reconnecting)
        XCTAssertEqual(session.state, .reconnecting(relayed: false))

        engine.emit(.reconnected)
        XCTAssertEqual(session.state, .connected(relayed: false))
    }

    func testEngineReportsActualLocalMediaAfterPermissionOutcome() async throws {
        let fixture = try Fixture()
        let API = FakeMeetingAPI(joinResults: [.credentials(fixture.direct)])
        let engine = FakeMeetingEngine(outcomes: [.success(())])
        let session = makeSession(API: API, engine: engine)
        await session.join(identity: fixture.identity, displayName: "Guest", cameraEnabled: true)

        engine.emit(.localMedia(microphoneEnabled: false, cameraEnabled: true))

        XCTAssertFalse(session.microphoneEnabled)
        XCTAssertTrue(session.cameraEnabled)
        XCTAssertEqual(session.state, .connected(relayed: false))
    }

    func testTerminalDisconnectTearsDownMediaAndEphemeralState() async throws {
        let fixture = try Fixture()
        let API = FakeMeetingAPI(joinResults: [.credentials(fixture.direct)])
        let engine = FakeMeetingEngine(outcomes: [.success(())])
        let session = makeSession(API: API, engine: engine)
        await session.join(identity: fixture.identity, displayName: "Guest", cameraEnabled: true)

        engine.emit(.disconnected(.connection))
        await Task.yield()

        XCTAssertEqual(session.state, .failed(.connection))
        XCTAssertEqual(engine.disconnectCount, 1)
        XCTAssertTrue(session.participants.isEmpty)
        XCTAssertFalse(session.microphoneEnabled)
        XCTAssertFalse(session.cameraEnabled)
    }

    func testConnectedParticipantCanListAndResolveLobbyKnocks() async throws {
        let fixture = try Fixture()
        let knock = PendingKnock(id: "knock-1", displayName: "Jordan", createdAt: 42)
        let API = FakeMeetingAPI(
            joinResults: [.credentials(fixture.direct)],
            pendingKnocks: [knock]
        )
        let engine = FakeMeetingEngine(outcomes: [.success(())])
        let session = makeSession(API: API, engine: engine)
        await session.join(identity: fixture.identity, displayName: "Host", cameraEnabled: false)

        try await session.refreshPendingKnocks()

        XCTAssertEqual(session.pendingKnocks, [knock])
        let listRequests = await API.listRequests
        XCTAssertEqual(
            listRequests,
            [.init(
                roomID: fixture.identity.roomID,
                hostKey: nil,
                participantIdentity: fixture.direct.identity
            )]
        )

        try await session.resolveKnock(id: knock.id, admit: true)

        XCTAssertTrue(session.pendingKnocks.isEmpty)
        let resolveRequests = await API.resolveRequests
        XCTAssertEqual(
            resolveRequests,
            [.init(
                roomID: fixture.identity.roomID,
                knockID: knock.id,
                admit: true,
                hostKey: nil,
                participantIdentity: fixture.direct.identity
            )]
        )
    }

    func testLeaveDisconnectsAndClearsEphemeralState() async throws {
        let fixture = try Fixture()
        let API = FakeMeetingAPI(joinResults: [.credentials(fixture.direct)])
        let engine = FakeMeetingEngine(outcomes: [.success(())])
        let session = makeSession(API: API, engine: engine)
        await session.join(identity: fixture.identity, displayName: "Guest", cameraEnabled: true)
        engine.emit(.participants([
            ParticipantSnapshot(
                identity: "p-1",
                displayName: "Guest",
                isLocal: true,
                isSpeaking: false,
                isMicrophoneMuted: false,
                isCameraEnabled: true,
                videoTrackID: "camera"
            ),
        ]))

        await session.leave()

        XCTAssertEqual(session.state, .ended)
        XCTAssertEqual(engine.disconnectCount, 1)
        XCTAssertTrue(session.participants.isEmpty)
        XCTAssertFalse(session.microphoneEnabled)
        XCTAssertFalse(session.cameraEnabled)
        XCTAssertEqual(session.unreadCount, 0)
    }

    func testLeaveInvalidatesLateJoinResponse() async throws {
        let fixture = try Fixture()
        let API = FakeMeetingAPI(joinResults: [.credentials(fixture.direct)], suspendJoin: true)
        let engine = FakeMeetingEngine(outcomes: [.success(())])
        let session = makeSession(API: API, engine: engine)

        let joinTask = Task {
            await session.join(identity: fixture.identity, displayName: "Guest", cameraEnabled: false)
        }
        for _ in 0 ..< 20 where await API.joinCallCount == 0 {
            await Task.yield()
        }

        await session.leave()
        await API.releaseJoin()
        await joinTask.value

        XCTAssertEqual(session.state, .ended)
        XCTAssertTrue(engine.requests.isEmpty)
    }

    private func makeSession(
        API: FakeMeetingAPI,
        engine: FakeMeetingEngine,
        clock: MeetingClock = .immediate,
        timing: MeetingTiming = .live
    ) -> MeetingSession {
        MeetingSession(
            API: API,
            engine: engine,
            credentials: SessionCredentialStore(),
            clock: clock,
            timing: timing
        )
    }
}

private struct Fixture {
    let identity: RoomIdentity
    let direct: JoinCredentials
    let relay: JoinCredentials

    init() throws {
        identity = try RoomIdentity(
            encodedKey: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
        )
        direct = JoinCredentials(
            token: "direct-token",
            url: "wss://sfu.nmetalk.com",
            identity: "p-direct",
            displayName: "Guest",
            iceServers: nil
        )
        relay = JoinCredentials(
            token: "relay-token",
            url: "wss://sfu.nmetalk.com",
            identity: "p-relay",
            displayName: "Guest",
            iceServers: [
                IceServerConfiguration(
                    urls: ["turns:turn.nmetalk.com:443?transport=tcp"],
                    username: "u",
                    credential: "c"
                ),
            ]
        )
    }
}

private actor FakeMeetingAPI: MeetingAPI {
    struct ListRequest: Equatable, Sendable {
        let roomID: String
        let hostKey: String?
        let participantIdentity: String?
    }

    struct ResolveRequest: Equatable, Sendable {
        let roomID: String
        let knockID: String
        let admit: Bool
        let hostKey: String?
        let participantIdentity: String?
    }

    private let configurationValue = ClientConfiguration(
        livekitUrl: "wss://sfu.nmetalk.com",
        maxParticipants: 12,
        videoCodec: .vp8
    )
    private var joinResults: [JoinResult]
    private var claimResults: [AdmissionResult]
    private let suspendJoin: Bool
    private var joinContinuation: CheckedContinuation<Void, Never>?
    private var relayFlags: [Bool] = []
    private var claims = 0
    private var knocks: [PendingKnock]
    private var knockLists: [ListRequest] = []
    private var knockResolutions: [ResolveRequest] = []

    init(
        joinResults: [JoinResult],
        claimResults: [AdmissionResult] = [],
        suspendJoin: Bool = false,
        pendingKnocks: [PendingKnock] = []
    ) {
        self.joinResults = joinResults
        self.claimResults = claimResults
        self.suspendJoin = suspendJoin
        knocks = pendingKnocks
    }

    var joinRelayFlags: [Bool] { relayFlags }
    var joinCallCount: Int { relayFlags.count }
    var claimCount: Int { claims }
    var listRequests: [ListRequest] { knockLists }
    var resolveRequests: [ResolveRequest] { knockResolutions }

    func configuration() async throws -> ClientConfiguration { configurationValue }

    func join(
        roomID _: String,
        displayName _: String,
        hostKey _: String?,
        relay: Bool
    ) async throws -> JoinResult {
        relayFlags.append(relay)
        if suspendJoin {
            await withCheckedContinuation { joinContinuation = $0 }
        }
        guard !joinResults.isEmpty else {
            throw APIError(code: "EMPTY_FAKE", message: "Missing fake join result.", status: 0)
        }
        return joinResults.removeFirst()
    }

    func claim(roomID _: String, knockID _: String, relay _: Bool) async throws -> AdmissionResult {
        claims += 1
        return claimResults.isEmpty ? .waiting : claimResults.removeFirst()
    }

    func listKnocks(
        roomID: String,
        hostKey: String?,
        participantIdentity: String?
    ) async throws -> [PendingKnock] {
        knockLists.append(.init(
            roomID: roomID,
            hostKey: hostKey,
            participantIdentity: participantIdentity
        ))
        return knocks
    }

    func resolveKnock(
        roomID: String,
        knockID: String,
        admit: Bool,
        hostKey: String?,
        participantIdentity: String?
    ) async throws -> String {
        knockResolutions.append(.init(
            roomID: roomID,
            knockID: knockID,
            admit: admit,
            hostKey: hostKey,
            participantIdentity: participantIdentity
        ))
        knocks.removeAll { $0.id == knockID }
        return admit ? "admitted" : "denied"
    }

    func releaseJoin() {
        joinContinuation?.resume()
        joinContinuation = nil
    }
}

@MainActor
private final class FakeMeetingEngine: MeetingEngine {
    private var outcomes: [Result<Void, MeetingEngineError>]
    private var handler: (@MainActor @Sendable (MeetingEngineEvent) -> Void)?
    private(set) var requests: [MeetingConnectionRequest] = []
    private(set) var disconnectCount = 0

    init(outcomes: [Result<Void, MeetingEngineError>] = []) {
        self.outcomes = outcomes
    }

    func setEventHandler(
        _ handler: (@MainActor @Sendable (MeetingEngineEvent) -> Void)?
    ) {
        self.handler = handler
    }

    func connect(_ request: MeetingConnectionRequest) async throws {
        requests.append(request)
        guard !outcomes.isEmpty else { return }
        try outcomes.removeFirst().get()
    }

    func disconnect() async {
        disconnectCount += 1
    }

    func setMicrophone(enabled _: Bool) async throws {}
    func setCamera(enabled _: Bool) async throws {}
    func flipCamera() async throws {}
    func publishData(_: Data) async throws {}
    func blockParticipant(identity _: String) async {}
    func videoTrack(for _: String) -> VideoTrack? { nil }

    func emit(_ event: MeetingEngineEvent) {
        handler?(event)
    }
}

private final class SleepRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var sleeps = 0

    var count: Int { lock.withLock { sleeps } }

    var clock: MeetingClock {
        MeetingClock { [weak self] _ in
            self?.lock.withLock { self?.sleeps += 1 }
        }
    }
}

private struct SessionCredentialStore: CredentialStoring {
    func loadDisplayName() -> String { "" }
    func saveDisplayName(_: String) {}
    func loadHostKey(roomID _: String) -> String? { nil }
    func saveHostKey(_: String, roomID _: String) throws {}
}
