import XCTest

final class NMEUITests: XCTestCase {
    @MainActor
    func testLaunchShowsProductIdentity() {
        let app = XCUIApplication()
        app.launch()

        XCTAssertTrue(app.staticTexts["productName"].waitForExistence(timeout: 5))
    }
}
