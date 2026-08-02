import CryptoKit
import Foundation
import Security

enum RoomCryptoError: Error, Equatable {
    case invalidKey
    case entropyUnavailable
}

enum RoomCrypto {
    static let keyByteCount = 32
    static let encodedKeyLength = 43
    private static let roomAlphabet = Array("abcdefghjkmnpqrstuvwxyz23456789")

    static func decodeBase64URLKey(_ value: String) throws -> Data {
        guard value.utf8.count == encodedKeyLength,
              value.utf8.allSatisfy(isBase64URLByte)
        else {
            throw RoomCryptoError.invalidKey
        }

        var base64 = value
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        base64.append(String(repeating: "=", count: (4 - base64.count % 4) % 4))

        guard let decoded = Data(base64Encoded: base64), decoded.count == keyByteCount else {
            throw RoomCryptoError.invalidKey
        }
        return decoded
    }

    static func encodeBase64URLKey(_ value: Data) throws -> String {
        guard value.count == keyByteCount else {
            throw RoomCryptoError.invalidKey
        }
        return value.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func digest(_ roomKey: Data) -> Data {
        Data(SHA256.hash(data: roomKey))
    }

    static func roomID(from digest: Data) -> String {
        precondition(digest.count >= 12)
        let characters = digest.prefix(12).map { byte in
            roomAlphabet[Int(byte) % roomAlphabet.count]
        }
        let value = String(characters)
        return "\(value.prefix(4))-\(value.dropFirst(4).prefix(4))-\(value.dropFirst(8))"
    }

    static func safetyNumber(from digest: Data) -> String {
        precondition(digest.count >= 12)
        let bytes = Array(digest.prefix(12))
        return stride(from: 0, to: 12, by: 3)
            .map { offset in
                let value = Int(bytes[offset]) * 65_536
                    + Int(bytes[offset + 1]) * 256
                    + Int(bytes[offset + 2])
                return String(format: "%05d", value % 100_000)
            }
            .joined(separator: " ")
    }

    static func randomBytes(count: Int) throws -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        let result = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        guard result == errSecSuccess else {
            throw RoomCryptoError.entropyUnavailable
        }
        return Data(bytes)
    }

    private static func isBase64URLByte(_ byte: UInt8) -> Bool {
        switch byte {
        case 45, 48 ... 57, 65 ... 90, 95, 97 ... 122:
            true
        default:
            false
        }
    }
}

