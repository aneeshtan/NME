import Foundation
import OSLog

struct AppLogger: Sendable {
    enum Event: String, Sendable {
        case appStarted = "app_started"
        case roomCreationFailed = "room_creation_failed"
        case joinFailed = "join_failed"
        case relayRetryStarted = "relay_retry_started"
        case meetingConnected = "meeting_connected"
        case meetingEnded = "meeting_ended"
        case mediaPermissionDenied = "media_permission_denied"
    }

    struct Metadata: Sendable {
        var participantCount: Int?
        var HTTPStatus: Int?
        var retryCount: Int?
        var relayed: Bool?

        init(
            participantCount: Int? = nil,
            HTTPStatus: Int? = nil,
            retryCount: Int? = nil,
            relayed: Bool? = nil
        ) {
            self.participantCount = participantCount
            self.HTTPStatus = HTTPStatus
            self.retryCount = retryCount
            self.relayed = relayed
        }
    }

    private let logger: Logger

    init(
        subsystem: String = Bundle.main.bundleIdentifier ?? "com.ctrlaltl.nme",
        category: String = "meeting"
    ) {
        logger = Logger(subsystem: subsystem, category: category)
    }

    func record(_ event: Event, metadata: Metadata = Metadata()) {
        let participantCount = metadata.participantCount ?? -1
        let HTTPStatus = metadata.HTTPStatus ?? -1
        let retryCount = metadata.retryCount ?? -1
        let relayed = metadata.relayed ?? false
        logger.info("event=\(event.rawValue, privacy: .public) participants=\(participantCount, privacy: .public) http_status=\(HTTPStatus, privacy: .public) retry=\(retryCount, privacy: .public) relayed=\(relayed, privacy: .public)")
    }
}
