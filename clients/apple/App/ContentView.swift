import SwiftUI

struct ContentView: View {
    @ObservedObject var client: Client
    /// Back to the mode choice, offered until the device is enrolled.
    var back: (() -> Void)?
    @State private var service = ""
    @State private var username = ""
    @State private var password = ""
    @State private var name = ""
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
        .refreshable { await client.refresh() }
        .task { while !Task.isCancelled { await client.refresh(); try? await Task.sleep(nanoseconds: 30_000_000_000) } }
    }

    private var signIn: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Sign in this \(deviceNoun)").font(.title2).bold()
            Text("Use the username and password a parent made for you on the family dashboard. Your password isn't saved on this \(deviceNoun).")
            Field("Family dashboard address") {
                TextField("Family dashboard address", text: $service, prompt: Text(verbatim: "https://myhome.example.com")).plainEntry(.URL)
            }
            Field("Username") { TextField("Username", text: $username).plainEntry(.username) }
            Field("Password") { SecureField("Password", text: $password).plainEntry(.password) }
            Field("Name for this \(deviceNoun)") {
                TextField("Name for this \(deviceNoun)", text: $name, prompt: Text(verbatim: "Alex's \(deviceNoun)"))
            }
            Button { Task { await client.enroll(service: service, username: username, password: password, name: name); password = "" } } label: {
                Text("Sign in").frame(maxWidth: .infinity)
            }.buttonStyle(.borderedProminent).controlSize(.large)
            if client.busy { ProgressView().frame(maxWidth: .infinity) }
            if let back { Button("I'm a parent instead", action: back) }
        }
    }

    private var allowVPN: some View {
        VStack(alignment: .leading, spacing: 16) {
            if !client.profile.isEmpty { Text(client.profile).font(.title2).bold() }
            Text("You're signed in. Your family's rules for this profile come with your account.")
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
