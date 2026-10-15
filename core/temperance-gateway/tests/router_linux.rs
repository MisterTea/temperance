//! Router mode against the real kernel: network namespaces, veth links and nftables.
//! Needs root, so it runs only with TEMPERANCE_DISPOSABLE_TEST=1 in a throwaway VM or
//! privileged container (CI, or `deploy/Dockerfile.test`), never on a workstation.
#![cfg(target_os = "linux")]

use std::io::{Read, Write};
use std::net::{TcpListener, UdpSocket};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use temperance_gateway::{generate_private_key, Config, Gateway};

const HELPER: &str = "TEMPERANCE_TEST_HELPER";
const INTERNET: &str = "203.0.113.2";

fn run(args: &[&str]) -> String {
    let out = Command::new(args[0]).args(&args[1..]).output().unwrap();
    assert!(
        out.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn quiet(args: &[&str]) -> bool {
    Command::new(args[0])
        .args(&args[1..])
        .output()
        .is_ok_and(|o| o.status.success())
}

/// Runs this test binary's `helper` in a namespace, as `role`.
fn in_namespace(namespace: &str, role: &str) -> Command {
    let mut command = Command::new("ip");
    command
        .args(["netns", "exec", namespace])
        .arg(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "helper",
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(HELPER, role);
    command
}

/// The roles `helper` plays inside the namespaces.
#[test]
#[ignore]
fn helper() {
    match std::env::var(HELPER).as_deref() {
        Ok("http") => {
            let listener = TcpListener::bind((INTERNET, 8080)).unwrap();
            for mut stream in listener.incoming().flatten() {
                let mut buf = [0; 1024];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                );
            }
        }
        Ok(source) if source.starts_with("dns:") => {
            // Asks an outside resolver for blocked.test; router mode must answer NXDOMAIN itself.
            let socket = UdpSocket::bind((&source[4..], 0)).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut query = vec![0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0];
            query.extend_from_slice(b"\x07blocked\x04test\x00\x00\x01\x00\x01");
            socket.send_to(&query, (INTERNET, 53)).unwrap();
            let mut answer = [0; 512];
            let n = socket.recv(&mut answer).expect("DNS answer");
            assert!(n > 3 && answer[3] & 15 == 3, "expected NXDOMAIN");
        }
        _ => {}
    }
}

fn browse(source: &str) -> bool {
    quiet(&[
        "ip",
        "netns",
        "exec",
        "t-home",
        "curl",
        "--silent",
        "--fail",
        "--max-time",
        "2",
        "--interface",
        source,
        &format!("http://{INTERNET}:8080"),
    ])
}

fn eventually(what: &str, condition: impl Fn() -> bool) {
    let end = Instant::now() + Duration::from_secs(10);
    while Instant::now() < end {
        if condition() {
            return;
        }
        thread::sleep(Duration::from_millis(250));
    }
    panic!("timed out: {what}");
}

fn state(tv_paused: bool) -> String {
    json!({
        "policy_schema": 2,
        "timezone": "UTC",
        "paused": false,
        "profiles": [{"id": 1, "name": "Living room", "filter_level": "teen", "deny": ["blocked.test"], "limit": 0}],
        "peers": [],
        "lan_devices": [{"id": "tv", "ip": "192.168.50.2", "profile_id": 1, "paused": tv_paused, "managed": true}],
    })
    .to_string()
}

struct Network;

impl Network {
    fn new() -> Network {
        let network = Network;
        for name in ["t-home", "t-internet"] {
            run(&["ip", "netns", "add", name]);
            run(&["ip", "netns", "exec", name, "ip", "link", "set", "lo", "up"]);
        }
        for (host, peer, namespace, host_ip, peer_ips) in [
            (
                "lan-test",
                "lan-peer",
                "t-home",
                "192.168.50.1/24",
                &["192.168.50.2/24", "192.168.50.3/24"][..],
            ),
            (
                "wan-test",
                "wan-peer",
                "t-internet",
                "203.0.113.1/24",
                &["203.0.113.2/24"][..],
            ),
        ] {
            run(&[
                "ip", "link", "add", host, "type", "veth", "peer", "name", peer,
            ]);
            run(&["ip", "link", "set", peer, "netns", namespace]);
            run(&["ip", "addr", "add", host_ip, "dev", host]);
            run(&["ip", "link", "set", host, "up"]);
            for ip in peer_ips {
                run(&[
                    "ip", "netns", "exec", namespace, "ip", "addr", "add", ip, "dev", peer,
                ]);
            }
            run(&[
                "ip", "netns", "exec", namespace, "ip", "link", "set", peer, "up",
            ]);
        }
        run(&[
            "ip",
            "netns",
            "exec",
            "t-home",
            "ip",
            "route",
            "add",
            "default",
            "via",
            "192.168.50.1",
        ]);
        // Temperance masquerades only registered devices; this stands in for the router's own NAT.
        run(&[
            "ip",
            "netns",
            "exec",
            "t-internet",
            "ip",
            "route",
            "add",
            "192.168.50.0/24",
            "via",
            "203.0.113.1",
        ]);
        run(&["sysctl", "-qw", "net.ipv4.ip_forward=1"]);
        network
    }
}

impl Drop for Network {
    fn drop(&mut self) {
        for name in ["t-home", "t-internet"] {
            quiet(&["ip", "netns", "delete", name]);
        }
        for name in ["lan-test", "wan-test"] {
            quiet(&["ip", "link", "delete", name]);
        }
        quiet(&["nft", "delete", "table", "inet", "temperance_home"]);
        quiet(&["nft", "delete", "table", "ip", "temperance_home_nat"]);
    }
}

#[test]
fn router_mode_routes_filters_and_fails_closed() {
    if std::env::var("TEMPERANCE_DISPOSABLE_TEST").as_deref() != Ok("1") {
        eprintln!("skipped: set TEMPERANCE_DISPOSABLE_TEST=1 in a disposable root environment");
        return;
    }
    let _network = Network::new();
    let mut http = in_namespace("t-internet", "http").spawn().unwrap();
    let config: Config = serde_json::from_value(json!({
        "listen": "127.0.0.1:0",
        "private_key": generate_private_key(),
        "home_dns": "192.168.50.1:53",
        "lan_networks": ["192.168.50.0/24"],
        "router": {"lan_interface": "lan-test", "lan_address": "192.168.50.1", "uplink": "wan-test"},
        "idle_bytes": 0,
    }))
    .unwrap();
    let mut gateway = Gateway::start(config).unwrap();
    gateway.apply_state(&state(false)).unwrap();
    run(&["nft", "list", "table", "inet", "temperance_home"]);

    eventually("the TV to be routed", || browse("192.168.50.2"));
    let dns = in_namespace("t-home", "dns:192.168.50.2").output().unwrap();
    assert!(
        dns.status.success(),
        "DNS to an outside resolver is redirected and filtered: {}",
        String::from_utf8_lossy(&dns.stdout)
    );
    // Counters are read when the next state arrives.
    gateway.apply_state(&state(false)).unwrap();
    let activity: Value = gateway.drain_activity();
    assert!(
        activity["activity"]
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["device_id"] == "tv" && a["buckets"][0] == "total"),
        "routed traffic is counted: {activity}"
    );

    gateway.apply_state(&state(true)).unwrap();
    eventually("pausing the TV to stop it", || !browse("192.168.50.2"));
    assert!(
        browse("192.168.50.3"),
        "unregistered LAN devices are untouched"
    );

    gateway.apply_state(&state(false)).unwrap();
    eventually("resuming the TV", || browse("192.168.50.2"));

    // No state update for longer than the lease: registered devices fail closed.
    thread::sleep(Duration::from_secs(17));
    assert!(!browse("192.168.50.2"), "an expired lease leaked traffic");
    assert!(
        browse("192.168.50.3"),
        "unregistered LAN devices are untouched"
    );

    // Stopping fails closed too: registered devices stay blocked, others keep working.
    gateway.apply_state(&state(false)).unwrap();
    eventually("a fresh lease to restore the TV", || browse("192.168.50.2"));
    gateway.stop();
    assert!(!browse("192.168.50.2"), "a stopped gateway leaked traffic");
    assert!(
        browse("192.168.50.3"),
        "unregistered LAN devices are untouched"
    );
    let _ = http.kill();
    let _ = http.wait();
}
