import AVFoundation
import Foundation
import LiveKit

enum MediaEncryptionConfiguration {
    static func passphrase(for identity: RoomIdentity) -> String {
        identity.encodedKey
    }

    static func makeRoomOptions(
        identity: RoomIdentity,
        videoCodec: VideoCodec
    ) -> RoomOptions {
        let keyProvider = BaseKeyProvider(
            isSharedKey: true,
            sharedKey: passphrase(for: identity)
        )

        // E2EEOptions deliberately encrypts media only. NME data messages use
        // the existing AES-GCM envelope shared with older web/mobile clients.
        let mediaEncryption = E2EEOptions(keyProvider: keyProvider)
        let codec: LiveKit.VideoCodec = switch videoCodec {
        case .vp8: .vp8
        case .vp9: .vp9
        }

        return RoomOptions(
            defaultCameraCaptureOptions: CameraCaptureOptions(
                position: .front,
                dimensions: .h720_169,
                fps: 24
            ),
            defaultVideoPublishOptions: VideoPublishOptions(
                simulcast: true,
                simulcastLayers: [
                    .presetH180_169,
                    .presetH360_169,
                ],
                preferredCodec: codec
            ),
            adaptiveStream: true,
            dynacast: true,
            stopLocalTrackOnUnpublish: true,
            suspendLocalVideoTracksInBackground: true,
            e2eeOptions: mediaEncryption
        )
    }
}

enum LiveKitConnectionConfiguration {
    static func makeConnectOptions(for request: MeetingConnectionRequest) -> ConnectOptions {
        let timeout: TimeInterval = request.relayed ? 15 : 8
        let iceServers = (request.credentials.iceServers ?? []).map { server in
            IceServer(
                urls: server.urls,
                username: server.username,
                credential: server.credential
            )
        }

        return ConnectOptions(
            autoSubscribe: true,
            reconnectAttempts: 15,
            reconnectAttemptDelay: 0.3,
            reconnectMaxDelay: 10,
            socketConnectTimeoutInterval: timeout,
            primaryTransportConnectTimeout: timeout,
            publisherTransportConnectTimeout: timeout,
            iceServers: iceServers,
            iceTransportPolicy: request.relayed ? .relay : .all,
            isDscpEnabled: false,
            enableMicrophone: false
        )
    }
}

enum LiveKitMediaOperation: Sendable {
    case microphone
    case camera
}

enum LiveKitErrorClassifier {
    static func connectionError(_ type: LiveKitErrorType) -> MeetingEngineError {
        switch type {
        case .timedOut, .webRTC, .network, .serverPingTimedOut:
            .mediaPath
        case .validation, .joinFailure, .insufficientPermissions, .duplicateIdentity:
            .tokenRejected
        default:
            .connection
        }
    }

    static func mediaError(
        _ type: LiveKitErrorType,
        operation: LiveKitMediaOperation
    ) -> MeetingEngineError {
        guard type == .deviceAccessDenied else { return .connection }
        return switch operation {
        case .microphone: .microphonePermissionDenied
        case .camera: .cameraPermissionDenied
        }
    }

    static func connectionError(_ error: Error) -> MeetingEngineError {
        guard let liveKitError = error as? LiveKitError else { return .connection }
        return connectionError(liveKitError.type)
    }

    static func mediaError(
        _ error: Error,
        operation: LiveKitMediaOperation
    ) -> MeetingEngineError {
        guard let liveKitError = error as? LiveKitError else { return .connection }
        return mediaError(liveKitError.type, operation: operation)
    }
}
