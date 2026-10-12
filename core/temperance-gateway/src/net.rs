//! IPv4 header inspection, address classes and TCP MSS clamping.
use std::net::Ipv4Addr;
use std::str::FromStr;

use serde::{Deserialize, Deserializer};

pub const GATEWAY_IP: Ipv4Addr = Ipv4Addr::new(10, 77, 0, 1);
pub const TUNNEL: Net = Net {
    addr: 0x0a4d_0000,
    prefix: 24,
};
/// Inner MTU every WireGuard client supports; the userspace stack never exceeds it.
pub const MTU: u16 = 1280;
pub const TCP: u8 = 6;
pub const UDP: u8 = 17;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Net {
    addr: u32,
    prefix: u8,
}

impl Net {
    pub fn contains(&self, ip: Ipv4Addr) -> bool {
        let mask = if self.prefix == 0 {
            0
        } else {
            u32::MAX << (32 - self.prefix)
        };
        u32::from(ip) & mask == self.addr & mask
    }
}

impl FromStr for Net {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        let (addr, prefix) = s.split_once('/').unwrap_or((s, "32"));
        let addr: Ipv4Addr = addr.parse().map_err(|_| format!("Invalid network {s}"))?;
        let prefix: u8 = prefix
            .parse()
            .ok()
            .filter(|p| *p <= 32)
            .ok_or_else(|| format!("Invalid network {s}"))?;
        Ok(Net {
            addr: u32::from(addr),
            prefix,
        })
    }
}

impl<'de> Deserialize<'de> for Net {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        String::deserialize(d)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}

/// Destinations a household device may never reach through the tunnel.
pub fn forwardable(ip: Ipv4Addr) -> bool {
    const BLOCKED: [&str; 9] = [
        "0.0.0.0/8",
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "224.0.0.0/4",
        "240.0.0.0/4",
    ];
    !BLOCKED
        .iter()
        .any(|n| n.parse::<Net>().expect("static network").contains(ip))
}

/// The parts of an IPv4 packet the gateway routes and filters on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Header {
    pub protocol: u8,
    pub src: Ipv4Addr,
    pub dst: Ipv4Addr,
    pub dst_port: u16,
    /// A TCP SYN without ACK: the packet that opens a connection.
    pub syn: bool,
    header_len: usize,
}

pub fn parse(packet: &[u8]) -> Option<Header> {
    if packet.len() < 20 || packet[0] >> 4 != 4 {
        return None;
    }
    let header_len = usize::from(packet[0] & 0x0f) * 4;
    let fragment = u16::from_be_bytes([packet[6], packet[7]]) & 0x1fff;
    if header_len < 20 || packet.len() < header_len + 4 || fragment != 0 {
        return None;
    }
    let protocol = packet[9];
    let flags = if protocol == TCP {
        *packet.get(header_len + 13)?
    } else {
        0
    };
    Some(Header {
        protocol,
        src: Ipv4Addr::new(packet[12], packet[13], packet[14], packet[15]),
        dst: Ipv4Addr::new(packet[16], packet[17], packet[18], packet[19]),
        dst_port: u16::from_be_bytes([packet[header_len + 2], packet[header_len + 3]]),
        syn: flags & 0x12 == 0x02,
        header_len,
    })
}

pub fn destination(packet: &[u8]) -> Option<Ipv4Addr> {
    (packet.len() >= 20 && packet[0] >> 4 == 4)
        .then(|| Ipv4Addr::new(packet[16], packet[17], packet[18], packet[19]))
}

/// Lower the MSS option of a SYN so the client's segments fit in [`MTU`].
pub fn clamp_mss(packet: &mut [u8], header: &Header) {
    let max = MTU - 40;
    let tcp = header.header_len;
    let Some(&offset) = packet.get(tcp + 12) else {
        return;
    };
    let end = (tcp + usize::from(offset >> 4) * 4).min(packet.len());
    let mut at = tcp + 20;
    while at + 1 < end {
        match packet[at] {
            0 => return,
            1 => at += 1,
            kind => {
                let len = usize::from(packet[at + 1]);
                if len < 2 || at + len > end {
                    return;
                }
                if kind == 2 && len == 4 {
                    let old = u16::from_be_bytes([packet[at + 2], packet[at + 3]]);
                    if old > max {
                        packet[at + 2..at + 4].copy_from_slice(&max.to_be_bytes());
                        // RFC 1624 incremental update: HC' = ~(~HC + ~m + m').
                        let sum = tcp + 16;
                        let checksum = u16::from_be_bytes([packet[sum], packet[sum + 1]]);
                        let mut acc = u32::from(!checksum) + u32::from(!old) + u32::from(max);
                        acc = (acc & 0xffff) + (acc >> 16);
                        acc = (acc & 0xffff) + (acc >> 16);
                        packet[sum..sum + 2].copy_from_slice(&(!(acc as u16)).to_be_bytes());
                    }
                    return;
                }
                at += len;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn checksum(data: &[u8]) -> u16 {
        let mut sum: u32 = data
            .chunks(2)
            .map(|c| u32::from(u16::from_be_bytes([c[0], *c.get(1).unwrap_or(&0)])))
            .sum();
        while sum >> 16 != 0 {
            sum = (sum & 0xffff) + (sum >> 16);
        }
        !(sum as u16)
    }

    fn syn(mss: u16) -> Vec<u8> {
        let mut p = vec![
            0x45, 0, 0, 44, 0, 0, 0x40, 0, 64, TCP, 0, 0, 10, 77, 0, 2, 93, 184, 216, 34,
        ];
        let mut tcp = vec![
            0xc3, 0x50, 0, 80, 0, 0, 0, 1, 0, 0, 0, 0, 0x60, 0x02, 0xff, 0xff, 0, 0, 0, 0, 2, 4,
        ];
        tcp.extend(mss.to_be_bytes());
        let mut pseudo = p[12..20].to_vec();
        pseudo.extend([0, TCP, 0, tcp.len() as u8]);
        pseudo.extend(&tcp);
        let sum = checksum(&pseudo);
        tcp[16..18].copy_from_slice(&sum.to_be_bytes());
        p.extend(tcp);
        p
    }

    #[test]
    fn parses_and_clamps_syn() {
        let mut p = syn(1460);
        let h = parse(&p).unwrap();
        assert!(h.syn);
        assert_eq!((h.protocol, h.dst_port), (TCP, 80));
        assert_eq!(h.dst, Ipv4Addr::new(93, 184, 216, 34));
        clamp_mss(&mut p, &h);
        assert_eq!(u16::from_be_bytes([p[42], p[43]]), MTU - 40);
        let mut pseudo = p[12..20].to_vec();
        pseudo.extend([0, TCP, 0, 24]);
        pseudo.extend(&p[20..]);
        assert_eq!(checksum(&pseudo), 0, "checksum stays valid");
        let mut small = syn(1000);
        let header = parse(&small).unwrap();
        clamp_mss(&mut small, &header);
        assert_eq!(small, syn(1000));
    }

    #[test]
    fn address_classes() {
        for private in [
            "10.1.2.3",
            "192.168.1.1",
            "127.0.0.1",
            "169.254.1.1",
            "100.64.0.1",
            "224.0.0.1",
        ] {
            assert!(!forwardable(private.parse().unwrap()), "{private}");
        }
        assert!(forwardable("93.184.216.34".parse().unwrap()));
        assert!(TUNNEL.contains("10.77.0.9".parse().unwrap()));
        assert!(!TUNNEL.contains("10.78.0.9".parse().unwrap()));
        assert!("192.168.1.0/24"
            .parse::<Net>()
            .unwrap()
            .contains("192.168.1.77".parse().unwrap()));
        assert!("300.0.0.0/8".parse::<Net>().is_err());
    }
}
