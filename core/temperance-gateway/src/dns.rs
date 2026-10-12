//! DNS answered inside the tunnel (and on the home LAN): a policy decision
//! before resolution, restricted-mode rewrites, and attribution of every
//! answered address to the host it was resolved for.
use std::collections::HashMap;
use std::io;
use std::net::{Ipv4Addr, SocketAddr};
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpStream, UdpSocket};
use tokio::time::timeout;

use crate::gateway::Shared;
use crate::net::TUNNEL;

const NOERROR: u16 = 0;
const FORMERR: u16 = 1;
const SERVFAIL: u16 = 2;
const NXDOMAIN: u16 = 3;
const REFUSED: u16 = 5;
const AAAA: u16 = 28;

fn u16_at(p: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes([*p.get(at)?, *p.get(at + 1)?]))
}

/// The single question of a standard query: (lower-case host, end offset).
pub fn question(p: &[u8]) -> Option<(String, usize)> {
    if p.len() < 12 || u16_at(p, 2)? & 0xf800 != 0 || u16_at(p, 4)? != 1 {
        return None;
    }
    let mut labels = Vec::new();
    let mut at = 12;
    loop {
        let len = usize::from(*p.get(at)?);
        at += 1;
        if len == 0 {
            break;
        }
        if len > 63 || at + len > p.len() {
            return None;
        }
        labels.push(
            std::str::from_utf8(&p[at..at + len])
                .ok()?
                .to_ascii_lowercase(),
        );
        at += len;
    }
    if at + 4 > p.len() || at - 12 > 255 || u16_at(p, at + 2)? != 1 {
        return None;
    }
    Some((labels.join("."), at + 4))
}

pub fn failure(p: &[u8], code: u16, end: Option<usize>) -> Vec<u8> {
    if p.len() < 12 {
        return Vec::new();
    }
    let flags = 0x8080 | (u16_at(p, 2).unwrap_or(0) & 0x0100) | code;
    let mut out = p[..2].to_vec();
    for v in [flags, u16::from(end.is_some()), 0, 0, 0] {
        out.extend(v.to_be_bytes());
    }
    if let Some(end) = end {
        out.extend(&p[12..end]);
    }
    out
}

/// Answer the question with a CNAME to `target`, pinning a restricted endpoint.
pub fn cname(p: &[u8], end: usize, target: &str) -> Vec<u8> {
    let mut name: Vec<u8> = target
        .split('.')
        .flat_map(|l| std::iter::once(l.len() as u8).chain(l.bytes()))
        .collect();
    name.push(0);
    let mut out = p[..2].to_vec();
    for v in [0x8180u16, 1, 1, 0, 0] {
        out.extend(v.to_be_bytes());
    }
    out.extend(&p[12..end]);
    out.extend([0xc0, 0x0c]);
    out.extend(5u16.to_be_bytes());
    out.extend(1u16.to_be_bytes());
    out.extend(60u32.to_be_bytes());
    out.extend((name.len() as u16).to_be_bytes());
    out.extend(name);
    out
}

/// IPv4 addresses in the answer section with TTLs clamped to 30 s – 1 h.
pub fn addresses(p: &[u8]) -> Vec<(Ipv4Addr, u32)> {
    fn skip_name(p: &[u8], mut at: usize) -> Option<usize> {
        for _ in 0..128 {
            let len = *p.get(at)?;
            at += 1;
            if len & 0xc0 == 0xc0 {
                return (at < p.len()).then_some(at + 1);
            }
            if len == 0 {
                return Some(at);
            }
            if len > 63 || at + usize::from(len) > p.len() {
                return None;
            }
            at += usize::from(len);
        }
        None
    }
    let parse = || -> Option<Vec<(Ipv4Addr, u32)>> {
        let (questions, answers) = (u16_at(p, 4)?, u16_at(p, 6)?);
        let mut at = 12;
        for _ in 0..questions {
            at = skip_name(p, at)? + 4;
        }
        let mut out = Vec::new();
        for _ in 0..answers {
            at = skip_name(p, at)?;
            let header = p.get(at..at + 10)?;
            let (kind, class) = (u16_at(header, 0)?, u16_at(header, 2)?);
            let ttl = u32::from_be_bytes(header[4..8].try_into().ok()?);
            let len = usize::from(u16_at(header, 8)?);
            at += 10;
            let data = p.get(at..at + len)?;
            at += len;
            if kind == 1 && class == 1 && len == 4 {
                out.push((
                    Ipv4Addr::new(data[0], data[1], data[2], data[3]),
                    ttl.clamp(30, 3600),
                ));
            }
        }
        Some(out)
    };
    parse().unwrap_or_default()
}

/// Which hosts each client resolved to each address, until the answer's TTL.
#[derive(Default)]
pub struct Destinations {
    map: HashMap<(Ipv4Addr, Ipv4Addr), HashMap<String, Instant>>,
}

impl Destinations {
    pub fn observe(
        &mut self,
        client: Ipv4Addr,
        host: &str,
        answers: &[(Ipv4Addr, u32)],
        now: Instant,
    ) {
        self.map.retain(|_, hosts| {
            hosts.retain(|_, expires| *expires > now);
            !hosts.is_empty()
        });
        for (address, ttl) in answers {
            self.map
                .entry((client, *address))
                .or_default()
                .insert(host.to_string(), now + Duration::from_secs(u64::from(*ttl)));
        }
        if self.map.len() > 10_000 {
            let mut by_expiry: Vec<_> = self
                .map
                .iter()
                .map(|(k, hosts)| (*hosts.values().max().expect("non-empty"), *k))
                .collect();
            by_expiry.sort();
            for (_, key) in &by_expiry[..by_expiry.len() - 10_000] {
                self.map.remove(key);
            }
        }
    }

    /// Every live (address, hosts) pair `client` resolved, in address order.
    pub fn entries(&self, client: Ipv4Addr, now: Instant) -> Vec<(Ipv4Addr, Vec<String>)> {
        let mut out: Vec<_> = self
            .map
            .keys()
            .filter(|(c, _)| *c == client)
            .map(|(_, address)| (*address, self.hosts(client, *address, now)))
            .filter(|(_, hosts)| !hosts.is_empty())
            .collect();
        out.sort();
        out
    }

    pub fn hosts(&self, client: Ipv4Addr, address: Ipv4Addr, now: Instant) -> Vec<String> {
        let mut hosts: Vec<String> = self
            .map
            .get(&(client, address))
            .into_iter()
            .flatten()
            .filter(|(_, expires)| **expires > now)
            .map(|(h, _)| h.clone())
            .collect();
        hosts.sort();
        hosts
    }
}

async fn forward(upstream: SocketAddr, packet: &[u8], tcp: bool) -> io::Result<Vec<u8>> {
    let response = if tcp {
        let mut sock = TcpStream::connect(upstream).await?;
        sock.write_all(&(packet.len() as u16).to_be_bytes()).await?;
        sock.write_all(packet).await?;
        let len = sock.read_u16().await?;
        let mut buf = vec![0; usize::from(len)];
        sock.read_exact(&mut buf).await?;
        buf
    } else {
        let bind: SocketAddr = if upstream.is_ipv4() {
            "0.0.0.0:0"
        } else {
            "[::]:0"
        }
        .parse()
        .expect("static");
        let sock = UdpSocket::bind(bind).await?;
        sock.connect(upstream).await?;
        sock.send(packet).await?;
        let mut buf = vec![0; 65535];
        let n = sock.recv(&mut buf).await?;
        buf.truncate(n);
        buf
    };
    if response.len() < 12 || response[..2] != packet[..2] || response[2] & 0x80 == 0 {
        return Err(io::Error::other("Invalid upstream reply"));
    }
    Ok(response)
}

pub async fn resolve(shared: &Shared, packet: &[u8], ip: Ipv4Addr, tcp: bool) -> Vec<u8> {
    if !TUNNEL.contains(ip) && !shared.config.lan_networks.iter().any(|n| n.contains(ip)) {
        return failure(packet, REFUSED, None);
    }
    let Some((host, end)) = question(packet) else {
        return failure(packet, FORMERR, None);
    };
    let policy = shared.policy();
    if let Some(policy) = policy.as_deref() {
        // The control-plane hostname must resolve even when the profile is paused.
        if !policy.management(&host) {
            let (blocked, _, entry) = policy.evaluate(ip, &host, crate::now());
            if let Some(entry) = entry {
                shared.record_history(entry);
            }
            if blocked {
                return failure(packet, NXDOMAIN, Some(end));
            }
        }
        if let Some(target) = policy.dns_override(ip, &host) {
            return cname(packet, end, target);
        }
    }
    // IPv6 never leaves the tunnel; an empty answer avoids a slow fallback.
    if u16_at(packet, end - 4) == Some(AAAA) {
        return failure(packet, NOERROR, Some(end));
    }
    match timeout(
        Duration::from_secs(3),
        forward(shared.config.dns_upstream, packet, tcp),
    )
    .await
    {
        Ok(Ok(response)) => {
            shared.observe(ip, &host, &addresses(&response));
            response
        }
        _ => failure(packet, SERVFAIL, Some(end)),
    }
}

/// DNS over a TCP stream: length-prefixed queries until the client hangs up.
pub async fn serve_stream<S: AsyncRead + AsyncWrite + Unpin>(
    shared: &Shared,
    mut stream: S,
    ip: Ipv4Addr,
) {
    loop {
        let Ok(Ok(len)) = timeout(Duration::from_secs(10), stream.read_u16()).await else {
            return;
        };
        let mut query = vec![0; usize::from(len)];
        if stream.read_exact(&mut query).await.is_err() {
            return;
        }
        let response = resolve(shared, &query, ip, true).await;
        if response.is_empty() {
            continue;
        }
        let mut framed = (response.len() as u16).to_be_bytes().to_vec();
        framed.extend(response);
        if stream.write_all(&framed).await.is_err() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(host: &str, kind: u16) -> Vec<u8> {
        let mut p = vec![0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0];
        for label in host.split('.') {
            p.push(label.len() as u8);
            p.extend(label.as_bytes());
        }
        p.push(0);
        p.extend(kind.to_be_bytes());
        p.extend(1u16.to_be_bytes());
        p
    }

    fn reply(host: &str, answers: &[([u8; 4], u32)]) -> Vec<u8> {
        let mut p = query(host, 1);
        p[2] = 0x81;
        p[3] = 0x80;
        p[7] = answers.len() as u8;
        for (ip, ttl) in answers {
            p.extend([0xc0, 0x0c, 0, 1, 0, 1]);
            p.extend(ttl.to_be_bytes());
            p.extend([0, 4]);
            p.extend(ip);
        }
        p
    }

    #[test]
    fn parses_questions() {
        let q = query("WWW.Example.COM", 1);
        assert_eq!(question(&q), Some(("www.example.com".into(), q.len())));
        let mut two = q.clone();
        two[5] = 2;
        assert_eq!(question(&two), None);
        assert_eq!(question(&q[..10]), None);
    }

    #[test]
    fn builds_failures_and_cnames() {
        let q = query("blocked.test", 1);
        let end = q.len();
        let nx = failure(&q, NXDOMAIN, Some(end));
        assert_eq!(&nx[..2], &[0x12, 0x34]);
        assert_eq!(u16_at(&nx, 2), Some(0x8183));
        assert_eq!(u16_at(&nx, 4), Some(1));
        let c = cname(&q, end, "restrict.youtube.com");
        assert_eq!(u16_at(&c, 6), Some(1), "one answer");
        assert!(c.ends_with(b"\x08restrict\x07youtube\x03com\x00"));
    }

    #[test]
    fn extracts_answers_with_clamped_ttl() {
        let r = reply(
            "example.com",
            &[([93, 184, 216, 34], 5), ([93, 184, 216, 35], 99_999)],
        );
        assert_eq!(
            addresses(&r),
            [
                (Ipv4Addr::new(93, 184, 216, 34), 30),
                (Ipv4Addr::new(93, 184, 216, 35), 3600)
            ]
        );
        assert!(
            addresses(&r[..r.len() - 2]).is_empty(),
            "truncated replies are ignored"
        );
    }

    #[test]
    fn destinations_expire() {
        let mut d = Destinations::default();
        let (client, addr) = (Ipv4Addr::new(10, 77, 0, 2), Ipv4Addr::new(93, 184, 216, 34));
        let now = Instant::now();
        d.observe(client, "a.example", &[(addr, 30)], now);
        d.observe(client, "b.example", &[(addr, 60)], now);
        assert_eq!(d.hosts(client, addr, now), ["a.example", "b.example"]);
        assert_eq!(
            d.hosts(client, addr, now + Duration::from_secs(45)),
            ["b.example"]
        );
        assert!(d.hosts(Ipv4Addr::new(10, 77, 0, 3), addr, now).is_empty());
    }
}
