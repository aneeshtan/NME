@preconcurrency import AVFoundation
import Combine
import LiveKit

@MainActor
final class PreviewController: ObservableObject {
    enum Status: Equatable {
        case off
        case requestingPermission
        case starting
        case active
        case denied
        case unavailable
    }

    @Published private(set) var status: Status = .off
    @Published private(set) var track: LocalVideoTrack?

    private let requestAuthorization: @Sendable () async -> Bool
    private let makeTrack: @MainActor () -> LocalVideoTrack
    private var generation = UUID()

    init(
        requestAuthorization: @escaping @Sendable () async -> Bool = PreviewController.requestVideoAuthorization,
        makeTrack: @escaping @MainActor () -> LocalVideoTrack = {
            LocalVideoTrack.createCameraTrack(
                options: CameraCaptureOptions(position: .front, dimensions: .h720_169, fps: 30)
            )
        }
    ) {
        self.requestAuthorization = requestAuthorization
        self.makeTrack = makeTrack
    }

    func setCameraEnabled(_ enabled: Bool) async {
        guard enabled else {
            await stop()
            return
        }
        guard track == nil else { return }

        let attempt = UUID()
        generation = attempt
        status = .requestingPermission
        guard await requestAuthorization() else {
            guard generation == attempt else { return }
            status = .denied
            return
        }
        guard generation == attempt else { return }

        status = .starting
        let newTrack = makeTrack()
        do {
            try await newTrack.start()
            guard generation == attempt else {
                try? await newTrack.stop()
                return
            }
            track = newTrack
            status = .active
        } catch {
            guard generation == attempt else { return }
            try? await newTrack.stop()
            status = .unavailable
        }
    }

    func stop() async {
        generation = UUID()
        let oldTrack = track
        track = nil
        status = .off
        try? await oldTrack?.stop()
    }

    private static func requestVideoAuthorization() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            true
        case .notDetermined:
            await AVCaptureDevice.requestAccess(for: .video)
        default:
            false
        }
    }
}
