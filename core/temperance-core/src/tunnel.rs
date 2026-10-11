use std::net::{IpAddr, SocketAddr};

use base64::{engine::general_purpose::STANDARD, Engine};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use x25519_dalek::{PublicKey, StaticSecret};

use crate::CoreError;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
pub struct Tunnel {
    pub address: String,
    pub address_v6: String,
    pub dns: String,
    pub endpoint: String,
    pub public_key: String,
    #[serde(default)]
    pub allowed_ips: String,
    #[serde(default)]
    pub keepalive: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct KeyPair {
    pub private_key: String,
    pub public_key: String,
}

/// Generates a WireGuard key pair. The private key never leaves the device.
#[uniffi::export]
pub fn generate_keypair() -> KeyPair {
    let secret = StaticSecret::random_from_rng(OsRng);
    KeyPair {
        private_key: STANDARD.encode(secret.to_bytes()),
        public_key: STANDARD.encode(PublicKey::from(&secret).as_bytes()),
    }
}

fn key_bytes(value: &str) -> Result<[u8; 32], CoreError> {
    STANDARD
        .decode(value)
        .ok()
        .and_then(|b| <[u8; 32]>::try_from(b).ok())
        .ok_or_else(|| CoreError::Invalid {
            detail: "Invalid tunnel key".into(),
        })
}

#[uniffi::export]
pub fn public_key_for(private_key: String) -> Result<String, CoreError> {
    let secret = StaticSecret::from(key_bytes(&private_key)?);
    Ok(STANDARD.encode(PublicKey::from(&secret).as_bytes()))
}

fn cidr(value: &str) -> Result<(), CoreError> {
    let bad = || CoreError::Invalid {
        detail: format!("Invalid tunnel address {value}"),
    };
    let (ip, prefix) = value.split_once('/').ok_or_else(bad)?;
    let ip: IpAddr = ip.parse().map_err(|_| bad())?;
    let prefix: u8 = prefix.parse().map_err(|_| bad())?;
    if prefix > if ip.is_ipv4() { 32 } else { 128 } {
        return Err(bad());
    }
    Ok(())
}

/// Renders a full-tunnel WireGuard config. Routes, scripts, and DNS servers are
/// never taken verbatim from the control plane; every field is validated.
#[uniffi::export]
pub fn tunnel_config(private_key: String, tunnel: Tunnel) -> Result<String, CoreError> {
    key_bytes(&private_key)?;
    key_bytes(&tunnel.public_key)?;
    cidr(&tunnel.address)?;
    cidr(&tunnel.address_v6)?;
    tunnel
        .dns
        .parse::<IpAddr>()
        .map_err(|_| CoreError::Invalid {
            detail: "Invalid DNS address".into(),
        })?;
    let endpoint: SocketAddr = tunnel.endpoint.parse().map_err(|_| CoreError::Invalid {
        detail: "Invalid endpoint".into(),
    })?;
    if endpoint.port() == 0 {
        return Err(CoreError::Invalid {
            detail: "Invalid endpoint".into(),
        });
    }
    Ok(format!(
        "[Interface]\nPrivateKey = {private_key}\nAddress = {}, {}\nDNS = {}\n\n[Peer]\nPublicKey = {}\nEndpoint = {}\nAllowedIPs = 0.0.0.0/0, ::/0\nPersistentKeepalive = 25\n",
        tunnel.address, tunnel.address_v6, tunnel.dns, tunnel.public_key, tunnel.endpoint
    ))
}
