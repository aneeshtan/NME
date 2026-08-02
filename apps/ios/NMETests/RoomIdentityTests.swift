import XCTest
@testable import NME

final class RoomIdentityTests: XCTestCase {
    private let key = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"

    func testFixtureDerivesBrowserCompatibleIdentity() throws {
        let identity = try RoomIdentity(encodedKey: key)

        XCTAssertEqual(identity.roomID, "gqwm-kmxk-yvzm")
        XCTAssertEqual(identity.safetyNumber, "91597 13284 68593 01224")
        XCTAssertEqual(identity.rawKey, Data((0...31).map(UInt8.init)))
    }

    func testAcceptsEverySupportedInvitationForm() throws {
        let links = [
            key,
            "  \(key)  ",
            "https://nmetalk.com/#\(key)",
            "https://nmetalk.com/r/old-room#k=\(key)",
            "nmetalk://meeting#\(key)",
            "nmetalk://meeting#k=\(key)",
        ]

        for link in links {
            XCTAssertEqual(try RoomIdentity(linkOrKey: link).encodedKey, key, link)
        }
    }

    func testIgnoresInvitationHostWhenReadingTheSecret() throws {
        let identity = try RoomIdentity(linkOrKey: "https://attacker.example/#\(key)")

        XCTAssertEqual(identity.encodedKey, key)
        XCTAssertEqual(identity.roomID, "gqwm-kmxk-yvzm")
    }

    func testRejectsMalformedInvitationsWithoutFallback() {
        let malformed = [
            "",
            "https://nmetalk.com/",
            "#",
            "#short",
            String(repeating: "A", count: 42),
            String(repeating: "A", count: 44),
            String(repeating: "A", count: 42) + "+",
            "#k=" + String(repeating: "A", count: 42) + "=",
            "#k=<script>alert(1)</script>",
        ]

        for value in malformed {
            XCTAssertThrowsError(try RoomIdentity(linkOrKey: value), value)
        }
    }

    func testGeneratedIdentityUsesThirtyTwoRandomBytes() throws {
        let identity = try RoomIdentity.generate(randomBytes: { count in
            XCTAssertEqual(count, 32)
            return Data(repeating: 7, count: count)
        })

        XCTAssertEqual(identity.rawKey, Data(repeating: 7, count: 32))
        XCTAssertEqual(identity.encodedKey.count, 43)
    }
}

