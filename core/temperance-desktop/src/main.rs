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

/// HTTPS-only agent for the policy service, plus a plain-HTTP agent used only for
/// the captive-portal probe.
struct Https {
    policy: ureq::Agent,
    probe: ureq::Agent,
}

fn run(
    agent: &ureq::Agent,
    request: &HttpRequest,
    limit: u64,
) -> Result<(u16, Option<String>, String), String> {
    let mut builder = ureq::http::Request::builder()
        .method(request.method.as_str())
        .uri(&request.url);
    for header in &request.headers {
        builder = builder.header(&header.name, &header.value);
    }
    let req = builder
        .body(request.body.clone().unwrap_or_default())
        .map_err(|e| e.to_string())?;
    let mut response = agent.run(req).map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let location = response
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let body = response
        .body_mut()
        .with_config()
        .limit(limit)
        .read_to_string()
        .unwrap_or_default();
    Ok((status, location, body))
}

impl Transport for Https {
    fn send(&self, request: &HttpRequest) -> Result<(u16, String), String> {
        run(&self.policy, request, 1 << 20).map(|(status, _, body)| (status, body))
    }
    fn probe(&self, request: &HttpRequest) -> Result<(u16, Option<String>, String), String> {
        run(&self.probe, request, 64 << 10)
    }
}

fn agent(timeout: u64, https_only: bool) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(timeout)))
        .max_redirects(0)
        .http_status_as_error(false)
        .https_only(https_only)
        .build()
        .into()
}

fn wireguard_tool(name: &str) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(std::env::var("ProgramFiles").unwrap_or_default())
            .join("WireGuard")
            .join(name)
    } else {
        PathBuf::from(name)
    }
}

fn command_result(output: std::io::Result<std::process::Output>) -> Result<(), String> {
    let output = output.map_err(|e| format!("WireGuard: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "WireGuard: {}",
            String::from_utf8_lossy(&output.stderr)
        ))
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
        command_result(if cfg!(windows) {
            Command::new(wireguard_tool("wireguard.exe"))
                .arg("/installtunnelservice")
                .arg(config)
                .output()
        } else {
            Command::new("wg-quick").arg("up").arg(config).output()
        })
    }
    fn down(&self, config: &Path) -> Result<(), String> {
        command_result(if cfg!(windows) {
            Command::new(wireguard_tool("wireguard.exe"))
                .args(["/uninstalltunnelservice", "temperance"])
                .output()
        } else {
            Command::new("wg-quick").arg("down").arg(config).output()
        })
    }
    fn handshake_age(&self) -> Option<u64> {
        let output = Command::new(wireguard_tool(if cfg!(windows) { "wg.exe" } else { "wg" }))
            .args(["show", "temperance", "latest-handshakes"])
            .output()
            .ok()
            .filter(|o| o.status.success())?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_secs();
        handshake_age(&String::from_utf8_lossy(&output.stdout), now)
    }
}

/// Parses `wg show <if> latest-handshakes` ("<peer key>\t<unix seconds>" per line).
fn handshake_age(output: &str, now: u64) -> Option<u64> {
    let latest: u64 = output
        .lines()
        .filter_map(|line| line.split_whitespace().nth(1)?.parse().ok())
        .max()?;
    // Zero means no handshake has ever completed.
    Some(if latest == 0 {
        u64::MAX
    } else {
        now.saturating_sub(latest)
    })
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
    if cfg!(target_os = "linux") {
        eprintln!("Temperance has no Linux device app. Protect Linux computers by routing them through the gateway as home-network devices.");
        std::process::exit(2);
    }
    let dir = data_dir();
    std::fs::create_dir_all(&dir).expect("create data directory");
    let mut nonce = [0u8; 32];
    OsRng.fill_bytes(&mut nonce);
    let transport = Https {
        policy: agent(15, true),
        probe: agent(5, false),
    };
    let app =
        App::new(dir, URL_SAFE_NO_PAD.encode(nonce), transport, WireGuard).expect("load identity");
    let app = Arc::new(Mutex::new(app));
    let server = tiny_http::Server::http("127.0.0.1:0").expect("bind localhost");
    let host = server
        .server_addr()
        .to_ip()
        .expect("ip listener")
        .to_string();
    println!("Temperance: http://{host}");

    let background = Arc::clone(&app);
    std::thread::spawn(move || {
        let mut tick = 0u64;
        loop {
            tick += 1;
            std::thread::sleep(Duration::from_secs(5));
            let mut app = background.lock().unwrap();
            if let Err(e) = app.check_portal() {
                app.status = e;
            }
            if tick % 6 == 0 && app.identity.is_some() && app.portal_until.is_none() {
                if let Err(e) = app.refresh() {
                    app.status = format!("{e}; existing VPN remains installed");
                }
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
