import Foundation
import XCTest
@testable import NME

@MainActor
final class APIClientTests: XCTestCase {
    override func tearDown() {
        URLProtocolStub.reset()
        super.tearDown()
    }

    func testRejectsNonHTTPSOrigin() {
        XCTAssertThrowsError(try APIClient(origin: URL(string: "http://nmetalk.com")!)) { error in
            XCTAssertEqual(error as? APIClient.ConfigurationError, .insecureOrigin)
        }
    }

    func testFetchConfigurationUsesBodylessGet() async throws {
        let client = stub(
            status: 200,
            json: #"{"livekitUrl":"wss://sfu.nmetalk.com","maxParticipants":12,"videoCodec":"vp8"}"#
        )

        let configuration = try await client.configuration()

        XCTAssertEqual(configuration.videoCodec, .vp8)
        XCTAssertEqual(URLProtocolStub.lastRequest?.url?.path, "/api/config")
        XCTAssertEqual(URLProtocolStub.lastRequest?.httpMethod, "GET")
        XCTAssertNil(URLProtocolStub.lastRequest?.value(forHTTPHeaderField: "Content-Type"))
        XCTAssertEqual(URLProtocolStub.lastRequest?.httpShouldHandleCookies, false)
    }

    func testCreateRoomSendsOnlyLobbyAndDerivedRoomID() async throws {
        let client = stub(
            status: 201,
            json: #"{"roomId":"gqwm-kmxk-yvzm","hostKey":"host-secret"}"#
        )

        let response = try await client.createRoom(roomID: "gqwm-kmxk-yvzm", lobby: true)

        XCTAssertEqual(response.hostKey, "host-secret")
        XCTAssertEqual(URLProtocolStub.lastRequest?.url?.path, "/api/rooms")
        XCTAssertEqual(URLProtocolStub.lastRequest?.httpMethod, "POST")
        XCTAssertEqual(jsonBody()["lobby"] as? Bool, true)
        XCTAssertEqual(jsonBody()["roomId"] as? String, "gqwm-kmxk-yvzm")
        XCTAssertFalse(String(data: URLProtocolStub.lastRequest?.httpBody ?? Data(), encoding: .utf8)!.contains("AAECAw"))
    }

    func testJoinSendsHostKeyOnlyInHeader() async throws {
        let client = stub(
            status: 200,
            json: #"{"token":"join-token","url":"wss://sfu.nmetalk.com","identity":"p-1","displayName":"Farshad"}"#
        )

        let result = try await client.join(
            roomID: "gqwm-kmxk-yvzm",
            displayName: "Farshad",
            hostKey: "host-secret",
            relay: false
        )

        XCTAssertEqual(result, .credentials(.init(
            token: "join-token",
            url: "wss://sfu.nmetalk.com",
            identity: "p-1",
            displayName: "Farshad",
            iceServers: nil
        )))
        XCTAssertEqual(URLProtocolStub.lastRequest?.url?.path, "/api/rooms/gqwm-kmxk-yvzm/join")
        XCTAssertEqual(URLProtocolStub.lastRequest?.value(forHTTPHeaderField: "X-Host-Key"), "host-secret")
        XCTAssertEqual(jsonBody()["displayName"] as? String, "Farshad")
        XCTAssertNil(jsonBody()["relay"])
        XCTAssertFalse(String(data: URLProtocolStub.lastRequest?.httpBody ?? Data(), encoding: .utf8)!.contains("host-secret"))
    }

    func testJoinDecodesWaitingResponse() async throws {
        let client = stub(status: 202, json: #"{"status":"waiting","knockId":"knock-1"}"#)

        let result = try await client.join(
            roomID: "gqwm-kmxk-yvzm",
            displayName: "Guest",
            hostKey: nil,
            relay: false
        )

        XCTAssertEqual(result, .waiting(knockID: "knock-1"))
    }

    func testClaimCanRequestRelayCredentials() async throws {
        let client = stub(
            status: 200,
            json: #"{"status":"admitted","token":"fresh","url":"wss://sfu.nmetalk.com","identity":"p-2","displayName":"Guest","iceServers":[{"urls":["turns:turn.nmetalk.com:443?transport=tcp"],"username":"u","credential":"c"}]}"#
        )

        let result = try await client.claim(
            roomID: "gqwm-kmxk-yvzm",
            knockID: "knock-1",
            relay: true
        )

        guard case let .admitted(credentials) = result else {
            return XCTFail("Expected admitted credentials")
        }
        XCTAssertEqual(credentials.token, "fresh")
        XCTAssertEqual(credentials.iceServers?.first?.username, "u")
        XCTAssertEqual(jsonBody()["relay"] as? Bool, true)
    }

    func testListsAndResolvesKnocksWithAdmissionHeaders() async throws {
        let client = stub(
            status: 200,
            json: #"{"knocks":[{"id":"knock-1","displayName":"Guest","createdAt":1700000000000}]}"#
        )

        let knocks = try await client.listKnocks(
            roomID: "gqwm-kmxk-yvzm",
            hostKey: "host-secret",
            participantIdentity: "p-host"
        )

        XCTAssertEqual(knocks.first?.displayName, "Guest")
        XCTAssertEqual(URLProtocolStub.lastRequest?.value(forHTTPHeaderField: "X-Host-Key"), "host-secret")
        XCTAssertEqual(URLProtocolStub.lastRequest?.value(forHTTPHeaderField: "X-Participant-Identity"), "p-host")

        URLProtocolStub.handler = Self.response(status: 200, json: #"{"status":"admitted"}"#)
        let status = try await client.resolveKnock(
            roomID: "gqwm-kmxk-yvzm",
            knockID: "knock-1",
            admit: true,
            hostKey: "host-secret",
            participantIdentity: nil
        )
        XCTAssertEqual(status, "admitted")
        XCTAssertEqual(jsonBody()["admit"] as? Bool, true)
    }

    func testMapsServerAndTransportErrors() async throws {
        let server = stub(status: 409, json: #"{"error":"ROOM_FULL","message":"This meeting is full."}"#)
        await XCTAssertThrowsAPIError(
            try await server.join(
                roomID: "gqwm-kmxk-yvzm",
                displayName: "Guest",
                hostKey: nil,
                relay: false
            ),
            expected: APIError(code: "ROOM_FULL", message: "This meeting is full.", status: 409)
        )

        URLProtocolStub.handler = { _ in throw URLError(.timedOut) }
        let timeout = try APIClient(
            origin: URL(string: "https://nmetalk.com")!,
            session: Self.stubbedSession()
        )
        do {
            _ = try await timeout.configuration()
            XCTFail("Expected timeout")
        } catch {
            XCTAssertEqual(error as? APIError, APIError(code: "TIMEOUT", message: "The server took too long to respond.", status: 0))
        }
    }

    private func stub(status: Int, json: String) -> APIClient {
        URLProtocolStub.handler = Self.response(status: status, json: json)
        return try! APIClient(origin: URL(string: "https://nmetalk.com")!, session: Self.stubbedSession())
    }

    private static func response(status: Int, json: String) -> URLProtocolStub.Handler {
        { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (response, Data(json.utf8))
        }
    }

    private static func stubbedSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [URLProtocolStub.self]
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpShouldSetCookies = false
        return URLSession(configuration: configuration)
    }

    private func jsonBody() -> [String: Any] {
        let body = URLProtocolStub.lastRequest?.httpBody ?? Data()
        return (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
    }
}

private extension XCTestCase {
    @MainActor
    func XCTAssertThrowsAPIError<T>(
        _ expression: @autoclosure () async throws -> T,
        expected: APIError,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        do {
            _ = try await expression()
            XCTFail("Expected APIError", file: file, line: line)
        } catch {
            XCTAssertEqual(error as? APIError, expected, file: file, line: line)
        }
    }
}
