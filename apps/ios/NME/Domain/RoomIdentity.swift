import Foundation

enum RoomIdentityError: Error, Equatable {
    case invalidInvitation
}

struct RoomIdentity: Equatable, Sendable {
    let encodedKey: String
    let rawKey: Data
    let roomID: String
    let safetyNumber: String

    init(encodedKey: String) throws {
        do {
            let rawKey = try RoomCrypto.decodeBase64URLKey(encodedKey)
            let digest = RoomCrypto.digest(rawKey)
            self.encodedKey = encodedKey
            self.rawKey = rawKey
            roomID = RoomCrypto.roomID(from: digest)
            safetyNumber = RoomCrypto.safetyNumber(from: digest)
        } catch {
            throw RoomIdentityError.invalidInvitation
        }
    }

    init(linkOrKey: String) throws {
        let trimmed = linkOrKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw RoomIdentityError.invalidInvitation
        }

        if let identity = try? RoomIdentity(encodedKey: trimmed) {
            self = identity
            return
        }

        guard let hashIndex = trimmed.firstIndex(of: "#") else {
            throw RoomIdentityError.invalidInvitation
        }
        let fragment = String(trimmed[trimmed.index(after: hashIndex)...])

        if let identity = try? RoomIdentity(encodedKey: fragment) {
            self = identity
            return
        }

        for field in fragment.split(separator: "&", omittingEmptySubsequences: false) {
            let pair = field.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard pair.count == 2, pair[0] == "k" else { continue }
            self = try RoomIdentity(encodedKey: String(pair[1]))
            return
        }

        throw RoomIdentityError.invalidInvitation
    }

    static func generate(
        randomBytes: (Int) throws -> Data = RoomCrypto.randomBytes
    ) throws -> RoomIdentity {
        let bytes = try randomBytes(RoomCrypto.keyByteCount)
        let encoded = try RoomCrypto.encodeBase64URLKey(bytes)
        return try RoomIdentity(encodedKey: encoded)
    }
}

