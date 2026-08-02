import Foundation

enum VideoCodec: String, Codable, Sendable {
    case vp8
    case vp9
}

struct ClientConfiguration: Codable, Equatable, Sendable {
    let livekitUrl: String
    let maxParticipants: Int
    let videoCodec: VideoCodec
}

struct IceServerConfiguration: Codable, Equatable, Sendable {
    let urls: [String]
    let username: String?
    let credential: String?
}

struct JoinCredentials: Codable, Equatable, Sendable {
    let token: String
    let url: String
    let identity: String
    let displayName: String
    let iceServers: [IceServerConfiguration]?
}

enum JoinResult: Equatable, Sendable {
    case waiting(knockID: String)
    case credentials(JoinCredentials)
}

enum AdmissionResult: Equatable, Sendable {
    case waiting
    case denied
    case admitted(JoinCredentials)
}

struct PendingKnock: Codable, Equatable, Sendable {
    let id: String
    let displayName: String
    let createdAt: Int64
}

struct CreateRoomResponse: Codable, Equatable, Sendable {
    let roomId: String
    let hostKey: String?
}
