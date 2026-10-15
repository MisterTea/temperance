import Foundation

/// Which app this install is: a client's protected device or an admin's remote.
enum Mode: String {
    case child, parent
}

/// Admin mode: pair once with the dashboard's QR code, then open the home
/// dashboard through the gateway's UDP port (`RemoteSession` in the shared core).
/// It never asks for VPN permission.
@MainActor final class Parent: ObservableObject {
    @Published private(set) var paired: ParentSummary?
    @Published private(set) var dashboard: URL?
    @Published private(set) var busy = false
    @Published var status = ""
    private let store: ParentStore
    private let pairing: @Sendable (String, String) throws -> String
    private let starting: (String) throws -> RemoteSessionProtocol
    private var session: RemoteSessionProtocol?

    init(store: ParentStore = ParentVault(),
         pair: @escaping @Sendable (String, String) throws -> String = { try pairParent(link: $0, deviceName: $1) },
         start: @escaping (String) throws -> RemoteSessionProtocol = { try RemoteSession.start(identity: $0) }) {
        self.store = store; self.pairing = pair; self.starting = start
        do { if let identity = try store.load() { paired = try describeParentIdentity(identity: identity) } }
        catch { status = error.message }
    }

    /// The pairing dials home, so it runs off the main thread.
    func pair(link: String, name: String) async {
        busy = true; defer { busy = false }
        do {
            let link = link.trimmingCharacters(in: .whitespacesAndNewlines)
            _ = try parsePairingLink(link: link)
            let pairing = self.pairing
            let identity = try await Task.detached { try pairing(link, name) }.value
            try store.save(identity)
            paired = try describeParentIdentity(identity: identity)
            status = ""
            open()
        } catch { status = error.message }
    }

    func open() {
        do {
            guard let identity = try store.load() else { throw ClientError.message("Pair this \(deviceNoun) first") }
            let session = try self.session ?? starting(identity)
            self.session = session
            dashboard = URL(string: session.url())
        } catch { status = error.message }
    }

    func close() {
        session?.stop()
        session = nil
        dashboard = nil
    }

    func forget() {
        close()
        do { try store.clear(); paired = nil; status = "" }
        catch { status = error.message }
    }
}
