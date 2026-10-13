//! Parent mode: the app reaches the home gateway with QUIC on the gateway's
//! WireGuard port. Both sides pin each other's keys at pairing, so there is no
//! certificate authority and nothing for the household to set up beyond the
//! port forward children's devices already need.
use std::io;
use std::time::Duration;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{de::DeserializeOwned, Deserialize, Serialize};

use crate::CoreError;

pub mod client;
pub mod device;
pub mod tls;

pub use client::{describe_parent_identity, pair_parent, ParentSummary, RemoteSession};
pub use device::{home_send, HttpResponse};

/// A phone that is not paired yet may only ask to pair.
pub const PAIR_ALPN: &[u8] = b"temperance-pair/1";
/// A paired phone's requests to the dashboard.
pub const PARENT_ALPN: &[u8] = b"temperance-parent/1";
/// A child's device: sign-in, enrollment and `/v1/device/…` only, with its
/// device token. Any client key is accepted.
pub const DEVICE_ALPN: &[u8] = b"temperance-device/1";
/// Both sides ignore the name and check pinned keys instead.
pub const SERVER_NAME: &str = "temperance";
/// Large enough for a household backup import.
pub const MAX_BODY: usize = 16 << 20;
const MAX_HEAD: usize = 64 << 10;
pub const MAX_STREAMS: u32 = 32;
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
pub const KEEPALIVE: Duration = Duration::from_secs(10);
const LINK_PREFIX: &str = "temperance://pair#";

/// WireGuard messages are types 1-4 followed by three zero bytes.
pub fn is_wireguard(datagram: &[u8]) -> bool {
    datagram.len() >= 4 && (1..=4).contains(&datagram[0]) && datagram[1..4] == [0, 0, 0]
}

/// Every QUIC packet sets the fixed bit while QUIC-bit greasing is off, which
/// no WireGuard message type does.
pub fn is_quic(datagram: &[u8]) -> bool {
    datagram.first().is_some_and(|b| b & 0x40 != 0)
}

/// What the dashboard's "Pair a parent device" QR code carries.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
pub struct PairingLink {
    pub v: u32,
    pub host: String,
    pub port: u16,
    /// Base64url SHA-256 of the gateway's certificate.
    pub pin: String,
    pub code: String,
    #[serde(default)]
    pub household: String,
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::Invalid {
        detail: message.into(),
    }
}

#[uniffi::export]
pub fn parse_pairing_link(link: String) -> Result<PairingLink, CoreError> {
    let bad = || {
        invalid(
            "This is not a Temperance pairing code. Scan the code under Settings → Parent devices.",
        )
    };
    let encoded = link.trim().strip_prefix(LINK_PREFIX).ok_or_else(bad)?;
    let json = URL_SAFE_NO_PAD
        .decode(encoded.trim_end_matches('='))
        .map_err(|_| bad())?;
    let link: PairingLink = serde_json::from_slice(&json).map_err(|_| bad())?;
    if link.v != 1 {
        return Err(invalid(
            "This pairing code needs a newer version of Temperance.",
        ));
    }
    if link.host.is_empty() || link.port == 0 || link.pin.is_empty() || link.code.is_empty() {
        return Err(bad());
    }
    Ok(link)
}

pub fn format_pairing_link(link: &PairingLink) -> String {
    let json = serde_json::to_vec(link).expect("serializable");
    format!("{LINK_PREFIX}{}", URL_SAFE_NO_PAD.encode(json))
}

/// What a paired app keeps in the platform's secure storage.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParentIdentity {
    pub v: u32,
    pub host: String,
    pub port: u16,
    pub pin: String,
    /// PKCS#8 Ed25519 private key, base64url.
    pub key: String,
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub household: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairRequest {
    pub code: String,
    pub name: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairReply {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default)]
    pub household: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequestHead {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResponseHead {
    pub status: u16,
    pub headers: Vec<(String, String)>,
}

/// Headers that describe one HTTP hop rather than the message.
pub fn end_to_end(name: &str) -> bool {
    !matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "keep-alive"
            | "proxy-connection"
            | "transfer-encoding"
            | "upgrade"
            | "te"
            | "trailer"
            | "content-length"
            | "host"
    )
}

/// One message per stream: a length-prefixed JSON head, then the body to the
/// end of the stream.
pub fn encode<T: Serialize>(head: &T, body: &[u8]) -> Vec<u8> {
    let json = serde_json::to_vec(head).expect("serializable");
    let mut out = Vec::with_capacity(4 + json.len() + body.len());
    out.extend_from_slice(&(json.len() as u32).to_be_bytes());
    out.extend_from_slice(&json);
    out.extend_from_slice(body);
    out
}

pub fn decode<T: DeserializeOwned>(message: &[u8]) -> io::Result<(T, Vec<u8>)> {
    let bad = |m: &str| io::Error::new(io::ErrorKind::InvalidData, m.to_string());
    let len = message
        .get(..4)
        .map(|b| u32::from_be_bytes(b.try_into().expect("4 bytes")) as usize)
        .ok_or_else(|| bad("short message"))?;
    if len > MAX_HEAD || message.len() < 4 + len {
        return Err(bad("bad message head"));
    }
    let head = serde_json::from_slice(&message[4..4 + len]).map_err(|e| bad(&e.to_string()))?;
    Ok((head, message[4 + len..].to_vec()))
}

pub async fn send<T: Serialize>(
    stream: &mut quinn::SendStream,
    head: &T,
    body: &[u8],
) -> io::Result<()> {
    stream.write_all(&encode(head, body)).await?;
    stream.finish()?;
    Ok(())
}

pub async fn receive<T: DeserializeOwned>(
    stream: &mut quinn::RecvStream,
) -> io::Result<(T, Vec<u8>)> {
    let message = stream
        .read_to_end(MAX_HEAD + MAX_BODY)
        .await
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
    decode(&message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link() -> PairingLink {
        PairingLink {
            v: 1,
            host: "jordanshouse.ddnsfree.com".into(),
            port: 51820,
            pin: "pin".into(),
            code: "code".into(),
            household: "The Riveras".into(),
        }
    }

    #[test]
    fn pairing_links_round_trip_and_reject_junk() {
        let text = format_pairing_link(&link());
        assert!(text.starts_with("temperance://pair#"));
        assert_eq!(parse_pairing_link(format!("  {text}\n")).unwrap(), link());
        for junk in [
            "",
            "https://example.com",
            "temperance://pair#!!",
            "temperance://pair#e30",
        ] {
            assert!(parse_pairing_link(junk.into()).is_err(), "{junk}");
        }
        let newer = format_pairing_link(&PairingLink { v: 2, ..link() });
        assert!(parse_pairing_link(newer)
            .unwrap_err()
            .to_string()
            .contains("newer"));
    }

    #[test]
    fn wireguard_and_quic_never_overlap() {
        for kind in 1..=4u8 {
            let wg = [kind, 0, 0, 0, 9, 9];
            assert!(is_wireguard(&wg) && !is_quic(&wg));
        }
        for first in [0x40u8, 0x41, 0x7f, 0xc0, 0xff] {
            let quic = [first, 0, 0, 0, 1];
            assert!(is_quic(&quic) && !is_wireguard(&quic), "{first:#x}");
        }
        assert!(!is_wireguard(&[1, 0, 0]) && !is_quic(&[]));
        assert!(!is_wireguard(&[1, 0, 1, 0]));
    }

    #[test]
    fn messages_round_trip_and_reject_bad_heads() {
        let head = RequestHead {
            method: "POST".into(),
            path: "/api/pause".into(),
            headers: vec![("content-type".into(), "application/json".into())],
        };
        let (back, body) = decode::<RequestHead>(&encode(&head, b"{}")).unwrap();
        assert_eq!((back, body.as_slice()), (head, b"{}".as_slice()));
        assert!(decode::<RequestHead>(&[0, 0]).is_err());
        assert!(decode::<RequestHead>(&[0, 0, 0, 9, b'{']).is_err());
        assert!(decode::<RequestHead>(&[0xff, 0, 0, 0]).is_err());
        assert!(decode::<RequestHead>(&encode(&"text", b"")).is_err());
    }

    #[test]
    fn hop_headers_are_dropped() {
        assert!(end_to_end("Content-Type") && end_to_end("set-cookie"));
        assert!(!end_to_end("Connection") && !end_to_end("HOST") && !end_to_end("Content-Length"));
    }
}
