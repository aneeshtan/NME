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

        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")
        app.buttons["joinPastedMeeting"].tap()
        XCTAssertTrue(app.staticTexts["preJoinTitle"].waitForExistence(timeout: 5))

        app.buttons["cameraToggle"].tap()
        app.buttons["joinMeeting"].tap()
        XCTAssertTrue(app.buttons["leaveMeeting"].waitForExistence(timeout: 5))
        app.buttons["leaveMeeting"].tap()
        XCTAssertTrue(app.staticTexts["productName"].waitForExistence(timeout: 5))
    }

    @MainActor
    func testDemoMeetingExposesControlsTilesAndEphemeralChat() {
        let app = XCUIApplication()
        app.launchArguments += [
            "--ui-testing",
            "--ui-testing-demo-meeting=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
        ]
        app.launch()

        XCTAssertTrue(app.buttons["microphoneToggle"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["meetingCameraToggle"].exists)
        XCTAssertTrue(app.buttons["openChat"].exists)
        XCTAssertTrue(app.buttons["Admit Jordan"].exists)
        XCTAssertTrue(app.buttons["Deny Jordan"].exists)

        app.buttons["Admit Jordan"].tap()
        waitForDisappearance(of: app.buttons["Admit Jordan"])

        app.buttons["openChat"].tap()
        XCTAssertTrue(app.textFields["chatComposer"].waitForExistence(timeout: 5))
        app.buttons["closeChat"].tap()

        app.buttons["leaveMeeting"].tap()
        XCTAssertTrue(app.staticTexts["productName"].waitForExistence(timeout: 5))
    }

    private func waitForDisappearance(of element: XCUIElement, timeout: TimeInterval = 5) {
        let disappeared = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"),
            object: element
        )
        XCTAssertEqual(XCTWaiter().wait(for: [disappeared], timeout: timeout), .completed)
    }
}
