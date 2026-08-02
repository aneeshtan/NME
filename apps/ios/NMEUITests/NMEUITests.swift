import XCTest

final class NMEUITests: XCTestCase {
    @MainActor
    func testLaunchShowsProductIdentity() {
        let app = XCUIApplication()
        app.launchArguments.append("--ui-testing")
        app.launch()

        XCTAssertTrue(app.staticTexts["productName"].waitForExistence(timeout: 5))
    }

    @MainActor
    func testPastedLinkCanCancelAndJoinAudioOnly() {
        let app = XCUIApplication()
        app.launchArguments.append("--ui-testing")
        app.launch()

        let field = app.textFields["meetingLinkField"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")
        app.buttons["joinPastedMeeting"].tap()

        XCTAssertTrue(app.staticTexts["preJoinTitle"].waitForExistence(timeout: 5))
        app.buttons["cancelPreJoin"].tap()
        XCTAssertTrue(app.staticTexts["productName"].waitForExistence(timeout: 5))

        field.tap()
        field.typeText("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")
        app.buttons["joinPastedMeeting"].tap()
        XCTAssertTrue(app.staticTexts["preJoinTitle"].waitForExistence(timeout: 5))

        app.buttons["cameraToggle"].tap()
        app.buttons["joinMeeting"].tap()
        XCTAssertTrue(app.staticTexts["meetingPlaceholder"].waitForExistence(timeout: 5))
        app.buttons["leaveMeeting"].tap()
        XCTAssertTrue(app.staticTexts["productName"].waitForExistence(timeout: 5))
    }
}
