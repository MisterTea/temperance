//! WireGuard on one UDP socket: a boringtun session per enrolled device.
use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine};
use boringtun::noise::{handshake::parse_handshake_anon, Packet, Tunn, TunnResult};
use boringtun::x25519::{PublicKey, StaticSecret};
use tokio::net::UdpSocket;
use tokio::sync::mpsc;

pub fn decode_key(value: &str) -> Result<[u8; 32], String> {
    let raw = STANDARD
        .decode(value.trim())
        .map_err(|_| "Invalid WireGuard key".to_string())?;
    let key: [u8; 32] = raw
        .try_into()
        .map_err(|_| "Invalid WireGuard key".to_string())?;
    if key == [0; 32] {
        return Err("Invalid WireGuard key".into());
    }
    Ok(key)
}

pub fn encode_key(key: &[u8; 32]) -> String {
    STANDARD.encode(key)
}

struct Peer {
    ip: Ipv4Addr,
    tunn: Mutex<Tunn>,
    endpoint: Mutex<Option<SocketAddr>>,
}

#[derive(Default)]
struct Peers {
    by_key: HashMap<[u8; 32], (u32, Arc<Peer>)>,
    by_index: HashMap<u32, Arc<Peer>>,
    by_ip: HashMap<Ipv4Addr, Arc<Peer>>,
    next_index: u32,
}

pub struct Wireguard {
    secret: StaticSecret,
    public: PublicKey,
    pub socket: Arc<UdpSocket>,
    peers: RwLock<Peers>,
}

fn buffer(len: usize) -> Vec<u8> {
    vec![0; (len + 64).max(148)]
}

impl Wireguard {
    pub fn new(secret: [u8; 32], socket: UdpSocket) -> Self {
        let secret = StaticSecret::from(secret);
        Wireguard {
            public: PublicKey::from(&secret),
            secret,
            socket: Arc::new(socket),
            peers: RwLock::default(),
        }
    }

    pub fn public_key(&self) -> String {
        encode_key(self.public.as_bytes())
    }

    /// Replace the peer set; sessions of unchanged (key, address) pairs survive.
    pub fn set_peers(&self, wanted: &[([u8; 32], Ipv4Addr)]) {
        let mut peers = self.peers.write().expect("peers lock");
        let old = std::mem::take(&mut peers.by_key);
        let mut next = Peers {
            next_index: peers.next_index,
            ..Peers::default()
        };
        for (key, ip) in wanted {
            let (index, peer) = match old.get(key) {
                Some((index, peer)) if peer.ip == *ip => (*index, peer.clone()),
                _ => {
                    next.next_index = (next.next_index + 1) & 0x00ff_ffff;
                    let index = next.next_index;
                    let tunn = Tunn::new(
                        self.secret.clone(),
                        PublicKey::from(*key),
                        None,
                        None,
                        index,
                        None,
                    );
                    (
                        index,
                        Arc::new(Peer {
                            ip: *ip,
                            tunn: Mutex::new(tunn),
                            endpoint: Mutex::new(None),
                        }),
                    )
                }
            };
            next.by_index.insert(index, peer.clone());
            next.by_ip.insert(*ip, peer.clone());
            next.by_key.insert(*key, (index, peer));
        }
        *peers = next;
    }

    fn lookup(&self, datagram: &[u8]) -> Option<Arc<Peer>> {
        let peers = self.peers.read().expect("peers lock");
        let index = match Tunn::parse_incoming_packet(datagram).ok()? {
            Packet::HandshakeInit(init) => {
                let half = parse_handshake_anon(&self.secret, &self.public, &init).ok()?;
                return peers
                    .by_key
                    .get(&half.peer_static_public)
                    .map(|(_, p)| p.clone());
            }
            Packet::HandshakeResponse(p) => p.receiver_idx,
            Packet::PacketCookieReply(p) => p.receiver_idx,
            Packet::PacketData(p) => p.receiver_idx,
        };
        peers.by_index.get(&(index >> 8)).cloned()
    }

    /// Receive datagrams forever, handing decrypted IPv4 packets from each
    /// peer's own tunnel address to `inbound`.
    pub async fn receive(self: Arc<Self>, inbound: mpsc::Sender<(Ipv4Addr, Vec<u8>)>) {
        let mut datagram = vec![0; 65536];
        let mut out = vec![0; 65536];
        loop {
            let Ok((n, from)) = self.socket.recv_from(&mut datagram).await else {
                continue;
            };
            let Some(peer) = self.lookup(&datagram[..n]) else {
                continue;
            };
            let mut replies = Vec::new();
            let mut packet = None;
            {
                let mut tunn = peer.tunn.lock().expect("tunnel lock");
                match tunn.decapsulate(Some(from.ip()), &datagram[..n], &mut out) {
                    TunnResult::WriteToNetwork(reply) => {
                        replies.push(reply.to_vec());
                        while let TunnResult::WriteToNetwork(queued) =
                            tunn.decapsulate(None, &[], &mut out)
                        {
                            replies.push(queued.to_vec());
                        }
                    }
                    TunnResult::WriteToTunnelV4(p, src) if src == peer.ip => {
                        packet = Some(p.to_vec())
                    }
                    TunnResult::Err(_) => continue,
                    _ => {}
                }
            }
            *peer.endpoint.lock().expect("endpoint lock") = Some(from);
            for reply in replies {
                let _ = self.socket.send_to(&reply, from).await;
            }
            if let Some(packet) = packet {
                if inbound.send((peer.ip, packet)).await.is_err() {
                    return;
                }
            }
        }
    }

    /// Encrypt an IPv4 packet to the peer that owns its destination address.
    pub async fn send(&self, packet: &[u8]) {
        let Some(dst) = crate::net::destination(packet) else {
            return;
        };
        let Some(peer) = self
            .peers
            .read()
            .expect("peers lock")
            .by_ip
            .get(&dst)
            .cloned()
        else {
            return;
        };
        let Some(endpoint) = *peer.endpoint.lock().expect("endpoint lock") else {
            return;
        };
        let mut out = buffer(packet.len());
        let datagram = match peer
            .tunn
            .lock()
            .expect("tunnel lock")
            .encapsulate(packet, &mut out)
        {
            TunnResult::WriteToNetwork(d) => d.to_vec(),
            _ => return,
        };
        let _ = self.socket.send_to(&datagram, endpoint).await;
    }

    /// Drive handshakes, keepalives and session expiry.
    pub async fn timers(self: Arc<Self>) {
        let mut tick = tokio::time::interval(Duration::from_millis(250));
        let mut out = buffer(0);
        loop {
            tick.tick().await;
            let peers: Vec<Arc<Peer>> = self
                .peers
                .read()
                .expect("peers lock")
                .by_ip
                .values()
                .cloned()
                .collect();
            for peer in peers {
                let datagram = match peer
                    .tunn
                    .lock()
                    .expect("tunnel lock")
                    .update_timers(&mut out)
                {
                    TunnResult::WriteToNetwork(d) => d.to_vec(),
                    _ => continue,
                };
                let endpoint = *peer.endpoint.lock().expect("endpoint lock");
                if let Some(endpoint) = endpoint {
                    let _ = self.socket.send_to(&datagram, endpoint).await;
                }
            }
        }
    }
}
