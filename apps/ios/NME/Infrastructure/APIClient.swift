import Foundation

struct APIClient: Sendable {
    enum ConfigurationError: Error, Equatable {
        case insecureOrigin
    }

    private static let timeout: TimeInterval = 10

    private let apiRoot: URL
    private let session: URLSession
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(origin: URL, session: URLSession? = nil) throws {
        guard origin.scheme?.lowercased() == "https" else {
            throw ConfigurationError.insecureOrigin
        }

        apiRoot = origin.appendingPathComponent("api", isDirectory: true)
        self.session = session ?? Self.makeSession()
    }

    func configuration() async throws -> ClientConfiguration {
        try await send(path: ["config"])
    }

    func createRoom(roomID: String, lobby: Bool) async throws -> CreateRoomResponse {
        try await send(
            path: ["rooms"],
            method: "POST",
            body: CreateRoomBody(lobby: lobby, roomId: roomID)
        )
    }

    func join(
        roomID: String,
        displayName: String,
        hostKey: String?,
        relay: Bool
    ) async throws -> JoinResult {
        let response: JoinWireResponse = try await send(
            path: ["rooms", roomID, "join"],
            method: "POST",
            body: JoinBody(displayName: displayName, relay: relay ? true : nil),
            headers: admissionHeaders(hostKey: hostKey, participantIdentity: nil)
        )

        if response.status == "waiting", let knockID = response.knockId {
            return .waiting(knockID: knockID)
        }
        return .credentials(try response.credentials())
    }

    func claim(roomID: String, knockID: String, relay: Bool) async throws -> AdmissionResult {
        let response: JoinWireResponse = try await send(
            path: ["rooms", roomID, "knocks", knockID, "claim"],
            method: "POST",
            body: ClaimBody(relay: relay ? true : nil)
        )

        switch response.status {
        case "waiting":
            return .waiting
        case "denied":
            return .denied
        case "admitted":
            return .admitted(try response.credentials())
        default:
            throw Self.invalidResponse
        }
    }

    func listKnocks(
        roomID: String,
        hostKey: String?,
        participantIdentity: String?
    ) async throws -> [PendingKnock] {
        let response: KnocksResponse = try await send(
            path: ["rooms", roomID, "knocks"],
            headers: admissionHeaders(
                hostKey: hostKey,
                participantIdentity: participantIdentity
            )
        )
        return response.knocks
    }

    func resolveKnock(
        roomID: String,
        knockID: String,
        admit: Bool,
        hostKey: String?,
        participantIdentity: String?
    ) async throws -> String {
        let response: StatusResponse = try await send(
            path: ["rooms", roomID, "knocks", knockID],
            method: "POST",
            body: ResolveKnockBody(admit: admit),
            headers: admissionHeaders(
                hostKey: hostKey,
                participantIdentity: participantIdentity
            )
        )
        return response.status
    }

    private func send<Response: Decodable & Sendable>(
        path: [String],
        method: String = "GET",
        headers: [String: String] = [:]
    ) async throws -> Response {
        try await send(path: path, method: method, encodedBody: nil, headers: headers)
    }

    private func send<Response: Decodable & Sendable, Body: Encodable>(
        path: [String],
        method: String,
        body: Body,
        headers: [String: String] = [:]
    ) async throws -> Response {
        let data: Data
        do {
            data = try encoder.encode(body)
        } catch {
            throw Self.invalidResponse
        }
        return try await send(path: path, method: method, encodedBody: data, headers: headers)
    }

    private func send<Response: Decodable & Sendable>(
        path: [String],
        method: String,
        encodedBody: Data?,
        headers: [String: String]
    ) async throws -> Response {
        var url = apiRoot
        for component in path {
            url.appendPathComponent(component)
        }

        var request = URLRequest(url: url, timeoutInterval: Self.timeout)
        request.httpMethod = method
        request.httpBody = encodedBody
        request.httpShouldHandleCookies = false
        if encodedBody != nil {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        for (name, value) in headers {
            request.setValue(value, forHTTPHeaderField: name)
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError where error.code == .timedOut {
            throw APIError(
                code: "TIMEOUT",
                message: "The server took too long to respond.",
                status: 0
            )
        } catch {
            throw APIError(code: "NETWORK", message: "Could not reach the server.", status: 0)
        }

        guard let httpResponse = response as? HTTPURLResponse else {
            throw Self.invalidResponse
        }
        guard (200 ..< 300).contains(httpResponse.statusCode) else {
            let serverError = try? decoder.decode(ServerErrorResponse.self, from: data)
            throw APIError(
                code: serverError?.error ?? "UNKNOWN",
                message: serverError?.message ?? "Something went wrong.",
                status: httpResponse.statusCode
            )
        }

        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw Self.invalidResponse
        }
    }

    private func admissionHeaders(
        hostKey: String?,
        participantIdentity: String?
    ) -> [String: String] {
        var headers: [String: String] = [:]
        if let hostKey, !hostKey.isEmpty {
            headers["X-Host-Key"] = hostKey
        }
        if let participantIdentity, !participantIdentity.isEmpty {
            headers["X-Participant-Identity"] = participantIdentity
        }
        return headers
    }

    private static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpShouldSetCookies = false
        configuration.timeoutIntervalForRequest = timeout
        return URLSession(configuration: configuration)
    }

    fileprivate static let invalidResponse = APIError(
        code: "INVALID_RESPONSE",
        message: "The server returned an invalid response.",
        status: 0
    )
}

private struct CreateRoomBody: Encodable {
    let lobby: Bool
    let roomId: String
}

private struct JoinBody: Encodable {
    let displayName: String
    let relay: Bool?
}

private struct ClaimBody: Encodable {
    let relay: Bool?
}

private struct ResolveKnockBody: Encodable {
    let admit: Bool
}

private struct KnocksResponse: Decodable, Sendable {
    let knocks: [PendingKnock]
}

private struct StatusResponse: Decodable, Sendable {
    let status: String
}

private struct ServerErrorResponse: Decodable {
    let error: String?
    let message: String?
}

private struct JoinWireResponse: Decodable, Sendable {
    let status: String?
    let knockId: String?
    let token: String?
    let url: String?
    let identity: String?
    let displayName: String?
    let iceServers: [IceServerConfiguration]?

    func credentials() throws -> JoinCredentials {
        guard let token, let url, let identity, let displayName else {
            throw APIClient.invalidResponse
        }
        return JoinCredentials(
            token: token,
            url: url,
            identity: identity,
            displayName: displayName,
            iceServers: iceServers
        )
    }
}
