import XCTest
@testable import NME

final class MessageCipherTests: XCTestCase {
    private let roomKey = Data((0...31).map(UInt8.init))
    private let fixtureEnvelope = Data(hexString:
        "000102030405060708090a0b3c68c4e1fe37703e96d95c5bc3330125384f69edc829e54b401771dd06cf3b81f8afac7fe3e77b7cb95e30709edbb198096a7a776512e385b8a2997a7e5e0d4aa8"
    )!

    func testOpensTypeScriptFixture() throws {
        let message = try MessageCipher(roomKey: roomKey).open(fixtureEnvelope)

        XCTAssertEqual(message, ChatMessage(at: 1_700_000_000_000, text: "hello"))
    }

    func testSealsTheSharedFixtureWithAnInjectedNonce() throws {
        let nonce = Data((0...11).map(UInt8.init))
        let envelope = try MessageCipher(roomKey: roomKey).seal(
            ChatMessage(at: 1_700_000_000_000, text: "hello"),
            nonce: nonce
        )

        XCTAssertEqual(envelope, fixtureEnvelope)
    }

    func testRejectsTamperedCiphertext() throws {
        var tampered = fixtureEnvelope
        tampered[20] ^= 1

        XCTAssertThrowsError(try MessageCipher(roomKey: roomKey).open(tampered)) { error in
            XCTAssertEqual(error as? MessageCipherError, .authenticationFailed)
        }
    }

    func testRejectsImplausibleEnvelopeSizes() throws {
        let cipher = MessageCipher(roomKey: roomKey)

        XCTAssertThrowsError(try cipher.open(Data(repeating: 0, count: 28)))
        XCTAssertThrowsError(try cipher.open(Data(repeating: 0, count: 16 * 1024 + 1)))
    }

    func testTrimsAndCapsIncomingChat() throws {
        let text = "   " + String(repeating: "x", count: 2_010) + "   "
        let sealed = try MessageCipher(roomKey: roomKey).seal(
            ChatMessage(at: 1, text: text),
            nonce: Data((0...11).map(UInt8.init))
        )
        let opened = try MessageCipher(roomKey: roomKey).open(sealed)

        XCTAssertEqual(opened.text.count, 2_000)
        XCTAssertFalse(opened.text.hasPrefix(" "))
        XCTAssertFalse(opened.text.hasSuffix(" "))
    }

    func testRejectsEmptyChat() throws {
        XCTAssertThrowsError(
            try MessageCipher(roomKey: roomKey).seal(
                ChatMessage(at: 1, text: "   "),
                nonce: Data((0...11).map(UInt8.init))
            )
        ) { error in
            XCTAssertEqual(error as? MessageCipherError, .invalidMessage)
        }
    }

    func testDifferentRoomKeyCannotDecrypt() throws {
        let otherKey = Data(repeating: 9, count: 32)

        XCTAssertThrowsError(try MessageCipher(roomKey: otherKey).open(fixtureEnvelope))
    }
}

private extension Data {
    init?(hexString: String) {
        guard hexString.count.isMultiple(of: 2) else { return nil }
        var bytes: [UInt8] = []
        bytes.reserveCapacity(hexString.count / 2)
        var index = hexString.startIndex
        while index < hexString.endIndex {
            let next = hexString.index(index, offsetBy: 2)
            guard let byte = UInt8(hexString[index ..< next], radix: 16) else { return nil }
            bytes.append(byte)
            index = next
        }
        self = Data(bytes)
    }
}

