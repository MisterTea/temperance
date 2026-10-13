//! Temperance shared client core. Compiled natively for the Windows/macOS
//! desktop app and exported through UniFFI to Swift (iOS/macOS) and Kotlin (Android).
pub mod api;
pub mod diagnostics;
pub mod policy;
#[cfg(feature = "remote")]
pub mod remote;
pub mod status;
pub mod tunnel;

pub use api::*;
pub use diagnostics::{
    captive_portal_probe, diagnose, diagnostics_request, parse_captive_portal_probe,
    portal_sign_in_seconds, Connectivity, DeviceFacts, Diagnostic, Severity,
    PORTAL_SIGN_IN_SECONDS,
};
pub use policy::{
    access_reason, domain_matches, domain_reason, AppLimit, Bedtime, Profile, Reward, Window,
};
pub use status::{child_alerts, child_status, ChildStatus};
pub use tunnel::{generate_keypair, public_key_for, tunnel_config, KeyPair, Tunnel};

uniffi::setup_scaffolding!();

#[derive(Debug, thiserror::Error, PartialEq, Eq, uniffi::Error)]
pub enum CoreError {
    #[error("{detail}")]
    Invalid { detail: String },
    #[error("{detail}")]
    Service { status: u16, detail: String },
}

#[uniffi::export]
pub fn core_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
