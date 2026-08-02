import Foundation

struct APIError: Error, Equatable, Sendable {
    let code: String
    let message: String
    let status: Int
}

extension APIError: LocalizedError {
    var errorDescription: String? { message }
}
