import SwiftUI
import NetworkExtension
import UserNotifications
import WireGuardKit

final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
@MainActor final class Client: ObservableObject {
    @Published var status = "Enroll to install your family's VPN."
    @Published var child: ChildStatus?
    @Published var busy = false
    @Published var health: [Diagnostic] = []
    private var reported: [String]?
    private var connected = false
    private var manager: NETunnelProviderManager?
    private let session = URLSession(configuration: .ephemeral, delegate: NoRedirect(), delegateQueue: nil)
    let location = LocationResponder()
    init() {
        do { if let state = try Vault.load()?.state { child = try childStatus(state: state, now: now()) } }
        catch { status = error.localizedDescription }
    }
    private func now() -> Int64 { Int64(Date().timeIntervalSince1970) }
    /// Sends a request built by the shared Rust core over the platform's HTTPS stack.
    func send(_ request: HttpRequest) async throws -> (UInt16, String) {
        guard let url = URL(string: request.url) else { throw ClientError.message("Invalid request URL") }
        var urlRequest = URLRequest(url: url)
        urlRequest.timeoutInterval = 15
        urlRequest.httpMethod = request.method
        for header in request.headers { urlRequest.setValue(header.value, forHTTPHeaderField: header.name) }
        urlRequest.httpBody = request.body.map { Data($0.utf8) }
        let (data, response) = try await session.data(for: urlRequest)
        guard let response = response as? HTTPURLResponse, response.url?.host == url.host, response.url?.scheme == "https" else {
            throw ClientError.message("Policy service rejected this request")
        }
        return (UInt16(clamping: response.statusCode), String(decoding: data, as: UTF8.self))
    }
    func enroll(service: String, code: String, name: String) async {
        busy = true; defer { busy = false }
        do {
            guard try Vault.load()?.state == nil else { throw ClientError.message("Device already enrolled") }
            let origin = try validateService(raw: service)
            let keys = generateKeypair()
            let (statusCode, body) = try await send(try enrollRequest(service: origin, code: code, name: name, publicKey: keys.publicKey))
            let identity = try enrolledIdentity(service: origin, keys: keys, status: statusCode, body: body)
            _ = try tunnelConfiguration(identity)
            try Vault.save(identity)
            child = try childStatus(state: identity.state!, now: now())
            status = "Enrolled. Install VPN to connect."
        } catch { status = error.localizedDescription }
    }
    func refresh() async {
        do {
            guard let identity = try Vault.load(), identity.state != nil else { return }
            let (statusCode, body) = try await send(try stateRequest(identity: identity))
            let latest = try parseDeviceState(status: statusCode, body: body)
            let alerts = childAlerts(previous: identity.state, current: latest, now: now())
            let next = try refreshedIdentity(identity: identity, latest: latest, connected: connected)
            try Vault.save(next)
            child = try childStatus(state: next.state!, now: now())
            status = "Policy \(next.state!.version)"
            alerts.forEach(ChildNotifier.post)
            if latest.locationRequested { try await shareLocation(next) }
            await checkHealth(next, policyReachable: true)
        } catch {
            status = "Policy refresh unavailable; existing VPN remains configured."
            if let identity = try? Vault.load() { await checkHealth(identity, policyReachable: false) }
        }
    }
    /// Gathers platform facts; the shared core decides what they mean. Reports changes to parents.
    private func checkHealth(_ identity: Identity, policyReachable: Bool) async {
        let identifier = Bundle.main.object(forInfoDictionaryKey: "TunnelBundleIdentifier") as? String
        let managers = (try? await NETunnelProviderManager.loadAllFromPreferences()) ?? []
        let manager = managers.first { ($0.protocolConfiguration as? NETunnelProviderProtocol)?.providerBundleIdentifier == identifier }
        let notifications = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        let facts = DeviceFacts(
            vpnPermission: manager?.isEnabled ?? false,
            tunnelUp: manager?.connection.status == .connected,
            secondsSinceHandshake: nil,
            connectivity: nil,
            policyReachable: policyReachable,
            notificationsAllowed: notifications == .notDetermined ? nil : notifications == .authorized || notifications == .provisional,
            locationAllowed: location.allowed,
            portalSignInUntil: nil)
        health = diagnose(facts: facts, now: now())
        let codes = health.map(\.code)
        guard policyReachable, codes != reported, let request = try? diagnosticsRequest(identity: identity, diagnostics: health) else { return }
        if let (statusCode, body) = try? await send(request), (try? parseOk(status: statusCode, body: body)) != nil { reported = codes }
    }
    private func shareLocation(_ identity: Identity) async throws {
        let (fix, reason) = await location.currentLocation()
        let request = if let fix {
            try locationRequest(identity: identity, latitude: fix.coordinate.latitude, longitude: fix.coordinate.longitude, accuracyMeters: max(0, fix.horizontalAccuracy))
        } else {
            try locationUnavailableRequest(identity: identity, reason: reason)
        }
        let (statusCode, body) = try await send(request)
        try parseOk(status: statusCode, body: body)
        ChildNotifier.post("A parent viewed this device's location")
    }
    func askForTime(minutes: UInt32, message: String) async {
        busy = true; defer { busy = false }
        do {
            guard let identity = try Vault.load() else { throw ClientError.message("Enroll first") }
            let (statusCode, body) = try await send(try timeRequest(identity: identity, minutes: minutes, message: message))
            _ = try parseTimeRequest(status: statusCode, body: body)
            await refresh()
            status = "Request sent to your parents."
        } catch { status = error.localizedDescription }
    }
    func install() async {
        busy = true; defer { busy = false }
        do {
            guard let identity = try Vault.load(), let state = identity.state else { throw ClientError.message("Enroll first") }
            let identifier = Bundle.main.object(forInfoDictionaryKey: "TunnelBundleIdentifier") as! String
            let managers = try await NETunnelProviderManager.loadAllFromPreferences()
            let manager = managers.first { ($0.protocolConfiguration as? NETunnelProviderProtocol)?.providerBundleIdentifier == identifier } ?? NETunnelProviderManager()
            let config = NETunnelProviderProtocol()
            config.providerBundleIdentifier = identifier; config.serverAddress = state.tunnel.endpoint
            config.includeAllNetworks = true; config.excludeLocalNetworks = false
            manager.protocolConfiguration = config; manager.localizedDescription = "Temperance Family VPN"; manager.isEnabled = true
            let rule = NEOnDemandRuleConnect(); rule.interfaceTypeMatch = .any
            manager.onDemandRules = [rule]; manager.isOnDemandEnabled = true
            try await manager.saveToPreferences(); try await manager.loadFromPreferences()
            try manager.connection.startVPNTunnel(); self.manager = manager; connected = true
            status = "VPN installed. Connection status appears in system VPN settings."
        } catch { status = error.localizedDescription }
    }
}
@main struct TemperanceApp: App {
    @StateObject private var client = Client()
    @State private var service = ""
    @State private var code = ""
    @State private var name = ""
    @State private var note = ""
    var body: some Scene {
        WindowGroup {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("Temperance").font(.largeTitle).bold()
                    Text(client.status).foregroundStyle(.secondary).accessibilityIdentifier("status")
                    if let child = client.child {
                        Text(child.headline).font(.title2).bold()
                        Text(child.detail)
                        Text(child.remainingMinutes.map { "\($0) min left today" } ?? "No daily limit")
                        if let next = child.nextChange { Text(next).foregroundStyle(.secondary) }
                        ForEach(client.health, id: \.code) { issue in
                            VStack(alignment: .leading) {
                                Text(issue.message).bold()
                                Text(issue.action).font(.callout).foregroundStyle(.secondary)
                            }.accessibilityElement(children: .combine)
                        }
                        if child.pendingRequest {
                            Text("Your request for more time is waiting for a parent.")
                        } else if child.canRequestTime {
                            TextField("Why do you need more time?", text: $note)
                            HStack {
                                ForEach([15, 30, 60] as [UInt32], id: \.self) { minutes in
                                    Button("+\(minutes) min") { Task { await client.askForTime(minutes: minutes, message: note) } }
                                }
                            }
                        }
                        Button("Install / start VPN") { Task { await client.install() } }.buttonStyle(.borderedProminent)
                        Button("Refresh policy") { Task { await client.refresh() } }
                        Button("Allow alerts and parent location requests") {
                            ChildNotifier.requestPermission()
                            client.location.requestPermission()
                        }
                    } else {
                        TextField("https://policy.example.com", text: $service)
                        SecureField("Enrollment code", text: $code)
                        TextField("Device name", text: $name)
                        Button("Enroll device") { Task { await client.enroll(service: service, code: code, name: name) } }.buttonStyle(.borderedProminent)
                    }
                    Text("Full tunnel with automatic reconnection. Managed-device restrictions are required to prevent the owner from removing the VPN. IPv6 internet traffic is captured and blocked by this gateway version.").font(.caption).foregroundStyle(.secondary)
                }.padding(32).frame(maxWidth: 600).disabled(client.busy)
            }.task { while !Task.isCancelled { await client.refresh(); try? await Task.sleep(nanoseconds: 30_000_000_000) } }
        }
    }
}
