import Foundation
import Security

struct KeychainAccess: @unchecked Sendable {
    typealias CopyMatching = (
        CFDictionary,
        UnsafeMutablePointer<CFTypeRef?>?
    ) -> OSStatus
    typealias Update = (CFDictionary, CFDictionary) -> OSStatus
    typealias Add = (CFDictionary) -> OSStatus

    let copyMatching: CopyMatching
    let update: Update
    let add: Add

    static let live = KeychainAccess(
        copyMatching: SecItemCopyMatching,
        update: SecItemUpdate,
        add: { SecItemAdd($0, nil) }
    )
}

struct KeychainClient: HostKeyStoring, @unchecked Sendable {
    enum KeychainError: Error, Equatable {
        case unexpectedStatus(OSStatus)
    }

    private static let service = "com.ctrlaltl.nme.host-keys"

    private let access: KeychainAccess

    init(access: KeychainAccess = .live) {
        self.access = access
    }

    func loadHostKey(roomID: String) -> String? {
        var query = baseQuery(roomID: roomID)
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        query[kSecReturnData as String] = true

        var result: CFTypeRef?
        guard access.copyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              let value = String(data: data, encoding: .utf8),
              !value.isEmpty
        else {
            return nil
        }
        return value
    }

    func saveHostKey(_ value: String, roomID: String) throws {
        let attributes: [String: Any] = [
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = access.update(
            baseQuery(roomID: roomID) as CFDictionary,
            attributes as CFDictionary
        )

        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else {
            throw KeychainError.unexpectedStatus(status)
        }

        var addition = baseQuery(roomID: roomID)
        addition.merge(attributes) { _, replacement in replacement }
        let addStatus = access.add(addition as CFDictionary)
        guard addStatus == errSecSuccess else {
            throw KeychainError.unexpectedStatus(addStatus)
        }
    }

    private func baseQuery(roomID: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: roomID,
        ]
    }
}
