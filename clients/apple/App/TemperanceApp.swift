import SwiftUI

@main struct TemperanceApp: App {
    @StateObject private var client = Client()
    var body: some Scene {
        WindowGroup { ContentView(client: client) }
    }
}
