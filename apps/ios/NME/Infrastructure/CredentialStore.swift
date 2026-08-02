import Foundation

protocol CredentialStoring: Sendable {
    func loadDisplayName() -> String
    func saveDisplayName(_ value: String)
    func loadHostKey(roomID: String) -> String?
    func saveHostKey(_ value: String, roomID: String) throws
}

protocol PreferenceStoring: Sendable {
    func string(forKey key: String) -> String?
    func set(_ value: String, forKey key: String)
}

protocol HostKeyStoring: Sendable {
    func loadHostKey(roomID: String) -> String?
    func saveHostKey(_ value: String, roomID: String) throws
}

struct CredentialStore: CredentialStoring {
    static let maximumDisplayNameLength = 60
    private static let displayNameKey = "nme.displayName"

    private let preferences: any PreferenceStoring
    private let hostKeys: any HostKeyStoring

    init(
        preferences: any PreferenceStoring = UserDefaultsPreferences(),
        hostKeys: any HostKeyStoring = KeychainClient()
    ) {
        self.preferences = preferences
        self.hostKeys = hostKeys
    }

    func loadDisplayName() -> String {
        String((preferences.string(forKey: Self.displayNameKey) ?? "")
            .prefix(Self.maximumDisplayNameLength))
    }

    func saveDisplayName(_ value: String) {
        preferences.set(
            String(value.prefix(Self.maximumDisplayNameLength)),
            forKey: Self.displayNameKey
        )
    }

    func loadHostKey(roomID: String) -> String? {
        hostKeys.loadHostKey(roomID: roomID)
    }

    func saveHostKey(_ value: String, roomID: String) throws {
        try hostKeys.saveHostKey(value, roomID: roomID)
    }
}

private struct UserDefaultsPreferences: PreferenceStoring, @unchecked Sendable {
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func string(forKey key: String) -> String? {
        defaults.string(forKey: key)
    }

    func set(_ value: String, forKey key: String) {
        defaults.set(value, forKey: key)
    }
}
