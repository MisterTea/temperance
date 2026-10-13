//! Parent phones away from home: QUIC on the WireGuard socket. A phone pairs
//! once with a code from the dashboard; afterwards each request it sends is
//! forwarded to the dashboard marked with the paired parent's id.
use std::collections::HashMap;
use std::fmt;
use std::io::{self, IoSliceMut};
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex, RwLock};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use quinn::udp::{RecvMeta, Transmit};
use quinn::{AsyncUdpSocket, UdpPoller};
use serde::Deserialize;
use serde_json::{json, Value};
use temperance_core::remote::client::UNPAIRED;
use temperance_core::remote::tls::{self, Identity};
use temperance_core::remote::{
    end_to_end, receive, send, PairReply, PairRequest, RequestHead, ResponseHead, MAX_BODY,
    PAIR_ALPN, PARENT_ALPN,
};
use tokio::net::UdpSocket;
use tokio::sync::mpsc;
use tokio::time::timeout;

pub const FORWARDED: &str = "x-temperance-forwarded";
pub const PARENT: &str = "x-temperance-parent";
const SLOW_DOWN: u32 = 2;

/// QUIC datagrams the WireGuard receive loop passes on, with their sender.
pub type Datagrams = mpsc::Sender<(SocketAddr, Vec<u8>)>;

#[derive(Clone, Debug, Deserialize)]
pub struct Config {
    /// Ed25519 identity for parent phones; created on first start.
    pub key_file: PathBuf,
    /// Proves to the dashboard that a request came through this gateway.
    pub secret: String,
    /// Where the dashboard is, e.g. `http://127.0.0.1:3000`.
    pub target: String,
}

/// A paired phone as `service.gatewayState()` lists it.
#[derive(Clone, Debug, Deserialize)]
pub struct Paired {
    pub id: String,
    pub key: String,
}

/// Keys must survive restarts: every paired phone pins this one.
pub fn load_or_create_key(path: &Path) -> Result<String, String> {
    let shown = path.display();
    if let Ok(existing) = std::fs::read_to_string(path) {
        let key = existing.trim().to_string();
        Identity::new(&key).map_err(|e| format!("{shown}: {e}"))?;
        return Ok(key);
    }
    let key = tls::generate_key();
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(path).map_err(|e| format!("{shown}: {e}"))?;
    io::Write::write_all(&mut file, key.as_bytes()).map_err(|e| format!("{shown}: {e}"))?;
    Ok(key)
}

/// QUIC datagrams the WireGuard receive loop handed over, plus sends on the
/// same socket so replies leave from the port the router forwards.
struct Shared {
    socket: Arc<UdpSocket>,
    inbound: Mutex<mpsc::Receiver<(SocketAddr, Vec<u8>)>>,
}

impl fmt::Debug for Shared {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Shared").finish_non_exhaustive()
    }
}

#[derive(Debug)]
struct Writable(Arc<UdpSocket>);

impl UdpPoller for Writable {
    fn poll_writable(self: Pin<&mut Self>, cx: &mut Context) -> Poll<io::Result<()>> {
        self.0.poll_send_ready(cx)
    }
}

impl AsyncUdpSocket for Shared {
    fn create_io_poller(self: Arc<Self>) -> Pin<Box<dyn UdpPoller>> {
        Box::pin(Writable(self.socket.clone()))
    }

    fn try_send(&self, transmit: &Transmit) -> io::Result<()> {
        self.socket
            .try_send_to(transmit.contents, transmit.destination)
            .map(|_| ())
    }

    fn poll_recv(
        &self,
        cx: &mut Context,
        bufs: &mut [IoSliceMut<'_>],
        meta: &mut [RecvMeta],
    ) -> Poll<io::Result<usize>> {
        let mut inbound = self.inbound.lock().expect("inbound lock");
        match inbound.poll_recv(cx) {
            Poll::Ready(Some((from, datagram))) => {
                let len = datagram.len().min(bufs[0].len());
                bufs[0][..len].copy_from_slice(&datagram[..len]);
                meta[0] = RecvMeta {
                    addr: from,
                    len,
                    stride: len,
                    ..RecvMeta::default()
                };
                Poll::Ready(Ok(1))
            }
            Poll::Ready(None) => Poll::Ready(Err(io::ErrorKind::BrokenPipe.into())),
            Poll::Pending => Poll::Pending,
        }
    }

    fn local_addr(&self) -> io::Result<SocketAddr> {
        self.socket.local_addr()
    }
}

/// At most 5 pairing attempts a minute from one address and 30 overall.
#[derive(Default)]
struct Limiter {
    recent: HashMap<IpAddr, Vec<Instant>>,
    all: Vec<Instant>,
}

impl Limiter {
    fn allow(&mut self, ip: IpAddr, now: Instant) -> bool {
        let fresh = |t: &Instant| now.duration_since(*t) < Duration::from_secs(60);
        self.all.retain(fresh);
        self.recent.retain(|_, times| {
            times.retain(fresh);
            !times.is_empty()
        });
        let mine = self.recent.entry(ip).or_default();
        if mine.len() >= 5 || self.all.len() >= 30 {
            return false;
        }
        mine.push(now);
        self.all.push(now);
        true
    }
}

pub struct Parents {
    config: Config,
    pin: String,
    endpoint: quinn::Endpoint,
    /// Certificate fingerprint to parent id.
    paired: RwLock<HashMap<String, String>>,
    connections: Mutex<Vec<(String, quinn::Connection)>>,
    limiter: Mutex<Limiter>,
    agent: ureq::Agent,
}

impl Parents {
    /// Must run inside the gateway's runtime; returns the sender the WireGuard
    /// receive loop passes QUIC datagrams to.
    pub fn start(
        config: Config,
        socket: Arc<UdpSocket>,
    ) -> Result<(Arc<Parents>, Datagrams), String> {
        let identity = Identity::new(&load_or_create_key(&config.key_file)?)?;
        let (tx, rx) = mpsc::channel(1024);
        let shared = Arc::new(Shared {
            socket,
            inbound: Mutex::new(rx),
        });
        let endpoint = quinn::Endpoint::new_with_abstract_socket(
            tls::endpoint_config(),
            Some(tls::server_config(&identity)?),
            shared,
            Arc::new(quinn::TokioRuntime),
        )
        .map_err(|e| e.to_string())?;
        let parents = Arc::new(Parents {
            config: Config {
                target: config.target.trim_end_matches('/').to_string(),
                ..config
            },
            pin: identity.pin(),
            endpoint,
            paired: RwLock::default(),
            connections: Mutex::default(),
            limiter: Mutex::default(),
            agent: ureq::Agent::config_builder()
                .timeout_global(Some(Duration::from_secs(60)))
                .http_status_as_error(false)
                .max_redirects(0)
                .build()
                .into(),
        });
        tokio::spawn(parents.clone().accept());
        Ok((parents, tx))
    }

    /// The gateway's certificate fingerprint, for the dashboard's pairing link.
    pub fn pin(&self) -> &str {
        &self.pin
    }

    /// Replace the paired set; connections of phones no longer in it close.
    pub fn set_paired(&self, paired: &[Paired]) {
        let next: HashMap<String, String> = paired
            .iter()
            .map(|p| (p.key.clone(), p.id.clone()))
            .collect();
        self.connections
            .lock()
            .expect("connections lock")
            .retain(|(key, connection)| {
                let keep = next.contains_key(key) && connection.close_reason().is_none();
                if !keep {
                    connection.close(UNPAIRED.into(), b"unpaired");
                }
                keep
            });
        *self.paired.write().expect("paired lock") = next;
    }

    pub fn stop(&self) {
        self.endpoint.close(0u32.into(), b"stopping");
    }

    async fn accept(self: Arc<Self>) {
        while let Some(incoming) = self.endpoint.accept().await {
            tokio::spawn(self.clone().connection(incoming));
        }
    }

    async fn connection(self: Arc<Self>, incoming: quinn::Incoming) {
        let from = incoming.remote_address();
        let Ok(Ok(connection)) = timeout(Duration::from_secs(10), incoming).await else {
            return;
        };
        let (Some(alpn), Some(key)) = (
            tls::negotiated_alpn(&connection),
            tls::peer_fingerprint(&connection),
        ) else {
            connection.close(0u32.into(), b"");
            return;
        };
        if alpn == PAIR_ALPN {
            self.pairing(connection, from.ip(), key).await;
            return;
        }
        if alpn != PARENT_ALPN {
            return;
        }
        let Some(id) = self.paired.read().expect("paired lock").get(&key).cloned() else {
            connection.close(UNPAIRED.into(), b"unpaired");
            return;
        };
        self.connections
            .lock()
            .expect("connections lock")
            .push((key, connection.clone()));
        while let Ok((tx, rx)) = connection.accept_bi().await {
            tokio::spawn(self.clone().forward(id.clone(), tx, rx));
        }
        self.connections
            .lock()
            .expect("connections lock")
            .retain(|(_, c)| c.stable_id() != connection.stable_id());
    }

    async fn pairing(self: Arc<Self>, connection: quinn::Connection, ip: IpAddr, key: String) {
        if !self
            .limiter
            .lock()
            .expect("limiter lock")
            .allow(ip, Instant::now())
        {
            connection.close(SLOW_DOWN.into(), b"too many pairing attempts");
            return;
        }
        let Ok(Ok((mut tx, mut rx))) =
            timeout(Duration::from_secs(30), connection.accept_bi()).await
        else {
            return;
        };
        let Ok((request, _)) = receive::<PairRequest>(&mut rx).await else {
            return;
        };
        let parents = self.clone();
        let reply = tokio::task::spawn_blocking(move || parents.pair(&request, &key))
            .await
            .unwrap_or_else(|_| failed("Pairing failed. Try again."));
        if send(&mut tx, &reply, b"").await.is_ok() {
            let _ = timeout(Duration::from_secs(5), connection.closed()).await;
        }
    }

    fn pair(&self, request: &PairRequest, key: &str) -> PairReply {
        let sent = self
            .agent
            .post(format!("{}/v1/gateway/parents/pair", self.config.target))
            .header(FORWARDED, &self.config.secret)
            .content_type("application/json")
            .send(json!({"code": request.code, "name": request.name, "key": key}).to_string());
        let Ok(mut response) = sent else {
            return failed("Temperance at home isn't answering. Try again in a minute.");
        };
        let status = response.status().as_u16();
        let body: Value = response
            .body_mut()
            .read_to_string()
            .ok()
            .and_then(|b| serde_json::from_str(&b).ok())
            .unwrap_or(Value::Null);
        match body["id"].as_str() {
            Some(id) if status == 200 => {
                self.paired
                    .write()
                    .expect("paired lock")
                    .insert(key.to_string(), id.to_string());
                PairReply {
                    id: Some(id.to_string()),
                    household: body["household"].as_str().unwrap_or_default().to_string(),
                    error: None,
                }
            }
            _ => failed(
                body["error"]
                    .as_str()
                    .unwrap_or("Pairing failed. Create a new code and try again."),
            ),
        }
    }

    async fn forward(
        self: Arc<Self>,
        id: String,
        mut tx: quinn::SendStream,
        mut rx: quinn::RecvStream,
    ) {
        let Ok((head, body)) = receive::<RequestHead>(&mut rx).await else {
            return;
        };
        let parents = self.clone();
        let (head, body) = tokio::task::spawn_blocking(move || parents.call(&id, head, body))
            .await
            .unwrap_or_else(|_| text(502, "The gateway could not forward this request."));
        let _ = send(&mut tx, &head, &body).await;
    }

    /// Gateway-only routes are never reachable through a parent's phone.
    fn call(&self, id: &str, head: RequestHead, body: Vec<u8>) -> (ResponseHead, Vec<u8>) {
        if !head.path.starts_with('/') || head.path.starts_with("/v1/gateway") {
            return text(404, "Not found");
        }
        let mut request = ureq::http::Request::builder()
            .method(head.method.as_str())
            .uri(format!("{}{}", self.config.target, head.path));
        for (name, value) in &head.headers {
            if end_to_end(name) && !name.to_ascii_lowercase().starts_with("x-temperance-") {
                request = request.header(name, value);
            }
        }
        request = request
            .header(FORWARDED, &self.config.secret)
            .header(PARENT, id);
        let sent = if body.is_empty() {
            request
                .body(ureq::SendBody::none())
                .map(|r| self.agent.run(r))
        } else {
            request.body(body).map(|r| self.agent.run(r))
        };
        let Ok(Ok(response)) = sent else {
            return text(
                502,
                "Temperance at home isn't answering. Try again in a minute.",
            );
        };
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .filter(|(name, _)| end_to_end(name.as_str()))
            .filter_map(|(name, value)| Some((name.to_string(), value.to_str().ok()?.to_string())))
            .collect();
        match response
            .into_body()
            .with_config()
            .limit(MAX_BODY as u64)
            .read_to_vec()
        {
            Ok(body) => (ResponseHead { status, headers }, body),
            Err(_) => text(502, "The dashboard's reply was too large."),
        }
    }
}

fn failed(message: &str) -> PairReply {
    PairReply {
        error: Some(message.to_string()),
        ..PairReply::default()
    }
}

fn text(status: u16, message: &str) -> (ResponseHead, Vec<u8>) {
    (
        ResponseHead {
            status,
            headers: vec![("content-type".into(), "text/plain; charset=utf-8".into())],
        },
        message.as_bytes().to_vec(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_attempts_are_rate_limited() {
        let mut limiter = Limiter::default();
        let now = Instant::now();
        let one: IpAddr = "198.51.100.1".parse().unwrap();
        for _ in 0..5 {
            assert!(limiter.allow(one, now));
        }
        assert!(!limiter.allow(one, now));
        for n in 0..25u8 {
            assert!(limiter.allow(IpAddr::from([203, 0, 113, n]), now));
        }
        assert!(!limiter.allow("192.0.2.1".parse().unwrap(), now));
        let later = now + Duration::from_secs(61);
        assert!(limiter.allow(one, later));
    }

    #[test]
    fn the_key_file_is_created_once_and_validated() {
        let dir = std::env::temp_dir().join(format!("temperance-parent-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("parent.key");
        let _ = std::fs::remove_file(&path);
        let first = load_or_create_key(&path).unwrap();
        assert_eq!(load_or_create_key(&path).unwrap(), first);
        std::fs::write(&path, "garbage").unwrap();
        assert!(load_or_create_key(&path)
            .unwrap_err()
            .contains("parent.key"));
        assert!(load_or_create_key(&dir.join("missing/parent.key")).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
