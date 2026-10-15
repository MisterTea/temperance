import SwiftUI
#if os(iOS)
import VisionKit
#endif

struct ContentView: View {
    @ObservedObject var client: Client
    /// Back to the mode choice, offered until the device is enrolled.
    var back: (() -> Void)?
    @State private var home = ""
    @State private var scanning = false
    @State private var username = ""
    @State private var password = ""
    @State private var note = ""
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Temperance").font(.largeTitle).bold()
                if !client.status.isEmpty {
                    Text(client.status).foregroundStyle(.secondary).accessibilityIdentifier("status")
                }
                if let child = client.child {
                    if client.vpnInstalled == false { allowVPN } else { status(child) }
                } else {
                    signIn
                }
            }.padding(32).frame(maxWidth: 600, alignment: .leading).disabled(client.busy)
        }
        #if os(iOS)
        .sheet(isPresented: $scanning) {
            QRScanner(prefix: "temperance://home#") { code in scanning = false; home = code }.ignoresSafeArea()
        }
        #endif
        .refreshable { await client.refresh() }
        .task { while !Task.isCancelled { await client.refresh(); try? await Task.sleep(nanoseconds: 30_000_000_000) } }
    }

    private var signIn: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Sign in this \(deviceNoun)").font(.title2).bold()
            Text("On the family dashboard at home, a parent opens Devices and shows the setup code. Then use the username and password a parent made for you. Your password isn't saved on this \(deviceNoun).")
            #if os(iOS)
            if DataScannerViewController.isSupported {
                Button { scanning = true } label: {
                    Label("Scan the setup code", systemImage: "qrcode.viewfinder")
                }.buttonStyle(.bordered).controlSize(.large)
            }
            #endif
            Field(setupCodeLabel) {
                TextField(setupCodeLabel, text: $home, prompt: Text(verbatim: "temperance://home#…"), axis: .vertical)
                    .lineLimit(1...3).plainEntry(.URL)
            }
            Field("Username") { TextField("Username", text: $username).plainEntry(.username) }
            PasswordField(label: "Password", text: $password)
            Button { Task { await client.enroll(home: home, username: username, password: password, name: defaultDeviceName()); password = "" } } label: {
                Text("Sign in").frame(maxWidth: .infinity)
            }.buttonStyle(.borderedProminent).controlSize(.large)
            if client.busy { ProgressView().frame(maxWidth: .infinity) }
            if let back { Button("I'm a parent instead", action: back) }
        }
    }

    private var allowVPN: some View {
        VStack(alignment: .leading, spacing: 16) {
            if !client.profile.isEmpty { Text(client.profile).font(.title2).bold() }
            Text("You're signed in. Your rules and time budget come with this account.")
            Text("One last step").font(.headline)
            Text("Allow the family VPN so the rules work on this \(deviceNoun). Your \(deviceNoun) asks you to confirm.")
            Button { Task { await client.install() } } label: {
                Text("Allow VPN connection").frame(maxWidth: .infinity)
            }.buttonStyle(.borderedProminent).controlSize(.large)
        }
    }

    private func status(_ child: ChildStatus) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(child.headline).font(.title).bold()
            Text(child.detail)
            Text(child.remainingMinutes.map { "\($0) min left today" } ?? "No daily limit").font(.title3)
            if let next = child.nextChange { Text(next).foregroundStyle(.secondary) }
            ForEach(client.health, id: \.code) { issue in
                VStack(alignment: .leading) {
                    Text(issue.message).bold()
                    Text(issue.action).font(.callout).foregroundStyle(.secondary)
                }.accessibilityElement(children: .combine)
            }
            if client.health.contains(where: { ["tunnel_down", "vpn_permission"].contains($0.code) }) {
                Button("Turn on the VPN") { Task { await client.install() } }.buttonStyle(.borderedProminent)
            }
            if !client.alerts.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Recent alerts").font(.headline)
                    ForEach(Array(client.alerts.enumerated()), id: \.offset) { _, alert in Text(alert) }
                }
            }
            if child.pendingRequest {
                Text("Your request for more time is waiting for a parent.")
            } else if child.canRequestTime {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Need more time?").font(.headline)
                    TextField("Why do you need more time?", text: $note).textFieldStyle(.roundedBorder)
                    HStack {
                        ForEach([15, 30, 60] as [UInt32], id: \.self) { minutes in
                            Button("+\(minutes) min") { Task { if await client.askForTime(minutes: minutes, message: note) { note = "" } } }.buttonStyle(.bordered)
                        }
                    }
                }
            }
            if client.canAskPermissions {
                Button("Allow alerts and parent location requests") { client.allowAlerts() }
            }
            #if os(macOS)
            Button("Check for new rules") { Task { await client.refresh() } }
            #endif
        }
    }
}

/// A text field with its label above it.
struct Field<Content: View>: View {
    let label: String
    let content: Content
    init(_ label: String, @ViewBuilder content: () -> Content) { self.label = label; self.content = content() }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.subheadline).foregroundStyle(.secondary).accessibilityHidden(true)
            content.textFieldStyle(.roundedBorder).accessibilityLabel(Text(label))
        }
    }
}

/// A password field with an eye button inside it that shows or masks what was typed.
struct PasswordField: View {
    let label: String
    @Binding var text: String
    @State private var shown = false
    @FocusState private var focused: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.subheadline).foregroundStyle(.secondary).accessibilityHidden(true)
            HStack(spacing: 0) {
                Group {
                    if shown { TextField(label, text: $text) } else { SecureField(label, text: $text) }
                }
                .textFieldStyle(.plain).plainEntry(.password).focused($focused)
                .accessibilityLabel(Text(label))
                Button {
                    shown.toggle()
                    focused = true
                } label: {
                    Image(systemName: shown ? "eye.slash" : "eye")
                        .frame(width: Self.button.width, height: Self.button.height).contentShape(Rectangle())
                }
                .buttonStyle(.borderless).foregroundStyle(.secondary)
                .accessibilityLabel(shown ? "Hide password" : "Show password")
                .accessibilityIdentifier("revealPassword")
                .help(shown ? "Hide password" : "Show password")
            }
            .padding(.leading, 7).padding(.vertical, 1)
            .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Self.fill))
            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(.quaternary))
        }
    }
    #if os(iOS)
    private static let fill = Color(uiColor: .systemBackground)
    private static let button = CGSize(width: 40, height: 34)
    #else
    private static let fill = Color(nsColor: .textBackgroundColor)
    private static let button = CGSize(width: 28, height: 22)
    #endif
}

enum Entry { case URL, username, password }

extension View {
    /// Typed exactly as entered: no capitals or corrections.
    func plainEntry(_ entry: Entry) -> some View {
        #if os(iOS)
        let type: UITextContentType = switch entry { case .URL: .URL; case .username: .username; case .password: .password }
        return autocorrectionDisabled().textInputAutocapitalization(.never).textContentType(type).keyboardType(entry == .URL ? .URL : .default)
        #else
        return autocorrectionDisabled()
        #endif
    }
}
