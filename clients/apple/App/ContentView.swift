import SwiftUI

struct ContentView: View {
    @ObservedObject var client: Client
    @State private var service = ""
    @State private var username = ""
    @State private var password = ""
    @State private var name = ""
    @State private var note = ""
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Temperance").font(.largeTitle).bold()
                Text(client.status).foregroundStyle(.secondary).accessibilityIdentifier("status")
                if let child = client.child {
                    Text(child.headline).font(.title2).bold()
                    Text(child.detail)
                    Text(child.remainingMinutes.map { "\($0) min left today" } ?? "No daily limit")
                    if let next = child.nextChange { Text(next).foregroundStyle(.secondary) }
                    ForEach(client.health, id: \.code) { issue in
                        VStack(alignment: .leading) {
                            Text(issue.message).bold()
                            Text(issue.action).font(.callout).foregroundStyle(.secondary)
                        }.accessibilityElement(children: .combine)
                    }
                    if child.pendingRequest {
                        Text("Your request for more time is waiting for a parent.")
                    } else if child.canRequestTime {
                        TextField("Why do you need more time?", text: $note)
                        HStack {
                            ForEach([15, 30, 60] as [UInt32], id: \.self) { minutes in
                                Button("+\(minutes) min") { Task { await client.askForTime(minutes: minutes, message: note) } }
                            }
                        }
                    }
                    Button("Install / start VPN") { Task { await client.install() } }.buttonStyle(.borderedProminent)
                    Button("Refresh policy") { Task { await client.refresh() } }
                    Button("Allow alerts and parent location requests") { client.allowAlerts() }
                } else {
                    TextField("https://policy.example.com", text: $service)
                    TextField("Username", text: $username)
                    SecureField("Password", text: $password)
                    TextField("Device name", text: $name)
                    Button("Sign in to this device") { Task { await client.enroll(service: service, username: username, password: password, name: name); password = "" } }.buttonStyle(.borderedProminent)
                }
                Text("Full tunnel with automatic reconnection. Managed-device restrictions are required to prevent the owner from removing the VPN. IPv6 internet traffic is captured and blocked by this gateway version.").font(.caption).foregroundStyle(.secondary)
            }.padding(32).frame(maxWidth: 600).disabled(client.busy)
        }.task { while !Task.isCancelled { await client.refresh(); try? await Task.sleep(nanoseconds: 30_000_000_000) } }
    }
}
