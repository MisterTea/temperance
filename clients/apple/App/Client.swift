import CoreLocation
import Foundation

/// The system VPN configuration that runs the tunnel extension (`SystemVPN`).
protocol VPNControl {
    /// `nil` when no Temperance configuration is installed.
    func status() async -> (enabled: Bool, connected: Bool)?
    func install(endpoint: String) async throws
}

/// Local notifications to the child (`ChildNotifier`).
protocol Notifier {
    func post(_ message: String)
    func requestPermission()
    /// `nil` until the child has been asked.
    func allowed() async -> Bool?
}

/// One-time location fixes for a parent's request (`LocationResponder`).
@MainActor protocol LocationSource: AnyObject {
    var allowed: Bool? { get }
    func requestPermission()
    func currentLocation() async -> (CLLocation?, String)
}

/// Sends requests built by the shared Rust core over the platform's HTTPS stack, never following redirects.
final class HTTPSTransport: NSObject, URLSessionTaskDelegate {
    private var session: URLSession!
    init(configuration: URLSessionConfiguration = .ephemeral) {
        super.init()
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
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
}

@MainActor final class Client: ObservableObject {
    /// A short message about the last action, empty when there's nothing to say.
    @Published var status = ""
    @Published var child: ChildStatus?
    /// The profile's avatar and name, e.g. "🦊 Riley".
    @Published var profile = ""
    /// `nil` until checked; `false` until the child allows the family VPN.
    @Published var vpnInstalled: Bool?
    /// Notifications or location permission hasn't been asked for yet.
    @Published var canAskPermissions = false
    @Published var busy = false
    @Published var health: [Diagnostic] = []
    /// Recent alerts, newest first, also shown in the app: a notification
    /// doesn't appear while the app is open, or once the child dismisses it.
    @Published var alerts: [String] = []
    private var reported: [String]?
    private var connected = false
    private let send: (HttpRequest) async throws -> (UInt16, String)
    private let store: IdentityStore
    private let vpn: VPNControl
    private let notifier: Notifier
    private let clock: () -> Int64
    let location: LocationSource

    init(send: ((HttpRequest) async throws -> (UInt16, String))? = nil, store: IdentityStore = Vault(), vpn: VPNControl = SystemVPN(),
         notifier: Notifier = ChildNotifier(), location: LocationSource? = nil, clock: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970) }) {
        let transport = HTTPSTransport()
        self.send = send ?? { try await transport.send($0) }
        self.store = store; self.vpn = vpn; self.notifier = notifier; self.clock = clock
        self.location = location ?? LocationResponder()
        do { if let state = try store.load()?.state { try show(state) } }
        catch { status = error.localizedDescription }
    }
    private func show(_ state: DeviceState) throws {
        child = try childStatus(state: state, now: clock())
        profile = [state.policy.avatar, state.policy.name].filter { !$0.isEmpty }.joined(separator: " ")
    }
    func enroll(service: String, username: String, password: String, name: String) async {
        busy = true; defer { busy = false }
        do {
            guard try store.load()?.state == nil else { throw ClientError.message("Device already enrolled") }
            let origin = try validateService(raw: service)
            let keys = generateKeypair()
            let (statusCode, body) = try await send(try signInRequest(service: origin, username: username, password: password, name: name, publicKey: keys.publicKey))
            let identity = try enrolledIdentity(service: origin, keys: keys, status: statusCode, body: body)
            _ = try tunnelConfiguration(identity)
            try store.save(identity)
            try show(identity.state!)
            vpnInstalled = await vpn.status()?.enabled == true
            status = ""
        } catch { status = error.localizedDescription }
    }
    func refresh() async {
        do {
            guard let identity = try store.load(), identity.state != nil else { return }
            let (statusCode, body) = try await send(try stateRequest(identity: identity))
            let latest = try parseDeviceState(status: statusCode, body: body)
            let alerts = childAlerts(previous: identity.state, current: latest, now: clock())
            let next = try refreshedIdentity(identity: identity, latest: latest, connected: connected)
            try store.save(next)
            try show(next.state!)
            status = ""
            alerts.forEach(notifier.post)
            self.alerts = Array((alerts.reversed() + self.alerts).prefix(5))
            if latest.locationRequested { try await shareLocation(next) }
            await checkHealth(next, policyReachable: true)
        } catch {
            status = "Can't reach your family's Temperance right now. The last rules stay in effect."
            if let identity = try? store.load() { await checkHealth(identity, policyReachable: false) }
        }
    }
    /// Gathers platform facts; the shared core decides what they mean. Reports changes to parents.
    private func checkHealth(_ identity: Identity, policyReachable: Bool) async {
        let vpnStatus = await vpn.status()
        let notificationsAllowed = await notifier.allowed()
        let facts = DeviceFacts(
            vpnPermission: vpnStatus?.enabled ?? false,
            tunnelUp: vpnStatus?.connected ?? false,
            secondsSinceHandshake: nil,
            connectivity: nil,
            policyReachable: policyReachable,
            notificationsAllowed: notificationsAllowed,
            locationAllowed: location.allowed,
            portalSignInUntil: nil)
        vpnInstalled = vpnStatus?.enabled == true
        canAskPermissions = notificationsAllowed == nil || location.allowed == nil
        health = diagnose(facts: facts, now: clock())
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
        notifier.post("A parent viewed this device's location")
    }
    /// `true` once the request reached the parents.
    @discardableResult func askForTime(minutes: UInt32, message: String) async -> Bool {
        busy = true; defer { busy = false }
        do {
            guard let identity = try store.load() else { throw ClientError.message("Enroll first") }
            let (statusCode, body) = try await send(try timeRequest(identity: identity, minutes: minutes, message: message))
            _ = try parseTimeRequest(status: statusCode, body: body)
            await refresh()
            status = "Request sent to your parents."
            return true
        } catch { status = error.localizedDescription; return false }
    }
    func install() async {
        busy = true; defer { busy = false }
        do {
            guard let state = try store.load()?.state else { throw ClientError.message("Enroll first") }
            try await vpn.install(endpoint: state.tunnel.endpoint)
            connected = true
            await refresh()
            vpnInstalled = true
        } catch { status = error.localizedDescription }
    }
    func allowAlerts() {
        notifier.requestPermission()
        location.requestPermission()
        canAskPermissions = false
    }
}
