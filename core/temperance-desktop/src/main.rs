mod app;

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand_core::{OsRng, RngCore};
use temperance_core::HttpRequest;

use app::{App, Transport, TunnelControl};

struct Https(ureq::Agent);

impl Transport for Https {
    fn send(&self, request: &HttpRequest) -> Result<(u16, String), String> {
        let mut builder = ureq::http::Request::builder()
            .method(request.method.as_str())
            .uri(&request.url);
        for header in &request.headers {
            builder = builder.header(&header.name, &header.value);
        }
        let req = builder
            .body(request.body.clone().unwrap_or_default())
            .map_err(|e| e.to_string())?;
        let mut response = self.0.run(req).map_err(|e| e.to_string())?;
        let status = response.status().as_u16();
        let body = response
            .body_mut()
            .with_config()
            .limit(1 << 20)
            .read_to_string()
            .map_err(|e| e.to_string())?;
        Ok((status, body))
    }
}

struct WireGuard;

impl TunnelControl for WireGuard {
    fn is_up(&self) -> bool {
        if cfg!(windows) {
            Command::new("sc.exe")
                .args(["query", "WireGuardTunnel$temperance"])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).contains("RUNNING"))
                .unwrap_or(false)
        } else {
            Command::new("wg")
                .args(["show", "temperance"])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        }
    }
    fn up(&self, config: &Path) -> Result<(), String> {
        let output = if cfg!(windows) {
            let program = PathBuf::from(std::env::var("ProgramFiles").unwrap_or_default())
                .join("WireGuard")
                .join("wireguard.exe");
            Command::new(program)
                .arg("/installtunnelservice")
                .arg(config)
                .output()
        } else {
            Command::new("wg-quick").arg("up").arg(config).output()
        }
        .map_err(|e| format!("WireGuard: {e}"))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!(
                "WireGuard: {}",
                String::from_utf8_lossy(&output.stderr)
            ))
        }
    }
}

fn data_dir() -> PathBuf {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--data" {
            if let Some(dir) = args.next() {
                return PathBuf::from(dir);
            }
        }
    }
    let base = std::env::var_os("APPDATA")
        .or_else(|| std::env::var_os("XDG_CONFIG_HOME"))
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("temperance")
}

fn main() {
    let dir = data_dir();
    std::fs::create_dir_all(&dir).expect("create data directory");
    let mut nonce = [0u8; 32];
    OsRng.fill_bytes(&mut nonce);
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(15)))
        .max_redirects(0)
        .http_status_as_error(false)
        .https_only(true)
        .build()
        .into();
    let app = App::new(dir, URL_SAFE_NO_PAD.encode(nonce), Https(agent), WireGuard)
        .expect("load identity");
    let app = Arc::new(Mutex::new(app));
    let server = tiny_http::Server::http("127.0.0.1:0").expect("bind localhost");
    let host = server
        .server_addr()
        .to_ip()
        .expect("ip listener")
        .to_string();
    println!("Temperance: http://{host}");

    let background = Arc::clone(&app);
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(30));
        let mut app = background.lock().unwrap();
        if app.identity.is_some() {
            if let Err(e) = app.refresh() {
                app.status = format!("{e}; existing VPN remains installed");
            }
        }
    });

    for mut request in server.incoming_requests() {
        let header = |request: &tiny_http::Request, name: &'static str| {
            request
                .headers()
                .iter()
                .find(|h| h.field.equiv(name))
                .map(|h| h.value.to_string())
        };
        let (req_host, origin) = (
            header(&request, "Host").unwrap_or_default(),
            header(&request, "Origin"),
        );
        let mut body = String::new();
        let _ = request.as_reader().take(8193).read_to_string(&mut body);
        let method = request.method().to_string();
        let path = request.url().split('?').next().unwrap_or("/").to_string();
        let response =
            app.lock()
                .unwrap()
                .handle(&method, &path, &req_host, &host, origin.as_deref(), &body);
        let mut out = tiny_http::Response::from_string(response.body)
            .with_status_code(response.status)
            .with_header(
                tiny_http::Header::from_bytes("Content-Type", response.content_type).unwrap(),
            )
            .with_header(tiny_http::Header::from_bytes("Cache-Control", "no-store").unwrap())
            .with_header(tiny_http::Header::from_bytes("X-Frame-Options", "DENY").unwrap())
            .with_header(
                tiny_http::Header::from_bytes(
                    "Content-Security-Policy",
                    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
                )
                .unwrap(),
            );
        if let Some(location) = response.location {
            out = out.with_header(tiny_http::Header::from_bytes("Location", location).unwrap());
        }
        let _ = request.respond(out);
    }
}

#[cfg(test)]
mod tests;
