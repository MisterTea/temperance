//! Temperance home gateway: devices connect with WireGuard, every flow is
//! checked against household policy, and usage is reported per minute.
//!
//! Embedded in the Next.js server through the `node` feature (napi-rs) or run
//! standalone with the `cli` feature, which polls `/v1/gateway/*`.
pub mod ap;
pub mod dns;
pub mod gateway;
pub mod home;
pub mod net;
pub mod parent;
pub mod policy;
pub mod reach;
pub mod wg;

#[cfg(all(feature = "node", not(test)))]
mod node;

pub use gateway::{Config, Gateway, LEASE};

use rand_core::{OsRng, RngCore};

pub(crate) fn now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or_default()
}

pub(crate) fn uuid() -> String {
    let mut b = [0u8; 16];
    OsRng.fill_bytes(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

/// A fresh WireGuard private key (base64).
pub fn generate_private_key() -> String {
    temperance_core::generate_keypair().private_key
}

pub fn public_key(private_key: &str) -> Result<String, String> {
    let key = wg::decode_key(private_key)?;
    Ok(wg::encode_key(
        boringtun::x25519::PublicKey::from(&boringtun::x25519::StaticSecret::from(key)).as_bytes(),
    ))
}
