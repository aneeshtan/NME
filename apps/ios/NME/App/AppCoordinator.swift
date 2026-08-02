import Combine
import Foundation

@MainActor
final class AppCoordinator: ObservableObject {
    enum Route: Equatable {
        case home
        case preJoin(RoomIdentity)
        case meeting(RoomIdentity, displayName: String, cameraEnabled: Bool)
    }

    @Published private(set) var route: Route = .home
    @Published private(set) var presentedIssue: AppIssue?

    func open(_ linkOrKey: String) {
        do {
            open(try RoomIdentity(linkOrKey: linkOrKey))
        } catch {
            presentedIssue = .invalidInvitation
        }
    }

    func open(_ identity: RoomIdentity) {
        presentedIssue = nil
        route = .preJoin(identity)
    }

    func cancelPreJoin() {
        route = .home
    }

    func join(displayName: String, cameraEnabled: Bool) {
        guard case let .preJoin(identity) = route else { return }
        let trimmed = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        let safeName = String((trimmed.isEmpty ? "Guest" : trimmed)
            .prefix(CredentialStore.maximumDisplayNameLength))
        route = .meeting(identity, displayName: safeName, cameraEnabled: cameraEnabled)
    }

    func leaveMeeting() {
        route = .home
    }

    func dismissIssue() {
        presentedIssue = nil
    }
}
