import Combine
import Foundation

@MainActor
final class HomeViewModel: ObservableObject {
    @Published var pastedLink = ""
    @Published private(set) var isCreating = false
    @Published private(set) var presentedIssue: AppIssue?

    private let API: any RoomCreating
    private let credentials: any CredentialStoring
    private let generateIdentity: @Sendable () throws -> RoomIdentity

    init(
        api: any RoomCreating,
        credentials: any CredentialStoring,
        generateIdentity: @escaping @Sendable () throws -> RoomIdentity = {
            try RoomIdentity.generate()
        }
    ) {
        API = api
        self.credentials = credentials
        self.generateIdentity = generateIdentity
    }

    var canOpenPastedLink: Bool {
        !pastedLink.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    func createMeeting() async -> RoomIdentity? {
        guard !isCreating else { return nil }
        isCreating = true
        presentedIssue = nil
        defer { isCreating = false }

        do {
            let identity = try generateIdentity()
            let response = try await API.createRoom(roomID: identity.roomID, lobby: true)
            guard response.roomId == identity.roomID, let hostKey = response.hostKey else {
                throw APIError(
                    code: "INVALID_RESPONSE",
                    message: "The server returned an invalid response.",
                    status: 0
                )
            }
            try credentials.saveHostKey(hostKey, roomID: identity.roomID)
            return identity
        } catch let error as APIError {
            presentedIssue = .roomCreationFailed(error.message)
        } catch {
            presentedIssue = .roomCreationFailed("Please check your connection and try again.")
        }
        return nil
    }

    func openPastedLink() -> RoomIdentity? {
        do {
            let identity = try RoomIdentity(linkOrKey: pastedLink)
            pastedLink = ""
            presentedIssue = nil
            return identity
        } catch {
            presentedIssue = .invalidInvitation
            return nil
        }
    }
}
