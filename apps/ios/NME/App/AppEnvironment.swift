import Foundation

@MainActor
final class AppEnvironment {
    let coordinator: AppCoordinator
    let credentials: CredentialStore
    let API: APIClient

    init(
        coordinator: AppCoordinator = AppCoordinator(),
        credentials: CredentialStore = CredentialStore()
    ) {
        self.coordinator = coordinator
        self.credentials = credentials
        do {
            API = try APIClient(origin: AppConfiguration.origin)
        } catch {
            preconditionFailure("NMEOrigin must be an HTTPS URL")
        }

        if let invitation = ProcessInfo.processInfo.arguments
            .first(where: { $0.hasPrefix("--ui-testing-invitation=") })?
            .split(separator: "=", maxSplits: 1)
            .last
        {
            coordinator.open(String(invitation))
        }
    }

    func makeHomeViewModel() -> HomeViewModel {
        HomeViewModel(api: API, credentials: credentials)
    }

    func makePreJoinViewModel(identity: RoomIdentity) -> PreJoinViewModel {
        PreJoinViewModel(identity: identity, credentials: credentials)
    }

    func makePreviewController() -> PreviewController {
        if ProcessInfo.processInfo.arguments.contains("--ui-testing") {
            return PreviewController(requestAuthorization: { false })
        }
        return PreviewController()
    }
}
