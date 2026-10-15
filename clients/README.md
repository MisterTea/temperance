# Device applications

Each application enrolls a locally generated WireGuard public key through the policy service, receives full-tunnel provisioning, installs the VPN with OS consent/admin privileges, and refreshes policy status. Filtering and time controls apply at the Linux gateway, so mobile background refresh is not required for policy enforcement.

| Platform | App / tunnel integration | Build |
| --- | --- | --- |
| macOS 13+ | Native SwiftUI app + WireGuardKit Network Extension | `apple/bootstrap.sh`, Xcode `TemperanceMac` |
| iOS 16+ | Native SwiftUI app + WireGuardKit Network Extension | Same project, Xcode `TemperanceIOS` |
| Android 8+ | Kotlin app + embedded official WireGuard GoBackend + foreground session service | `cd android && ./gradlew assembleDebug` |
| Windows 10+ | Tauri app (Rust + React UI) + official WireGuard tunnel service; child or parent mode | `npx tauri build` (NSIS installer) |
| Linux | The same Tauri app, parent mode only | `npx tauri build` (`.deb`, AppImage) |

## Shared Rust core

Client business logic lives once in [`core/temperance-core`](../core/temperance-core): the home setup code (`temperance://home#…`) and the transport to home (`home_send`: plain HTTP inside the tunnel, otherwise QUIC pinned to the gateway's key, both on the WireGuard UDP port), WireGuard key generation, enrollment/refresh/time-request protocol (request building and response parsing), identity persistence format, full-tunnel config validation, the policy engine (verified against the same `specs/policy-cases.json` golden cases as the TypeScript service; the gateway uses this engine too), the child-facing status view ("Bedtime starts in 30 min", remaining minutes, ask-for-time eligibility), child alerts, location-request answers, and device diagnostics. `diagnose` turns facts each platform observes (VPN permission, tunnel state, WireGuard handshake age, captive-portal probe, notification and location permission) into ordered issues with a fix for the child; changes are reported to parents (`POST /v1/device/diagnostics`) and shown on the dashboard's Devices tab.

**Wi-Fi sign-in pages.** On the desktop app, "Sign in to Wi-Fi" appears only when the tunnel cannot reach the gateway. It lowers the tunnel for at most five minutes, probes `connectivitycheck.gstatic.com` outside the tunnel, restores protection as soon as the network is online, and parents are told afterwards. Android detects the captive-portal state itself and its sign-in flow runs outside the VPN (the app's button opens Wi-Fi settings); on Apple platforms `includeAllNetworks` always exempts captive-network sign-in traffic.

- **Windows and Linux desktop**: the Tauri backend in `core/temperance-desktop` links the crate natively (it also runs on macOS for development, in parent mode).
- **iOS / macOS apps**: `core/build-bindings.sh apple` builds `clients/apple/Core/TemperanceCoreFFI.xcframework` (device, simulator, macOS universal) and UniFFI Swift bindings; `apple/bootstrap.sh` runs it.
- **Android**: `core/build-bindings.sh android` builds `jniLibs` for arm64-v8a, armeabi-v7a, x86_64, x86 with `cargo-ndk` and generates Kotlin bindings; Gradle's `preBuild` runs it (set `TEMPERANCE_SKIP_RUST=1` to use prebuilt libraries).

Platform code only supplies keychain/keystore storage, VPN APIs, the QR scanner, and UI. Requirements: Rust (via rustup) with the mobile targets, `cargo-ndk` and `ANDROID_NDK_HOME` for Android, Xcode for Apple. Run `cargo test --workspace` in `core/` for unit, golden, and desktop tests.

## macOS / iOS

Install Xcode, Go, Rust (rustup with the Apple targets), Python 3, and XcodeGen. Run `clients/apple/bootstrap.sh`; it also builds the shared Rust core XCFramework. The script fetches a pinned WireGuardKit revision and applies two small compatibility fixes (Swift manifest tools version and a missing C system-types include), recorded in `patch-dependency.py`. The Go bridge build applies upstream's Darwin continuous-time runtime patch in an isolated build copy; it never modifies your installed Go toolchain.

Open `Temperance.xcodeproj`. Configure your Apple Developer team on both app/extension targets, enable Network Extensions and shared Keychain groups for the chosen bundle identifiers, and build the corresponding scheme. Set `DEVELOPMENT_TEAM` on the `xcodebuild` command line for CI signing. The shared Keychain group must match `$(AppIdentifierPrefix)org.temperance.shared`; private keys and device tokens use device-only Keychain storage shared with the tunnel extension. If you change identifiers, update the provider bundle ID and entitlements together.

Unsigned build verification (not an installable/distributable VPN):

```sh
cd clients/apple
xcodebuild -project Temperance.xcodeproj -scheme TemperanceMac \
  -derivedDataPath ../../build/apple CODE_SIGNING_ALLOWED=NO build
xcodebuild -project Temperance.xcodeproj -scheme TemperanceIOS \
  -destination 'generic/platform=iOS' -derivedDataPath ../../build/apple-ios \
  CODE_SIGNING_ALLOWED=NO build
```

Use an actual iPhone/iPad and correctly signed entitlement-bearing build for VPN testing. The Go bridge build targets macOS and physical iOS; iOS simulator VPN operation is not supported by this recipe. Distribution needs a signed/notarized macOS app or Apple provisioning/TestFlight/App Store review. On-demand reconnect and include-all-networks routing are enabled. Unmanaged devices can still remove the VPN; supervised/MDM restrictions are separate deployment work.

## Android

Requires JDK 17+ and Android SDK 36. The repository includes the Gradle 8.11.1 wrapper. The WireGuard library is pinned to `1.0.20260102`. A debug APK is written to `app/build/outputs/apk/debug/app-debug.apk`; debug signing is for testing. Production APK/AAB signing uses your private release key and distribution review.

Install the APK. On first launch it asks for the Temperance server and the client username/password created on the dashboard, enrolls the device, then asks for Android's VPN consent (and notification permission on Android 13+) and connects. Use the menu's **Always-on VPN settings** to enable **Always-on VPN** and **Block connections without VPN**. The embedded VPN service supports always-on reactivation using saved provisioning. The app stores keys/tokens encrypted with an Android Keystore AES-GCM key and disables backups. A foreground session service keeps the connection/status active. Grant notification permission if your OS prompts so its status remains visible. Only a device owner/managed policy can prevent the child from changing these settings or uninstalling the app.

Tests (from `clients/android`):

- `./gradlew testDebugUnitTest`: JVM unit tests for sign-in and status text, running against a host build of the shared Rust core.
- `./gradlew connectedDebugAndroidTest`: on a booted emulator or device, runs the setup flow, including Android's real VPN consent dialog and a live WireGuard tunnel, plus every menu item. A layout audit fails on clipped or ellipsized text, content under the action bar, system bars, or keyboard, overlapping views, and tap targets under 48dp. It runs on phone, small phone, landscape, 130% and 200% text, and tablet. Screenshots are written to `/data/local/tmp/temperance-shots` on the device.
- `e2e/real-server.sh`: needs `npm run build` in `web/` first. It starts a fresh local policy service with its embedded gateway, signs in through the UI with the dashboard's setup code over the gateway's UDP port, connects, and checks the result on the server.

## Windows and Linux

One [Tauri](https://tauri.app) app serves both. Its Rust backend is `core/temperance-desktop`; its React UI is `clients/desktop`, shown in the system web view (WebView2 on Windows, WebKitGTK on Linux). The UI calls two commands, `view` and `act`, and the backend pushes a fresh view every five seconds. On first launch the app asks whether this is a child's computer or a parent's.

- **Child mode (Windows only)**: sign in with the client username and password, then **Start protection** installs the WireGuard tunnel service. It persists across reboots and closing the app. Children see their status, Wi-Fi sign-in help and device health, and can ask for more time.
- **Parent mode (Windows and Linux)**: paste a pairing link and the family dashboard opens in its own window (see [remote parents](../docs/remote-parents.md)). That window loads only the paired dashboard and has no access to the app's commands; other links open in the browser.

Protect a Linux computer by adding it as a home-network device so the gateway enforces it by LAN address (see `docs/deployment.md`).

Build (Node 24 and Rust; on Linux also `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev`; for Windows on ARM also LLVM's `clang`, which `ring` needs):

```sh
(cd clients/desktop && npm ci)
cd core/temperance-desktop && ../../clients/desktop/node_modules/.bin/tauri build
```

The bundles land in `core/target/release/bundle/` (`nsis/` on Windows, `deb/` and `appimage/` on Linux). For development, `tauri dev` from the same directory serves the UI with hot reload; `npm test` in `clients/desktop` runs the UI tests.

The Windows installer is per-machine and the app asks for administrator rights, because installing the tunnel service needs them. The installer installs WireGuard from the official winget package if it is missing and restricts `%ProgramData%\Temperance`, where private keys and device tokens are stored, to SYSTEM and administrators. Uninstalling removes the tunnel service. Client routes capture both IP families; the gateway currently blocks captured IPv6. Full-tunnel WireGuard on Windows applies its default-route firewall semantics.

## Protocol references

Integration follows upstream [WireGuard embedding documentation](https://www.wireguard.com/embedding/), [Windows tunnel-service commands](https://git.zx2c4.com/wireguard-windows/about/docs/enterprise.md), [Android VPN guidance](https://developer.android.com/develop/connectivity/vpn), and [Apple network-routing guidance](https://developer.apple.com/documentation/networkextension/routing-your-vpn-network-traffic). See [architecture](../docs/architecture.md) for policy/usage semantics and current enforcement limits.

## Password sign-in

Add a client on the dashboard overview, then add a sign-in on that client’s card, using the admin password. In the app, scan the setup code from the dashboard's **Devices** tab (Android and iPhone) or paste it (Mac and Windows), then enter that username/password. The server determines the profile; no admin account, OAuth exchange, enrollment code or profile picker is used on a client. Clients never use the dashboard's address: they send passwords only through the gateway's UDP port, over QUIC pinned to the key in the setup code (or inside the tunnel), and store only scoped device credentials. Devices set up before version 0.5.4 stored a web address instead and must be set up again with the setup code. Password reset, user deletion or disable revokes the associated devices; clear/reset their local identity before signing in again.
