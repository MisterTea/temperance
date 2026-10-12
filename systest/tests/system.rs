//! Client and server together: the real server image behind Caddy, a fake internet only
//! the server can reach, and this headless client that enrolls through `temperance-core`
//! and browses over a kernel WireGuard interface. `systest/run.sh` starts everything;
//! outside that environment (`TEMPERANCE_SYSTEST` unset) every test is skipped.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream, UdpSocket};
use std::process::Command;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use temperance_core as core;
use ureq::tls::{Certificate, RootCerts, TlsConfig};

const SERVICE: &str = "https://server.test";
const ALLOWED: &str = "allowed.test";
const ALLOWED_IP: Ipv4Addr = Ipv4Addr::new(198, 51, 100, 10);
const GAMES: &str = "games.test";
const GAMES_IP: Ipv4Addr = Ipv4Addr::new(198, 51, 100, 11);
const OUTSIDE_DNS: Ipv4Addr = Ipv4Addr::new(198, 51, 100, 53);
const TUNNEL_DNS: Ipv4Addr = Ipv4Addr::new(10, 77, 0, 1);
const POLICY_DELAY: Duration = Duration::from_secs(30);

/// Returns the shared tunnel lock, or `None` (skip) outside the Compose environment.
fn environment() -> Option<MutexGuard<'static, ()>> {
    if std::env::var("TEMPERANCE_SYSTEST").as_deref() != Ok("1") {
        eprintln!("skipped: run systest/run.sh");
        return None;
    }
    // One wg0 per container, so tests take turns even if run with several threads.
    static TUNNEL: Mutex<()> = Mutex::new(());
    let guard = TUNNEL.lock().unwrap_or_else(|e| e.into_inner());
    disconnect();
    Some(guard)
}

fn agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        let path = std::env::var("TEMPERANCE_SYSTEST_CA")
            .unwrap_or_else(|_| "/caddy/caddy/pki/authorities/local/root.crt".into());
        let pem = wait_for("Caddy's root certificate", Duration::from_secs(120), || {
            std::fs::read(&path).ok()
        });
        let cert = Certificate::from_pem(&pem)
            .expect("Caddy root certificate")
            .to_owned();
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .tls_config(
                TlsConfig::builder()
                    .root_certs(RootCerts::Specific(Arc::new(vec![cert])))
                    .build(),
            )
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(15)))
            .build()
            .into();
        wait_for("the server", Duration::from_secs(180), || {
            let request = ureq::http::Request::get(format!("{SERVICE}/healthz"))
                .body(())
                .unwrap();
            agent
                .run(request)
                .ok()
                .filter(|r| r.status() == 200)
                .map(|_| ())
        });
        agent
    })
}

fn send(
    method: &str,
    url: &str,
    headers: &[(&str, String)],
    body: Option<String>,
) -> (u16, String) {
    let mut request = ureq::http::Request::builder().method(method).uri(url);
    for (name, value) in headers {
        request = request.header(*name, value);
    }
    let mut response = agent()
        .run(request.body(body.unwrap_or_default()).unwrap())
        .unwrap_or_else(|e| panic!("{method} {url}: {e}"));
    let status = response.status().as_u16();
    (
        status,
        response.body_mut().read_to_string().unwrap_or_default(),
    )
}

/// Sends a request built by `temperance-core`, exactly as the apps do.
fn call(request: core::HttpRequest) -> (u16, String) {
    let headers: Vec<(&str, String)> = request
        .headers
        .iter()
        .map(|h| (h.name.as_str(), h.value.clone()))
        .collect();
    send(&request.method, &request.url, &headers, request.body)
}

/// The parent, using the dashboard API with the admin password as bearer token.
fn admin(method: &str, path: &str, body: Option<Value>) -> Value {
    let password = std::env::var("TEMPERANCE_ADMIN_PASSWORD").expect("TEMPERANCE_ADMIN_PASSWORD");
    let headers = [
        ("Authorization", format!("Bearer {password}")),
        ("Origin", SERVICE.to_string()),
        ("Content-Type", "application/json".to_string()),
    ];
    let (status, text) = send(
        method,
        &format!("{SERVICE}/{path}"),
        &headers,
        body.map(|b| b.to_string()),
    );
    assert_eq!(status, 200, "{method} /{path}: {text}");
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("/{path}: {e}: {text}"))
}

/// A child profile with one client user, as the parent sets it up in the dashboard.
struct Child {
    profile: Value,
    username: String,
}

impl Child {
    fn new(name: &str) -> Child {
        let state = admin(
            "POST",
            "api/profiles",
            Some(json!({ "name": name, "limit": 0 })),
        );
        let profile = state["profiles"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["name"] == name)
            .cloned()
            .expect("created profile");
        let username = name.to_lowercase();
        admin(
            "POST",
            "api/users",
            Some(
                json!({ "username": username, "password": password(&username), "profile_id": profile["id"] }),
            ),
        );
        Child { profile, username }
    }

    fn id(&self) -> i64 {
        self.profile["id"].as_i64().unwrap()
    }

    /// Saves the whole profile with `changes` applied (the API replaces profiles).
    fn update(&mut self, changes: Value) {
        for (key, value) in changes.as_object().unwrap() {
            self.profile[key] = value.clone();
        }
        let mut saved = self.profile.clone();
        let fields = saved.as_object_mut().unwrap();
        fields.retain(|k, _| {
            [
                "id",
                "name",
                "avatar",
                "filter_level",
                "managed",
                "paused",
                "limit",
                "weekday_limits",
                "categories",
                "allow",
                "deny",
                "unmanaged",
                "allow_only",
                "safe_search",
                "youtube_restricted",
                "bedtime",
                "schedules",
                "category_limits",
                "site_limits",
                "app_limits",
            ]
            .contains(&k.as_str())
        });
        admin("POST", "api/profiles", Some(saved));
    }

    /// The profile as the server currently computes it (including minutes used today).
    fn current(&self) -> Value {
        admin("GET", "api/state", None)["profiles"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == self.profile["id"])
            .cloned()
            .expect("profile still exists")
    }

    /// Signs a new device in with the user's credentials and returns its identity.
    fn enroll(&self) -> core::Identity {
        let keys = core::generate_keypair();
        let request = core::sign_in_request(
            SERVICE.into(),
            self.username.clone(),
            password(&self.username),
            format!("{} system test", self.username),
            keys.public_key.clone(),
        )
        .unwrap();
        let (status, body) = call(request);
        core::enrolled_identity(SERVICE.into(), keys, status, body).expect("enrollment")
    }
}

fn password(username: &str) -> String {
    format!("{username}-system-test-password")
}

fn run(args: &[&str]) -> Result<(), String> {
    let output = Command::new(args[0])
        .args(&args[1..])
        .output()
        .map_err(|e| format!("{}: {e}", args[0]))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "{}: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

/// Brings up wg0 from the provisioning the server issued. Only the fake internet and
/// the tunnel's DNS are routed into it; without it they are unreachable.
fn connect(identity: &core::Identity) {
    let tunnel = identity.state.as_ref().unwrap().tunnel.clone();
    core::tunnel_config(identity.private_key.clone(), tunnel.clone()).expect("valid tunnel");
    std::fs::write("/run/wg0.key", &identity.private_key).unwrap();
    let keepalive = tunnel.keepalive.to_string();
    for step in [
        vec!["ip", "link", "add", "wg0", "type", "wireguard"],
        vec![
            "wg",
            "set",
            "wg0",
            "private-key",
            "/run/wg0.key",
            "peer",
            &tunnel.public_key,
            "endpoint",
            &tunnel.endpoint,
            "allowed-ips",
            "0.0.0.0/0",
            "persistent-keepalive",
            &keepalive,
        ],
        vec!["ip", "address", "add", &tunnel.address, "dev", "wg0"],
        vec!["ip", "link", "set", "wg0", "mtu", "1280", "up"],
        vec!["ip", "route", "replace", "198.51.100.0/24", "dev", "wg0"],
        vec!["ip", "route", "replace", "10.77.0.0/24", "dev", "wg0"],
    ] {
        run(&step).unwrap();
    }
}

fn disconnect() {
    let _ = run(&["ip", "link", "del", "wg0"]);
}

/// A plain DNS A query, so a filtered answer can be told apart from a timeout.
fn resolve(name: &str, server: Ipv4Addr) -> Result<Vec<Ipv4Addr>, String> {
    let socket = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    socket
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let id = (SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .subsec_nanos()
        & 0xffff) as u16;
    let mut query = vec![(id >> 8) as u8, id as u8, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0];
    for label in name.split('.') {
        query.push(label.len() as u8);
        query.extend(label.as_bytes());
    }
    query.extend([0, 0, 1, 0, 1]);
    socket
        .send_to(&query, SocketAddr::from((server, 53)))
        .map_err(|e| e.to_string())?;
    let mut buf = [0u8; 1500];
    let len = loop {
        let (len, _) = socket
            .recv_from(&mut buf)
            .map_err(|e| format!("DNS {name}: {e}"))?;
        if len >= 12 && buf[..2] == query[..2] {
            break len;
        }
    };
    let answer = &buf[..len];
    match answer[3] & 0x0f {
        0 => {}
        3 => return Err(format!("{name}: NXDOMAIN")),
        code => return Err(format!("{name}: DNS error {code}")),
    }
    let skip_name = |mut at: usize| {
        while at < answer.len() {
            match answer[at] {
                0 => return at + 1,
                n if n & 0xc0 == 0xc0 => return at + 2,
                n => at += 1 + n as usize,
            }
        }
        at
    };
    let u16_at = |at: usize| u16::from_be_bytes([answer[at], answer[at + 1]]);
    let mut at = skip_name(12) + 4;
    let mut addresses = Vec::new();
    for _ in 0..u16_at(6) {
        at = skip_name(at);
        if at + 10 > answer.len() {
            break;
        }
        let (kind, length) = (u16_at(at), u16_at(at + 8) as usize);
        at += 10;
        if kind == 1 && length == 4 && at + 4 <= answer.len() {
            addresses.push(Ipv4Addr::new(
                answer[at],
                answer[at + 1],
                answer[at + 2],
                answer[at + 3],
            ));
        }
        at += length;
    }
    Ok(addresses)
}

/// `GET /` from one of the fake internet's sites; returns the page body.
fn fetch(ip: Ipv4Addr, host: &str) -> Result<String, String> {
    let mut stream =
        TcpStream::connect_timeout(&SocketAddr::from((ip, 80)), Duration::from_secs(3))
            .map_err(|e| format!("connect {ip}: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    write!(stream, "GET / HTTP/1.0\r\nHost: {host}\r\n\r\n").map_err(|e| e.to_string())?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|e| format!("read {host}: {e}"))?;
    let (head, body) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| format!("{host}: incomplete response"))?;
    if !head.starts_with("HTTP/1.") || !head.contains(" 200 ") {
        return Err(format!(
            "{host}: {}",
            head.lines().next().unwrap_or_default()
        ));
    }
    Ok(body.trim().to_string())
}

/// What a browser on the device does: resolve through the tunnel, then connect.
fn browse(host: &str) -> Result<String, String> {
    let address = resolve(host, TUNNEL_DNS)?
        .into_iter()
        .find(|ip| !ip.is_unspecified())
        .ok_or_else(|| format!("{host}: filtered"))?;
    fetch(address, host)
}

fn wait_for<T>(what: &str, timeout: Duration, mut check: impl FnMut() -> Option<T>) -> T {
    let start = Instant::now();
    loop {
        if let Some(value) = check() {
            return value;
        }
        assert!(
            start.elapsed() < timeout,
            "timed out after {timeout:?} waiting for {what}"
        );
        std::thread::sleep(Duration::from_millis(500));
    }
}

fn browsing_works(host: &str) {
    let mut last = Ok(String::new());
    let start = Instant::now();
    while start.elapsed() < POLICY_DELAY {
        last = browse(host);
        if last.as_deref() == Ok(host) {
            return;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    let wg = Command::new("wg")
        .args(["show", "wg0"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    panic!("{host} did not load within {POLICY_DELAY:?}; last attempt: {last:?}\n{wg}");
}

fn browsing_is_blocked(host: &str) {
    wait_for(&format!("{host} to be blocked"), POLICY_DELAY, || {
        browse(host).err()
    });
}

/// `HH:MM` in the server's timezone (UTC in the Compose environment).
fn clock(offset_minutes: i64) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let minute = (now / 60 + offset_minutes).rem_euclid(24 * 60);
    format!("{:02}:{:02}", minute / 60, minute % 60)
}

#[test]
fn the_fake_internet_is_only_reachable_through_the_tunnel() {
    let Some(_tunnel) = environment() else { return };
    let child = Child::new("Isolation");
    assert!(
        fetch(ALLOWED_IP, ALLOWED).is_err(),
        "the client must not reach the internet directly"
    );

    let identity = child.enroll();
    connect(&identity);
    browsing_works(ALLOWED);
}

#[test]
fn denied_domains_are_filtered_and_the_parent_sees_the_history() {
    let Some(_tunnel) = environment() else { return };
    let mut child = Child::new("Filtering");
    child.update(json!({ "deny": [GAMES] }));
    let identity = child.enroll();
    connect(&identity);

    browsing_works(ALLOWED);
    let filtered = |answer: Result<Vec<Ipv4Addr>, String>| match answer {
        Ok(addresses) => !addresses.contains(&GAMES_IP),
        Err(error) => !error.contains("os error"),
    };
    assert!(
        filtered(resolve(GAMES, TUNNEL_DNS)),
        "{GAMES} resolved through the tunnel"
    );
    // A resolver the device picks itself is intercepted by the gateway too.
    assert!(
        filtered(resolve(GAMES, OUTSIDE_DNS)),
        "{GAMES} resolved via an outside resolver"
    );
    assert_eq!(resolve(ALLOWED, OUTSIDE_DNS).unwrap(), vec![ALLOWED_IP]);

    wait_for(
        "browsing history to reach the dashboard",
        POLICY_DELAY,
        || {
            let history = admin(
                "GET",
                &format!("api/history?profile_id={}", child.id()),
                None,
            );
            let rows = history.as_array().cloned().unwrap_or_default();
            let seen = |domain: &str, blocked: bool| {
                rows.iter()
                    .any(|r| r["domain"] == domain && r["blocked"] == blocked)
            };
            (seen(ALLOWED, false) && seen(GAMES, true)).then_some(())
        },
    );
}

#[test]
fn the_daily_limit_blocks_until_a_parent_approves_more_time() {
    let Some(_tunnel) = environment() else { return };
    let mut child = Child::new("Budget");
    let identity = child.enroll();
    connect(&identity);
    browsing_works(ALLOWED);

    wait_for(
        "the gateway to count a minute",
        Duration::from_secs(90),
        || {
            let _ = browse(ALLOWED);
            (child.current()["used"].as_u64().unwrap_or(0) >= 1).then_some(())
        },
    );
    child.update(json!({ "limit": 1 }));
    browsing_is_blocked(ALLOWED);

    let request = core::time_request(identity.clone(), 30, "Homework".into()).unwrap();
    let (status, body) = call(request);
    let asked = core::parse_time_request(status, body).expect("time request accepted");
    assert_eq!((asked.minutes, asked.status.as_str()), (30, "pending"));
    admin(
        "POST",
        "api/requests",
        Some(json!({ "id": asked.id, "approve": true })),
    );
    browsing_works(ALLOWED);
}

#[test]
fn pause_and_bedtime_block_browsing_until_lifted() {
    let Some(_tunnel) = environment() else { return };
    let mut child = Child::new("Evenings");
    let identity = child.enroll();
    connect(&identity);
    browsing_works(ALLOWED);

    child.update(json!({ "paused": true }));
    browsing_is_blocked(ALLOWED);
    child.update(json!({ "paused": false }));
    browsing_works(ALLOWED);

    child.update(json!({ "bedtime": { "start": clock(-1), "end": clock(30), "days": [0, 1, 2, 3, 4, 5, 6] } }));
    browsing_is_blocked(ALLOWED);
    child.update(json!({ "bedtime": { "start": "", "end": "", "days": [0, 1, 2, 3, 4, 5, 6] } }));
    browsing_works(ALLOWED);
}

#[test]
fn a_revoked_device_loses_the_tunnel_and_the_api() {
    let Some(_tunnel) = environment() else { return };
    let child = Child::new("Revoked");
    let identity = child.enroll();
    connect(&identity);
    browsing_works(ALLOWED);

    let device_id = identity.state.as_ref().unwrap().device_id.clone();
    let devices = admin("GET", "api/state", None)["devices"].clone();
    let device = devices
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["id"] == device_id.as_str())
        .expect("device listed in the dashboard");
    admin(
        "POST",
        "api/devices/delete",
        Some(json!({ "ip": device["ip"] })),
    );

    browsing_is_blocked(ALLOWED);
    let (status, body) = call(core::state_request(identity).unwrap());
    assert!(
        core::parse_device_state(status, body).is_err(),
        "revoked token still accepted ({status})"
    );
}
