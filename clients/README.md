# Device applications

Each application enrolls a locally generated WireGuard public key through the policy service, receives full-tunnel provisioning, installs the VPN with OS consent/admin privileges, and refreshes policy status. Filtering and time controls apply at the Linux gateway, so mobile background refresh is not required for policy enforcement.

| Platform | App / tunnel integration | Build |
| --- | --- | --- |
| macOS 13+ | Native SwiftUI app + WireGuardKit Network Extension | `apple/bootstrap.sh`, Xcode `TemperanceMac` |
| iOS 16+ | Native SwiftUI app + WireGuardKit Network Extension | Same project, Xcode `TemperanceIOS` |
| Android 8+ | Kotlin app + embedded official WireGuard GoBackend + foreground session service | `cd android && ./gradlew assembleDebug` |
| Linux | Rust application with localhost browser UI + `wg-quick` | `desktop/build.sh`, `desktop/install-linux.sh` |
| Windows | Rust application with localhost browser UI + WireGuard tunnel service | `desktop/build.sh`, elevated `desktop/install-windows.ps1` |

## Shared Rust core

Client business logic lives once in [`core/temperance-core`](../core/temperance-core): HTTPS-origin validation, WireGuard key generation, enrollment/refresh/time-request protocol (request building and response parsing), identity persistence format, full-tunnel config validation, the policy engine (verified against the same `specs/policy-cases.json` golden cases as the TypeScript service and Python gateway), the child-facing status view ("Bedtime starts in 30 min", remaining minutes, ask-for-time eligibility), child alerts, location-request answers, and device diagnostics. `diagnose` turns facts each platform observes (VPN permission, tunnel state, WireGuard handshake age, captive-portal probe, notification and location permission) into ordered issues with a fix for the child; changes are reported to parents (`POST /v1/device/diagnostics`) and shown on the dashboard's Devices tab.

**Wi-Fi sign-in pages.** On the desktop app, "Sign in to Wi-Fi" appears only when the tunnel cannot reach the gateway. It lowers the tunnel for at most five minutes, probes `connectivitycheck.gstatic.com` outside the tunnel, restores protection as soon as the network is online, and parents are told afterwards. Android detects the captive-portal state itself and its sign-in flow runs outside the VPN (the app's button opens Wi-Fi settings); on Apple platforms `includeAllNetworks` always exempts captive-network sign-in traffic.

- **Linux / Windows / macOS desktop**: `core/temperance-desktop` links the crate natively.
- **iOS / macOS apps**: `core/build-bindings.sh apple` builds `clients/apple/Core/TemperanceCoreFFI.xcframework` (device, simulator, macOS universal) and UniFFI Swift bindings; `apple/bootstrap.sh` runs it.
- **Android**: `core/build-bindings.sh android` builds `jniLibs` for arm64-v8a, armeabi-v7a, x86_64, x86 with `cargo-ndk` and generates Kotlin bindings; Gradle's `preBuild` runs it (set `TEMPERANCE_SKIP_RUST=1` to use prebuilt libraries).

Platform code only supplies the native HTTPS transport, keychain/keystore storage, VPN APIs, and UI. Requirements: Rust (via rustup) with the mobile targets, `cargo-ndk` and `ANDROID_NDK_HOME` for Android, Xcode for Apple. Run `cargo test --workspace` in `core/` for unit, golden, and desktop tests.

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

Install the APK, enroll with your HTTPS service origin and one-use code, and tap Install / start VPN. Accept Android's VPN consent dialog. Use the app's settings button to enable **Always-on VPN** and **Block connections without VPN**. The embedded VPN service supports always-on reactivation using saved provisioning. The app stores keys/tokens encrypted with an Android Keystore AES-GCM key and disables backups. A foreground session service keeps the connection/status active. Grant notification permission if your OS prompts so its status remains visible. Only a device owner/managed policy can prevent the child from changing these settings or uninstalling the app.

## Linux / Windows

Build with Rust using `clients/desktop/build.sh` (cross targets use `cargo-zigbuild`; override with `TARGETS="rust-target:os:arch ..."`). Binaries for amd64/arm64 Linux and Windows go to `build/`. Installers use these local build outputs, never an unverified remote binary. Children can see their status and send an "ask for more time" request from the desktop UI.

On Linux, `sudo clients/desktop/install-linux.sh` installs distribution WireGuard tools and the app. Launch `sudo temperance-desktop --data /var/lib/temperance-client` and open its printed localhost URL in your normal browser. Enroll, then Install / start VPN. After connection, `sudo systemctl enable temperance-vpn` persists the tunnel at boot. The app must keep running for its status polling; gateway enforcement continues without it. To reset/remove a tunnel, an administrator stops the installed unit or runs `wg-quick down /var/lib/temperance-client/temperance.conf` and deletes/reset the private identity deliberately.

On Windows, run `clients/desktop/install-windows.ps1` in elevated PowerShell. It installs WireGuard from the official winget package if needed, secures the app/state directory to SYSTEM and administrators, and creates a desktop shortcut. Launch the shortcut, open its printed localhost URL, enroll, then install/start the tunnel. The WireGuard tunnel service persists across reboots and closing the app. Administrator privilege is required for installation/removal. The desktop application is a compiled executable with a local browser interface, not a WPF/GTK window.

Linux/Windows private keys and device tokens reside in restricted state files. Run through the installers so the directory permissions/ACLs are correct. Client routes capture both IP families; the gateway currently blocks captured IPv6. Full-tunnel WireGuard on Windows applies its default-route firewall semantics. Linux `wg-quick` alone does not provide a complete off-tunnel kill switch; use managed accounts and host firewall restrictions for tamper-resistant deployments. Cross-compilation proves buildability, not successful VPN installation on a physical Windows/Linux client.

## Protocol references

Integration follows upstream [WireGuard embedding documentation](https://www.wireguard.com/embedding/), [Windows tunnel-service commands](https://git.zx2c4.com/wireguard-windows/about/docs/enterprise.md), [Android VPN guidance](https://developer.android.com/develop/connectivity/vpn), and [Apple network-routing guidance](https://developer.apple.com/documentation/networkextension/routing-your-vpn-network-traffic). See [architecture](../docs/architecture.md) for policy/usage semantics and current enforcement limits.
