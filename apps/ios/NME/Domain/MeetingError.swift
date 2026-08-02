import Foundation

struct APIError: Error, Equatable, Sendable {
    let code: String
    let message: String
    let status: Int
}

extension APIError: LocalizedError {
    var errorDescription: String? { message }
}

enum AppIssue: Equatable, Identifiable, Sendable {
    case invalidInvitation
    case roomCreationFailed(String)

    var id: String {
        switch self {
        case .invalidInvitation: "invalid_invitation"
        case .roomCreationFailed: "room_creation_failed"
        }
    }

    var title: String {
        switch self {
        case .invalidInvitation: "That link is not complete"
        case .roomCreationFailed: "Could not start the meeting"
        }
    }

    var message: String {
        switch self {
        case .invalidInvitation:
            "A meeting link must include its encryption key after the #. Ask the sender to share the complete link."
        case let .roomCreationFailed(message):
            message
        }
    }
}
