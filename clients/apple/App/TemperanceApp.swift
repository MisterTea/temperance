import SwiftUI
import NetworkExtension
import WireGuardKit

final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
@MainActor final class Client: ObservableObject {
    @Published var status = "Enroll to install your family's VPN."
    @Published var state: DeviceState?
    @Published var busy = false
    private var manager: NETunnelProviderManager?
    private let session = URLSession(configuration: .ephemeral, delegate: NoRedirect(), delegateQueue: nil)
    init() {
        do { state = try Vault.load()?.state } catch { status = error.localizedDescription }
    }
    func request(service: URL, path: String, token: String? = nil, body: [String: String]? = nil) async throws -> DeviceState {
        var request = URLRequest(url: service.appendingPathComponent(path))
        request.timeoutInterval = 15
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body { request.httpMethod = "POST"; request.httpBody = try JSONSerialization.data(withJSONObject: body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse, response.statusCode == 200,
              response.url?.host == service.host, response.url?.scheme == "https" else { throw ClientError.message("Policy service rejected this request") }
        return try JSONDecoder().decode(DeviceState.self, from: data)
    }
    func enroll(service: String, code: String, name: String) async {
        busy = true; defer { busy = false }
        do {
            guard let url = URL(string: service), url.scheme == "https", url.host != nil, url.user == nil,
                  url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/" else { throw ClientError.message("Enter an HTTPS service origin") }
            guard try Vault.load()?.state == nil else { throw ClientError.message("Device already enrolled") }
            let privateKey = PrivateKey()
            var identity = Identity(service: url, privateKey: privateKey.base64Key, state: nil)
            try Vault.save(identity)
            identity.state = try await request(service: url, path: "v1/enroll", body: ["code": code, "name": name, "public_key": privateKey.publicKey.base64Key])
            _ = try tunnelConfiguration(identity)
            try Vault.save(identity); state = identity.state; status = "Enrolled. Install VPN to connect."
        } catch { status = error.localizedDescription }
    }
    func refresh() async {
        do {
            guard var identity = try Vault.load(), let token = identity.state?.token else { return }
            var latest = try await request(service: identity.service, path: "v1/device/state", token: token)
            latest.token = token; identity.state = latest; try Vault.save(identity)
            state = latest; status = "Policy \(latest.version) · \(latest.policy.used) network activity minutes"
        } catch { status = "Policy refresh unavailable; existing VPN remains configured." }
    }
    func install() async {
        busy = true; defer { busy = false }
        do {
            guard let identity = try Vault.load(), identity.state != nil else { throw ClientError.message("Enroll first") }
            let identifier = Bundle.main.object(forInfoDictionaryKey: "TunnelBundleIdentifier") as! String
            let managers = try await NETunnelProviderManager.loadAllFromPreferences()
            let manager = managers.first { ($0.protocolConfiguration as? NETunnelProviderProtocol)?.providerBundleIdentifier == identifier } ?? NETunnelProviderManager()
            let config = NETunnelProviderProtocol()
            config.providerBundleIdentifier = identifier; config.serverAddress = identity.state!.tunnel.endpoint
            config.includeAllNetworks = true; config.excludeLocalNetworks = false
            manager.protocolConfiguration = config; manager.localizedDescription = "Temperance Family VPN"; manager.isEnabled = true
            let rule = NEOnDemandRuleConnect(); rule.interfaceTypeMatch = .any
            manager.onDemandRules = [rule]; manager.isOnDemandEnabled = true
            try await manager.saveToPreferences(); try await manager.loadFromPreferences()
            try manager.connection.startVPNTunnel(); self.manager = manager
            status = "VPN installed. Connection status appears in system VPN settings."
        } catch { status = error.localizedDescription }
    }
}
@main struct TemperanceApp: App {
    @StateObject private var client = Client()
    @State private var service = ""
    @State private var code = ""
    @State private var name = ""
    var body: some Scene {
        WindowGroup {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("Temperance").font(.largeTitle).bold()
                    Text("Your family's rules, wherever you go.").foregroundStyle(.secondary)
                    Text(client.status).accessibilityIdentifier("status")
                    if let state = client.state {
                        Text("\(state.policy.name) · Policy \(state.version)")
                        Text(state.policy.paused ? "Access paused by your family" : "\(state.policy.used) observed network minutes · \(state.policy.limit == 0 ? "unlimited" : "\(state.policy.limit) minute budget")")
                        Button("Install / start VPN") { Task { await client.install() } }.buttonStyle(.borderedProminent)
                        Button("Refresh policy") { Task { await client.refresh() } }
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
