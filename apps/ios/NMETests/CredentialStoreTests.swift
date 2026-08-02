import Foundation
import Security
import XCTest
@testable import NME

final class CredentialStoreTests: XCTestCase {
    func testDisplayNameIsCappedAtSixtyCharacters() {
        let preferences = PreferenceStoreSpy()
        let store = CredentialStore(preferences: preferences, hostKeys: HostKeyStoreSpy())

        store.saveDisplayName(String(repeating: "a", count: 75))

        XCTAssertEqual(store.loadDisplayName(), String(repeating: "a", count: 60))
    }

    func testHostKeysAreScopedByDerivedRoomID() throws {
        let keys = HostKeyStoreSpy()
        let store = CredentialStore(preferences: PreferenceStoreSpy(), hostKeys: keys)

        try store.saveHostKey("host-a", roomID: "aaaa-bbbb-cccc")
        try store.saveHostKey("host-b", roomID: "dddd-eeee-ffff")

        XCTAssertEqual(store.loadHostKey(roomID: "aaaa-bbbb-cccc"), "host-a")
        XCTAssertEqual(store.loadHostKey(roomID: "dddd-eeee-ffff"), "host-b")
        XCTAssertNil(store.loadHostKey(roomID: "xxxx-yyyy-zzzz"))
    }

    func testKeychainWriteUsesDeviceOnlyAccessibility() throws {
        let recorder = KeychainRecorder()
        let client = KeychainClient(access: recorder.access)

        try client.saveHostKey("host-secret", roomID: "gqwm-kmxk-yvzm")

        let addition = try XCTUnwrap(recorder.addedItem)
        XCTAssertEqual(addition[kSecClass as String] as? String, kSecClassGenericPassword as String)
        XCTAssertEqual(addition[kSecAttrService as String] as? String, "com.ctrlaltl.nme.host-keys")
        XCTAssertEqual(addition[kSecAttrAccount as String] as? String, "gqwm-kmxk-yvzm")
        XCTAssertEqual(
            addition[kSecAttrAccessible as String] as? String,
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String
        )
    }

    func testKeychainFailuresAreGracefulAndNeverReturnGarbage() {
        let access = KeychainAccess(
            copyMatching: { _, _ in errSecInteractionNotAllowed },
            update: { _, _ in errSecInteractionNotAllowed },
            add: { _ in errSecInteractionNotAllowed }
        )
        let client = KeychainClient(access: access)

        XCTAssertNil(client.loadHostKey(roomID: "gqwm-kmxk-yvzm"))
        XCTAssertThrowsError(try client.saveHostKey("host-secret", roomID: "gqwm-kmxk-yvzm")) {
            XCTAssertEqual(
                $0 as? KeychainClient.KeychainError,
                .unexpectedStatus(errSecInteractionNotAllowed)
            )
        }
    }

    func testCredentialProtocolContainsNoRoomKeyPersistence() {
        let store: any CredentialStoring = CredentialStore(
            preferences: PreferenceStoreSpy(),
            hostKeys: HostKeyStoreSpy()
        )

        store.saveDisplayName("Guest")
        XCTAssertEqual(store.loadDisplayName(), "Guest")
        XCTAssertNil(store.loadHostKey(roomID: "gqwm-kmxk-yvzm"))
    }
}

private final class PreferenceStoreSpy: PreferenceStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String] = [:]

    func string(forKey key: String) -> String? {
        lock.withLock { values[key] }
    }

    func set(_ value: String, forKey key: String) {
        lock.withLock { values[key] = value }
    }
}

private final class HostKeyStoreSpy: HostKeyStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String] = [:]

    func loadHostKey(roomID: String) -> String? {
        lock.withLock { values[roomID] }
    }

    func saveHostKey(_ value: String, roomID: String) throws {
        lock.withLock { values[roomID] = value }
    }
}

private final class KeychainRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var item: [String: Any]?

    var addedItem: [String: Any]? {
        lock.withLock { item }
    }

    lazy var access = KeychainAccess(
        copyMatching: { _, _ in errSecItemNotFound },
        update: { _, _ in errSecItemNotFound },
        add: { [weak self] attributes in
            self?.lock.withLock {
                self?.item = attributes as NSDictionary as? [String: Any]
            }
            return errSecSuccess
        }
    )
}
