import NetworkExtension
import WireGuardKit

final class PacketTunnelProvider: NEPacketTunnelProvider {
    private lazy var adapter = WireGuardAdapter(with: self) { _, _ in } // No keys/config in system logs.
    override func startTunnel(options: [String: NSObject]?, completionHandler: @escaping (Error?) -> Void) {
        do {
            guard let identity = try Vault().load() else { throw ClientError.message("VPN identity missing") }
            let configuration = try tunnelConfiguration(identity)
            adapter.start(tunnelConfiguration: configuration) { error in completionHandler(error) }
        } catch { completionHandler(error) }
    }
    override func stopTunnel(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        adapter.stop { _ in completionHandler() }
    }
}
