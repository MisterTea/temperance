import SwiftUI

@main struct TemperanceApp: App {
    @StateObject private var client = Client(vpn: systemVPN())
    @StateObject private var parent = Parent()
    var body: some Scene {
        #if os(macOS)
        // Without a minimum width, the window's minimum height is that of text wrapped at almost no width.
        WindowGroup { RootView(client: client, parent: parent).frame(minWidth: 420) }.defaultSize(width: 540, height: 660)
        #else
        WindowGroup { RootView(client: client, parent: parent) }
        #endif
    }
}
