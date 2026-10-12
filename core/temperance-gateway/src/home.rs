//! Router mode (Linux): home-network devices that cannot run the VPN app are
//! enforced by LAN address with nftables when this machine is their default
//! router. DNS mode needs none of this; it only answers DNS (see `home_dns`).
use std::collections::{BTreeSet, HashMap};
use std::net::Ipv4Addr;
use std::time::Instant;

use serde::Deserialize;

use crate::dns::Destinations;
use crate::policy::{Policy, Verdict};

#[derive(Clone, Debug, Deserialize)]
pub struct Router {
    pub lan_interface: String,
    pub lan_address: Ipv4Addr,
    pub uplink: String,
}

/// Counter name → (device id, usage bucket).
pub type Counters = HashMap<String, (String, String)>;

fn interface(name: &str) -> Result<&str, String> {
    let ok = (1..=15).contains(&name.len())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c));
    ok.then_some(name)
        .ok_or_else(|| "Invalid interface name".into())
}

fn total_counter(ip: Ipv4Addr) -> String {
    format!("home_{}", u32::from(ip))
}

fn bucket_counter(ip: Ipv4Addr, bucket: &str) -> String {
    // FNV-1a keeps names stable across restarts without a hashing dependency.
    let hash = bucket.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
    });
    format!("bucket_{}_{:012x}", u32::from(ip), hash & 0xffff_ffff_ffff)
}

fn lease_set(name: &str, addresses: &[String]) -> String {
    let elements = if addresses.is_empty() {
        String::new()
    } else {
        format!(" elements = {{ {} }};", addresses.join(", "))
    };
    format!(" set {name} {{ type ipv4_addr; flags timeout; timeout 15s;{elements} }}")
}

/// The nftables script for the home devices in `policy`; `None` when there are none.
/// With `expired`, home devices keep LAN access but lose the internet.
pub fn script(
    router: &Router,
    policy: &Policy,
    destinations: &Destinations,
    expired: bool,
) -> Result<Option<(String, Counters)>, String> {
    let (lan, uplink) = (
        interface(&router.lan_interface)?,
        interface(&router.uplink)?,
    );
    let home = &policy.state.lan_devices;
    if home.is_empty() {
        return Ok(None);
    }
    let at = crate::now();
    let ips: Vec<String> = home.iter().map(|d| d.ip.to_string()).collect();
    let live: Vec<String> = home
        .iter()
        .filter(|d| !expired && policy.allowed(d, at))
        .map(|d| d.ip.to_string())
        .collect();
    let mut objects = vec![
        format!(
            " set home {{ type ipv4_addr; elements = {{ {} }}; }}",
            ips.join(", ")
        ),
        lease_set("home_lease", &live),
    ];
    let mut counters = Counters::new();
    // Destination rules precede the lease check; per-device accepts follow it.
    let (mut outbound, mut inbound) = (Vec::new(), Vec::new());
    let (mut device_out, mut device_in) = (Vec::new(), Vec::new());
    if !expired {
        let now = Instant::now();
        for d in home {
            for (address, hosts) in destinations.entries(d.ip, now) {
                let (out, back) = (
                    format!("ip saddr {} ip daddr {address}", d.ip),
                    format!("ip daddr {} ip saddr {address}", d.ip),
                );
                match policy.flow(d.ip, &hosts, at) {
                    Verdict::Drop => {
                        outbound.push(format!("  {out} drop"));
                        inbound.push(format!("  {back} drop"));
                    }
                    Verdict::Allow { buckets, .. } => {
                        let names: Vec<String> = buckets
                            .iter()
                            .map(|b| {
                                let name = if b == "total" {
                                    total_counter(d.ip)
                                } else {
                                    bucket_counter(d.ip, b)
                                };
                                if b != "total" && !counters.contains_key(&name) {
                                    objects.push(format!(" counter {name} {{ }}"));
                                }
                                counters.insert(name.clone(), (d.id.clone(), b.clone()));
                                format!("counter name \"{name}\" ")
                            })
                            .collect();
                        let count = names.concat();
                        outbound.push(format!("  {out} {count}accept"));
                        inbound.push(format!(
                            "  {back} ct state established,related {count}accept"
                        ));
                    }
                }
            }
        }
    }
    for d in home {
        objects.push(format!(" counter {} {{ }}", total_counter(d.ip)));
        if !expired && policy.allowed(d, at) && !policy.strict(d, at) {
            let count = if policy.counted(d) {
                counters.insert(total_counter(d.ip), (d.id.clone(), "total".into()));
                format!("counter name \"{}\" ", total_counter(d.ip))
            } else {
                String::new()
            };
            device_out.push(format!("  ip saddr {} {count}accept", d.ip));
            device_in.push(format!(
                "  ip daddr {} ct state established,related {count}accept",
                d.ip
            ));
        }
    }
    let listed = format!("{{ {} }}", ips.join(", "));
    let mut lines = vec!["table inet temperance_home {".to_string()];
    lines.extend(objects);
    lines.extend([
        " chain forward { type filter hook forward priority -10; policy accept;".to_string(),
        format!("  iifname \"{lan}\" ip saddr @home jump home_outbound"),
        format!("  oifname \"{lan}\" ip daddr @home jump home_inbound"),
        " }".into(),
        " chain home_outbound {".into(),
        format!("  oifname != \"{uplink}\" accept"),
        "  udp dport { 53, 853 } drop".into(),
        "  tcp dport { 53, 853 } drop".into(),
    ]);
    lines.extend(outbound);
    lines.push("  ip saddr != @home_lease drop".into());
    lines.extend(device_out);
    lines.extend([
        "  drop".into(),
        " }".into(),
        " chain home_inbound {".into(),
        format!("  iifname != \"{uplink}\" accept"),
    ]);
    lines.extend(inbound);
    lines.push("  ip daddr != @home_lease drop".into());
    lines.extend(device_in);
    lines.extend([
        "  drop".into(),
        " }".into(),
        "}".into(),
        "table ip temperance_home_nat {".into(),
        " chain postrouting { type nat hook postrouting priority srcnat; policy accept;".into(),
        format!("  ip saddr {listed} oifname \"{uplink}\" masquerade"),
        " }".into(),
        " chain prerouting { type nat hook prerouting priority dstnat; policy accept;".into(),
        format!(
            "  iifname \"{lan}\" ip saddr {listed} udp dport 53 dnat to {}:53",
            router.lan_address
        ),
        format!(
            "  iifname \"{lan}\" ip saddr {listed} tcp dport 53 dnat to {}:53",
            router.lan_address
        ),
        " }".into(),
        "}".into(),
    ]);
    Ok(Some((lines.join("\n") + "\n", counters)))
}

#[cfg(target_os = "linux")]
fn nft(args: &[&str], input: Option<&str>) -> Result<String, String> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let mut child = Command::new("nft")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("nft: {e}"))?;
    if let Some(input) = input {
        child
            .stdin
            .take()
            .expect("piped")
            .write_all(input.as_bytes())
            .map_err(|e| e.to_string())?;
    }
    drop(child.stdin.take());
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!(
            "nft failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(not(target_os = "linux"))]
fn nft(_: &[&str], _: Option<&str>) -> Result<String, String> {
    Err("Router mode is only available on Linux".into())
}

/// Replace our tables in one transaction; other applications' rules are never touched.
pub fn install(script: Option<&str>) -> Result<(), String> {
    let mut body = String::new();
    for (family, table) in [("inet", "temperance_home"), ("ip", "temperance_home_nat")] {
        if nft(&["list", "table", family, table], None).is_ok() {
            body.push_str(&format!("delete table {family} {table}\n"));
        }
    }
    body.push_str(script.unwrap_or_default());
    if body.is_empty() {
        return Ok(());
    }
    nft(&["-f", "-"], Some(&body)).map(drop)
}

/// Read and reset nothing: counters restart whenever the table is replaced.
pub fn activity(counters: &Counters) -> HashMap<String, BTreeSet<String>> {
    let mut active: HashMap<String, BTreeSet<String>> = HashMap::new();
    if counters.is_empty() {
        return active;
    }
    let Ok(raw) = nft(&["-j", "list", "table", "inet", "temperance_home"], None) else {
        return active;
    };
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap_or_default();
    for item in parsed["nftables"].as_array().into_iter().flatten() {
        let counter = &item["counter"];
        if counter["bytes"].as_u64().unwrap_or(0) == 0 {
            continue;
        }
        if let Some((device, bucket)) = counter["name"].as_str().and_then(|n| counters.get(n)) {
            active
                .entry(device.clone())
                .or_default()
                .insert(bucket.clone());
        }
    }
    active
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::State;
    use serde_json::json;

    fn policy(profile: serde_json::Value, paused: bool) -> Policy {
        let mut p = json!({"id": 1, "name": "TV", "filter_level": "teen"});
        p.as_object_mut()
            .unwrap()
            .extend(profile.as_object().unwrap().clone());
        let state: State = serde_json::from_value(json!({
            "policy_schema": 2, "timezone": "UTC", "profiles": [p], "peers": [],
            "lan_devices": [{"id": "tv", "ip": "192.168.1.50", "profile_id": 1, "paused": paused}],
        }))
        .unwrap();
        Policy::new(state, &["192.168.1.0/24".parse().unwrap()], &[]).unwrap()
    }

    fn router() -> Router {
        Router {
            lan_interface: "eth0".into(),
            lan_address: "192.168.1.2".parse().unwrap(),
            uplink: "eth0".into(),
        }
    }

    #[test]
    fn allowed_devices_are_leased_counted_and_dns_redirected() {
        let mut d = Destinations::default();
        d.observe(
            "192.168.1.50".parse().unwrap(),
            "youtube.com",
            &[("142.250.1.1".parse().unwrap(), 300)],
            Instant::now(),
        );
        let (script, counters) = script(&router(), &policy(json!({}), false), &d, false)
            .unwrap()
            .unwrap();
        assert!(script.contains("set home_lease { type ipv4_addr; flags timeout; timeout 15s; elements = { 192.168.1.50 }; }"));
        assert!(script.contains("ip saddr 192.168.1.50 counter name \"home_3232235826\" accept"));
        assert!(script.contains(
            "iifname \"eth0\" ip saddr { 192.168.1.50 } udp dport 53 dnat to 192.168.1.2:53"
        ));
        assert!(script.contains("ip saddr 192.168.1.50 ip daddr 142.250.1.1 counter name"));
        let buckets: BTreeSet<&str> = counters.values().map(|(_, b)| b.as_str()).collect();
        assert_eq!(
            buckets,
            BTreeSet::from(["category:video", "site:youtube.com", "total"])
        );
        assert!(counters.values().all(|(device, _)| device == "tv"));
        // Destination rules come before the lease check so blocked hosts drop even for leased devices.
        assert!(
            script.find("ip daddr 142.250.1.1").unwrap()
                < script.find("ip saddr != @home_lease").unwrap()
        );
    }

    #[test]
    fn paused_or_expired_devices_lose_the_internet() {
        let d = Destinations::default();
        for (paused, expired) in [(true, false), (false, true)] {
            let (script, _) = script(&router(), &policy(json!({}), paused), &d, expired)
                .unwrap()
                .unwrap();
            assert!(
                script.contains("set home_lease { type ipv4_addr; flags timeout; timeout 15s; }"),
                "{script}"
            );
            assert!(
                !script.contains("ip saddr 192.168.1.50 counter"),
                "{script}"
            );
        }
    }

    #[test]
    fn rejects_hostile_interface_names() {
        let bad = Router {
            lan_interface: "eth0\"; flush".into(),
            ..router()
        };
        assert!(script(
            &bad,
            &policy(json!({}), false),
            &Destinations::default(),
            false
        )
        .is_err());
    }
}
