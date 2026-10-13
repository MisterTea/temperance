import Foundation
import NetworkExtension

/// The system VPN, or in debug builds launched with `-SimulatedVPN YES` a
/// stand-in for where the tunnel extension can't run (the iOS simulator,
/// unsigned Mac builds), used to record the client storyboards.
func systemVPN() -> VPNControl {
    #if DEBUG
    if UserDefaults.standard.bool(forKey: "SimulatedVPN") { return SimulatedVPN() }
    #endif
    return SystemVPN()
}

#if DEBUG
struct SimulatedVPN: VPNControl {
    private let key = "simulatedVPNInstalled"
    func status() async -> (enabled: Bool, connected: Bool)? { UserDefaults.standard.bool(forKey: key) ? (true, true) : nil }
    func install(endpoint: String) async throws { UserDefaults.standard.set(true, forKey: key) }
}
#endif

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
