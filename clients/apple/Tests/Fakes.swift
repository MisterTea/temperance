import CoreLocation
import Foundation

/// A scripted Temperance service speaking the same JSON as the Next.js server.
@MainActor final class FakeService {
    static let serverKey = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
    /// The dashboard's setup code for family.example:51820.
    static let home = "temperance://home#eyJ2IjoxLCJob3N0IjoiZmFtaWx5LmV4YW1wbGUiLCJwb3J0Ijo1MTgyMCwicGluIjoiQUFFQ0F3UUZCZ2NJQ1FvTERBME9EeEFSRWhNVUZSWVhHQmthR3h3ZEhoOCIsImhvdXNlaG9sZCI6IlRoZSBSaXZlcmFzIn0"
    var password = "correct horse"
    var reason = "allowed"
    var remaining = 40
    var version = 3
    var pending = false
    var unreachable = false
    var locationRequested = false
    private(set) var requests: [HttpRequest] = []

    func bodies(_ path: String) -> [String] { requests.filter { $0.url.hasSuffix(path) }.map { $0.body ?? "" } }

    func send(_ request: HttpRequest) async throws -> (UInt16, String) {
        requests.append(request)
        if unreachable { throw URLError(.cannotFindHost) }
        let body = request.body ?? ""
        switch "\(request.method) \(URL(string: request.url)!.path)" {
        case "POST /v1/device/login":
            return body.contains("\"password\":\"\(password)\"") ? (200, state(token: true)) : (401, #"{"error":"Invalid username or password"}"#)
        case "GET /v1/device/state":
            return (200, state(token: false))
        case "POST /v1/device/requests":
            pending = true
            let minutes = (try JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any])?["minutes"] as? Int ?? 0
            return (200, #"{"id":"r1","minutes":\#(minutes),"message":"","status":"pending","at":\#(Self.now)}"#)
        case "POST /v1/device/diagnostics", "POST /v1/device/location":
            return (200, "{}")
        default:
            return (404, #"{"error":"Not found"}"#)
        }
    }

    static var now: Int64 { Int64(Date().timeIntervalSince1970) }

    func state(token: Bool) -> String {
        let requests = pending ? #"[{"id":"r1","minutes":15,"message":"","status":"pending","at":\#(Self.now)}]"# : "[]"
        return """
        {\(token ? #""token":"device-token","# : "")"device_id":"dev-1","version":\(version),
        "policy":{"id":1,"name":"Alex","limit":60,"used":\(60 - remaining),"timezone":"UTC"},
        "tunnel":{"address":"10.77.0.2/32","address_v6":"fd77::2/128","dns":"10.77.0.1","endpoint":"192.0.2.1:51820","public_key":"\(Self.serverKey)","allowed_ips":"0.0.0.0/0, ::/0","keepalive":25},
        "status":{"reason":"\(reason)","remaining_minutes":\(remaining),"active_windows":[],"observed_at":\(Self.now)},
        "requests":\(requests),"location_requested":\(locationRequested)}
        """
    }

    /// An enrolled identity as the core builds it from a sign-in reply.
    func identity() throws -> Identity {
        try enrolledIdentity(service: Self.home, keys: generateKeypair(), status: 200, body: state(token: true))
    }
}

final class MemoryStore: IdentityStore {
    var identity: Identity?
    var failure: Error?
    init(_ identity: Identity? = nil) { self.identity = identity }
    func load() throws -> Identity? {
        if let failure { throw failure }
        return identity
    }
    func save(_ identity: Identity) throws { self.identity = identity }
}

final class FakeVPN: VPNControl {
    var current: (enabled: Bool, connected: Bool)?
    var failure: Error?
    private(set) var installed: [String] = []
    func status() async -> (enabled: Bool, connected: Bool)? { current }
    func install(endpoint: String) async throws {
        if let failure { throw failure }
        installed.append(endpoint)
        current = (true, true)
    }
}

final class FakeNotifier: Notifier {
    var permission: Bool?
    private(set) var posted: [String] = []
    private(set) var permissionRequests = 0
    func post(_ message: String) { posted.append(message) }
    func requestPermission() { permissionRequests += 1 }
    func allowed() async -> Bool? { permission }
}

@MainActor final class FakeLocation: LocationSource {
    var allowed: Bool?
    var fix: CLLocation?
    var reason = "location permission not granted"
    private(set) var permissionRequests = 0
    func requestPermission() { permissionRequests += 1 }
    func currentLocation() async -> (CLLocation?, String) { (fix, fix == nil ? reason : "") }
}

/// A CLLocationManager whose authorization and fixes the test controls.
final class FakeLocationManager: CLLocationManager {
    var status: CLAuthorizationStatus = .notDetermined
    var authorizationRequests = 0
    var locationRequests = 0
    override var authorizationStatus: CLAuthorizationStatus { status }
    override func requestWhenInUseAuthorization() { authorizationRequests += 1 }
    override func requestLocation() { locationRequests += 1 }
    func deliver(_ fix: CLLocation?) {
        if let fix { delegate?.locationManager?(self, didUpdateLocations: [fix]) }
        else { delegate?.locationManager?(self, didFailWithError: CLError(.locationUnknown)) }
    }
}
