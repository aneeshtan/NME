import AVFoundation
import XCTest
@testable import NME

@MainActor
final class AudioLifecycleTests: XCTestCase {
    func testForwardsRouteAndMediaResetEventsOnlyWhileStarted() {
        let notifications = NotificationCenter()
        let lifecycle = AudioLifecycle(notificationCenter: notifications)
        var events: [AudioLifecycle.Event] = []

        lifecycle.start { events.append($0) }
        notifications.post(name: AVAudioSession.routeChangeNotification, object: nil)
        notifications.post(name: AVAudioSession.mediaServicesWereResetNotification, object: nil)

        XCTAssertEqual(events, [.routeChanged, .mediaServicesReset])

        lifecycle.stop()
        notifications.post(name: AVAudioSession.routeChangeNotification, object: nil)
        XCTAssertEqual(events, [.routeChanged, .mediaServicesReset])
    }

    func testInterruptionEventsPreserveEndedResumeHint() {
        let notifications = NotificationCenter()
        let lifecycle = AudioLifecycle(notificationCenter: notifications)
        var events: [AudioLifecycle.Event] = []
        lifecycle.start { events.append($0) }

        notifications.post(
            name: AVAudioSession.interruptionNotification,
            object: nil,
            userInfo: [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.began.rawValue]
        )
        notifications.post(
            name: AVAudioSession.interruptionNotification,
            object: nil,
            userInfo: [
                AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.ended.rawValue,
                AVAudioSessionInterruptionOptionKey:
                    AVAudioSession.InterruptionOptions.shouldResume.rawValue,
            ]
        )

        XCTAssertEqual(events, [.interruptionBegan, .interruptionEnded(shouldResume: true)])
    }
}
