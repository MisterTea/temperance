//! The parent app's side: pair once, then serve the home dashboard to the
//! app's web view from a loopback proxy that forwards over QUIC.
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand_core::{OsRng, RngCore};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::runtime::Runtime;
use tokio::time::timeout;

use super::tls::{self, Identity};
use super::{
    end_to_end, invalid, parse_pairing_link, receive, send, PairReply, PairRequest, ParentIdentity,
    RequestHead, ResponseHead, MAX_BODY, PAIR_ALPN, PARENT_ALPN, SERVER_NAME,
};
use crate::CoreError;

const PROXY_COOKIE: &str = "temperance_proxy";
const START: &str = "/__temperance/start";
const MAX_REQUEST_HEAD: usize = 64 << 10;
/// The gateway closes a parent connection with this code once the phone is unpaired.
pub const UNPAIRED: u32 = 1;

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct ParentSummary {
    pub id: String,
    pub name: String,
    pub household: String,
    pub host: String,
}

fn identity_from(json: &str) -> Result<ParentIdentity, CoreError> {
    serde_json::from_str(json)
        .map_err(|_| invalid("This device's pairing is damaged. Pair it again."))
}

#[uniffi::export]
pub fn describe_parent_identity(identity: String) -> Result<ParentSummary, CoreError> {
    let parent = identity_from(&identity)?;
    Ok(ParentSummary {
        id: parent.id,
        name: parent.name,
        household: parent.household,
        host: parent.host,
    })
}

fn unreachable(host: &str, port: u16, detail: impl std::fmt::Display) -> CoreError {
    CoreError::Service {
        status: 503,
        detail: format!("Can't reach your home's Temperance gateway at {host}:{port} ({detail})."),
    }
}

struct Home {
    endpoint: quinn::Endpoint,
    connection: quinn::Connection,
}

impl Home {
    async fn dial(
        host: &str,
        port: u16,
        pin: &str,
        identity: &Identity,
        alpn: &[u8],
    ) -> Result<Home, CoreError> {
        let addr = tokio::net::lookup_host((host, port))
            .await
            .map_err(|e| unreachable(host, port, e))?
            .next()
            .ok_or_else(|| unreachable(host, port, "no address"))?;
        let bind: SocketAddr = if addr.is_ipv6() {
            "[::]:0"
        } else {
            "0.0.0.0:0"
        }
        .parse()
        .expect("static");
        let socket = std::net::UdpSocket::bind(bind).map_err(|e| unreachable(host, port, e))?;
        let mut endpoint = quinn::Endpoint::new(
            tls::endpoint_config(),
            None,
            socket,
            Arc::new(quinn::TokioRuntime),
        )
        .map_err(|e| unreachable(host, port, e))?;
        endpoint
            .set_default_client_config(tls::client_config(identity, pin, alpn).map_err(invalid)?);
        let connecting = endpoint
            .connect(addr, SERVER_NAME)
            .map_err(|e| unreachable(host, port, e))?;
        let connection = timeout(Duration::from_secs(10), connecting)
            .await
            .map_err(|_| unreachable(host, port, "timed out"))?
            .map_err(|e| unreachable(host, port, e))?;
        Ok(Home {
            endpoint,
            connection,
        })
    }

    async fn close(self) {
        self.connection.close(0u32.into(), b"done");
        let _ = timeout(Duration::from_secs(1), self.endpoint.wait_idle()).await;
    }
}

/// Pairs this phone using the dashboard's QR code; returns the identity JSON to
/// keep in secure storage.
#[uniffi::export]
pub fn pair_parent(link: String, device_name: String) -> Result<String, CoreError> {
    let link = parse_pairing_link(link)?;
    let name = device_name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(invalid("Give this device a name of up to 80 characters."));
    }
    let key = tls::generate_key();
    let identity = Identity::new(&key).map_err(invalid)?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| invalid(e.to_string()))?;
    let reply = runtime.block_on(async {
        let home = Home::dial(&link.host, link.port, &link.pin, &identity, PAIR_ALPN).await?;
        let lost = |e: std::io::Error| unreachable(&link.host, link.port, e);
        let (mut tx, mut rx) = home
            .connection
            .open_bi()
            .await
            .map_err(|e| unreachable(&link.host, link.port, e))?;
        let request = PairRequest {
            code: link.code.clone(),
            name: name.to_string(),
        };
        send(&mut tx, &request, b"").await.map_err(lost)?;
        let (reply, _) = receive::<PairReply>(&mut rx).await.map_err(lost)?;
        home.close().await;
        Ok::<_, CoreError>(reply)
    })?;
    let Some(id) = reply.id else {
        return Err(CoreError::Service {
            status: 403,
            detail: reply
                .error
                .unwrap_or_else(|| "Pairing failed. Create a new code and try again.".into()),
        });
    };
    let parent = ParentIdentity {
        v: 1,
        host: link.host,
        port: link.port,
        pin: link.pin,
        key,
        id,
        name: name.to_string(),
        household: if reply.household.is_empty() {
            link.household
        } else {
            reply.household
        },
    };
    Ok(serde_json::to_string(&parent).expect("serializable"))
}

struct Upstream {
    parent: ParentIdentity,
    identity: Identity,
    home: tokio::sync::Mutex<Option<Home>>,
}

impl Upstream {
    async fn connection(&self, fresh: bool) -> Result<quinn::Connection, String> {
        let mut home = self.home.lock().await;
        if let Some(h) = &*home {
            if !fresh && h.connection.close_reason().is_none() {
                return Ok(h.connection.clone());
            }
        }
        let p = &self.parent;
        let dialed = Home::dial(&p.host, p.port, &p.pin, &self.identity, PARENT_ALPN)
            .await
            .map_err(|e| e.to_string())?;
        let connection = dialed.connection.clone();
        *home = Some(dialed);
        Ok(connection)
    }

    /// Only opening the stream is retried, so a request is never sent twice.
    async fn request(
        &self,
        head: &RequestHead,
        body: &[u8],
    ) -> Result<(ResponseHead, Vec<u8>), String> {
        let mut opened = None;
        for fresh in [false, true] {
            let connection = self.connection(fresh).await?;
            match connection.open_bi().await {
                Ok(streams) => {
                    opened = Some((connection, streams));
                    break;
                }
                Err(e) if is_unpaired(&e) => return Err(unpaired()),
                Err(_) => {}
            }
        }
        let (connection, (mut tx, mut rx)) = opened.ok_or("The connection to home dropped")?;
        let exchange = async {
            send(&mut tx, head, body).await?;
            receive::<ResponseHead>(&mut rx).await
        };
        match exchange.await {
            Ok(reply) => Ok(reply),
            // A failed exchange usually means the gateway closed the connection;
            // its reason says whether this phone was unpaired.
            Err(e) => match timeout(Duration::from_secs(2), connection.closed()).await {
                Ok(reason) if is_unpaired(&reason) => Err(unpaired()),
                _ => Err(e.to_string()),
            },
        }
    }
}

fn is_unpaired(error: &quinn::ConnectionError) -> bool {
    matches!(error, quinn::ConnectionError::ApplicationClosed(c) if c.error_code == UNPAIRED.into())
}

fn unpaired() -> String {
    "This device was removed from the family's parent devices. Pair it again from the dashboard."
        .into()
}

/// A running parent session: open `url()` in a web view.
#[derive(uniffi::Object)]
pub struct RemoteSession {
    url: String,
    runtime: Mutex<Option<Runtime>>,
}

#[uniffi::export]
impl RemoteSession {
    #[uniffi::constructor]
    pub fn start(identity: String) -> Result<Arc<Self>, CoreError> {
        let parent = identity_from(&identity)?;
        let tls_identity = Identity::new(&parent.key).map_err(invalid)?;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("temperance-remote")
            .enable_all()
            .build()
            .map_err(|e| invalid(e.to_string()))?;
        let listener = runtime
            .block_on(TcpListener::bind("127.0.0.1:0"))
            .map_err(|e| invalid(e.to_string()))?;
        let port = listener
            .local_addr()
            .map_err(|e| invalid(e.to_string()))?
            .port();
        let mut secret = [0u8; 32];
        OsRng.fill_bytes(&mut secret);
        let token = URL_SAFE_NO_PAD.encode(secret);
        let proxy = Arc::new(Proxy {
            host: format!("127.0.0.1:{port}"),
            origin: format!("http://127.0.0.1:{port}"),
            token: token.clone(),
            upstream: Upstream {
                parent,
                identity: tls_identity,
                home: tokio::sync::Mutex::new(None),
            },
        });
        runtime.spawn(serve(listener, proxy));
        Ok(Arc::new(RemoteSession {
            url: format!("http://127.0.0.1:{port}{START}?t={token}"),
            runtime: Mutex::new(Some(runtime)),
        }))
    }

    /// Opens the dashboard once and leaves a cookie only this web view holds.
    pub fn url(&self) -> String {
        self.url.clone()
    }

    pub fn stop(&self) {
        if let Some(runtime) = self.runtime.lock().expect("runtime lock").take() {
            runtime.shutdown_background();
        }
    }
}

impl Drop for RemoteSession {
    fn drop(&mut self) {
        self.stop();
    }
}

struct Proxy {
    host: String,
    origin: String,
    token: String,
    upstream: Upstream,
}

struct Request {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    keep_alive: bool,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

async fn serve(listener: TcpListener, proxy: Arc<Proxy>) {
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            continue;
        };
        tokio::spawn(proxy.clone().connection(stream));
    }
}

impl Proxy {
    async fn connection(self: Arc<Self>, mut stream: TcpStream) {
        let mut buffer = Vec::new();
        loop {
            let response = match read_request(&mut stream, &mut buffer).await {
                None => return,
                Some(Err(status)) => {
                    let _ = stream.write_all(&page(status, "Bad request")).await;
                    return;
                }
                Some(Ok(request)) => {
                    let keep = request.keep_alive;
                    (self.respond(request).await, keep)
                }
            };
            if stream.write_all(&response.0).await.is_err() || !response.1 {
                return;
            }
        }
    }

    fn signed_in(&self, request: &Request) -> bool {
        request.header("cookie").is_some_and(|cookies| {
            cookies.split(';').any(|c| {
                c.trim()
                    .strip_prefix(PROXY_COOKIE)
                    .and_then(|v| v.strip_prefix('='))
                    == Some(&self.token)
            })
        })
    }

    async fn respond(&self, request: Request) -> Vec<u8> {
        if request.header("host") != Some(self.host.as_str()) {
            return page(421, "This address only serves the Temperance app.");
        }
        if request.header("origin").is_some_and(|o| o != self.origin) {
            return page(403, "Requests from other pages are refused.");
        }
        let (path, query) = request.path.split_once('?').unwrap_or((&request.path, ""));
        if path == START {
            let token = query.split('&').find_map(|p| p.strip_prefix("t="));
            if token != Some(self.token.as_str()) {
                return page(403, "Open the dashboard from the Temperance app.");
            }
            let cookie = format!(
                "{PROXY_COOKIE}={}; HttpOnly; SameSite=Strict; Path=/",
                self.token
            );
            return response(
                302,
                &[
                    ("location".into(), "/".into()),
                    ("set-cookie".into(), cookie),
                ],
                b"",
            );
        }
        if !self.signed_in(&request) {
            return page(403, "Open the dashboard from the Temperance app.");
        }
        let headers = request
            .headers
            .iter()
            .filter(|(n, _)| end_to_end(n) && !n.to_ascii_lowercase().starts_with("x-temperance-"))
            .filter_map(|(n, v)| {
                if !n.eq_ignore_ascii_case("cookie") {
                    return Some((n.clone(), v.clone()));
                }
                let rest: Vec<&str> = v
                    .split(';')
                    .map(str::trim)
                    .filter(|c| !c.starts_with(&format!("{PROXY_COOKIE}=")))
                    .collect();
                (!rest.is_empty()).then(|| (n.clone(), rest.join("; ")))
            })
            .collect();
        let head = RequestHead {
            method: request.method.clone(),
            path: request.path.clone(),
            headers,
        };
        match self.upstream.request(&head, &request.body).await {
            Ok((head, body)) => {
                let headers: Vec<(String, String)> = head
                    .headers
                    .into_iter()
                    .filter(|(n, _)| end_to_end(n))
                    .collect();
                response(head.status, &headers, &body)
            }
            Err(message) => page(502, &message),
        }
    }
}

/// `None` once the web view closes the connection; `Some(Err(status))` for
/// requests the proxy refuses to read.
async fn read_request(
    stream: &mut TcpStream,
    buffer: &mut Vec<u8>,
) -> Option<Result<Request, u16>> {
    loop {
        let parsed = {
            let mut headers = [httparse::EMPTY_HEADER; 64];
            let mut request = httparse::Request::new(&mut headers);
            match request.parse(buffer) {
                Ok(httparse::Status::Complete(n)) => Some(Ok((
                    n,
                    request.method.unwrap_or("GET").to_string(),
                    request.path.unwrap_or("/").to_string(),
                    request.version == Some(1),
                    request
                        .headers
                        .iter()
                        .map(|h| {
                            (
                                h.name.to_string(),
                                String::from_utf8_lossy(h.value).into_owned(),
                            )
                        })
                        .collect::<Vec<_>>(),
                ))),
                Ok(httparse::Status::Partial) if buffer.len() > MAX_REQUEST_HEAD => Some(Err(431)),
                Ok(httparse::Status::Partial) => None,
                Err(_) => Some(Err(400)),
            }
        };
        match parsed {
            Some(Err(status)) => return Some(Err(status)),
            Some(Ok((head_len, method, path, http11, headers))) => {
                let mut request = Request {
                    method,
                    path,
                    headers,
                    body: Vec::new(),
                    keep_alive: http11,
                };
                if let Some(connection) = request.header("connection") {
                    let connection = connection.to_ascii_lowercase();
                    request.keep_alive = connection.contains("keep-alive")
                        || (http11 && !connection.contains("close"));
                }
                if request.header("transfer-encoding").is_some() {
                    return Some(Err(411));
                }
                let length = match request
                    .header("content-length")
                    .map(|l| l.trim().parse::<usize>())
                {
                    None => 0,
                    Some(Ok(l)) if l <= MAX_BODY => l,
                    Some(_) => return Some(Err(413)),
                };
                while buffer.len() < head_len + length {
                    if !fill(stream, buffer).await {
                        return None;
                    }
                }
                request.body = buffer[head_len..head_len + length].to_vec();
                buffer.drain(..head_len + length);
                return Some(Ok(request));
            }
            None => {
                if !fill(stream, buffer).await {
                    return None;
                }
            }
        }
    }
}

async fn fill(stream: &mut TcpStream, buffer: &mut Vec<u8>) -> bool {
    let mut chunk = [0u8; 16 << 10];
    match stream.read(&mut chunk).await {
        Ok(0) | Err(_) => false,
        Ok(n) => {
            buffer.extend_from_slice(&chunk[..n]);
            true
        }
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        302 => "Found",
        304 => "Not Modified",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        411 => "Length Required",
        413 => "Payload Too Large",
        421 => "Misdirected Request",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "Status",
    }
}

fn response(status: u16, headers: &[(String, String)], body: &[u8]) -> Vec<u8> {
    let mut out = format!("HTTP/1.1 {status} {}\r\n", reason(status));
    for (name, value) in headers {
        if !value.contains(['\r', '\n']) {
            out.push_str(&format!("{name}: {value}\r\n"));
        }
    }
    out.push_str(&format!("content-length: {}\r\n\r\n", body.len()));
    let mut out = out.into_bytes();
    out.extend_from_slice(body);
    out
}

fn page(status: u16, message: &str) -> Vec<u8> {
    let escaped = message
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    let body = format!(
        "<!doctype html><meta name=viewport content=\"width=device-width\"><title>Temperance</title>\
         <body style=\"font:17px system-ui;margin:3em 1.5em;color:#1d3b2c\"><h1 style=\"font-size:1.3em\">\
         Temperance</h1><p>{escaped}</p><p><a href=\"/\">Try again</a></p>"
    );
    response(
        status,
        &[("content-type".into(), "text/html; charset=utf-8".into())],
        body.as_bytes(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::{format_pairing_link, PairingLink};
    use std::io::{Read, Write};

    /// A stand-in gateway: pairs code "good", then echoes each request's head.
    fn fake_gateway() -> (
        u16,
        String,
        std::thread::JoinHandle<()>,
        Arc<std::sync::atomic::AtomicBool>,
    ) {
        let identity = Identity::new(&tls::generate_key()).unwrap();
        let pin = identity.pin();
        let socket = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        let port = socket.local_addr().unwrap().port();
        let unpair = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = unpair.clone();
        let thread = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async move {
                let endpoint = quinn::Endpoint::new(
                    tls::endpoint_config(),
                    Some(tls::server_config(&identity).unwrap()),
                    socket,
                    Arc::new(quinn::TokioRuntime),
                )
                .unwrap();
                while let Some(incoming) = endpoint.accept().await {
                    let flag = flag.clone();
                    tokio::spawn(async move {
                        let Ok(connection) = incoming.await else {
                            return;
                        };
                        let alpn = tls::negotiated_alpn(&connection).unwrap();
                        let key = tls::peer_fingerprint(&connection).unwrap();
                        if alpn == PARENT_ALPN && flag.load(std::sync::atomic::Ordering::SeqCst) {
                            connection.close(UNPAIRED.into(), b"unpaired");
                            return;
                        }
                        while let Ok((mut tx, mut rx)) = connection.accept_bi().await {
                            if alpn == PAIR_ALPN {
                                let (request, _) = receive::<PairRequest>(&mut rx).await.unwrap();
                                let reply = if request.code == "good" {
                                    PairReply {
                                        id: Some(format!("par_{}", &key[..6])),
                                        household: "Riveras".into(),
                                        error: None,
                                    }
                                } else {
                                    PairReply {
                                        error: Some("That code has expired.".into()),
                                        ..PairReply::default()
                                    }
                                };
                                send(&mut tx, &reply, b"").await.unwrap();
                            } else if flag.load(std::sync::atomic::Ordering::SeqCst) {
                                connection.close(UNPAIRED.into(), b"unpaired");
                            } else {
                                let (head, body) = receive::<RequestHead>(&mut rx).await.unwrap();
                                let echo = serde_json::to_vec(&head).unwrap();
                                let reply = ResponseHead {
                                    status: 200,
                                    headers: vec![
                                        ("content-type".into(), "application/json".into()),
                                        ("connection".into(), "close".into()),
                                        ("x-body".into(), String::from_utf8(body).unwrap()),
                                    ],
                                };
                                send(&mut tx, &reply, &echo).await.unwrap();
                            }
                        }
                    });
                }
            });
        });
        (port, pin, thread, unpair)
    }

    fn http(port: u16, request: &str) -> String {
        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let mut out = Vec::new();
        let mut chunk = [0u8; 65536];
        loop {
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    out.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&out);
                    if let Some((head, body)) = text.split_once("\r\n\r\n") {
                        let len = head
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length: "))
                            .and_then(|l| l.parse::<usize>().ok());
                        if len.is_some_and(|l| body.len() >= l) {
                            break;
                        }
                    }
                }
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    #[test]
    fn pairs_then_proxies_the_dashboard_for_its_own_web_view_only() {
        let (port, pin, _thread, unpair) = fake_gateway();
        let link = |code: &str| {
            format_pairing_link(&PairingLink {
                v: 1,
                host: "127.0.0.1".into(),
                port,
                pin: pin.clone(),
                code: code.into(),
                household: "".into(),
            })
        };
        let err = pair_parent(link("stale"), "Sam's phone".into()).unwrap_err();
        assert!(err.to_string().contains("expired"), "{err}");
        assert!(pair_parent(link("good"), " ".into()).is_err());
        let wrong_pin = format_pairing_link(&PairingLink {
            pin: tls::fingerprint(b"other gateway"),
            ..parse_pairing_link(link("good")).unwrap()
        });
        assert!(pair_parent(wrong_pin, "Sam's phone".into()).is_err());

        let identity = pair_parent(link("good"), "Sam's phone".into()).unwrap();
        let summary = describe_parent_identity(identity.clone()).unwrap();
        assert_eq!(
            (summary.name.as_str(), summary.household.as_str()),
            ("Sam's phone", "Riveras")
        );
        assert!(summary.id.starts_with("par_"));
        assert!(describe_parent_identity("{}".into()).is_err());

        let session = RemoteSession::start(identity).unwrap();
        let url = session.url();
        let proxy_port: u16 = url
            .strip_prefix("http://127.0.0.1:")
            .and_then(|r| r.split('/').next())
            .unwrap()
            .parse()
            .unwrap();
        let host = format!("Host: 127.0.0.1:{proxy_port}\r\n");
        let token = url.split("t=").nth(1).unwrap();

        let start = http(
            proxy_port,
            &format!("GET /__temperance/start?t={token} HTTP/1.1\r\n{host}\r\n"),
        );
        assert!(start.starts_with("HTTP/1.1 302"), "{start}");
        assert!(start.contains(&format!("set-cookie: temperance_proxy={token}; HttpOnly")));
        let forged = http(
            proxy_port,
            &format!("GET /__temperance/start?t=guess HTTP/1.1\r\n{host}\r\n"),
        );
        assert!(forged.starts_with("HTTP/1.1 403"));
        let anonymous = http(
            proxy_port,
            &format!("GET /api/state HTTP/1.1\r\n{host}\r\n"),
        );
        assert!(anonymous.starts_with("HTTP/1.1 403"));
        let rebound = http(
            proxy_port,
            &format!(
                "GET / HTTP/1.1\r\nHost: evil.example\r\nCookie: temperance_proxy={token}\r\n\r\n"
            ),
        );
        assert!(rebound.starts_with("HTTP/1.1 421"));
        let cross = http(
            proxy_port,
            &format!("POST /api/pause HTTP/1.1\r\n{host}Origin: https://evil.example\r\nCookie: temperance_proxy={token}\r\n\r\n"),
        );
        assert!(cross.starts_with("HTTP/1.1 403"));
        let chunked = http(
            proxy_port,
            &format!("POST /api/x HTTP/1.1\r\n{host}Transfer-Encoding: chunked\r\n\r\n0\r\n\r\n"),
        );
        assert!(chunked.starts_with("HTTP/1.1 411"));

        let ok = http(
            proxy_port,
            &format!(
                "POST /api/rewards?x=1 HTTP/1.1\r\n{host}Origin: http://127.0.0.1:{proxy_port}\r\n\
                 Cookie: a=1; temperance_proxy={token}\r\nX-Temperance-Parent: spoof\r\n\
                 Content-Type: application/json\r\nContent-Length: 8\r\n\r\n{{\"m\":15}}"
            ),
        );
        assert!(ok.starts_with("HTTP/1.1 200"), "{ok}");
        assert!(ok.contains("x-body: {\"m\":15}") && !ok.contains("connection: close"));
        let echoed: RequestHead =
            serde_json::from_str(ok.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(
            (echoed.method.as_str(), echoed.path.as_str()),
            ("POST", "/api/rewards?x=1")
        );
        assert!(echoed.headers.contains(&("Cookie".into(), "a=1".into())));
        assert!(!echoed.headers.iter().any(|(n, _)| {
            let n = n.to_ascii_lowercase();
            n == "host" || n.starts_with("x-temperance") || n == "content-length"
        }));

        unpair.store(true, std::sync::atomic::Ordering::SeqCst);
        for _ in 0..2 {
            let removed = http(
                proxy_port,
                &format!("GET / HTTP/1.1\r\n{host}Cookie: temperance_proxy={token}\r\n\r\n"),
            );
            assert!(removed.starts_with("HTTP/1.1 502"), "{removed}");
            assert!(removed.contains("removed from the family"), "{removed}");
        }
        session.stop();
    }

    #[test]
    fn an_unreachable_home_is_explained() {
        let socket = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        let port = socket.local_addr().unwrap().port();
        drop(socket);
        let link = format_pairing_link(&PairingLink {
            v: 1,
            host: "127.0.0.1".into(),
            port,
            pin: "pin".into(),
            code: "c".into(),
            household: "".into(),
        });
        let err = pair_parent(link, "Sam's phone".into()).unwrap_err();
        assert!(err.to_string().contains("Can't reach"), "{err}");
    }
}
