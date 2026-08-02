import Combine
import Foundation

@MainActor
final class MeetingSession: ObservableObject, MeetingSessionProtocol {
    @Published private(set) var state: MeetingState = .idle
    @Published private(set) var participants: [ParticipantSnapshot] = []
    @Published private(set) var unreadCount = 0
    @Published private(set) var microphoneEnabled = false
    @Published private(set) var cameraEnabled = false

    private let API: any MeetingAPI
    private let engine: any MeetingEngine
    private let credentials: any CredentialStoring
    private let clock: MeetingClock
    private let timing: MeetingTiming

    private var generation = UUID()
    private var currentRelayMode = false

    init(
        API: any MeetingAPI,
        engine: any MeetingEngine,
        credentials: any CredentialStoring,
        clock: MeetingClock = .live,
        timing: MeetingTiming = .live
    ) {
        self.API = API
        self.engine = engine
        self.credentials = credentials
        self.clock = clock
        self.timing = timing
    }

    func join(identity: RoomIdentity, displayName: String, cameraEnabled: Bool) async {
        switch state {
        case .idle, .failed, .ended:
            break
        default:
            return
        }

        let attempt = UUID()
        generation = attempt
        resetEphemeralState()
        state = .preparing

        let hostKey = credentials.loadHostKey(roomID: identity.roomID)

        do {
            async let configurationRequest = API.configuration()
            async let joinRequest = API.join(
                roomID: identity.roomID,
                displayName: displayName,
                hostKey: hostKey,
                relay: false
            )
            let (configuration, initialResult) = try await (
                configurationRequest,
                joinRequest
            )
            guard isCurrent(attempt) else { return }

            let directCredentials = try await resolveCredentials(
                initialResult,
                roomID: identity.roomID,
                relay: false,
                generation: attempt
            )
            guard isCurrent(attempt) else { return }

            state = .connectingDirect
            configureEvents(generation: attempt)
            microphoneEnabled = true
            self.cameraEnabled = cameraEnabled

            do {
                try await engine.connect(MeetingConnectionRequest(
                    roomIdentity: identity,
                    configuration: configuration,
                    credentials: directCredentials,
                    relayed: false,
                    microphoneEnabled: true,
                    cameraEnabled: cameraEnabled
                ))
            } catch MeetingEngineError.mediaPath {
                guard isCurrent(attempt) else { return }
                engine.setEventHandler(nil)
                await engine.disconnect()
                guard isCurrent(attempt) else { return }

                state = .connectingRelay
                let relayResult = try await API.join(
                    roomID: identity.roomID,
                    displayName: displayName,
                    hostKey: hostKey,
                    relay: true
                )
                guard isCurrent(attempt) else { return }
                let relayCredentials = try await resolveCredentials(
                    relayResult,
                    roomID: identity.roomID,
                    relay: true,
                    generation: attempt
                )
                guard let iceServers = relayCredentials.iceServers, !iceServers.isEmpty else {
                    throw LifecycleError.relayUnavailable
                }
                guard isCurrent(attempt) else { return }

                state = .connectingRelay
                configureEvents(generation: attempt)
                microphoneEnabled = true
                self.cameraEnabled = cameraEnabled
                try await engine.connect(MeetingConnectionRequest(
                    roomIdentity: identity,
                    configuration: configuration,
                    credentials: relayCredentials,
                    relayed: true,
                    microphoneEnabled: true,
                    cameraEnabled: cameraEnabled
                ))
                guard isCurrent(attempt) else { return }
                currentRelayMode = true
            }

            guard isCurrent(attempt) else { return }
            state = .connected(relayed: currentRelayMode)
        } catch is CancellationError {
            guard isCurrent(attempt) else { return }
            await cleanupEngine()
            guard isCurrent(attempt) else { return }
            state = .ended
        } catch {
            guard isCurrent(attempt) else { return }
            await cleanupEngine()
            guard isCurrent(attempt) else { return }
            state = .failed(Self.failure(for: error))
        }
    }

    func leave() async {
        generation = UUID()
        state = .ended
        await cleanupEngine()
        resetEphemeralState()
        state = .ended
    }

    private func resolveCredentials(
        _ result: JoinResult,
        roomID: String,
        relay: Bool,
        generation: UUID
    ) async throws -> JoinCredentials {
        switch result {
        case let .credentials(credentials):
            return credentials
        case let .waiting(knockID):
            state = .waitingForAdmission
            for _ in 0 ..< timing.maximumPollAttempts {
                try Task.checkCancellation()
                try await clock.sleep(for: timing.pollInterval)
                guard isCurrent(generation) else { throw CancellationError() }

                switch try await API.claim(
                    roomID: roomID,
                    knockID: knockID,
                    relay: relay
                ) {
                case .waiting:
                    continue
                case .denied:
                    throw LifecycleError.denied
                case let .admitted(credentials):
                    return credentials
                }
            }
            throw LifecycleError.noAnswer
        }
    }

    private func configureEvents(generation: UUID) {
        engine.setEventHandler { [weak self] event in
            guard let self, self.isCurrent(generation) else { return }
            self.handle(event)
        }
    }

    private func handle(_ event: MeetingEngineEvent) {
        switch event {
        case let .participants(participants):
            self.participants = participants
        case let .localMedia(microphoneEnabled, cameraEnabled):
            self.microphoneEnabled = microphoneEnabled
            self.cameraEnabled = cameraEnabled
        case .reconnecting:
            state = .reconnecting(relayed: currentRelayMode)
        case .reconnected:
            state = .connected(relayed: currentRelayMode)
        case let .disconnected(error):
            guard state != .ended else { return }
            state = .failed(error.map(Self.failure(for:)) ?? .connection)
        case .data:
            break
        }
    }

    private func cleanupEngine() async {
        engine.setEventHandler(nil)
        await engine.disconnect()
        participants = []
        microphoneEnabled = false
        cameraEnabled = false
        unreadCount = 0
        currentRelayMode = false
    }

    private func resetEphemeralState() {
        participants = []
        unreadCount = 0
        microphoneEnabled = false
        cameraEnabled = false
        currentRelayMode = false
    }

    private func isCurrent(_ value: UUID) -> Bool {
        generation == value
    }

    private static func failure(for error: Error) -> MeetingFailure {
        switch error {
        case LifecycleError.denied:
            .denied
        case LifecycleError.noAnswer:
            .noAnswer
        case LifecycleError.relayUnavailable:
            .relayUnavailable
        case MeetingEngineError.tokenRejected:
            .tokenRejected
        case MeetingEngineError.microphonePermissionDenied:
            .microphonePermissionDenied
        case MeetingEngineError.cameraPermissionDenied:
            .cameraPermissionDenied
        case let error as APIError:
            .API(code: error.code, message: error.message)
        default:
            .connection
        }
    }
}

private enum LifecycleError: Error {
    case denied
    case noAnswer
    case relayUnavailable
}
