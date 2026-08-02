import Foundation

enum MeetingFailure: Equatable, Sendable {
    case denied
    case noAnswer
    case relayUnavailable
    case tokenRejected
    case microphonePermissionDenied
    case cameraPermissionDenied
    case API(code: String, message: String)
    case connection
}

enum MeetingState: Equatable, Sendable {
    case idle
    case preparing
    case waitingForAdmission
    case connectingDirect
    case connectingRelay
    case connected(relayed: Bool)
    case reconnecting(relayed: Bool)
    case failed(MeetingFailure)
    case ended
}

struct ParticipantSnapshot: Identifiable, Equatable, Sendable {
    var id: String { identity }

    let identity: String
    let displayName: String
    let isLocal: Bool
    let isSpeaking: Bool
    let isMicrophoneMuted: Bool
    let isCameraEnabled: Bool
    let videoTrackID: String?
}

struct MeetingConnectionRequest: Equatable, Sendable {
    let roomIdentity: RoomIdentity
    let configuration: ClientConfiguration
    let credentials: JoinCredentials
    let relayed: Bool
    let microphoneEnabled: Bool
    let cameraEnabled: Bool
}

enum MeetingEngineError: Error, Equatable, Sendable {
    case mediaPath
    case tokenRejected
    case microphonePermissionDenied
    case cameraPermissionDenied
    case connection
}

enum MeetingEngineEvent: Equatable, Sendable {
    case participants([ParticipantSnapshot])
    case reconnecting
    case reconnected
    case disconnected(MeetingEngineError?)
    case data(Data, senderIdentity: String?)
}
