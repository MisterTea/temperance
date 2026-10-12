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

/// The official WireGuard tools, run from `tools` or, when it is `None`, from `PATH`.
struct WireGuard {
    tools: Option<PathBuf>,
}

impl WireGuard {
    fn system() -> Self {
        WireGuard {
            tools: cfg!(windows).then(|| {
                PathBuf::from(std::env::var("ProgramFiles").unwrap_or_default()).join("WireGuard")
            }),
        }
    }
    fn tool(&self, name: &str) -> Command {
        let exe = format!("{name}{}", std::env::consts::EXE_SUFFIX);
        Command::new(
            self.tools
                .as_ref()
                .map_or(PathBuf::from(&exe), |d| d.join(&exe)),
        )
    }
}

impl TunnelControl for WireGuard {
    #[cfg(windows)]
    fn is_up(&self) -> bool {
        Command::new("sc.exe")
            .args(["query", "WireGuardTunnel$temperance"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains("RUNNING"))
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    fn is_up(&self) -> bool {
        self.tool("wg")
            .args(["show", "temperance"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[cfg(windows)]
    fn up(&self, config: &Path) -> Result<(), String> {
        command_result(
            self.tool("wireguard")
                .arg("/installtunnelservice")
                .arg(config)
                .output(),
        )
    }
    #[cfg(not(windows))]
    fn up(&self, config: &Path) -> Result<(), String> {
        command_result(self.tool("wg-quick").arg("up").arg(config).output())
    }
    #[cfg(windows)]
    fn down(&self, _config: &Path) -> Result<(), String> {
        command_result(
            self.tool("wireguard")
                .args(["/uninstalltunnelservice", "temperance"])
                .output(),
        )
    }
    #[cfg(not(windows))]
    fn down(&self, config: &Path) -> Result<(), String> {
        command_result(self.tool("wg-quick").arg("down").arg(config).output())
    }
    fn handshake_age(&self) -> Option<u64> {
        let output = self
            .tool("wg")
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

/// `--data <dir>`, else `temperance` under the platform's per-user config directory.
fn data_dir(
    mut args: impl Iterator<Item = String>,
    var: impl Fn(&str) -> Option<std::ffi::OsString>,
) -> PathBuf {
    while let Some(arg) = args.next() {
        if arg == "--data" {
            if let Some(dir) = args.next() {
                return PathBuf::from(dir);
            }
        }
    }
    let base = var("APPDATA")
        .or_else(|| var("XDG_CONFIG_HOME"))
        .map(PathBuf::from)
        .or_else(|| var("HOME").map(|h| PathBuf::from(h).join(".config")))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("temperance")
}

/// Background work every 5 seconds: end Wi-Fi sign-in windows, and refresh policy every 30 s.
fn tick<T: Transport, W: TunnelControl>(app: &mut App<T, W>, count: u64) {
    if let Err(e) = app.check_portal() {
        app.status = e;
    }
    if count % 6 == 0 && app.identity.is_some() && app.portal_until.is_none() {
        if let Err(e) = app.refresh() {
            app.status = format!("{e}; existing VPN remains installed");
        }
    }
}

fn respond<T: Transport, W: TunnelControl>(
    app: &mut App<T, W>,
    mut request: tiny_http::Request,
    host: &str,
) {
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
    let response = app.handle(&method, &path, &req_host, host, origin.as_deref(), &body);
    let mut out = tiny_http::Response::from_string(response.body)
        .with_status_code(response.status)
        .with_header(tiny_http::Header::from_bytes("Content-Type", response.content_type).unwrap())
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

fn main() {
    if cfg!(target_os = "linux") {
        eprintln!("Temperance has no Linux device app. Protect Linux computers by routing them through the gateway as home-network devices.");
        std::process::exit(2);
    }
    let dir = data_dir(std::env::args().skip(1), |name| std::env::var_os(name));
    std::fs::create_dir_all(&dir).expect("create data directory");
    let mut nonce = [0u8; 32];
    OsRng.fill_bytes(&mut nonce);
    let transport = Https {
        policy: agent(15, true),
        probe: agent(5, false),
    };
    let app = App::new(
        dir,
        URL_SAFE_NO_PAD.encode(nonce),
        transport,
        WireGuard::system(),
    )
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
    std::thread::spawn(move || {
        let mut count = 0u64;
        loop {
            count = count.wrapping_add(1);
            std::thread::sleep(Duration::from_secs(5));
            tick(&mut background.lock().unwrap(), count);
        }
    });
    for request in server.incoming_requests() {
        respond(&mut app.lock().unwrap(), request, &host);
    }
}

#[cfg(test)]
mod tests;
