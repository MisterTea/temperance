//! A Wi-Fi interface turned into an access point for a television or console.
//! hostapd is started by the root helper (`deploy/home/ap-prepare.sh`). Devices
//! are given a fixed address from the dashboard and use this address as their
//! gateway and DNS server.
use std::net::{Ipv4Addr, SocketAddr};

use serde::Deserialize;

use crate::gateway::Config;
use crate::home::Router;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct AccessPoint {
    pub interface: String,
    pub address: Ipv4Addr,
    pub prefix: u8,
    pub ssid: String,
    pub passphrase: String,
    /// Answer DNS on this access point's address. On unless turned off.
    #[serde(default = "yes")]
    pub dns: bool,
}

fn yes() -> bool {
    true
}

pub fn validate(ap: &AccessPoint) -> Result<(), String> {
    let iface_ok = (1..=15).contains(&ap.interface.len())
        && ap
            .interface
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c));
    if !iface_ok {
        return Err("Invalid access-point interface".into());
    }
    if !(8..=30).contains(&ap.prefix) || ap.address.is_unspecified() || ap.address.is_broadcast() {
        return Err("The access point needs an address such as 192.168.50.1/24".into());
    }
    let ssid = ap.ssid.as_bytes();
    if ssid.is_empty() || ssid.len() > 32 {
        return Err("The access point name must be 1–32 bytes".into());
    }
    if !(8..=63).contains(&ap.passphrase.len()) {
        return Err("The access point password must be 8–63 characters".into());
    }
    Ok(())
}

/// Fill in router mode, the LAN network, and DNS on the access point's address.
pub fn configure(config: &mut Config) -> Result<(), String> {
    let Some(ap) = config.ap.clone() else {
        return Ok(());
    };
    validate(&ap)?;
    let cidr = format!("{}/{}", network(ap.address, ap.prefix), ap.prefix);
    if !config.lan_networks.iter().any(|n| n.contains(ap.address)) {
        config.lan_networks.push(cidr.parse()?);
    }
    if ap.dns && config.home_dns.is_none() {
        config.home_dns = Some(SocketAddr::from((ap.address, 53)));
    }
    if config.router.is_none() {
        config.router = Some(Router {
            lan_interface: ap.interface.clone(),
            lan_address: ap.address,
            uplink: String::new(),
        });
    }
    Ok(())
}

pub fn default_uplink(skip: &str) -> Result<String, String> {
    let text = std::fs::read_to_string("/proc/net/route").map_err(|_| {
        "Cannot read the routing table to find the access point's uplink".to_string()
    })?;
    uplink_from(&text, skip)
}

fn uplink_from(text: &str, skip: &str) -> Result<String, String> {
    for line in text.lines().skip(1) {
        let mut cols = line.split_whitespace();
        let Some(iface) = cols.next() else { continue };
        let Some(dest) = cols.next() else { continue };
        if dest == "00000000" && iface != skip && !iface.is_empty() {
            return Ok(iface.to_string());
        }
    }
    Err("The access point needs an uplink interface with a default route".into())
}

fn network(ip: Ipv4Addr, prefix: u8) -> Ipv4Addr {
    let mask = u32::MAX << (32 - prefix);
    Ipv4Addr::from(u32::from(ip) & mask)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ap() -> AccessPoint {
        AccessPoint {
            interface: "wlan0".into(),
            address: "192.168.50.1".parse().unwrap(),
            prefix: 24,
            ssid: "Temperance".into(),
            passphrase: "correct horse".into(),
            dns: true,
        }
    }

    #[test]
    fn access_point_enables_dns_router_and_its_network() {
        let mut config = Config {
            listen: "0.0.0.0:51820".parse().unwrap(),
            private_key: String::new(),
            dns_upstream: "1.1.1.1:53".parse().unwrap(),
            idle_bytes: 0,
            management_domains: Vec::new(),
            web: None,
            home_dns: None,
            lan_networks: Vec::new(),
            router: None,
            connect_map: Default::default(),
            public_port: None,
            reach: Default::default(),
            remote: None,
            ap: Some(ap()),
        };
        configure(&mut config).unwrap();
        assert_eq!(config.home_dns, Some("192.168.50.1:53".parse().unwrap()));
        assert!(config.lan_networks[0].contains("192.168.50.40".parse().unwrap()));
        let router = config.router.unwrap();
        assert_eq!(router.lan_interface, "wlan0");
        assert_eq!(
            router.lan_address,
            "192.168.50.1".parse::<Ipv4Addr>().unwrap()
        );
        assert!(router.uplink.is_empty());
    }

    #[test]
    fn dns_can_be_turned_off() {
        let mut config = Config {
            listen: "0.0.0.0:51820".parse().unwrap(),
            private_key: String::new(),
            dns_upstream: "1.1.1.1:53".parse().unwrap(),
            idle_bytes: 0,
            management_domains: Vec::new(),
            web: None,
            home_dns: None,
            lan_networks: Vec::new(),
            router: None,
            connect_map: Default::default(),
            public_port: None,
            reach: Default::default(),
            remote: None,
            ap: Some(AccessPoint { dns: false, ..ap() }),
        };
        configure(&mut config).unwrap();
        assert!(config.home_dns.is_none());
    }

    #[test]
    fn uplink_is_the_default_route_that_is_not_the_access_point() {
        let table = "Iface Destination Gateway Flags\neth0 00000000 0101A8C0 0003\nwlan0 00000000 00000000 0001\n";
        assert_eq!(uplink_from(table, "wlan0").unwrap(), "eth0");
    }

    #[test]
    fn rejects_a_short_password() {
        let mut bad = ap();
        bad.passphrase = "short".into();
        assert!(validate(&bad).is_err());
    }
}
