import XCTest

/// Drives the app against a live server. Launch environment:
///   ALICE_URL    server address (default http://mochi:4317)
///   ALICE_BOARD  board id to open (use a scratch board; these tests create and move cards)
///   ALICE_CARD   a card in Review, for the review flows
/// Screenshots are written to /tmp/alice-uitest-<name>.png.
final class FlowTests: XCTestCase {
    var app: XCUIApplication!

    /// The launch setting `ALICE_<key>`, else nil.
    static func setting(_ key: String) -> String? {
        let env = ProcessInfo.processInfo.environment
        return env["ALICE_\(key)"] ?? env["SIMCTL_CHILD_ALICE_\(key)"]
    }

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        let board = Self.setting("BOARD") ?? ""
        let url = Self.setting("URL") ?? "http://mochi:4317"
        app.launchArguments = ["-serverURL", url, "-startRoute", name.contains("Capture") ? "today" : "board:\(board)"]
        if name.contains("Review"), let card = Self.setting("CARD"), !card.isEmpty { app.launchArguments += ["-startCard", card] }
        app.launch()
    }

    func shot(_ name: String) {
        let data = XCUIScreen.main.screenshot().pngRepresentation
        try? data.write(to: URL(fileURLWithPath: "/tmp/alice-uitest-\(name).png"))
    }

    func testCreateAndMoveCard() {
        let title = "UI test card \(Int(Date().timeIntervalSince1970) % 100000)"
        let new = app.buttons["New card"]
        XCTAssertTrue(new.waitForExistence(timeout: 15))
        new.tap()
        let titleField = app.textFields["What needs doing?"]
        XCTAssertTrue(titleField.waitForExistence(timeout: 5))
        titleField.tap()
        titleField.typeText(title)
        shot("1-new-card-sheet")
        app.buttons["Create"].tap()

        let tile = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
        XCTAssertTrue(tile.waitForExistence(timeout: 10), "created card appears on the board")
        shot("2-board-with-new-card")
        tile.tap()

        XCTAssertTrue(app.staticTexts[title].waitForExistence(timeout: 5))
        // A card you create starts in Ready.
        let triage = app.buttons["Move to Triage"]
        XCTAssertTrue(triage.waitForExistence(timeout: 5))
        shot("3-card-detail")
        triage.tap()
        XCTAssertTrue(app.staticTexts["Triage"].waitForExistence(timeout: 10), "status becomes Triage")
        shot("4-card-triage")
        app.buttons["Move to Ready"].tap()
        XCTAssertTrue(app.staticTexts["Ready"].waitForExistence(timeout: 10))
    }

    func testCreateCardInTriage() {
        let title = "UI test triage card \(Int(Date().timeIntervalSince1970) % 100000)"
        let new = app.buttons["New card"]
        XCTAssertTrue(new.waitForExistence(timeout: 15))
        new.tap()
        let titleField = app.textFields["What needs doing?"]
        XCTAssertTrue(titleField.waitForExistence(timeout: 5))
        titleField.tap()
        titleField.typeText(title)
        let triage = app.switches["Start in Triage"]
        XCTAssertTrue(triage.waitForExistence(timeout: 5))
        triage.switches.firstMatch.tap()
        XCTAssertEqual(triage.value as? String, "1", "Start in Triage is on")
        shot("triage-new-card-sheet")
        app.buttons["Create"].tap()

        let tile = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
        XCTAssertTrue(tile.waitForExistence(timeout: 10), "created card appears on the board")
        tile.tap()
        XCTAssertTrue(app.staticTexts[title].waitForExistence(timeout: 5))
        // A Triage card offers Move to Ready; a Ready one would offer Move to Triage.
        XCTAssertTrue(app.buttons["Move to Ready"].waitForExistence(timeout: 5), "the card starts in Triage")
        XCTAssertFalse(app.buttons["Move to Triage"].exists)
        shot("triage-card-detail")
    }

    /// Server JSON at `/api\(path)`, read straight from the server under test.
    func serverJSON(_ path: String) async throws -> Any {
        let base = Self.setting("URL") ?? "http://mochi:4317"
        let (data, _) = try await URLSession.shared.data(from: XCTUnwrap(URL(string: "\(base)/api\(path)")))
        return try JSONSerialization.jsonObject(with: data)
    }

    /// Captures on the ALICE_BOARD board from Today and checks with the server that it landed there in Triage.
    @MainActor func testCaptureInTriage() async throws {
        let boardId = try XCTUnwrap(Self.setting("BOARD").flatMap { $0.isEmpty ? nil : $0 }, "set ALICE_BOARD to a scratch board")
        let boardList = try await serverJSON("/boards")
        let boards = try XCTUnwrap(boardList as? [[String: Any]])
        let repo = try XCTUnwrap(boards.first { $0["id"] as? String == boardId }?["repo"] as? String, "ALICE_BOARD is on the server")
        let name = URL(fileURLWithPath: repo).lastPathComponent
        XCTAssertEqual(boards.filter { URL(fileURLWithPath: $0["repo"] as? String ?? "").lastPathComponent == name }.count, 1, "the capture menu picks boards by name, so it must be unique")

        let menu = app.buttons["capture-board"]
        XCTAssertTrue(menu.waitForExistence(timeout: 15))
        if !menu.label.contains(name) {
            menu.tap()
            let item = app.buttons[name].firstMatch
            XCTAssertTrue(item.waitForExistence(timeout: 5), "\(name) is in the capture menu")
            item.tap()
        }
        let chosen = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", name), object: menu)
        XCTAssertEqual(XCTWaiter.wait(for: [chosen], timeout: 5), .completed, "capture targets \(name)")

        let title = "UI test capture \(Int(Date().timeIntervalSince1970) % 100000)"
        let field = app.textFields["What needs doing?"]
        field.tap()
        field.typeText(title)
        let triage = app.descendants(matching: .any)["capture-triage"].firstMatch
        XCTAssertTrue(triage.waitForExistence(timeout: 5))
        triage.tap()
        let on = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == 'On'"), object: triage)
        XCTAssertEqual(XCTWaiter.wait(for: [on], timeout: 5), .completed, "Triage is on")
        shot("capture-triage")
        app.buttons["Add"].tap()
        // The toast names the lane the server put the card in.
        let toast = app.staticTexts.containing(NSPredicate(format: "label == %@", "Added to \(name) Triage")).firstMatch
        XCTAssertTrue(toast.waitForExistence(timeout: 10), "the card was added to Triage")
        shot("capture-triage-added")
        let cardList = try await serverJSON("/boards/\(boardId)/cards")
        let cards = try XCTUnwrap(cardList as? [[String: Any]])
        XCTAssertEqual(cards.first { $0["title"] as? String == title }?["status"] as? String, "triage", "the card is in Triage on ALICE_BOARD")
    }

    func testChatTab() {
        XCTAssertTrue(app.buttons["Chat"].waitForExistence(timeout: 15))
        app.buttons["Chat"].tap()
        sleep(2)
        shot("5-chat")
    }

    func testSearch() {
        let search = app.buttons["Search"]
        XCTAssertTrue(search.waitForExistence(timeout: 15))
        search.tap()
        let field = app.textFields["Search cards"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap(); field.typeText("onboarding")
        sleep(1)
        shot("6-search")
        XCTAssertTrue(app.staticTexts["Write onboarding copy"].exists)
    }

    /// Needs ALICE_CARD: a card in Review whose diff adds a line containing "Hello from Alice iOS".
    func testReviewCommentAndApprove() throws {
        try XCTSkipIf((Self.setting("CARD") ?? "").isEmpty, "ALICE_CARD not set")
        let reviewTab = app.buttons["Review"]
        XCTAssertTrue(reviewTab.waitForExistence(timeout: 15))
        reviewTab.tap()
        let line = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@ OR label BEGINSWITH %@", "Hello from", "Goodbye")).firstMatch
        _ = line.waitForExistence(timeout: 10)
        shot("7-review-diff")
        XCTAssertTrue(line.exists, "diff shows the added line")
        line.tap()
        let box = app.textFields.matching(NSPredicate(format: "placeholderValue BEGINSWITH %@", "Comment on line")).firstMatch
        XCTAssertTrue(box.waitForExistence(timeout: 5))
        box.tap(); box.typeText("Looks good")
        app.buttons["Add comment"].tap()
        XCTAssertTrue(app.staticTexts["Looks good"].waitForExistence(timeout: 10), "comment appears")
        shot("8-review-comment")
        app.buttons["Approve and merge"].tap()
        app.alerts.buttons["Continue"].tap()
        XCTAssertTrue(app.staticTexts["Done"].waitForExistence(timeout: 30), "card is merged and Done")
        shot("9-merged")
    }

    /// Needs ALICE_CARD: a card in Review. Requests changes with a comment; the card goes back to Running.
    func testReviewRequestChanges() throws {
        try XCTSkipIf((Self.setting("CARD") ?? "").isEmpty, "ALICE_CARD not set")
        XCTAssertTrue(app.buttons["Review"].waitForExistence(timeout: 15))
        app.buttons["Review"].tap()
        let line = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Goodbye")).firstMatch
        XCTAssertTrue(line.waitForExistence(timeout: 10))
        line.tap()
        let box = app.textFields.matching(NSPredicate(format: "placeholderValue BEGINSWITH %@", "Comment on line")).firstMatch
        XCTAssertTrue(box.waitForExistence(timeout: 5))
        box.tap(); box.typeText("Make it shout: uppercase please")
        app.buttons["Add comment"].tap()
        let request = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Request changes")).firstMatch
        XCTAssertTrue(request.waitForExistence(timeout: 10))
        request.tap()
        XCTAssertTrue(app.staticTexts["Running"].waitForExistence(timeout: 15), "card runs again")
        shot("10-request-changes")
    }

    func testChatSend() {
        XCTAssertTrue(app.buttons["Chat"].waitForExistence(timeout: 15))
        app.buttons["Chat"].tap()
        XCTAssertTrue(app.buttons.matching(identifier: "New chat").firstMatch.waitForExistence(timeout: 5))
        app.buttons.matching(identifier: "New chat").allElementsBoundByIndex.last!.tap()
        let field = app.descendants(matching: .any).matching(identifier: "Message").firstMatch
        _ = field.waitForExistence(timeout: 10)
        XCTAssertTrue(field.exists)
        sleep(2); field.tap(); sleep(1); field.typeText("Reply with exactly the word pong")
        app.buttons["Send"].tap()
        let sent = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "exactly the word pong")).firstMatch
        _ = sent.waitForExistence(timeout: 10)
        shot("11-chat-sent")
        XCTAssertTrue(sent.exists, "message shown")
        let pong = app.descendants(matching: .any).matching(NSPredicate(format: "label ==[c] %@", "pong")).firstMatch
        XCTAssertTrue(pong.waitForExistence(timeout: 90), "assistant replies")
        shot("12-chat-reply")
    }

    /// A bad address must keep the typed text and show an error; a good one must connect.
    func testConnectScreen() {
        app.terminate()
        app = XCUIApplication()
        app.launchArguments = ["-serverURL", ""]
        app.launch()
        let field = app.textFields["host:4317"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        sleep(1); field.tap(); sleep(1); field.typeText("nowhere.invalid:4317")
        app.buttons["Connect"].tap()
        XCTAssertTrue(app.staticTexts["Can't connect"].waitForExistence(timeout: 40), "error shown")
        XCTAssertEqual(field.value as? String, "nowhere.invalid:4317", "input kept")
        shot("13-connect-error")
        field.clearAndType("mochi")  // no port: defaults to 4317
        app.buttons["Connect"].tap()
        XCTAssertTrue(app.staticTexts["Today"].waitForExistence(timeout: 20), "connected")
    }

    /// An address without a scheme must reach an HTTPS-only server (Tailscale Serve on mochi:4318).
    func testConnectHTTPSWithoutScheme() {
        app.terminate()
        app = XCUIApplication()
        app.launchArguments = ["-serverURL", ""]
        app.launch()
        let field = app.textFields["host:4317"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        sleep(1); field.tap(); sleep(1); field.typeText("mochi.tail72fb46.ts.net:4318")
        app.buttons["Connect"].tap()
        XCTAssertTrue(app.staticTexts["Today"].waitForExistence(timeout: 20), "connected over HTTPS")
    }
}

extension XCUIElement {
    func clearAndType(_ text: String) {
        tap()
        if let current = value as? String { typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count)) }
        typeText(text)
    }
}
