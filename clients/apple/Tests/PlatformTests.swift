import CoreLocation
import SwiftUI
import XCTest

final class TransportTests: XCTestCase {
    func testOnlySpeaksToAHomesPinnedWireGuardPort() async {
        for url in ["https://family.example/v1/device/state", "temperance://family.example:51820/v1/device/state"] {
            do { _ = try await sendHome(HttpRequest(method: "GET", url: url, headers: [], body: nil), throughTunnel: false); XCTFail(url) }
            catch { XCTAssertTrue(error is CoreError, url) }
        }
    }
}

final class IdentityTests: XCTestCase {
    @MainActor func testTunnelConfigurationIsAFullTunnelToTheGateway() throws {
        let config = try tunnelConfiguration(try FakeService().identity())
        let peer = try XCTUnwrap(config.peers.first)
        XCTAssertEqual(peer.endpoint?.stringRepresentation, "192.0.2.1:51820")
        XCTAssertEqual(Set(peer.allowedIPs.map(\.stringRepresentation)), ["0.0.0.0/0", "::/0"])
        XCTAssertEqual(peer.persistentKeepAlive, 25)
        XCTAssertEqual(config.interface.dns.map(\.stringRepresentation), ["10.77.0.1"])
        XCTAssertEqual(config.interface.mtu, 1280)
    }

    @MainActor func testTunnelConfigurationNeedsAnEnrolledIdentity() throws {
        var identity = try FakeService().identity()
        identity.state = nil
        XCTAssertThrowsError(try tunnelConfiguration(identity)) { XCTAssertEqual($0.localizedDescription, "Enroll first") }
        XCTAssertEqual(ClientError.message("Enroll first").errorDescription, "Enroll first")
    }

    @MainActor func testTheVaultKeepsTheIdentityInTheKeychain() throws {
        let vault = Vault(service: "org.temperance.identity.tests.\(UUID().uuidString)", accessGroup: nil)
        defer { SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: vault.service] as CFDictionary) }
        XCTAssertNil(try vault.load())
        let first = try FakeService().identity()
        try vault.save(first)
        XCTAssertEqual(try vault.load(), first)
        var second = first
        second.state?.version = 9
        try vault.save(second)
        XCTAssertEqual(try vault.load()?.state?.version, 9)
    }
}

@MainActor final class LocationTests: XCTestCase {
    func testPermissionStateIsReportedAndRequested() {
        let manager = FakeLocationManager()
        let responder = LocationResponder(manager: manager)
        XCTAssertNil(responder.allowed)
        manager.status = .denied
        XCTAssertEqual(responder.allowed, false)
        manager.status = .authorizedAlways
        XCTAssertEqual(responder.allowed, true)
        responder.requestPermission()
        XCTAssertEqual(manager.authorizationRequests, 1)
    }

    func testAnswersWithOneFixOrAReason() async {
        let manager = FakeLocationManager()
        let responder = LocationResponder(manager: manager)
        var (fix, reason) = await responder.currentLocation()
        XCTAssertNil(fix); XCTAssertEqual(reason, "location permission not granted yet")
        XCTAssertEqual(manager.authorizationRequests, 1)
        manager.status = .restricted
        (fix, reason) = await responder.currentLocation()
        XCTAssertEqual(reason, "location permission not granted")

        manager.status = .authorizedAlways
        let here = CLLocation(latitude: 41.88, longitude: -87.63)
        let first = Task { await responder.currentLocation() }
        while manager.locationRequests == 0 { await Task.yield() }
        (fix, reason) = await responder.currentLocation()
        XCTAssertEqual(reason, "location request already in progress")
        manager.deliver(here)
        (fix, reason) = await first.value
        XCTAssertEqual(fix?.coordinate.latitude, 41.88); XCTAssertEqual(reason, "")

        let failing = Task { await responder.currentLocation() }
        while manager.locationRequests == 1 { await Task.yield() }
        manager.deliver(nil)
        (fix, reason) = await failing.value
        XCTAssertNil(fix); XCTAssertEqual(reason, "no location fix available")
    }
}

@MainActor final class ContentViewTests: XCTestCase {
    private func render(_ client: Client) {
        let renderer = ImageRenderer(content: ContentView(client: client).frame(width: 640, height: 1000))
        XCTAssertNotNil(renderer.nsImage)
    }

    func testRendersSignInStatusHealthAndRequests() async throws {
        let service = FakeService(), store = MemoryStore()
        let client = Client(send: { try await service.send($0) }, store: store, vpn: FakeVPN(), notifier: FakeNotifier(), location: FakeLocation())
        render(client)
        await client.enroll(home: FakeService.home, username: "alex", password: "correct horse", name: "Mac")
        await client.refresh()
        XCTAssertFalse(client.health.isEmpty)
        render(client)
        await client.install()
        XCTAssertEqual(client.vpnInstalled, true)
        render(client)
        await client.askForTime(minutes: 15, message: "")
        XCTAssertTrue(client.child!.pendingRequest)
        render(client)
    }
}
