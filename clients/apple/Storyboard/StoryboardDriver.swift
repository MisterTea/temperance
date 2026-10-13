import XCTest

/// Remote control for clients/storyboards/run.mjs: takes one command at a time
/// from the harness over HTTP (`STORYBOARD_DRIVER`), acts on the app or the
/// system UI, and reports back what it found, with frames in screen points.
final class StoryboardDriver: XCTestCase {
    private let app = XCUIApplication()
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

    func testDrive() throws {
        let base = try XCTUnwrap(ProcessInfo.processInfo.environment["STORYBOARD_DRIVER"].flatMap(URL.init(string:)))
        continueAfterFailure = true
        var result: [String: Any] = ["hello": true]
        while true {
            let command = try post(base.appendingPathComponent("next"), result)
            guard let op = command["op"] as? String, op != "done" else { return }
            do { result = try perform(op, command) } catch { result = ["error": "\(error)"] }
            result["id"] = command["id"]
        }
    }

    private func post(_ url: URL, _ body: [String: Any]) throws -> [String: Any] {
        var request = URLRequest(url: url, timeoutInterval: 600)
        request.httpMethod = "POST"
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        var reply: Data?
        let done = expectation(description: "harness")
        URLSession.shared.dataTask(with: request) { data, _, _ in reply = data; done.fulfill() }.resume()
        wait(for: [done], timeout: 600)
        return (try reply.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] }) ?? ["op": "done"]
    }

    struct Failure: Error, CustomStringConvertible { let description: String }

    private func perform(_ op: String, _ c: [String: Any]) throws -> [String: Any] {
        switch op {
        case "launch":
            app.launchArguments = c["arguments"] as? [String] ?? []
            app.launch()
            return [:]
        case "terminate":
            app.terminate()
            return [:]
        case "find":
            let element = try find(c, timeout: c["timeout"] as? Double ?? 15)
            return ["rect": frame(element)]
        case "tap":
            try find(c, timeout: 5).tap()
            return [:]
        case "type":
            let field = try find(c, timeout: 5)
            field.tap()
            if let old = field.value as? String, !old.isEmpty, old != field.placeholderValue {
                field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: old.count))
            }
            let text = c["text"] as? String ?? ""
            if c["paste"] as? Bool != true || !paste(text, into: field) { field.typeText(text) }
            // Return ends editing, so the keyboard doesn't hide what comes next.
            if app.keyboards.count > 0, c["multiline"] as? Bool != true { field.typeText("\n") }
            return [:]
        case "screen":
            let size = app.windows.firstMatch.frame.size
            return ["width": size.width, "height": size.height]
        default:
            throw Failure(description: "Unknown command \(op)")
        }
    }

    private func query(_ root: XCUIApplication, _ c: [String: Any]) -> XCUIElement {
        if let field = c["field"] as? String {
            let match = NSPredicate(format: "placeholderValue == %@ OR label == %@", field, field)
            let kinds: [XCUIElement.ElementType] = c["secure"] as? Bool == true ? [.secureTextField] : [.textField, .textView]
            return root.descendants(matching: .any).matching(NSPredicate(format: "elementType IN %@", kinds.map(\.rawValue))).matching(match).firstMatch
        }
        if let regex = c["regex"] as? String {
            let flags = (c["flags"] as? String ?? "").contains("i") ? "[c]" : ""
            let pattern = ".*(\(regex)).*"
            return root.descendants(matching: .any).matching(NSPredicate(format: "label MATCHES\(flags) %@ OR value MATCHES\(flags) %@", pattern, pattern)).firstMatch
        }
        let text = c["text"] as? String ?? ""
        let buttons = root.buttons.matching(NSPredicate(format: "label == %@", text))
        if buttons.count > 0 { return buttons.firstMatch }
        return root.descendants(matching: .any).matching(NSPredicate(format: "label == %@ OR value == %@", text, text)).firstMatch
    }

    private func find(_ c: [String: Any], timeout: Double) throws -> XCUIElement {
        let end = Date().addingTimeInterval(timeout)
        var swipes = 0
        while true {
            for root in [app, springboard] {
                let element = query(root, c)
                if element.exists, !element.frame.isEmpty {
                    if element.isHittable || root == springboard { return element }
                    if swipes < 4 {
                        swipes += 1
                        app.swipeUp(velocity: .slow)
                        continue
                    }
                    return element
                }
            }
            if Date() > end { throw Failure(description: "Not on screen: \(c)") }
            Thread.sleep(forTimeInterval: 0.5)
        }
    }

    /// Pastes through the field's edit menu, as a person would; false if the menu didn't offer Paste.
    private func paste(_ text: String, into field: XCUIElement) -> Bool {
        UIPasteboard.general.string = text
        // A second, separate tap on the focused field opens its edit menu.
        Thread.sleep(forTimeInterval: 0.8)
        field.tap()
        let item = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Paste' AND elementType IN %@",
            [XCUIElement.ElementType.menuItem, .button].map(\.rawValue))).firstMatch
        guard item.waitForExistence(timeout: 3) else { return false }
        Thread.sleep(forTimeInterval: 0.6)
        item.tap()
        return true
    }

    private func frame(_ element: XCUIElement) -> [String: Double] {
        let f = element.frame
        return ["x": f.minX, "y": f.minY, "width": f.width, "height": f.height]
    }
}
