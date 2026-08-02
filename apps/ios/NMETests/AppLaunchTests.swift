import XCTest
@testable import NME

final class AppLaunchTests: XCTestCase {
    func testProductIdentity() {
        XCTAssertEqual(AppConfiguration.productName, "NME Talk")
        XCTAssertEqual(AppConfiguration.origin, URL(string: "https://nmetalk.com")!)
    }
}

