import Combine
import Foundation
import LiveKit

struct PresentedChatMessage: Identifiable, Equatable, Sendable {
    let id: UUID
    let at: Int64
    let text: String
    let senderName: String
    let isLocal: Bool
}

struct MeetingControlIssue: Identifiable, Equatable, Sendable {
    let id = UUID()
    let message: String
}

@MainActor
final class MeetingViewModel: ObservableObject {
    @Published var composerText = "" {
        didSet {
            if composerText.count > 2_000 {
                composerText = String(composerText.prefix(2_000))
            }
        }
    }
    @Published private(set) var messages: [PresentedChatMessage] = []
    @Published private(set) var unreadCount = 0
    @Published private(set) var isChatPresented = false
    @Published private(set) var controlIssue: MeetingControlIssue?
    @Published private var blockedIdentities: Set<String> = []
    @Published private var controlsInFlight: Set<Control> = []

    let identity: RoomIdentity
    let displayName: String
    let initialCameraEnabled: Bool
    let session: any MeetingSessionProtocol

    private let cipher: MessageCipher
    private let nowMilliseconds: @MainActor () -> Int64
    private var subscriptions = Set<AnyCancellable>()
    private var hasStarted = false

    init(
        identity: RoomIdentity,
        displayName: String,
        initialCameraEnabled: Bool,
        session: any MeetingSessionProtocol,
        nowMilliseconds: @escaping @MainActor () -> Int64 = {
            Int64(Date().timeIntervalSince1970 * 1_000)
        }
    ) {
        self.identity = identity
        self.displayName = displayName
        self.initialCameraEnabled = initialCameraEnabled
        self.session = session
        self.nowMilliseconds = nowMilliseconds
        cipher = MessageCipher(roomKey: identity.rawKey)

        session.changes
            .receive(on: DispatchQueue.main)
            .sink { [weak self] in self?.objectWillChange.send() }
            .store(in: &subscriptions)

        session.setDataHandler { [weak self] data, senderIdentity in
            self?.receive(data, senderIdentity: senderIdentity)
        }
    }

    var state: MeetingState { session.state }
    var microphoneEnabled: Bool { session.microphoneEnabled }
    var cameraEnabled: Bool { session.cameraEnabled }
    var isMicrophoneBusy: Bool { controlsInFlight.contains(.microphone) }
    var isCameraBusy: Bool { controlsInFlight.contains(.camera) }
    var isFlipBusy: Bool { controlsInFlight.contains(.flip) }

    var orderedParticipants: [ParticipantSnapshot] {
        session.participants
            .filter { $0.isLocal || !blockedIdentities.contains($0.identity) }
            .sorted {
                if $0.isLocal != $1.isLocal { return $0.isLocal }
                let comparison = $0.displayName.localizedCaseInsensitiveCompare($1.displayName)
                if comparison != .orderedSame { return comparison == .orderedAscending }
                return $0.identity < $1.identity
            }
    }

    var featuredParticipant: ParticipantSnapshot? {
        guard orderedParticipants.count > 6 else { return nil }
        return orderedParticipants.first(where: { $0.isSpeaking && !$0.isLocal })
            ?? orderedParticipants.first(where: \.isSpeaking)
            ?? orderedParticipants.first(where: { !$0.isLocal })
            ?? orderedParticipants.first
    }

    var gridParticipants: [ParticipantSnapshot] {
        guard let featuredParticipant else { return orderedParticipants }
        return orderedParticipants.filter { $0.identity != featuredParticipant.identity }
    }

    var gridColumnCount: Int {
        orderedParticipants.count <= 1 ? 1 : 2
    }

    var statusTitle: String {
        switch state {
        case .idle, .preparing: "Preparing encrypted meeting"
        case .waitingForAdmission: "Waiting for the host"
        case .connectingDirect: "Connecting securely"
        case .connectingRelay: "Trying a protected relay"
        case .connected: "End-to-end encrypted"
        case .reconnecting: "Reconnecting"
        case .failed: "Could not join the meeting"
        case .ended: "Meeting ended"
        }
    }

    var isRelayed: Bool {
        switch state {
        case let .connected(relayed), let .reconnecting(relayed): relayed
        default: false
        }
    }

    func start() async {
        guard !hasStarted else { return }
        hasStarted = true
        await session.join(
            identity: identity,
            displayName: displayName,
            cameraEnabled: initialCameraEnabled
        )
    }

    func shouldMirror(participantIdentity: String) -> Bool {
        orderedParticipants.first(where: { $0.identity == participantIdentity })?.isLocal == true
    }

    func videoTrack(for participant: ParticipantSnapshot) -> VideoTrack? {
        guard let identifier = participant.videoTrackID else { return nil }
        return session.videoTrack(for: identifier)
    }

    func accessibilityLabel(for participant: ParticipantSnapshot) -> String {
        let local = participant.isLocal ? ", you" : ""
        let microphone = participant.isMicrophoneMuted ? "microphone muted" : "microphone on"
        let camera = participant.isCameraEnabled ? "camera on" : "camera off"
        return "\(participant.displayName)\(local), \(microphone), \(camera)"
    }

    func setChatPresented(_ presented: Bool) {
        isChatPresented = presented
        if presented { unreadCount = 0 }
    }

    func dismissControlIssue() {
        controlIssue = nil
    }

    func toggleMicrophone() async {
        guard !controlsInFlight.contains(.microphone) else { return }
        controlsInFlight.insert(.microphone)
        defer { controlsInFlight.remove(.microphone) }
        do {
            try await session.setMicrophone(enabled: !session.microphoneEnabled)
        } catch {
            controlIssue = MeetingControlIssue(
                message: "The microphone could not be changed. Check permission and try again."
            )
        }
    }

    func toggleCamera() async {
        guard !controlsInFlight.contains(.camera) else { return }
        controlsInFlight.insert(.camera)
        defer { controlsInFlight.remove(.camera) }
        do {
            try await session.setCamera(enabled: !session.cameraEnabled)
        } catch {
            controlIssue = MeetingControlIssue(
                message: "The camera could not be changed. Check permission and try again."
            )
        }
    }

    func flipCamera() async {
        guard cameraEnabled, !controlsInFlight.contains(.flip) else { return }
        controlsInFlight.insert(.flip)
        defer { controlsInFlight.remove(.flip) }
        do {
            try await session.flipCamera()
        } catch {
            controlIssue = MeetingControlIssue(message: "The camera could not be flipped.")
        }
    }

    func sendMessage() async {
        do {
            let message = try ChatMessage(
                at: nowMilliseconds(),
                text: composerText
            ).validated()
            let envelope = try cipher.seal(message)
            try await session.publishData(envelope)
            append(message, senderName: displayName, isLocal: true)
            composerText = ""
        } catch {
            controlIssue = MeetingControlIssue(
                message: "The encrypted message could not be sent."
            )
        }
    }

    func block(participantIdentity: String, report: Bool) async -> URL? {
        guard let participant = session.participants.first(where: {
            $0.identity == participantIdentity && !$0.isLocal
        }) else { return nil }

        blockedIdentities.insert(participantIdentity)
        await session.blockParticipant(identity: participantIdentity)
        return report ? reportURL(for: participant) : nil
    }

    func leave() async {
        session.setDataHandler(nil)
        await session.leave()
        messages.removeAll()
        unreadCount = 0
        isChatPresented = false
        blockedIdentities.removeAll()
    }

    private func receive(_ data: Data, senderIdentity: String?) {
        guard let message = try? cipher.open(data) else { return }
        let senderName = senderIdentity.flatMap { identity in
            session.participants.first(where: { $0.identity == identity })?.displayName
        } ?? "Participant"
        append(message, senderName: senderName, isLocal: false)
        if !isChatPresented { unreadCount += 1 }
    }

    private func append(_ message: ChatMessage, senderName: String, isLocal: Bool) {
        messages.append(PresentedChatMessage(
            id: UUID(),
            at: message.at,
            text: message.text,
            senderName: senderName,
            isLocal: isLocal
        ))
        if messages.count > 300 {
            messages.removeFirst(messages.count - 300)
        }
    }

    private func reportURL(for participant: ParticipantSnapshot) -> URL? {
        let date = Date(timeIntervalSince1970: Double(nowMilliseconds()) / 1_000)
        let timestamp = ISO8601DateFormatter().string(from: date)
        let body = """
        I want to report a participant in NME Talk.

        Room ID: \(identity.roomID)
        Participant name: \(participant.displayName)
        Time: \(timestamp)

        Please add any relevant context here. Do not include the meeting link or private messages.
        """
        var components = URLComponents()
        components.scheme = "mailto"
        components.path = "support@nmetalk.com"
        components.queryItems = [
            URLQueryItem(name: "subject", value: "NME Talk participant report"),
            URLQueryItem(name: "body", value: body),
        ]
        return components.url
    }
}

private extension MeetingViewModel {
    enum Control: Hashable {
        case microphone
        case camera
        case flip
    }
}
