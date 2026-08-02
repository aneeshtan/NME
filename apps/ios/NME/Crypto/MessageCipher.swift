import CryptoKit
import Foundation

enum MessageCipherError: Error, Equatable {
    case invalidEnvelope
    case authenticationFailed
    case invalidMessage
}

struct MessageCipher: Sendable {
    private static let nonceByteCount = 12
    private static let tagByteCount = 16
    private static let maximumEnvelopeBytes = 16 * 1024

    private let key: SymmetricKey

    init(roomKey: Data) {
        key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: roomKey),
            salt: Data(),
            info: Data("nme-chat-v1".utf8),
            outputByteCount: 32
        )
    }

    func seal(_ message: ChatMessage, nonce nonceData: Data? = nil) throws -> Data {
        let message = try message.validated()
        let payload = try WireChatMessage(message).encoded()
        let nonce: AES.GCM.Nonce
        if let nonceData {
            guard nonceData.count == Self.nonceByteCount else {
                throw MessageCipherError.invalidEnvelope
            }
            nonce = try AES.GCM.Nonce(data: nonceData)
        } else {
            nonce = AES.GCM.Nonce()
        }

        let sealed = try AES.GCM.seal(payload, using: key, nonce: nonce)
        guard let combined = sealed.combined, combined.count <= Self.maximumEnvelopeBytes else {
            throw MessageCipherError.invalidEnvelope
        }
        return combined
    }

    func open(_ envelope: Data) throws -> ChatMessage {
        guard envelope.count > Self.nonceByteCount + Self.tagByteCount,
              envelope.count <= Self.maximumEnvelopeBytes
        else {
            throw MessageCipherError.invalidEnvelope
        }

        let plaintext: Data
        do {
            let sealed = try AES.GCM.SealedBox(combined: envelope)
            plaintext = try AES.GCM.open(sealed, using: key)
        } catch {
            throw MessageCipherError.authenticationFailed
        }

        do {
            return try JSONDecoder().decode(WireChatMessage.self, from: plaintext).message.validated()
        } catch let error as MessageCipherError {
            throw error
        } catch {
            throw MessageCipherError.invalidMessage
        }
    }
}

private struct WireChatMessage: Codable {
    let at: Int64
    let text: String
    let type: String

    init(_ message: ChatMessage) {
        at = message.at
        text = message.text
        type = "chat"
    }

    var message: ChatMessage {
        get throws {
            guard type == "chat" else {
                throw MessageCipherError.invalidMessage
            }
            return ChatMessage(at: at, text: text)
        }
    }

    func encoded() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(self)
    }
}

