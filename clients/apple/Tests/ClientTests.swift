import CoreLocation
import XCTest

@MainActor final class ClientTests: XCTestCase {
    private var service: FakeService!
    private var store: MemoryStore!
    private var vpn: FakeVPN!
    private var notifier: FakeNotifier!
    private var location: FakeLocation!

    override func setUp() async throws {
        service = FakeService(); store = MemoryStore(); vpn = FakeVPN(); notifier = FakeNotifier(); location = FakeLocation()
    }

    private func client() -> Client {
        let service = service!
        return Client(send: { try await service.send($0) }, store: store, vpn: vpn, notifier: notifier, location: location)
    }

    private func enrolled() async -> Client {
        let client = client()
        await client.enroll(home: FakeService.home, username: "alex", password: "correct horse", name: "Mac")
        return client
    }

    func testEnrollingSavesTheIdentityWithoutThePassword() async throws {
        let client = await enrolled()
        XCTAssertEqual(client.status, "")
        XCTAssertEqual(client.profile, "Alex")
        XCTAssertEqual(client.vpnInstalled, false, "the child allows the VPN next")
        XCTAssertFalse(client.busy)
        XCTAssertEqual(client.child?.remainingMinutes, 40)
        XCTAssertEqual(store.identity?.state?.token, "device-token")
        XCTAssertFalse(identityToJson(identity: try XCTUnwrap(store.identity)).contains("correct horse"))
        XCTAssertTrue(service.bodies("/v1/device/login").first!.contains("\"name\":\"Mac\""))
    }

    func testEnrollingReportsErrorsAndRefusesASecondSignIn() async {
        let client = client()
        await client.enroll(home: FakeService.home, username: "alex", password: "nope", name: "Mac")
        XCTAssertEqual(client.status, "Invalid username or password")
        XCTAssertNil(store.identity)
        await client.enroll(home: FakeService.home, username: "alex", password: "correct horse", name: "Mac")
        await client.enroll(home: FakeService.home, username: "alex", password: "correct horse", name: "Mac")
        XCTAssertEqual(client.status, "Device already enrolled")
        XCTAssertEqual(service.bodies("/v1/device/login").count, 2)
    }

    func testStartUpRestoresTheChildOrShowsWhyItCannot() throws {
        store.identity = try service.identity()
        XCTAssertEqual(client().child?.remainingMinutes, 40)
        store.failure = ClientError.message("Keychain read failed: -25308")
        XCTAssertEqual(client().status, "Keychain read failed: -25308")
    }

    func testSignInNeedsTheDashboardsSetupCode() async {
        let client = Client(store: store, vpn: vpn, notifier: notifier, location: location)
        await client.enroll(home: "https://family.example", username: "alex", password: "correct horse", name: "Mac")
        XCTAssertTrue(client.status.hasPrefix("Scan or paste the setup code"), client.status)
        XCTAssertNil(store.identity)
    }

    func testRefreshSavesPolicyTellsTheChildAndReportsHealthOnlyWhenItChanges() async throws {
        let client = client()
        await client.refresh()
        XCTAssertTrue(service.requests.isEmpty, "nothing to refresh before sign-in")
        await client.enroll(home: FakeService.home, username: "alex", password: "correct horse", name: "Mac")
        vpn.current = (true, true); notifier.permission = true; location.allowed = true
        service.version = 4; service.remaining = 10
        await client.refresh()
        XCTAssertEqual(client.status, "")
        XCTAssertEqual(client.vpnInstalled, true)
        XCTAssertFalse(client.canAskPermissions, "both permissions were answered")
        XCTAssertEqual(store.identity?.state?.version, 4)
        XCTAssertEqual(client.child?.remainingMinutes, 10)
        XCTAssertEqual(notifier.posted, ["10 minutes left today"])
        XCTAssertEqual(service.bodies("/v1/device/diagnostics").count, 1)

        await client.refresh()
        XCTAssertEqual(service.bodies("/v1/device/diagnostics").count, 1, "unchanged health is not reported again")
        vpn.current = nil
        await client.refresh()
        XCTAssertFalse(client.health.isEmpty)
        XCTAssertEqual(service.bodies("/v1/device/diagnostics").count, 2)
    }

    func testAnUnreachableServiceKeepsTheVPNAndShowsInHealth() async {
        let client = await enrolled()
        service.unreachable = true
        await client.refresh()
        XCTAssertEqual(client.status, "Can't reach your family's Temperance right now. The last rules stay in effect.")
        XCTAssertFalse(client.health.isEmpty)
        XCTAssertTrue(service.bodies("/v1/device/diagnostics").isEmpty)
    }

    func testAParentsLocationRequestIsAnsweredWithAFixOrAReason() async {
        let client = await enrolled()
        service.locationRequested = true
        await client.refresh()
        XCTAssertTrue(service.bodies("/v1/device/location").last!.contains("location permission not granted"))
        XCTAssertEqual(notifier.posted.last, "A parent viewed this device's location")

        location.fix = CLLocation(coordinate: CLLocationCoordinate2D(latitude: 41.88, longitude: -87.63), altitude: 0, horizontalAccuracy: 12, verticalAccuracy: 0, timestamp: Date())
        await client.refresh()
        XCTAssertTrue(service.bodies("/v1/device/location").last!.contains("41.88"))
    }

    func testAskingForTimeSendsTheRequestAndShowsItPending() async {
        let client = client()
        let refused = await client.askForTime(minutes: 15, message: "")
        XCTAssertFalse(refused)
        XCTAssertEqual(client.status, "Enroll first")
        await client.enroll(home: FakeService.home, username: "alex", password: "correct horse", name: "Mac")
        let sent = await client.askForTime(minutes: 30, message: "homework")
        XCTAssertTrue(sent)
        XCTAssertEqual(client.status, "Request sent to your parents.")
        XCTAssertTrue(client.child!.pendingRequest)
        XCTAssertTrue(service.bodies("/v1/device/requests").first!.contains("\"minutes\":30"))
        XCTAssertFalse(client.busy)
    }

    func testInstallingTheVPNUsesTheGatewayEndpoint() async {
        let client = client()
        await client.install()
        XCTAssertEqual(client.status, "Enroll first")
        await client.enroll(home: FakeService.home, username: "alex", password: "correct horse", name: "Mac")
        vpn.failure = ClientError.message("Permission denied")
        await client.install()
        XCTAssertEqual(client.status, "Permission denied")
        XCTAssertEqual(client.vpnInstalled, false)
        vpn.failure = nil
        await client.install()
        XCTAssertEqual(vpn.installed, ["192.0.2.1:51820"])
        XCTAssertEqual(client.status, "")
        XCTAssertEqual(client.vpnInstalled, true)
    }

    func testAllowingAlertsAsksForNotificationsAndLocation() async {
        let client = await enrolled()
        await client.refresh()
        XCTAssertTrue(client.canAskPermissions)
        client.allowAlerts()
        XCTAssertEqual(notifier.permissionRequests, 1)
        XCTAssertEqual(location.permissionRequests, 1)
        XCTAssertFalse(client.canAskPermissions)
    }

    func testABuildWithoutTheTunnelExtensionCannotInstallTheVPN() async {
        let vpn = SystemVPN()
        let status = await vpn.status()
        XCTAssertNil(status)
        do { try await vpn.install(endpoint: "192.0.2.1:51820"); XCTFail("installed") }
        catch { XCTAssertEqual(error.localizedDescription, "This build has no VPN extension") }
    }
}
