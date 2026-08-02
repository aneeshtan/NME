import Foundation

struct ChatMessage: Equatable, Sendable {
    let at: Int64
    let text: String

    func validated() throws -> ChatMessage {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw MessageCipherError.invalidMessage
        }
        return ChatMessage(at: at, text: String(trimmed.prefix(2_000)))
    }
}

