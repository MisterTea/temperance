import Foundation
import Security
import WireGuardKit

enum ClientError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}
/// Persists the device identity; the apps use the shared Keychain (`Vault`).
protocol IdentityStore {
    func load() throws -> Identity?
    func save(_ identity: Identity) throws
}
/// Keychain storage shared with the tunnel extension. The identity format is
/// owned by the shared Rust core so every platform persists the same data.
struct Vault: IdentityStore {
    var service = "org.temperance.identity"
    var accessGroup = Bundle.main.object(forInfoDictionaryKey: "KeychainAccessGroup") as? String
    private var query: [String: Any] {
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: service,
                                    kSecAttrAccount as String: "device"]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }
    func load() throws -> Identity? {
        var q = query; q[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw ClientError.message("Keychain read failed: \(status)") }
        return try identityFromJson(json: String(decoding: data, as: UTF8.self))
    }
    func save(_ identity: Identity) throws {
        let data = Data(identityToJson(identity: identity).utf8)
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var q = query; q[kSecValueData as String] = data
            q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(q as CFDictionary, nil) == errSecSuccess else { throw ClientError.message("Keychain write failed") }
        } else if status != errSecSuccess { throw ClientError.message("Keychain update failed: \(status)") }
    }
}
func tunnelConfiguration(_ identity: Identity) throws -> TunnelConfiguration {
    guard let t = identity.state?.tunnel else { throw ClientError.message("Enroll first") }
    // The shared core validates every field and fixes the full-tunnel routes.
    _ = try tunnelConfig(privateKey: identity.privateKey, tunnel: t)
    guard let privateKey = PrivateKey(base64Key: identity.privateKey),
          let publicKey = PublicKey(base64Key: t.publicKey),
          let address = IPAddressRange(from: t.address),
          let addressV6 = IPAddressRange(from: t.addressV6),
          let dns = DNSServer(from: t.dns), let endpoint = Endpoint(from: t.endpoint) else { throw ClientError.message("Invalid VPN provisioning") }
    var interface = InterfaceConfiguration(privateKey: privateKey)
    interface.addresses = [address, addressV6]; interface.dns = [dns]; interface.mtu = 1280
    var peer = PeerConfiguration(publicKey: publicKey)
    peer.endpoint = endpoint; peer.allowedIPs = [IPAddressRange(from: "0.0.0.0/0")!, IPAddressRange(from: "::/0")!]; peer.persistentKeepAlive = 25
    return TunnelConfiguration(name: "Temperance", interface: interface, peers: [peer])
}
