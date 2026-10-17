//! IP header inspection, address classes and TCP MSS clamping.
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::str::FromStr;

use serde::{Deserialize, Deserializer};

pub const GATEWAY_IP: Ipv4Addr = Ipv4Addr::new(10, 77, 0, 1);
pub const TUNNEL: Net = Net {
    addr: 0x0a4d_0000,
    prefix: 24,
};

/// `10.77.0.N` (N = 2..=254) is also `fd77::N`, the address provisioning hands the device.
pub fn peer_v6(ip: Ipv4Addr) -> Option<Ipv6Addr> {
    let [10, 77, 0, n] = ip.octets() else {
        return None;
    };
    (2..=254)
        .contains(&n)
        .then_some(Ipv6Addr::new(0xfd77, 0, 0, 0, 0, 0, 0, u16::from(n)))
}

/// The tunnel IPv4 of an assigned `fd77::N` address.
pub fn peer_v4(ip: Ipv6Addr) -> Option<Ipv4Addr> {
    let [prefix, a, b, c, d, e, f, n] = ip.segments();
    if prefix == 0xfd77 && [a, b, c, d, e, f] == [0; 6] && (2..=254).contains(&n) {
        Some(Ipv4Addr::new(10, 77, 0, n as u8))
    } else {
        None
    }
}

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

    pub fn cidr(self) -> String {
        let mask = if self.prefix == 0 {
            0
        } else {
            u32::MAX << (32 - self.prefix)
        };
        format!("{}/{}", Ipv4Addr::from(self.addr & mask), self.prefix)
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
pub fn forwardable(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => forwardable_v4(ip),
        IpAddr::V6(ip) => forwardable_v6(ip),
    }
}

fn forwardable_v4(ip: Ipv4Addr) -> bool {
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

/// Global unicast may leave the tunnel. Unique-local (including `fd77::`),
/// link-local, multicast, IPv4-mapped and other non-global ranges may not.
fn forwardable_v6(ip: Ipv6Addr) -> bool {
    if ip.to_ipv4().is_some() || ip.is_multicast() {
        return false;
    }
    let s = ip.segments();
    // fe80::/10 link-local, fec0::/10 site-local, fc00::/7 unique-local.
    if s[0] & 0xffc0 == 0xfe80 || s[0] & 0xffc0 == 0xfec0 || s[0] & 0xfe00 == 0xfc00 {
        return false;
    }
    // 100::/64 discard-only, 2001::/23 IETF protocol assignments, 3ffe::/16 6bone.
    if (s[0] == 0x0100 && s[1] == 0 && s[2] == 0 && s[3] == 0)
        || (s[0] == 0x2001 && s[1] < 0x0200)
        || s[0] == 0x3ffe
    {
        return false;
    }
    // 64:ff9b::/96 well-known NAT64 and 64:ff9b:1::/48 local-use NAT64.
    if s[0] == 0x0064 && s[1] == 0xff9b && (s[2] == 0 || s[2] == 1) {
        return false;
    }
    // 2002::/16 6to4 embeds an IPv4 address; only a public one may proceed.
    if s[0] == 0x2002 {
        let embedded = Ipv4Addr::new((s[1] >> 8) as u8, s[1] as u8, (s[2] >> 8) as u8, s[2] as u8);
        return forwardable_v4(embedded);
    }
    true
}

/// The parts of an IP packet the gateway routes and filters on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Header {
    pub protocol: u8,
    pub src: IpAddr,
    pub dst: IpAddr,
    pub src_port: u16,
    pub dst_port: u16,
    /// A TCP SYN without ACK: the packet that opens a connection.
    pub syn: bool,
    transport_at: usize,
}

pub fn parse(packet: &[u8]) -> Option<Header> {
    match packet.first()? >> 4 {
        4 => parse_v4(packet),
        6 => parse_v6(packet),
        _ => None,
    }
}

fn parse_v4(packet: &[u8]) -> Option<Header> {
    if packet.len() < 20 {
        return None;
    }
    let header_len = usize::from(packet[0] & 0x0f) * 4;
    let fragment = u16::from_be_bytes([packet[6], packet[7]]) & 0x1fff;
    if header_len < 20 || packet.len() < header_len + 4 || fragment != 0 {
        return None;
    }
    header_at(packet, header_len, packet[9])
}

fn parse_v6(packet: &[u8]) -> Option<Header> {
    if packet.len() < 40 {
        return None;
    }
    let (protocol, at) = transport(packet, packet[6], 40)?;
    header_at(packet, at, protocol)
}

/// Walk IPv6 extension headers to TCP or UDP. Fragments and anything else are dropped.
fn transport(packet: &[u8], mut next: u8, mut at: usize) -> Option<(u8, usize)> {
    for _ in 0..8 {
        match next {
            TCP | UDP => return Some((next, at)),
            0 | 43 | 60 => {
                let hdr = packet.get(at..at + 2)?;
                next = hdr[0];
                let len = (usize::from(hdr[1]) + 1) * 8;
                at = at.checked_add(len)?;
                if at > packet.len() {
                    return None;
                }
            }
            _ => return None,
        }
    }
    None
}

fn header_at(packet: &[u8], transport_at: usize, protocol: u8) -> Option<Header> {
    if packet.len() < transport_at + 4 {
        return None;
    }
    let flags = if protocol == TCP {
        *packet.get(transport_at + 13)?
    } else {
        0
    };
    let (src, dst) = if packet[0] >> 4 == 4 {
        (
            IpAddr::V4(Ipv4Addr::new(
                packet[12], packet[13], packet[14], packet[15],
            )),
            IpAddr::V4(Ipv4Addr::new(
                packet[16], packet[17], packet[18], packet[19],
            )),
        )
    } else {
        (
            IpAddr::V6(Ipv6Addr::from(<[u8; 16]>::try_from(&packet[8..24]).ok()?)),
            IpAddr::V6(Ipv6Addr::from(<[u8; 16]>::try_from(&packet[24..40]).ok()?)),
        )
    };
    Some(Header {
        protocol,
        src,
        dst,
        src_port: u16::from_be_bytes([packet[transport_at], packet[transport_at + 1]]),
        dst_port: u16::from_be_bytes([packet[transport_at + 2], packet[transport_at + 3]]),
        syn: flags & 0x12 == 0x02,
        transport_at,
    })
}

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

/// The RST|ACK a closed port answers `syn` with, so the device gives up on
/// this address at once (and tries its next one) rather than timing out.
pub fn refuse(syn: &[u8]) -> Option<Vec<u8>> {
    let h = parse(syn)?;
    if h.protocol != TCP || !h.syn {
        return None;
    }
    let tcp = syn.get(h.transport_at..h.transport_at + 20)?;
    let end = match syn[0] >> 4 {
        4 => usize::from(u16::from_be_bytes([syn[2], syn[3]])),
        _ => 40 + usize::from(u16::from_be_bytes([syn[4], syn[5]])),
    }
    .min(syn.len());
    let data = end.saturating_sub(h.transport_at + usize::from(tcp[12] >> 4) * 4);
    let seq = u32::from_be_bytes([tcp[4], tcp[5], tcp[6], tcp[7]]);
    let ack = seq.wrapping_add(1).wrapping_add(data as u32);
    let mut segment = Vec::with_capacity(20);
    segment.extend(h.dst_port.to_be_bytes());
    segment.extend(h.src_port.to_be_bytes());
    segment.extend(0u32.to_be_bytes());
    segment.extend(ack.to_be_bytes());
    segment.extend([0x50, 0x14, 0, 0, 0, 0, 0, 0]);
    let (mut packet, mut pseudo) = match (h.dst, h.src) {
        (IpAddr::V4(from), IpAddr::V4(to)) => {
            let mut ip = vec![0x45, 0, 0, 40, 0, 0, 0x40, 0, 64, TCP, 0, 0];
            ip.extend(from.octets());
            ip.extend(to.octets());
            let sum = checksum(&ip);
            ip[10..12].copy_from_slice(&sum.to_be_bytes());
            let pseudo = [&from.octets()[..], &to.octets(), &[0, TCP, 0, 20]].concat();
            (ip, pseudo)
        }
        (IpAddr::V6(from), IpAddr::V6(to)) => {
            let mut ip = vec![0x60, 0, 0, 0, 0, 20, TCP, 64];
            ip.extend(from.octets());
            ip.extend(to.octets());
            let pseudo = [
                &from.octets()[..],
                &to.octets(),
                &[0, 0, 0, 20, 0, 0, 0, TCP],
            ]
            .concat();
            (ip, pseudo)
        }
        _ => return None,
    };
    pseudo.extend(&segment);
    segment[16..18].copy_from_slice(&checksum(&pseudo).to_be_bytes());
    packet.extend(segment);
    Some(packet)
}

/// The enrolled peer a packet returning through the tunnel is addressed to.
pub fn tunnel_peer(packet: &[u8]) -> Option<Ipv4Addr> {
    match parse(packet)?.dst {
        IpAddr::V4(ip) => Some(ip),
        IpAddr::V6(ip) => peer_v4(ip),
    }
}

/// Lower the MSS option of a SYN so the client's segments fit in [`MTU`].
pub fn clamp_mss(packet: &mut [u8], header: &Header) {
    let max = match packet.first().map(|b| b >> 4) {
        Some(4) => MTU - 40,
        Some(6) => MTU - 60,
        _ => return,
    };
    let tcp = header.transport_at;
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
        assert_eq!(h.dst, IpAddr::V4(Ipv4Addr::new(93, 184, 216, 34)));
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
        let peer = Ipv4Addr::new(10, 77, 0, 10);
        assert_eq!(peer_v6(peer), Some("fd77::a".parse().unwrap()));
        assert_eq!(peer_v4(peer_v6(peer).unwrap()), Some(peer));
        assert!(peer_v6(Ipv4Addr::new(10, 77, 0, 1)).is_none());
        assert!(peer_v4("fd77::1".parse().unwrap()).is_none());
        for blocked in [
            "::",
            "::1",
            "::ffff:8.8.8.8",
            "fe80::1",
            "fd77::2",
            "fd00::1",
            "ff02::1",
            "100::1",
            "2001::1",
            "64:ff9b::8.8.8.8",
            "2002:c0a8:101::",
        ] {
            assert!(!forwardable(blocked.parse().unwrap()), "{blocked}");
        }
        assert!(forwardable("2001:db8::1".parse::<IpAddr>().unwrap()));
        // 2002:5db8:d822:: embeds 93.184.216.34.
        assert!(forwardable("2002:5db8:d822::".parse::<IpAddr>().unwrap()));
    }

    #[test]
    fn parses_ipv6_and_clamps_its_mss() {
        let src: Ipv6Addr = "fd77::2".parse().unwrap();
        let dst: Ipv6Addr = "2001:db8::1".parse().unwrap();
        let mut packet = vec![0x60, 0, 0, 0, 0, 24, TCP, 64];
        packet.extend(src.octets());
        packet.extend(dst.octets());
        let mut tcp = vec![
            0xc3, 0x50, 0, 80, 0, 0, 0, 1, 0, 0, 0, 0, 0x60, 0x02, 0xff, 0xff, 0, 0, 0, 0, 2, 4,
        ];
        tcp.extend(1460u16.to_be_bytes());
        let mut pseudo = src.octets().to_vec();
        pseudo.extend(dst.octets());
        pseudo.extend((tcp.len() as u32).to_be_bytes());
        pseudo.extend([0, 0, 0, TCP]);
        pseudo.extend(&tcp);
        let sum = checksum(&pseudo);
        tcp[16..18].copy_from_slice(&sum.to_be_bytes());
        packet.extend(&tcp);
        // A hop-by-hop header in front of TCP is still a SYN we can read.
        let mut extended = vec![0x60, 0, 0, 0, 0, 32, 0, 64];
        extended.extend(src.octets());
        extended.extend(dst.octets());
        extended.extend([TCP, 0]);
        extended.extend([0; 6]);
        extended.extend(&tcp);
        let plain = parse(&packet).unwrap();
        assert!(plain.syn);
        assert_eq!(
            (plain.protocol, plain.dst_port, plain.src),
            (TCP, 80, IpAddr::V6(src))
        );
        clamp_mss(&mut packet, &plain);
        assert_eq!(u16::from_be_bytes([packet[62], packet[63]]), MTU - 60);
        let walked = parse(&extended).unwrap();
        assert_eq!(walked.dst, IpAddr::V6(dst));
        assert!(walked.syn);
        let mut fragment = packet.clone();
        fragment[6] = 44;
        assert!(parse(&fragment).is_none(), "fragments are dropped");
        let reset = refuse(&packet).unwrap();
        let r = parse(&reset).unwrap();
        assert_eq!((r.src, r.dst), (IpAddr::V6(dst), IpAddr::V6(src)));
        assert_eq!((r.src_port, r.dst_port), (80, 0xc350));
        let mut pseudo = dst.octets().to_vec();
        pseudo.extend(src.octets());
        pseudo.extend([0, 0, 0, 20, 0, 0, 0, TCP]);
        pseudo.extend(&reset[40..]);
        assert_eq!(checksum(&pseudo), 0, "TCP checksum is valid");
    }

    #[test]
    fn refuses_a_syn_with_a_matching_reset() {
        let p = syn(1460);
        let reset = refuse(&p).unwrap();
        assert_eq!(reset.len(), 40);
        let r = parse(&reset).unwrap();
        assert_eq!(r.src, IpAddr::V4(Ipv4Addr::new(93, 184, 216, 34)));
        assert_eq!(r.dst, IpAddr::V4(Ipv4Addr::new(10, 77, 0, 2)));
        assert_eq!((r.src_port, r.dst_port), (80, 0xc350));
        assert!(!r.syn);
        assert_eq!(reset[33], 0x14, "RST and ACK");
        assert_eq!(&reset[24..28], &0u32.to_be_bytes());
        assert_eq!(&reset[28..32], &2u32.to_be_bytes(), "acknowledges the SYN");
        assert_eq!(checksum(&reset[..20]), 0, "IPv4 header checksum is valid");
        let mut pseudo = reset[12..20].to_vec();
        pseudo.extend([0, TCP, 0, 20]);
        pseudo.extend(&reset[20..]);
        assert_eq!(checksum(&pseudo), 0, "TCP checksum is valid");
        assert!(refuse(&reset).is_none(), "only a SYN is refused");
    }
}
