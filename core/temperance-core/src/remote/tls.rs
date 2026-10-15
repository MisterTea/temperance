//! Pinned-key TLS for QUIC. Each side has an Ed25519 key and a self-signed
//! certificate derived from it deterministically, so the certificate's hash is
//! a stable identity: the gateway's is pinned in the pairing link, an admin
//! phone's is recorded when it pairs.
use std::sync::Arc;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls13_signature, CryptoProvider, WebPkiSupportedAlgorithms};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::{CertificateError, DigitallySignedStruct, DistinguishedName, Error, SignatureScheme};

use super::{
    DEVICE_ALPN, IDLE_TIMEOUT, KEEPALIVE, MAX_STREAMS, PAIR_ALPN, PARENT_ALPN, SERVER_NAME,
};

fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// A new PKCS#8 Ed25519 private key, base64url.
pub fn generate_key() -> String {
    let key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ED25519).expect("Ed25519 key");
    URL_SAFE_NO_PAD.encode(key.serialize_der())
}

/// Base64url SHA-256 of a certificate.
pub fn fingerprint(cert: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(ring::digest::digest(&ring::digest::SHA256, cert))
}

pub struct Identity {
    cert: CertificateDer<'static>,
    key: Vec<u8>,
}

impl Identity {
    pub fn new(key: &str) -> Result<Identity, String> {
        let der = URL_SAFE_NO_PAD
            .decode(key.trim().trim_end_matches('='))
            .map_err(|_| "Invalid parent key".to_string())?;
        let pair = rcgen::KeyPair::try_from(der.as_slice()).map_err(|e| e.to_string())?;
        let mut params = rcgen::CertificateParams::new(vec![SERVER_NAME.to_string()])
            .map_err(|e| e.to_string())?;
        params.distinguished_name = rcgen::DistinguishedName::new();
        params
            .distinguished_name
            .push(rcgen::DnType::CommonName, "Temperance");
        let cert = params.self_signed(&pair).map_err(|e| e.to_string())?;
        Ok(Identity {
            cert: cert.der().clone(),
            key: der,
        })
    }

    pub fn pin(&self) -> String {
        fingerprint(&self.cert)
    }

    fn key(&self) -> PrivateKeyDer<'static> {
        PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(self.key.clone()))
    }
}

fn transport(server: bool) -> Arc<quinn::TransportConfig> {
    let mut transport = quinn::TransportConfig::default();
    transport
        .max_idle_timeout(Some(IDLE_TIMEOUT.try_into().expect("idle timeout")))
        .keep_alive_interval((!server).then_some(KEEPALIVE))
        .max_concurrent_bidi_streams(if server { MAX_STREAMS } else { 0 }.into())
        .max_concurrent_uni_streams(0u32.into());
    Arc::new(transport)
}

/// QUIC-bit greasing would make QUIC packets indistinguishable from WireGuard.
pub fn endpoint_config() -> quinn::EndpointConfig {
    let mut config = quinn::EndpointConfig::default();
    config.grease_quic_bit(false);
    config
}

pub fn client_config(
    identity: &Identity,
    pin: &str,
    alpn: &[u8],
) -> Result<quinn::ClientConfig, String> {
    let provider = provider();
    let mut tls = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| e.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(Pinned {
            pin: pin.to_string(),
            algorithms: provider.signature_verification_algorithms,
        }))
        .with_client_auth_cert(vec![identity.cert.clone()], identity.key())
        .map_err(|e| e.to_string())?;
    tls.alpn_protocols = vec![alpn.to_vec()];
    let crypto =
        quinn::crypto::rustls::QuicClientConfig::try_from(tls).map_err(|e| e.to_string())?;
    let mut config = quinn::ClientConfig::new(Arc::new(crypto));
    config.transport_config(transport(false));
    Ok(config)
}

/// Accepts any client key; the gateway decides per ALPN after the handshake.
pub fn server_config(identity: &Identity) -> Result<quinn::ServerConfig, String> {
    let provider = provider();
    let mut tls = rustls::ServerConfig::builder_with_provider(provider.clone())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| e.to_string())?
        .with_client_cert_verifier(Arc::new(AnyClient {
            algorithms: provider.signature_verification_algorithms,
        }))
        .with_single_cert(vec![identity.cert.clone()], identity.key())
        .map_err(|e| e.to_string())?;
    tls.alpn_protocols = vec![
        PAIR_ALPN.to_vec(),
        PARENT_ALPN.to_vec(),
        DEVICE_ALPN.to_vec(),
    ];
    let crypto =
        quinn::crypto::rustls::QuicServerConfig::try_from(tls).map_err(|e| e.to_string())?;
    let mut config = quinn::ServerConfig::with_crypto(Arc::new(crypto));
    config.transport_config(transport(true));
    Ok(config)
}

/// The fingerprint of the key the other side proved it holds.
pub fn peer_fingerprint(connection: &quinn::Connection) -> Option<String> {
    let certs = connection
        .peer_identity()?
        .downcast::<Vec<CertificateDer<'static>>>()
        .ok()?;
    certs.first().map(|c| fingerprint(c))
}

pub fn negotiated_alpn(connection: &quinn::Connection) -> Option<Vec<u8>> {
    connection
        .handshake_data()?
        .downcast::<quinn::crypto::rustls::HandshakeData>()
        .ok()?
        .protocol
}

fn no_tls12() -> Error {
    Error::General("TLS 1.2 is not used".into())
}

#[derive(Debug)]
struct Pinned {
    pin: String,
    algorithms: WebPkiSupportedAlgorithms,
}

impl ServerCertVerifier for Pinned {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        if fingerprint(end_entity) == self.pin {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(Error::InvalidCertificate(
                CertificateError::ApplicationVerificationFailure,
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        Err(no_tls12())
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls13_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

#[derive(Debug)]
struct AnyClient {
    algorithms: WebPkiSupportedAlgorithms,
}

impl ClientCertVerifier for AnyClient {
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &[]
    }

    fn verify_client_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _now: UnixTime,
    ) -> Result<ClientCertVerified, Error> {
        Ok(ClientCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        Err(no_tls12())
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls13_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_always_has_the_same_pin() {
        let key = generate_key();
        let a = Identity::new(&key).unwrap();
        let b = Identity::new(&key).unwrap();
        assert_eq!(a.pin(), b.pin());
        assert_eq!(a.pin().len(), 43);
        assert_ne!(a.pin(), Identity::new(&generate_key()).unwrap().pin());
        assert!(Identity::new("not a key").is_err());
        assert!(Identity::new("AAAA").is_err());
    }
}
