//! Temperance shared client core. Compiled natively for Linux/Windows/macOS
//! desktop and exported through UniFFI to Swift (iOS/macOS) and Kotlin (Android).
pub mod api;
pub mod policy;
pub mod status;
pub mod tunnel;

pub use api::*;
pub use policy::{access_reason, domain_matches, domain_reason, Bedtime, Profile, Reward, Window};
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
