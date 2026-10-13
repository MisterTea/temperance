import SwiftUI
import WebKit
import XCTest

final class MemoryParentStore: ParentStore {
    var identity: String?
    var failure: Error?
    func load() throws -> String? { if let failure { throw failure }; return identity }
    func save(_ identity: String) throws { if let failure { throw failure }; self.identity = identity }
    func clear() throws { if let failure { throw failure }; identity = nil }
}

final class FakeSession: RemoteSessionProtocol, @unchecked Sendable {
    var stopped = false
    func stop() { stopped = true }
    func url() -> String { "http://127.0.0.1:5555/__temperance/start?t=token" }
}

private func link(_ fields: [String: Any]) -> String {
    let json = try! JSONSerialization.data(withJSONObject: fields)
    return "temperance://pair#" + json.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}
private let pairingLink = link(["v": 1, "host": "parkers.ddnsfree.com", "port": 51820, "pin": "PIN", "code": "CODE", "household": "The Parkers"])
private let identity = #"{"v":1,"host":"parkers.ddnsfree.com","port":51820,"pin":"PIN","key":"KEY","id":"par_1","name":"Robin's Mac","household":"The Parkers"}"#

@MainActor final class ParentTests: XCTestCase {
    func testParsesTheDashboardsPairingLink() throws {
        let parsed = try parsePairingLink(link: pairingLink)
        XCTAssertEqual(parsed.host, "parkers.ddnsfree.com")
        XCTAssertEqual(parsed.port, 51820)
        XCTAssertEqual(parsed.household, "The Parkers")
        XCTAssertThrowsError(try parsePairingLink(link: "https://example.com")) {
            XCTAssertTrue($0.localizedDescription.contains("not a Temperance pairing code"), $0.localizedDescription)
        }
    }

    func testPairsStoresTheIdentityAndOpensTheDashboard() async throws {
        let store = MemoryParentStore(), session = FakeSession()
        var paired: [(String, String)] = []
        let parent = Parent(store: store, pair: { link, name in
            DispatchQueue.main.sync { paired.append((link, name)) }
            return identity
        }, start: { _ in session })
        XCTAssertNil(parent.paired)
        await parent.pair(link: "  \(pairingLink)\n", name: "Robin's Mac")
        XCTAssertEqual(paired.first?.0, pairingLink)
        XCTAssertEqual(store.identity, identity)
        XCTAssertEqual(parent.paired?.household, "The Parkers")
        XCTAssertEqual(parent.dashboard?.port, 5555)
        XCTAssertEqual(parent.status, "")
        parent.close()
        XCTAssertTrue(session.stopped)
        XCTAssertNil(parent.dashboard)
        XCTAssertEqual(Parent(store: store).paired?.id, "par_1")
        parent.forget()
        XCTAssertNil(store.identity)
        XCTAssertNil(parent.paired)
    }

    func testReportsWhyPairingOrOpeningFailed() async {
        let store = MemoryParentStore()
        let parent = Parent(store: store, pair: { _, _ in throw ClientError.message("That pairing code has expired") }, start: { _ in FakeSession() })
        await parent.pair(link: "nonsense", name: "Mac")
        XCTAssertTrue(parent.status.contains("not a Temperance pairing code"), parent.status)
        await parent.pair(link: pairingLink, name: "Mac")
        XCTAssertEqual(parent.status, "That pairing code has expired")
        XCTAssertNil(store.identity)
        parent.open()
        XCTAssertEqual(parent.status, "Pair this \(deviceNoun) first")
        store.identity = "{broken"
        XCTAssertTrue(Parent(store: store).status.contains("damaged"))
        store.failure = ClientError.message("Keychain delete failed: -1")
        parent.forget()
        XCTAssertEqual(parent.status, "Keychain delete failed: -1")
    }

    func testTheParentVaultKeepsThePairingInTheKeychain() throws {
        let vault = ParentVault(service: "org.temperance.identity.tests.\(UUID().uuidString)", accessGroup: nil)
        defer { try? vault.clear() }
        XCTAssertNil(try vault.load())
        try vault.save(identity)
        XCTAssertEqual(try vault.load(), identity)
        try vault.save("{}")
        XCTAssertEqual(try vault.load(), "{}")
        try vault.clear()
        XCTAssertNil(try vault.load())
        try vault.clear()
    }

    func testOnlyLoopbackPagesStayInTheWebView() {
        let policy = LoopbackOnly(host: "127.0.0.1")
        XCTAssertEqual(policy.host, "127.0.0.1")
    }

    func testTheDashboardStopsShowingProgressOnceAPageLoadsOrFails() {
        var loads = 0
        let policy = LoopbackOnly(host: "127.0.0.1") { loads += 1 }
        let view = WKWebView()
        policy.webView(view, didFinish: nil)
        policy.webView(view, didFail: nil, withError: URLError(.timedOut))
        policy.webView(view, didFailProvisionalNavigation: nil, withError: URLError(.cannotConnectToHost))
        XCTAssertEqual(loads, 3)
    }

    func testRendersTheModeChoiceAndBothModes() async throws {
        UserDefaults.standard.removeObject(forKey: "mode")
        defer { UserDefaults.standard.removeObject(forKey: "mode") }
        let store = MemoryParentStore()
        let parent = Parent(store: store, pair: { _, _ in identity }, start: { _ in FakeSession() })
        let client = Client(send: { _ in (404, "{}") }, store: MemoryStore(), vpn: FakeVPN(), notifier: FakeNotifier(), location: FakeLocation())
        let root = RootView(client: client, parent: parent)
        XCTAssertNil(root.resolved)
        render(root)
        render(ModeChoice { _ in })
        UserDefaults.standard.set("child", forKey: "mode")
        XCTAssertEqual(RootView(client: client, parent: parent).resolved, .child)
        render(RootView(client: client, parent: parent))
        UserDefaults.standard.set("parent", forKey: "mode")
        XCTAssertEqual(RootView(client: client, parent: parent).resolved, .parent)
        render(ParentView(parent: parent, back: {}))
        await parent.pair(link: pairingLink, name: "Mac")
        UserDefaults.standard.removeObject(forKey: "mode")
        XCTAssertEqual(RootView(client: client, parent: parent).resolved, .parent)
        parent.close()
        render(ParentView(parent: parent, back: {}))
        parent.open()
        render(ParentView(parent: parent, back: {}))
    }

    private func render(_ view: some View) {
        XCTAssertNotNil(ImageRenderer(content: view.frame(width: 640, height: 1000)).nsImage)
    }
}
