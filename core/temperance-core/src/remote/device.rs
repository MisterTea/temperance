//! A client's device talking to its home. While the device's WireGuard tunnel
//! is up, requests go to the gateway inside it as plain HTTP: the tunnel
//! already encrypts and authenticates them, and the gateway admits them even
//! while the device is paused. Otherwise (setting up, or with the VPN off) they
//! go over QUIC to the home's address with the gateway's key pinned, on the
//! same UDP port as WireGuard.
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::OnceLock;
use std::time::Duration;

use tokio::time::timeout;
use url::Url;

use super::client::{unreachable, Home};
use super::tls::{self, Identity};
use super::{end_to_end, invalid, receive, send, RequestHead, ResponseHead, DEVICE_ALPN, MAX_BODY};
use crate::{CoreError, HttpRequest};

/// The gateway's own address inside the tunnel, where it serves the dashboard.
const IN_TUNNEL: SocketAddr = SocketAddr::new(
    std::net::IpAddr::V4(std::net::Ipv4Addr::new(10, 77, 0, 1)),
    80,
);
const REPLY_LIMIT: u64 = 1 << 20;

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

struct Target {
    pin: String,
    host: String,
    port: u16,
    path: String,
}

fn target(url: &str) -> Result<Target, CoreError> {
    let bad = || invalid("Set this device up again with the code from your family's dashboard.");
    let url = Url::parse(url).map_err(|_| bad())?;
    if url.scheme() != "temperance" || url.username().is_empty() {
        return Err(bad());
    }
    let host = url
        .host_str()
        .ok_or_else(bad)?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    Ok(Target {
        pin: url.username().to_string(),
        host,
        port: url.port().ok_or_else(bad)?,
        path: match url.query() {
            Some(query) => format!("{}?{query}", url.path()),
            None => url.path().to_string(),
        },
    })
}

/// Sends a request built by `api` to the device's home. `through_tunnel` is
/// whether this device's VPN is connected; blocking, so call it off the UI thread.
#[uniffi::export]
pub fn home_send(request: HttpRequest, through_tunnel: bool) -> Result<HttpResponse, CoreError> {
    send_via(&request, through_tunnel.then_some(IN_TUNNEL))
}

pub(crate) fn send_via(
    request: &HttpRequest,
    in_tunnel: Option<SocketAddr>,
) -> Result<HttpResponse, CoreError> {
    let target = target(&request.url)?;
    if let Some(addr) = in_tunnel {
        // Only a failed connect falls back: a request that may have arrived is never sent twice.
        if let Ok(stream) = TcpStream::connect_timeout(&addr, Duration::from_secs(3)) {
            return over_tunnel(stream, request, &target.path);
        }
    }
    over_quic(request, &target)
}

fn over_tunnel(
    mut stream: TcpStream,
    request: &HttpRequest,
    path: &str,
) -> Result<HttpResponse, CoreError> {
    let lost = |e: std::io::Error| CoreError::Service {
        status: 503,
        detail: format!("The connection to your home's Temperance dropped ({e})."),
    };
    let body = request.body.as_deref().unwrap_or("");
    // HTTP/1.0: the reply is never chunked and ends when the connection closes.
    let mut head = format!(
        "{} {path} HTTP/1.0\r\nHost: {}\r\n",
        request.method,
        IN_TUNNEL.ip()
    );
    for header in &request.headers {
        if end_to_end(&header.name)
            && !format!("{}{}", header.name, header.value).contains(['\r', '\n'])
        {
            head.push_str(&format!("{}: {}\r\n", header.name, header.value));
        }
    }
    head.push_str(&format!("Content-Length: {}\r\n\r\n", body.len()));
    stream
        .set_read_timeout(Some(Duration::from_secs(15)))
        .and_then(|_| stream.set_write_timeout(Some(Duration::from_secs(15))))
        .and_then(|_| stream.write_all(head.as_bytes()))
        .and_then(|_| stream.write_all(body.as_bytes()))
        .map_err(lost)?;
    let mut reply = Vec::new();
    stream
        .take(REPLY_LIMIT + (64 << 10))
        .read_to_end(&mut reply)
        .map_err(lost)?;
    parse_reply(&reply)
}

fn parse_reply(reply: &[u8]) -> Result<HttpResponse, CoreError> {
    let bad = || CoreError::Service {
        status: 502,
        detail: "Your home's Temperance sent a reply this app can't read.".into(),
    };
    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut response = httparse::Response::new(&mut headers);
    let httparse::Status::Complete(head_len) = response.parse(reply).map_err(|_| bad())? else {
        return Err(bad());
    };
    let status = response.code.ok_or_else(bad)?;
    let header = |name: &str| {
        response
            .headers
            .iter()
            .find(|h| h.name.eq_ignore_ascii_case(name))
            .and_then(|h| std::str::from_utf8(h.value).ok())
    };
    if header("transfer-encoding").is_some() {
        return Err(bad());
    }
    let mut body = &reply[head_len..];
    if let Some(length) = header("content-length").and_then(|l| l.trim().parse::<usize>().ok()) {
        body = body.get(..length).ok_or_else(bad)?;
    }
    Ok(HttpResponse {
        status,
        body: String::from_utf8_lossy(body).into_owned(),
    })
}

fn over_quic(request: &HttpRequest, target: &Target) -> Result<HttpResponse, CoreError> {
    // The gateway accepts any client key for device requests; the device token authenticates.
    static KEY: OnceLock<String> = OnceLock::new();
    let identity = Identity::new(KEY.get_or_init(tls::generate_key)).map_err(invalid)?;
    let head = RequestHead {
        method: request.method.clone(),
        path: target.path.clone(),
        headers: request
            .headers
            .iter()
            .map(|h| (h.name.clone(), h.value.clone()))
            .collect(),
    };
    let body = request.body.clone().unwrap_or_default();
    let (host, port) = (target.host.as_str(), target.port);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| invalid(e.to_string()))?;
    runtime.block_on(async {
        let home = Home::dial(host, port, &target.pin, &identity, DEVICE_ALPN).await?;
        let exchange = async {
            let (mut tx, mut rx) = home
                .connection
                .open_bi()
                .await
                .map_err(|e| unreachable(host, port, e))?;
            send(&mut tx, &head, body.as_bytes())
                .await
                .map_err(|e| unreachable(host, port, e))?;
            receive::<ResponseHead>(&mut rx)
                .await
                .map_err(|e| unreachable(host, port, e))
        };
        let reply = timeout(Duration::from_secs(20), exchange)
            .await
            .unwrap_or_else(|_| Err(unreachable(host, port, "timed out")));
        home.close().await;
        let (head, body) = reply?;
        if body.len() > MAX_BODY {
            return Err(invalid("Reply too large"));
        }
        Ok(HttpResponse {
            status: head.status,
            body: String::from_utf8_lossy(&body).into_owned(),
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{format_home_link, sign_in_request, validate_service, HomeLink};
    use std::net::TcpListener;
    use std::sync::Arc;

    fn service(port: u16, pin: &str) -> String {
        validate_service(format_home_link(&HomeLink {
            v: 1,
            host: "127.0.0.1".into(),
            port,
            pin: pin.into(),
            household: "Riveras".into(),
        }))
        .unwrap()
    }

    fn sign_in(service: String) -> HttpRequest {
        sign_in_request(
            service,
            "sam".into(),
            "secret".into(),
            "Phone".into(),
            "key".into(),
        )
        .unwrap()
    }

    /// A stand-in gateway answering device requests with their method and path.
    fn fake_gateway() -> (u16, String) {
        let identity = Identity::new(&tls::generate_key()).unwrap();
        let pin = identity.pin();
        let socket = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        let port = socket.local_addr().unwrap().port();
        std::thread::spawn(move || {
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
                    tokio::spawn(async move {
                        let connection = incoming.await.unwrap();
                        assert_eq!(tls::negotiated_alpn(&connection).unwrap(), DEVICE_ALPN);
                        while let Ok((mut tx, mut rx)) = connection.accept_bi().await {
                            let (head, body) = receive::<RequestHead>(&mut rx).await.unwrap();
                            let reply = ResponseHead {
                                status: 200,
                                headers: vec![],
                            };
                            let text = format!("quic {} {} {}", head.method, head.path, body.len());
                            send(&mut tx, &reply, text.as_bytes()).await.unwrap();
                        }
                    });
                }
            });
        });
        (port, pin)
    }

    #[test]
    fn requests_name_the_pinned_gateway() {
        let pin = "p".repeat(43);
        let request = sign_in(service(51820, &pin));
        assert_eq!(
            request.url,
            format!("temperance://{pin}@127.0.0.1:51820/v1/device/login")
        );
        let parsed = target(&request.url).unwrap();
        assert_eq!(
            (parsed.host.as_str(), parsed.port, parsed.path.as_str()),
            ("127.0.0.1", 51820, "/v1/device/login")
        );
        let v6 = target(&format!("temperance://{pin}@[::1]:9/v1/device/state?x=1")).unwrap();
        assert_eq!(
            (v6.host.as_str(), v6.path.as_str()),
            ("::1", "/v1/device/state?x=1")
        );
        for bad in [
            "https://family.example/v1/device/state",
            "temperance://host:1/x",
            "temperance://pin@host/x",
        ] {
            assert!(target(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn without_a_tunnel_requests_go_over_quic_to_the_pinned_key() {
        let (port, pin) = fake_gateway();
        let reply = home_send(sign_in(service(port, &pin)), false).unwrap();
        assert_eq!(reply.status, 200);
        assert!(
            reply.body.starts_with("quic POST /v1/device/login "),
            "{}",
            reply.body
        );

        let other = Identity::new(&tls::generate_key()).unwrap().pin();
        let err = home_send(sign_in(service(port, &other)), false).unwrap_err();
        assert!(err.to_string().contains("Can't reach"), "{err}");
    }

    #[test]
    fn inside_the_tunnel_requests_are_plain_http_to_the_gateway() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut seen = Vec::new();
            let mut chunk = [0u8; 4096];
            while !String::from_utf8_lossy(&seen).contains("\"public_key\"") {
                let n = stream.read(&mut chunk).unwrap();
                seen.extend_from_slice(&chunk[..n]);
            }
            stream
                .write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: 15\r\n\r\n{\"error\":\"no\"}\nextra")
                .unwrap();
            String::from_utf8(seen).unwrap()
        });
        let reply = send_via(&sign_in(service(9, &"p".repeat(43))), Some(addr)).unwrap();
        assert_eq!(
            (reply.status, reply.body.as_str()),
            (401, "{\"error\":\"no\"}\n")
        );
        let seen = server.join().unwrap();
        assert!(
            seen.starts_with("POST /v1/device/login HTTP/1.0\r\nHost: 10.77.0.1\r\n"),
            "{seen}"
        );
        assert!(seen.contains("Content-Type: application/json\r\n"));
    }

    #[test]
    fn a_tunnel_that_does_not_answer_falls_back_to_quic() {
        let (port, pin) = fake_gateway();
        let closed = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap();
        let reply = send_via(&sign_in(service(port, &pin)), Some(closed)).unwrap();
        assert!(reply.body.starts_with("quic POST"), "{}", reply.body);
    }

    #[test]
    fn unreadable_replies_are_errors() {
        assert!(parse_reply(b"HTTP/1.1 200 OK\r\n").is_err());
        assert!(parse_reply(b"nonsense\r\n\r\n").is_err());
        assert!(
            parse_reply(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n").is_err()
        );
        assert!(parse_reply(b"HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\nshort").is_err());
        let reply = parse_reply(b"HTTP/1.0 200 OK\r\n\r\n{\"ok\":true}").unwrap();
        assert_eq!(reply.body, "{\"ok\":true}");
    }
}
