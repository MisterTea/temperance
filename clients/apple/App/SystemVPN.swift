import Foundation
import NetworkExtension

/// The on-demand, full-tunnel NetworkExtension configuration for the bundled tunnel extension.
struct SystemVPN: VPNControl {
    private var identifier: String? { Bundle.main.object(forInfoDictionaryKey: "TunnelBundleIdentifier") as? String }
    private func ours(_ managers: [NETunnelProviderManager]) -> NETunnelProviderManager? {
        managers.first { ($0.protocolConfiguration as? NETunnelProviderProtocol)?.providerBundleIdentifier == identifier }
    }
    func status() async -> (enabled: Bool, connected: Bool)? {
        guard identifier != nil, let manager = ours((try? await NETunnelProviderManager.loadAllFromPreferences()) ?? []) else { return nil }
        return (manager.isEnabled, manager.connection.status == .connected)
    }
    func install(endpoint: String) async throws {
        guard let identifier else { throw ClientError.message("This build has no VPN extension") }
        let manager = ours(try await NETunnelProviderManager.loadAllFromPreferences()) ?? NETunnelProviderManager()
        let config = NETunnelProviderProtocol()
        config.providerBundleIdentifier = identifier; config.serverAddress = endpoint
        config.includeAllNetworks = true; config.excludeLocalNetworks = false
        manager.protocolConfiguration = config; manager.localizedDescription = "Temperance Family VPN"; manager.isEnabled = true
        let rule = NEOnDemandRuleConnect(); rule.interfaceTypeMatch = .any
        manager.onDemandRules = [rule]; manager.isOnDemandEnabled = true
        try await manager.saveToPreferences(); try await manager.loadFromPreferences()
        try manager.connection.startVPNTunnel()
    }
}
