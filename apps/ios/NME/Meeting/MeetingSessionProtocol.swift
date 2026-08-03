import Combine
import Foundation
import LiveKit

protocol MeetingAPI: Sendable {
    func configuration() async throws -> ClientConfiguration
    func join(
        roomID: String,
        displayName: String,
        hostKey: String?,
        relay: Bool
    ) async throws -> JoinResult
    func claim(roomID: String, knockID: String, relay: Bool) async throws -> AdmissionResult
    func listKnocks(
        roomID: String,
        hostKey: String?,
        participantIdentity: String?
    ) async throws -> [PendingKnock]
    func resolveKnock(
        roomID: String,
        knockID: String,
        admit: Bool,
        hostKey: String?,
        participantIdentity: String?
    ) async throws -> String
}

extension APIClient: MeetingAPI {}

@MainActor
protocol MeetingEngine: AnyObject {
    func setEventHandler(
        _ handler: (@MainActor @Sendable (MeetingEngineEvent) -> Void)?
    )
    func connect(_ request: MeetingConnectionRequest) async throws
    func disconnect() async
    func setMicrophone(enabled: Bool) async throws
    func setCamera(enabled: Bool) async throws
    func flipCamera() async throws
    func publishData(_ data: Data) async throws
    func blockParticipant(identity: String) async
    func videoTrack(for identifier: String) -> VideoTrack?
}

@MainActor
protocol MeetingSessionProtocol: AnyObject {
    var state: MeetingState { get }
    var participants: [ParticipantSnapshot] { get }
    var pendingKnocks: [PendingKnock] { get }
    var unreadCount: Int { get }
    var microphoneEnabled: Bool { get }
    var cameraEnabled: Bool { get }
    var changes: AnyPublisher<Void, Never> { get }

    func join(identity: RoomIdentity, displayName: String, cameraEnabled: Bool) async
    func leave() async
    func setMicrophone(enabled: Bool) async throws
    func setCamera(enabled: Bool) async throws
    func flipCamera() async throws
    func publishData(_ data: Data) async throws
    func blockParticipant(identity: String) async
    func refreshPendingKnocks() async throws
    func resolveKnock(id: String, admit: Bool) async throws
    func videoTrack(for identifier: String) -> VideoTrack?
    func setDataHandler(
        _ handler: (@MainActor @Sendable (Data, String?) -> Void)?
    )
}

struct MeetingClock: Sendable {
    private let sleepOperation: @Sendable (Duration) async throws -> Void

    init(_ sleepOperation: @escaping @Sendable (Duration) async throws -> Void) {
        self.sleepOperation = sleepOperation
    }

    func sleep(for duration: Duration) async throws {
        try await sleepOperation(duration)
    }

    static let live = MeetingClock { duration in
        try await ContinuousClock().sleep(for: duration)
    }

    static let immediate = MeetingClock { _ in
        await Task.yield()
    }
}

struct MeetingTiming: Equatable, Sendable {
    let pollInterval: Duration
    let maximumPollAttempts: Int

    var maximumWait: Duration {
        pollInterval * maximumPollAttempts
    }

    static let live = MeetingTiming(
        pollInterval: .seconds(2),
        maximumPollAttempts: 150
    )
}
