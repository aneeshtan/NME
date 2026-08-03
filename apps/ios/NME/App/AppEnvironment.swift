import Foundation
#if DEBUG
import Combine
import LiveKit
#endif

@MainActor
final class AppEnvironment {
    let coordinator: AppCoordinator
    let credentials: CredentialStore
    let API: APIClient

    init(
        coordinator: AppCoordinator = AppCoordinator(),
        credentials: CredentialStore = CredentialStore()
    ) {
        self.coordinator = coordinator
        self.credentials = credentials
        do {
            API = try APIClient(origin: AppConfiguration.origin)
        } catch {
            preconditionFailure("NMEOrigin must be an HTTPS URL")
        }

        if let invitation = ProcessInfo.processInfo.arguments
            .first(where: { $0.hasPrefix("--ui-testing-demo-meeting=") })?
            .split(separator: "=", maxSplits: 1)
            .last
        {
            coordinator.open(String(invitation))
            coordinator.join(displayName: "You", cameraEnabled: false)
        } else if let invitation = ProcessInfo.processInfo.arguments
            .first(where: { $0.hasPrefix("--ui-testing-invitation=") })?
            .split(separator: "=", maxSplits: 1)
            .last
        {
            coordinator.open(String(invitation))
        }
    }

    func makeHomeViewModel() -> HomeViewModel {
        HomeViewModel(api: API, credentials: credentials)
    }

    func makePreJoinViewModel(identity: RoomIdentity) -> PreJoinViewModel {
        PreJoinViewModel(identity: identity, credentials: credentials)
    }

    func makePreviewController() -> PreviewController {
        if ProcessInfo.processInfo.arguments.contains("--ui-testing") {
            return PreviewController(requestAuthorization: { false })
        }
        return PreviewController()
    }

    func makeMeetingViewModel(
        identity: RoomIdentity,
        displayName: String,
        cameraEnabled: Bool
    ) -> MeetingViewModel {
#if DEBUG
        if ProcessInfo.processInfo.arguments.contains(where: {
            $0.hasPrefix("--ui-testing-demo-meeting=")
        }) {
            return MeetingViewModel(
                identity: identity,
                displayName: displayName,
                initialCameraEnabled: cameraEnabled,
                session: UITestMeetingSession()
            )
        }
#endif
        let engine = LiveKitMeetingEngine()
        let session = MeetingSession(
            API: API,
            engine: engine,
            credentials: credentials
        )
        return MeetingViewModel(
            identity: identity,
            displayName: displayName,
            initialCameraEnabled: cameraEnabled,
            session: session
        )
    }
}

#if DEBUG
@MainActor
private final class UITestMeetingSession: MeetingSessionProtocol {
    private let changeSubject = PassthroughSubject<Void, Never>()
    private var dataHandler: (@MainActor @Sendable (Data, String?) -> Void)?

    private(set) var state: MeetingState = .connected(relayed: false)
    private(set) var participants: [ParticipantSnapshot] = [
        ParticipantSnapshot(
            identity: "ui-local",
            displayName: "You",
            isLocal: true,
            isSpeaking: false,
            isMicrophoneMuted: false,
            isCameraEnabled: false,
            videoTrackID: nil
        ),
        ParticipantSnapshot(
            identity: "ui-remote",
            displayName: "Alex",
            isLocal: false,
            isSpeaking: true,
            isMicrophoneMuted: true,
            isCameraEnabled: false,
            videoTrackID: nil
        ),
    ]
    private(set) var unreadCount = 0
    private(set) var pendingKnocks: [PendingKnock] = [
        PendingKnock(id: "ui-knock", displayName: "Jordan", createdAt: 1),
    ]
    private(set) var microphoneEnabled = true
    private(set) var cameraEnabled = false
    var changes: AnyPublisher<Void, Never> { changeSubject.eraseToAnyPublisher() }

    func join(identity _: RoomIdentity, displayName _: String, cameraEnabled _: Bool) async {
        state = .connected(relayed: false)
        changeSubject.send()
    }

    func leave() async {
        state = .ended
        participants.removeAll()
        changeSubject.send()
    }

    func setMicrophone(enabled: Bool) async throws {
        microphoneEnabled = enabled
        if let index = participants.firstIndex(where: \.isLocal) {
            let participant = participants[index]
            participants[index] = ParticipantSnapshot(
                identity: participant.identity,
                displayName: participant.displayName,
                isLocal: true,
                isSpeaking: participant.isSpeaking,
                isMicrophoneMuted: !enabled,
                isCameraEnabled: participant.isCameraEnabled,
                videoTrackID: participant.videoTrackID
            )
        }
        changeSubject.send()
    }

    func setCamera(enabled: Bool) async throws {
        cameraEnabled = enabled
        changeSubject.send()
    }

    func flipCamera() async throws {}
    func publishData(_: Data) async throws {}

    func blockParticipant(identity: String) async {
        participants.removeAll { $0.identity == identity && !$0.isLocal }
        changeSubject.send()
    }

    func refreshPendingKnocks() async throws {}

    func resolveKnock(id: String, admit _: Bool) async throws {
        pendingKnocks.removeAll { $0.id == id }
        changeSubject.send()
    }

    func videoTrack(for _: String) -> VideoTrack? { nil }

    func setDataHandler(
        _ handler: (@MainActor @Sendable (Data, String?) -> Void)?
    ) {
        dataHandler = handler
    }
}
#endif
