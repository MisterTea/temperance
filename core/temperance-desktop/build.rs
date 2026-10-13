fn main() {
    // Only these commands exist, and capabilities/default.json grants them to
    // the app's own window; the dashboard window gets no IPC at all.
    let mut attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(&["view", "act"]));
    // Installing the WireGuard tunnel service needs an administrator.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        attributes = attributes.windows_attributes(
            tauri_build::WindowsAttributes::new()
                .app_manifest(include_str!("windows/app.manifest")),
        );
    }
    tauri_build::try_build(attributes).expect("tauri build");
}
