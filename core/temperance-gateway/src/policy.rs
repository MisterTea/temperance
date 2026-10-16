//! Household policy as the gateway sees it: who a source address is, what a
//! DNS name may resolve to, and whether a flow may be forwarded and counted.
use std::collections::{BTreeSet, HashMap, HashSet};
use std::net::Ipv4Addr;

use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use temperance_core::policy::{
    access_reason_at, active_windows, categories_of, classify, domain_reason_at, matches, zone,
    Profile,
};

use crate::net::{Net, TUNNEL};

pub const POLICY_SCHEMA: u32 = 2;

fn yes() -> bool {
    true
}

/// A VPN peer or a home-network device enforced by LAN address.
#[derive(Clone, Debug, Deserialize)]
pub struct Client {
    pub id: String,
    pub ip: Ipv4Addr,
    #[serde(default)]
    pub public_key: Option<String>,
    pub profile_id: u32,
    #[serde(default)]
    pub paused: bool,
    #[serde(default = "yes")]
    pub managed: bool,
}

/// The subset of `service.gatewayState()` the gateway enforces.
#[derive(Clone, Debug, Deserialize)]
pub struct State {
    pub policy_schema: u32,
    pub timezone: String,
    #[serde(default)]
    pub paused: bool,
    pub profiles: Vec<Profile>,
    #[serde(default)]
    pub peers: Vec<Client>,
    #[serde(default)]
    pub lan_devices: Vec<Client>,
    #[serde(default)]
    pub extra_domains: HashMap<String, Vec<String>>,
    /// Device upkeep (updates, push, connectivity checks) that never counts as time.
    #[serde(default)]
    pub free_domains: Vec<String>,
    #[serde(default)]
    pub home_profile_id: Option<u32>,
    /// UPnP and dynamic DNS settings; absent means UPnP on, no dynamic DNS.
    #[serde(default)]
    pub network: Option<crate::reach::Settings>,
    /// Paired parent phones allowed to reach the dashboard.
    #[serde(default)]
    pub parents: Vec<crate::parent::Paired>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct HistoryEntry {
    pub id: String,
    pub device_id: String,
    pub at: f64,
    pub domain: String,
    pub blocked: bool,
    pub reason: String,
    pub category: String,
}

/// What to do with a flow: drop it, or forward it and count its traffic in
/// `buckets` (`total`, `category:…`, `site:…`, `group:…`) for `device`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Verdict {
    Drop,
    Allow {
        device: String,
        buckets: BTreeSet<String>,
    },
}

pub struct Policy {
    pub state: State,
    tz: Tz,
    clients: HashMap<Ipv4Addr, Client>,
    profiles: HashMap<u32, Profile>,
    lan_networks: Vec<Net>,
    management: HashSet<String>,
    free: HashSet<String>,
}

impl Policy {
    pub fn new(state: State, lan_networks: &[Net], management: &[String]) -> Result<Self, String> {
        if state.policy_schema != POLICY_SCHEMA {
            return Err("Unsupported policy format; upgrade the Temperance web service".into());
        }
        let tz = zone(&state.timezone).map_err(|e| e.to_string())?;
        for peer in &state.peers {
            if !TUNNEL.contains(peer.ip) {
                return Err(format!("Peer {} outside tunnel network", peer.ip));
            }
        }
        for device in &state.lan_devices {
            if TUNNEL.contains(device.ip) || !device.ip.is_private() {
                return Err(format!(
                    "Home device {} outside private LAN ranges",
                    device.ip
                ));
            }
        }
        let clients = state
            .peers
            .iter()
            .chain(&state.lan_devices)
            .map(|c| (c.ip, c.clone()))
            .collect();
        let profiles = state.profiles.iter().map(|p| (p.id, p.clone())).collect();
        let free = state
            .free_domains
            .iter()
            .map(|d| d.to_ascii_lowercase())
            .collect();
        Ok(Policy {
            free,
            state,
            tz,
            clients,
            profiles,
            lan_networks: lan_networks.to_vec(),
            management: management.iter().map(|d| d.to_ascii_lowercase()).collect(),
        })
    }

    pub fn client(&self, ip: Ipv4Addr) -> Option<&Client> {
        self.clients.get(&ip)
    }

    fn on_lan(&self, ip: Ipv4Addr) -> bool {
        self.lan_networks.iter().any(|n| n.contains(ip))
    }

    /// Unregistered addresses on the home network are not filtered. Only devices
    /// added on the dashboard follow a client.
    fn subject(&self, ip: Ipv4Addr) -> (Option<&Client>, Option<&Profile>) {
        if let Some(c) = self.clients.get(&ip) {
            return (Some(c), self.profiles.get(&c.profile_id));
        }
        (None, None)
    }

    pub fn management(&self, host: &str) -> bool {
        self.management.contains(host)
    }

    /// `host` or one of its parent domains is on the free list.
    pub fn free(&self, host: &str) -> bool {
        let mut rest = host;
        loop {
            if self.free.contains(rest) {
                return true;
            }
            match rest.split_once('.') {
                Some((_, parent)) => rest = parent,
                None => return false,
            }
        }
    }

    /// Free domains outlast budgets, focus time and allow-lists, but not pauses,
    /// bedtime, Off Time or a site the admin blocked for this client.
    fn domain_reason(&self, p: &Profile, host: &str, at: f64) -> String {
        let reason = domain_reason_at(
            p,
            host,
            at as i64,
            self.tz,
            self.state.paused,
            &self.state.extra_domains,
        );
        if !self.free(host) || p.deny.iter().any(|d| matches(host, d)) {
            return reason;
        }
        match reason.as_str() {
            "unmanaged" | "household pause" | "paused" | "bedtime" | "off time" => reason,
            _ => "allowed".into(),
        }
    }

    pub fn category(&self, host: &str) -> String {
        classify(host, &self.state.extra_domains)
    }

    /// DNS decision for `host` asked by `ip`; also returns the history entry to report.
    pub fn evaluate(
        &self,
        ip: Ipv4Addr,
        host: &str,
        at: f64,
    ) -> (bool, String, Option<HistoryEntry>) {
        let (client, profile) = self.subject(ip);
        let Some(p) = profile else {
            if client.is_none() && self.on_lan(ip) {
                return (false, "unmanaged".into(), None);
            }
            return (false, "unassigned VPN device".into(), None);
        };
        let mut reason = if client.is_some_and(|c| !c.managed) || !p.managed {
            "unmanaged".to_string()
        } else {
            self.domain_reason(p, host, at)
        };
        if client.is_some_and(|c| c.paused) && reason != "unmanaged" {
            reason = "device pause".into();
        }
        let blocked = reason != "allowed" && reason != "unmanaged";
        let entry = client
            .filter(|_| reason != "unmanaged" && p.filter_level != "none" && !self.free(host))
            .map(|c| HistoryEntry {
                id: crate::uuid(),
                device_id: c.id.clone(),
                at,
                domain: host.to_string(),
                blocked,
                reason: reason.clone(),
                category: self.category(host),
            });
        (blocked, reason, entry)
    }

    /// Restricted endpoints that SafeSearch and YouTube Restricted Mode pin hosts to.
    pub fn dns_override(&self, ip: Ipv4Addr, host: &str) -> Option<&'static str> {
        let (client, p) = self.subject(ip);
        let p = p?;
        if !p.managed || p.filter_level == "none" || client.is_some_and(|c| !c.managed) {
            return None;
        }
        if p.safe_search
            && (host == "google.com"
                || host.starts_with("www.google.")
                || host == "www.bing.com"
                || host == "duckduckgo.com")
        {
            return Some(match host {
                "www.bing.com" => "strict.bing.com",
                "duckduckgo.com" => "safe.duckduckgo.com",
                _ => "forcesafesearch.google.com",
            });
        }
        const YOUTUBE: [&str; 6] = [
            "youtube.com",
            "www.youtube.com",
            "m.youtube.com",
            "youtubei.googleapis.com",
            "youtube.googleapis.com",
            "www.youtube-nocookie.com",
        ];
        (p.youtube_restricted && YOUTUBE.contains(&host)).then_some("restrict.youtube.com")
    }

    fn profile_of(&self, c: &Client) -> Option<&Profile> {
        self.profiles.get(&c.profile_id)
    }

    /// The device may be online at all (not paused, no bedtime, budget left).
    pub fn allowed(&self, c: &Client, at: f64) -> bool {
        let Some(p) = self.profile_of(c) else {
            return false;
        };
        if !c.managed || !p.managed {
            return true;
        }
        !c.paused && access_reason_at(p, at as i64, self.tz, self.state.paused) == "allowed"
    }

    /// Only destinations learned through DNS may be reached (allow-lists, focus time).
    pub fn strict(&self, c: &Client, at: f64) -> bool {
        let Some(p) = self.profile_of(c) else {
            return true;
        };
        if !c.managed || !p.managed {
            return false;
        }
        (p.filter_level != "none" && p.allow_only)
            || active_windows(p, at as i64, self.tz)
                .iter()
                .any(|w| w.mode == "focus")
    }

    pub fn counted(&self, c: &Client) -> bool {
        self.profile_of(c)
            .is_some_and(|p| c.managed && p.managed && p.filter_level != "none")
    }

    /// Forwarding decision for traffic from `ip` to an address that DNS
    /// attributed to `hosts` (empty when the address was never resolved).
    pub fn flow(&self, ip: Ipv4Addr, hosts: &[String], at: f64) -> Verdict {
        let Some(c) = self.clients.get(&ip) else {
            return Verdict::Drop;
        };
        let Some(p) = self.profile_of(c) else {
            return Verdict::Drop;
        };
        let allow = |buckets: BTreeSet<String>| Verdict::Allow {
            device: c.id.clone(),
            buckets,
        };
        if hosts.iter().any(|h| self.management(h)) {
            return allow(BTreeSet::new());
        }
        if !hosts.is_empty() && c.managed && p.managed {
            let reasons: Vec<String> = hosts.iter().map(|h| self.domain_reason(p, h, at)).collect();
            if reasons.iter().any(|r| r == "unmanaged") {
                return allow(BTreeSet::new());
            }
            if c.paused || reasons.iter().any(|r| r != "allowed") {
                return Verdict::Drop;
            }
            // An address shared with any other name the device resolved still counts.
            let counted: Vec<&String> = hosts.iter().filter(|h| !self.free(h)).collect();
            if p.filter_level == "none" || counted.is_empty() {
                return allow(BTreeSet::new());
            }
            let mut buckets = BTreeSet::from(["total".to_string()]);
            for host in counted {
                buckets.extend(
                    categories_of(&self.category(host))
                        .into_iter()
                        .map(|c| format!("category:{c}")),
                );
                buckets.insert(format!("site:{host}"));
                buckets.extend(
                    p.site_limits
                        .keys()
                        .filter(|site| matches(host, site))
                        .map(|site| format!("site:{site}")),
                );
                buckets.extend(
                    p.app_limits
                        .iter()
                        .filter(|g| g.domains.iter().any(|d| matches(host, d)))
                        .map(|g| format!("group:{}", g.id)),
                );
            }
            return allow(buckets);
        }
        if !self.allowed(c, at) || self.strict(c, at) {
            return Verdict::Drop;
        }
        let mut buckets = BTreeSet::new();
        if self.counted(c) {
            buckets.insert("total".to_string());
        }
        allow(buckets)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOON: f64 = 1_767_268_800.0; // 2026-01-01T12:00:00Z, a Thursday

    fn policy(profile: serde_json::Value) -> Policy {
        with_free(profile, &[])
    }

    fn with_free(profile: serde_json::Value, free: &[&str]) -> Policy {
        let mut p = json!({"id": 1, "name": "Riley", "filter_level": "teen"});
        p.as_object_mut()
            .unwrap()
            .extend(profile.as_object().unwrap().clone());
        let state: State = serde_json::from_value(json!({
            "policy_schema": 2,
            "timezone": "UTC",
            "profiles": [p],
            "peers": [{"id": "d1", "ip": "10.77.0.2", "public_key": "k", "profile_id": 1, "paused": false, "managed": true}],
            "lan_devices": [{"id": "tv", "ip": "192.168.1.50", "profile_id": 1}],
            "free_domains": free,
        }))
        .unwrap();
        Policy::new(
            state,
            &["192.168.1.0/24".parse().unwrap()],
            &["home.example.net".into()],
        )
        .unwrap()
    }

    fn ip(s: &str) -> Ipv4Addr {
        s.parse().unwrap()
    }

    fn hosts(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn dns_blocks_categories_and_records_history() {
        let p = policy(json!({}));
        let (blocked, reason, entry) = p.evaluate(ip("10.77.0.2"), "pornhub.com", NOON);
        assert!(blocked);
        assert_eq!(reason, "adult");
        let entry = entry.unwrap();
        assert_eq!(
            (entry.device_id.as_str(), entry.category.as_str()),
            ("d1", "adult")
        );
        assert!(!p.evaluate(ip("10.77.0.2"), "example.com", NOON).0);
        // A registered home device follows its client. An address that was never added does not.
        assert!(p.evaluate(ip("192.168.1.50"), "pornhub.com", NOON).0);
        assert!(!p.evaluate(ip("192.168.1.99"), "pornhub.com", NOON).0);
        assert!(!p.evaluate(ip("10.77.0.9"), "pornhub.com", NOON).0);
    }

    #[test]
    fn safe_search_and_youtube_rewrites() {
        let p = policy(json!({"safe_search": true, "youtube_restricted": true}));
        let peer = ip("10.77.0.2");
        assert_eq!(
            p.dns_override(peer, "www.google.co.uk"),
            Some("forcesafesearch.google.com")
        );
        assert_eq!(
            p.dns_override(peer, "www.bing.com"),
            Some("strict.bing.com")
        );
        assert_eq!(
            p.dns_override(peer, "m.youtube.com"),
            Some("restrict.youtube.com")
        );
        assert_eq!(p.dns_override(peer, "example.com"), None);
        assert_eq!(policy(json!({})).dns_override(peer, "www.google.com"), None);
    }

    #[test]
    fn flows_count_into_buckets() {
        let p = policy(
            json!({"site_limits": {"youtube.com": 30}, "app_limits": [{"id": "fun", "name": "Fun", "domains": ["youtube.com"], "minutes": 60}]}),
        );
        let Verdict::Allow { device, buckets } =
            p.flow(ip("10.77.0.2"), &hosts(&["www.youtube.com"]), NOON)
        else {
            panic!("allowed")
        };
        assert_eq!(device, "d1");
        // YouTube counts toward its own category and the video one it sits within.
        assert_eq!(
            buckets.into_iter().collect::<Vec<_>>(),
            [
                "category:video",
                "category:youtube",
                "group:fun",
                "site:www.youtube.com",
                "site:youtube.com",
                "total"
            ]
        );
        // Unresolved destinations count only toward the daily total.
        assert_eq!(
            p.flow(ip("10.77.0.2"), &[], NOON),
            Verdict::Allow {
                device: "d1".into(),
                buckets: BTreeSet::from(["total".into()])
            }
        );
        assert_eq!(
            p.flow(ip("10.77.0.9"), &[], NOON),
            Verdict::Drop,
            "unknown peer"
        );
    }

    #[test]
    fn flows_close_when_budgets_run_out() {
        let spent = policy(json!({"limit": 60, "used": 60}));
        assert_eq!(spent.flow(ip("10.77.0.2"), &[], NOON), Verdict::Drop);
        assert_eq!(
            spent.flow(ip("10.77.0.2"), &hosts(&["example.com"]), NOON),
            Verdict::Drop
        );
        let video = policy(
            json!({"category_limits": {"video": 30}, "bucket_usage": {"category:video": 30}}),
        );
        assert_eq!(
            video.flow(ip("10.77.0.2"), &hosts(&["youtube.com"]), NOON),
            Verdict::Drop
        );
        assert!(matches!(
            video.flow(ip("10.77.0.2"), &hosts(&["example.com"]), NOON),
            Verdict::Allow { .. }
        ));
        // The dashboard itself stays reachable so the device can sync and request time.
        assert!(matches!(
            spent.flow(ip("10.77.0.2"), &hosts(&["home.example.net"]), NOON),
            Verdict::Allow { .. }
        ));
    }

    #[test]
    fn strict_profiles_only_reach_resolved_hosts() {
        let p = policy(json!({"allow_only": true, "allow": ["khanacademy.org"]}));
        assert_eq!(p.flow(ip("10.77.0.2"), &[], NOON), Verdict::Drop);
        assert!(matches!(
            p.flow(ip("10.77.0.2"), &hosts(&["www.khanacademy.org"]), NOON),
            Verdict::Allow { .. }
        ));
    }

    #[test]
    fn unmanaged_and_unfiltered_traffic_is_not_counted() {
        let none = policy(json!({"filter_level": "none"}));
        assert_eq!(
            none.flow(ip("10.77.0.2"), &[], NOON),
            Verdict::Allow {
                device: "d1".into(),
                buckets: BTreeSet::new()
            }
        );
        let exempt = policy(json!({"unmanaged": ["bank.example"], "limit": 1, "used": 5}));
        assert_eq!(
            exempt.flow(ip("10.77.0.2"), &hosts(&["bank.example"]), NOON),
            Verdict::Allow {
                device: "d1".into(),
                buckets: BTreeSet::new()
            }
        );
    }

    #[test]
    fn free_domains_are_not_counted_and_outlast_budgets() {
        const FREE: &[&str] = &["play.googleapis.com", "mesu.apple.com"];
        let peer = ip("10.77.0.2");
        let uncounted = Verdict::Allow {
            device: "d1".into(),
            buckets: BTreeSet::new(),
        };
        let open = with_free(json!({"limit": 60}), FREE);
        assert!(open.free("play.googleapis.com"));
        assert!(open.free("cdn.play.googleapis.com"));
        assert!(!open.free("evilplay.googleapis.com"));
        assert!(!open.free("googleapis.com"));
        assert_eq!(
            open.flow(peer, &hosts(&["play.googleapis.com"]), NOON),
            uncounted
        );
        // A shared address counts the other names the device resolved for it.
        let Verdict::Allow { buckets, .. } = open.flow(
            peer,
            &hosts(&["play.googleapis.com", "youtubei.googleapis.com"]),
            NOON,
        ) else {
            panic!("allowed")
        };
        assert_eq!(
            buckets.into_iter().collect::<Vec<_>>(),
            [
                "category:video",
                "category:youtube",
                "site:youtubei.googleapis.com",
                "total"
            ]
        );
        let (blocked, _, entry) = open.evaluate(peer, "mesu.apple.com", NOON);
        assert!(!blocked);
        assert!(entry.is_none(), "device upkeep stays out of history");

        let spent = with_free(json!({"limit": 60, "used": 60}), FREE);
        assert_eq!(
            spent.flow(peer, &hosts(&["play.googleapis.com"]), NOON),
            uncounted
        );
        assert!(!spent.evaluate(peer, "mesu.apple.com", NOON).0);
        assert_eq!(
            spent.flow(peer, &hosts(&["example.com"]), NOON),
            Verdict::Drop
        );
        assert_eq!(
            spent.flow(
                peer,
                &hosts(&["play.googleapis.com", "youtubei.googleapis.com"]),
                NOON
            ),
            Verdict::Drop
        );
        let strict = with_free(json!({"allow_only": true}), FREE);
        assert_eq!(
            strict.flow(peer, &hosts(&["mesu.apple.com"]), NOON),
            uncounted
        );
    }

    #[test]
    fn free_domains_still_follow_bedtime_and_blocked_sites() {
        const FREE: &[&str] = &["play.googleapis.com"];
        let peer = ip("10.77.0.2");
        let night = with_free(json!({"bedtime": {"start": "11:00", "end": "13:00"}}), FREE);
        assert_eq!(
            night.evaluate(peer, "play.googleapis.com", NOON).1,
            "bedtime"
        );
        assert_eq!(
            night.flow(peer, &hosts(&["play.googleapis.com"]), NOON),
            Verdict::Drop
        );
        let denied = with_free(json!({"deny": ["play.googleapis.com"]}), FREE);
        assert_eq!(
            denied.evaluate(peer, "play.googleapis.com", NOON).1,
            "custom rule"
        );
    }

    #[test]
    fn rejects_foreign_schema_and_addresses() {
        let state = |peer: &str, schema: u32| -> State {
            serde_json::from_value(
                json!({"policy_schema": schema, "timezone": "UTC", "profiles": [],
                "peers": [{"id": "d", "ip": peer, "profile_id": 1}]}),
            )
            .unwrap()
        };
        assert!(Policy::new(state("10.77.0.2", 1), &[], &[]).is_err());
        assert!(Policy::new(state("192.168.1.2", 2), &[], &[]).is_err());
        assert!(Policy::new(state("10.77.0.2", 2), &[], &[]).is_ok());
    }
}
