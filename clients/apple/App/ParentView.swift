import SwiftUI
import WebKit
#if os(iOS)
import VisionKit
#endif

/// The first screen of a fresh install, then whichever mode it chose. An
/// enrolled child device always stays in child mode.
struct RootView: View {
    @ObservedObject var client: Client
    @ObservedObject var parent: Parent
    @AppStorage("mode") private var mode = ""
    var resolved: Mode? {
        if client.child != nil { return .child }
        if parent.paired != nil { return .parent }
        return Mode(rawValue: mode)
    }
    var body: some View {
        switch resolved {
        case .child: ContentView(client: client, back: client.child == nil ? { mode = "" } : nil)
        case .parent: ParentView(parent: parent, back: { mode = "" })
        case nil: ModeChoice { mode = $0.rawValue }
        }
    }
}

struct ModeChoice: View {
    var choose: (Mode) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Temperance").font(.largeTitle).bold()
            Text("Is this your child's device, or are you a parent?").font(.title3).fixedSize(horizontal: false, vertical: true)
            Button { choose(.child) } label: {
                Label("This is my child's device", systemImage: deviceSymbol).frame(maxWidth: .infinity)
            }.buttonStyle(.borderedProminent).controlSize(.large)
            Button { choose(.parent) } label: {
                Label("I'm a parent", systemImage: "person.badge.key").frame(maxWidth: .infinity)
            }.buttonStyle(.bordered).controlSize(.large)
            Text("A child's device installs the family VPN. A parent's phone or computer opens the family dashboard from anywhere, with no VPN.")
                .font(.caption).foregroundStyle(.secondary)
        }.padding(32).frame(maxWidth: 600)
    }
}

struct ParentView: View {
    @ObservedObject var parent: Parent
    var back: () -> Void
    @State private var link = ""
    @State private var name = defaultDeviceName()
    @State private var scanning = false
    @State private var unpairing = false
    @State private var loading = true
    var body: some View {
        if let url = parent.dashboard {
            VStack(spacing: 0) {
                HStack {
                    Button("Done") { parent.close() }
                    Spacer()
                    Text(parent.paired?.household.isEmpty == false ? parent.paired!.household : "Family dashboard").bold()
                    Spacer()
                    Button("Reload") { parent.close(); parent.open() }
                }.padding(.horizontal).padding(.vertical, 10)
                DashboardWebView(url: url) { loading = false }
                    .overlay { if loading { ProgressView("Opening the dashboard…") } }
            }.onAppear { loading = true }
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("Temperance").font(.largeTitle).bold()
                    if let paired = parent.paired {
                        Text(paired.household.isEmpty ? "Paired with your home" : "Paired with \(paired.household)").font(.title2).bold()
                        Text("This \(deviceNoun) opens the family dashboard through your home's Temperance gateway, wherever you are.")
                        Button("Open dashboard") { parent.open() }.buttonStyle(.borderedProminent).controlSize(.large)
                        Button("Unpair this \(deviceNoun)", role: .destructive) { unpairing = true }
                            .confirmationDialog("Unpair this \(deviceNoun)?", isPresented: $unpairing) {
                                Button("Unpair", role: .destructive) { parent.forget() }
                            } message: {
                                Text("This \(deviceNoun) will stop opening the family dashboard. To use it again, pair it from the dashboard at home.")
                            }
                    } else {
                        Text("Pair this \(deviceNoun)").font(.title2).bold()
                        Text("On the family dashboard at home, open Settings → Parent devices and choose Pair a parent device.")
                        #if os(iOS)
                        if DataScannerViewController.isSupported {
                            Button { scanning = true } label: {
                                Label("Scan the QR code", systemImage: "qrcode.viewfinder")
                            }.buttonStyle(.borderedProminent).controlSize(.large)
                        }
                        #endif
                        Field(pasteLinkLabel) {
                            TextField(pasteLinkLabel, text: $link, prompt: Text(verbatim: "temperance://pair#…"), axis: .vertical)
                                .lineLimit(1...3).plainEntry(.URL)
                        }
                        Field("Name for this \(deviceNoun)") { TextField("Name for this \(deviceNoun)", text: $name) }
                        Button { Task { await parent.pair(link: link, name: name) } } label: {
                            Text("Pair").frame(maxWidth: .infinity)
                        }.buttonStyle(.borderedProminent).controlSize(.large).disabled(link.isEmpty || name.isEmpty)
                        if parent.busy { ProgressView().frame(maxWidth: .infinity) }
                        Button("This is a child's device instead", action: back)
                    }
                    if !parent.status.isEmpty { Text(parent.status).foregroundStyle(.red).accessibilityIdentifier("status") }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(32).frame(maxWidth: 600).disabled(parent.busy)
            }
            #if os(iOS)
            .sheet(isPresented: $scanning) {
                QRScanner { code in
                    scanning = false
                    link = code
                    Task { await parent.pair(link: code, name: name) }
                }.ignoresSafeArea()
            }
            #endif
        }
    }
}

#if os(iOS)
let deviceNoun = "phone"
let deviceSymbol = "iphone.gen3"
let pasteLinkLabel = "Or paste the pairing link"
func defaultDeviceName() -> String { UIDevice.current.name }

struct QRScanner: UIViewControllerRepresentable {
    var found: (String) -> Void
    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        return scanner
    }
    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        if !scanner.isScanning { try? scanner.startScanning() }
    }
    func makeCoordinator() -> Coordinator { Coordinator(found: found) }
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let found: (String) -> Void
        private var done = false
        init(found: @escaping (String) -> Void) { self.found = found }
        func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
            for case .barcode(let code) in items {
                guard !done, let text = code.payloadStringValue, text.hasPrefix("temperance://pair#") else { continue }
                done = true
                scanner.stopScanning()
                found(text)
            }
        }
    }
}
#else
let deviceNoun = "Mac"
let deviceSymbol = "laptopcomputer"
/// A Mac has no QR scanner to offer first.
let pasteLinkLabel = "Paste the pairing link"
func defaultDeviceName() -> String { Host.current().localizedName ?? "Mac" }
#endif

/// Shows the dashboard from the local proxy; any other address opens in the browser.
final class LoopbackOnly: NSObject, WKNavigationDelegate {
    let host: String?
    /// Called once a page has loaded or failed to.
    let loaded: () -> Void
    init(host: String?, loaded: @escaping () -> Void = {}) { self.host = host; self.loaded = loaded }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded() }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { loaded() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { loaded() }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if url.host == host || url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" { return decisionHandler(.allow) }
        decisionHandler(.cancel)
        #if os(iOS)
        UIApplication.shared.open(url)
        #else
        NSWorkspace.shared.open(url)
        #endif
    }
}

private func dashboardView(_ url: URL, _ delegate: LoopbackOnly) -> WKWebView {
    let config = WKWebViewConfiguration()
    // The proxy's cookie lives only as long as this session.
    config.websiteDataStore = .nonPersistent()
    let view = WKWebView(frame: .zero, configuration: config)
    view.navigationDelegate = delegate
    view.load(URLRequest(url: url))
    return view
}

#if os(iOS)
struct DashboardWebView: UIViewRepresentable {
    let url: URL
    var loaded: () -> Void = {}
    func makeCoordinator() -> LoopbackOnly { LoopbackOnly(host: url.host, loaded: loaded) }
    func makeUIView(context: Context) -> WKWebView { dashboardView(url, context.coordinator) }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
#else
struct DashboardWebView: NSViewRepresentable {
    let url: URL
    var loaded: () -> Void = {}
    func makeCoordinator() -> LoopbackOnly { LoopbackOnly(host: url.host, loaded: loaded) }
    func makeNSView(context: Context) -> WKWebView { dashboardView(url, context.coordinator) }
    func updateNSView(_ view: WKWebView, context: Context) {}
}
#endif
