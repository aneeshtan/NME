import Combine
import Foundation

@MainActor
final class PreJoinViewModel: ObservableObject {
    let identity: RoomIdentity
    let shareURL: URL

    @Published var displayName: String
    @Published var cameraEnabled = true
    @Published private(set) var isJoining = false

    private let credentials: any CredentialStoring

    init(identity: RoomIdentity, credentials: any CredentialStoring) {
        self.identity = identity
        self.credentials = credentials
        displayName = credentials.loadDisplayName()
        shareURL = URL(string: "https://nmetalk.com/#\(identity.encodedKey)")!
    }

    var preparedDisplayName: String {
        let trimmed = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        return String((trimmed.isEmpty ? "Guest" : trimmed)
            .prefix(CredentialStore.maximumDisplayNameLength))
    }

    func updateDisplayName(_ value: String) {
        displayName = String(value.prefix(CredentialStore.maximumDisplayNameLength))
    }

    func prepareToJoin(preview: PreviewController) async -> (displayName: String, cameraEnabled: Bool)? {
        guard !isJoining else { return nil }
        isJoining = true
        let cameraReady = cameraEnabled && preview.status == .active
        await preview.stop()
        let name = preparedDisplayName
        credentials.saveDisplayName(name)
        isJoining = false
        return (name, cameraReady)
    }
}
