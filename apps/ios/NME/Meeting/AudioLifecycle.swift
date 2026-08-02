@preconcurrency import AVFoundation
import Foundation

@MainActor
final class AudioLifecycle: @unchecked Sendable {
    enum Event: Equatable, Sendable {
        case routeChanged
        case interruptionBegan
        case interruptionEnded(shouldResume: Bool)
        case mediaServicesReset
    }

    private let notificationCenter: NotificationCenter
    private var observers: [NSObjectProtocol] = []
    private var handler: ((Event) -> Void)?

    init(notificationCenter: NotificationCenter = .default) {
        self.notificationCenter = notificationCenter
    }

    func start(handler: @escaping (Event) -> Void) {
        stop()
        self.handler = handler

        observe(AVAudioSession.routeChangeNotification) { _ in
            .routeChanged
        }
        observe(AVAudioSession.interruptionNotification) { notification in
            Self.interruptionEvent(from: notification)
        }
        observe(AVAudioSession.mediaServicesWereResetNotification) { _ in
            .mediaServicesReset
        }
    }

    func stop() {
        observers.forEach(notificationCenter.removeObserver)
        observers.removeAll()
        handler = nil
    }

    private func observe(
        _ name: Notification.Name,
        transform: @escaping @Sendable (Notification) -> Event?
    ) {
        let observer = notificationCenter.addObserver(
            forName: name,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            let event = transform(notification)
            MainActor.assumeIsolated {
                guard let event else { return }
                self?.handler?(event)
            }
        }
        observers.append(observer)
    }

    nonisolated private static func interruptionEvent(from notification: Notification) -> Event? {
        guard let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: rawType)
        else {
            return nil
        }

        switch type {
        case .began:
            return .interruptionBegan
        case .ended:
            let rawOptions = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            let options = AVAudioSession.InterruptionOptions(rawValue: rawOptions)
            return .interruptionEnded(shouldResume: options.contains(.shouldResume))
        @unknown default:
            return nil
        }
    }
}
