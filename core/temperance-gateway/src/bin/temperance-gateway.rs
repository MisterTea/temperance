//! Standalone gateway for a Temperance server running elsewhere: polls
//! `/v1/gateway/state` and reports to `/v1/gateway/activity` every 5 s.
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use temperance_gateway::{generate_private_key, public_key, Config, Gateway};

const USAGE: &str = "usage: temperance-gateway --service URL [--key-file PATH] [--listen 0.0.0.0:51820] [--public-port 51820] [--dns-upstream 1.1.1.1:53]
       [--parent-key-file PATH]  (parent phones reach the dashboard over the gateway port)
       [--home-dns 0.0.0.0:53 --lan-network 192.168.1.0/24]
       [--router-lan-interface eth0 --router-lan-address 192.168.1.2 --router-uplink eth0]
environment: TEMPERANCE_GATEWAY_TOKEN (required), TEMPERANCE_GATEWAY_PRIVATE_KEY";

fn fail(message: &str) -> ! {
    eprintln!("{message}\n{USAGE}");
    std::process::exit(2)
}

fn main() {
    let mut args = std::collections::HashMap::new();
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let Some(name) = flag.strip_prefix("--") else {
            fail(&format!("Unexpected argument {flag}"))
        };
        if name == "help" {
            println!("{USAGE}");
            return;
        }
        let value = it
            .next()
            .unwrap_or_else(|| fail(&format!("--{name} needs a value")));
        args.insert(name.to_string(), value);
    }
    let service = args
        .get("service")
        .cloned()
        .unwrap_or_else(|| fail("--service is required"));
    let service = service.trim_end_matches('/').to_string();
    let host = service
        .split("://")
        .nth(1)
        .and_then(|rest| rest.split(['/', ':']).next())
        .unwrap_or_else(|| fail("--service must be a URL"))
        .to_string();
    if !service.starts_with("https://") && !["localhost", "127.0.0.1"].contains(&host.as_str()) {
        fail("Remote policy service must use HTTPS");
    }
    let token = std::env::var("TEMPERANCE_GATEWAY_TOKEN").unwrap_or_default();
    if token.len() < 32 {
        fail("Set TEMPERANCE_GATEWAY_TOKEN");
    }
    let private_key = match (
        std::env::var("TEMPERANCE_GATEWAY_PRIVATE_KEY"),
        args.get("key-file"),
    ) {
        (Ok(key), _) => key,
        (Err(_), Some(path)) => load_or_create_key(path),
        _ => fail("Set TEMPERANCE_GATEWAY_PRIVATE_KEY or --key-file"),
    };
    let router = match (
        args.get("router-lan-interface"),
        args.get("router-lan-address"),
        args.get("router-uplink"),
    ) {
        (Some(i), Some(a), Some(u)) => json!({"lan_interface": i, "lan_address": a, "uplink": u}),
        (None, None, None) => Value::Null,
        _ => fail(
            "--router-lan-interface, --router-lan-address and --router-uplink are used together",
        ),
    };
    let config: Config = serde_json::from_value(json!({
        "listen": args.get("listen").map_or("0.0.0.0:51820", String::as_str),
        "private_key": private_key,
        "dns_upstream": args.get("dns-upstream").map_or("1.1.1.1:53", String::as_str),
        "management_domains": [host],
        "home_dns": args.get("home-dns"),
        "lan_networks": args.get("lan-network").into_iter().collect::<Vec<_>>(),
        "router": router,
        "public_port": args.get("public-port").map(|p| p.parse::<u16>().unwrap_or_else(|_| fail("--public-port must be a port number"))),
        "remote": args.get("parent-key-file").map(|path| json!({"key_file": path, "secret": token, "target": service})),
    }))
    .unwrap_or_else(|e| fail(&e.to_string()));
    let gateway = Gateway::start(config).unwrap_or_else(|e| fail(&e));
    println!(
        "Temperance gateway listening on {}; set TEMPERANCE_VPN_PUBLIC_KEY={} on the server",
        gateway.local_addr(),
        gateway.public_key()
    );
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(5)))
        .build()
        .into();
    let auth = format!("Bearer {token}");
    let mut pending: Option<String> = None;
    // The last policy and when the parent's offline grace for it runs out.
    let mut cached: Option<(String, Instant)> = None;
    loop {
        let batch = pending
            .take()
            .unwrap_or_else(|| gateway.drain_activity().to_string());
        let reported = agent
            .post(format!("{service}/v1/gateway/activity"))
            .header("Authorization", &auth)
            .content_type("application/json")
            .send(batch.as_str());
        if reported.is_err() {
            pending = Some(batch);
        }
        let state = agent
            .get(format!("{service}/v1/gateway/state"))
            .header("Authorization", &auth)
            .call()
            .map_err(|e| e.to_string())
            .and_then(|mut r| r.body_mut().read_to_string().map_err(|e| e.to_string()))
            .and_then(|body| gateway.apply_state(&body).map(|()| body));
        match state {
            Ok(body) => {
                let grace = serde_json::from_str::<Value>(&body)
                    .ok()
                    .and_then(|s| s["offline_grace_seconds"].as_u64())
                    .unwrap_or(0);
                cached = Some((body, Instant::now() + Duration::from_secs(grace)));
            }
            Err(e) => match &cached {
                Some((body, until)) if Instant::now() < *until => {
                    let left = until.saturating_duration_since(Instant::now()).as_secs();
                    eprintln!("Gateway sync failed ({e}); enforcing the cached policy ({left} s of offline grace left)");
                    let _ = gateway.apply_state(body);
                }
                _ => eprintln!(
                    "Gateway sync failed ({e}); retrying. Forwarding stops after {} s without policy.",
                    temperance_gateway::LEASE.as_secs()
                ),
            },
        }
        std::thread::sleep(Duration::from_secs(5));
    }
}

/// Devices pin the gateway's public key, so the private key must survive restarts.
fn load_or_create_key(path: &str) -> String {
    if let Ok(existing) = std::fs::read_to_string(path) {
        let key = existing.trim().to_string();
        public_key(&key).unwrap_or_else(|e| fail(&format!("{path}: {e}")));
        return key;
    }
    let key = generate_private_key();
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options
        .open(path)
        .unwrap_or_else(|e| fail(&format!("{path}: {e}")));
    std::io::Write::write_all(&mut file, key.as_bytes())
        .unwrap_or_else(|e| fail(&format!("{path}: {e}")));
    key
}
