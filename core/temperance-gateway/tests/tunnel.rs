//! End to end without root or a TUN device: an in-test WireGuard client
//! (boringtun + smoltcp) browses through the gateway to a local server.
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, UdpSocket};
use std::thread;
use std::time::{Duration, Instant};

use boringtun::noise::{Tunn, TunnResult};
use boringtun::x25519::{PublicKey, StaticSecret};
use serde_json::{json, Value};
use smoltcp::iface::{Config as IfaceConfig, Interface, SocketHandle, SocketSet};
use smoltcp::phy::{Device, DeviceCapabilities, Medium, RxToken, TxToken};
use smoltcp::socket::{tcp, udp};
use smoltcp::time::Instant as SmolInstant;
use smoltcp::wire::{HardwareAddress, IpAddress, IpCidr, IpEndpoint};
use temperance_gateway::{generate_private_key, public_key, Config, Gateway};

const ALLOWED: Ipv4Addr = Ipv4Addr::new(203, 0, 113, 10);
const ALLOWED_V6: Ipv6Addr = Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 0xa);
const PEER: Ipv4Addr = Ipv4Addr::new(10, 77, 0, 2);
const PEER_V6: Ipv6Addr = Ipv6Addr::new(0xfd77, 0, 0, 0, 0, 0, 0, 2);
const GATEWAY: Ipv4Addr = Ipv4Addr::new(10, 77, 0, 1);
const GATEWAY_V6: Ipv6Addr = Ipv6Addr::new(0xfd77, 0, 0, 0, 0, 0, 0, 1);

#[derive(Default)]
struct Queue {
    rx: VecDeque<Vec<u8>>,
    tx: VecDeque<Vec<u8>>,
}

struct Rx(Vec<u8>);
struct Tx<'a>(&'a mut VecDeque<Vec<u8>>);

impl RxToken for Rx {
    fn consume<R, F: FnOnce(&[u8]) -> R>(self, f: F) -> R {
        f(&self.0)
    }
}

impl TxToken for Tx<'_> {
    fn consume<R, F: FnOnce(&mut [u8]) -> R>(self, len: usize, f: F) -> R {
        let mut buf = vec![0; len];
        let r = f(&mut buf);
        self.0.push_back(buf);
        r
    }
}

impl Device for Queue {
    type RxToken<'a> = Rx;
    type TxToken<'a> = Tx<'a>;
    fn receive(&mut self, _: SmolInstant) -> Option<(Rx, Tx<'_>)> {
        let packet = self.rx.pop_front()?;
        Some((Rx(packet), Tx(&mut self.tx)))
    }
    fn transmit(&mut self, _: SmolInstant) -> Option<Tx<'_>> {
        Some(Tx(&mut self.tx))
    }
    fn capabilities(&self) -> DeviceCapabilities {
        let mut caps = DeviceCapabilities::default();
        caps.medium = Medium::Ip;
        caps.max_transmission_unit = 1280;
        caps
    }
}

/// A phone: WireGuard to the gateway and a TCP/IP stack on 10.77.0.2.
struct Phone {
    tunn: Tunn,
    udp: UdpSocket,
    gateway: SocketAddr,
    device: Queue,
    iface: Interface,
    sockets: SocketSet<'static>,
    next_port: u16,
}

impl Phone {
    fn new(private: &str, gateway_public: &str, gateway: SocketAddr) -> Phone {
        let key = |s: &str| -> [u8; 32] {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD
                .decode(s)
                .unwrap()
                .try_into()
                .unwrap()
        };
        let tunn = Tunn::new(
            StaticSecret::from(key(private)),
            PublicKey::from(key(gateway_public)),
            None,
            Some(25),
            7,
            None,
        );
        let udp = UdpSocket::bind("127.0.0.1:0").unwrap();
        udp.set_read_timeout(Some(Duration::from_millis(2)))
            .unwrap();
        let mut device = Queue::default();
        let mut iface = Interface::new(
            IfaceConfig::new(HardwareAddress::Ip),
            &mut device,
            SmolInstant::now(),
        );
        iface.update_ip_addrs(|a| a.push(IpCidr::new(IpAddress::Ipv4(PEER), 24)).unwrap());
        iface.routes_mut().add_default_ipv4_route(GATEWAY).unwrap();
        Phone {
            tunn,
            udp,
            gateway,
            device,
            iface,
            sockets: SocketSet::new(vec![]),
            next_port: 40000,
        }
    }

    /// Move packets between the stack and the tunnel once.
    fn step(&mut self) {
        self.iface
            .poll(SmolInstant::now(), &mut self.device, &mut self.sockets);
        let mut out = vec![0; 65536];
        while let Some(packet) = self.device.tx.pop_front() {
            if let TunnResult::WriteToNetwork(d) = self.tunn.encapsulate(&packet, &mut out) {
                self.udp.send_to(d, self.gateway).unwrap();
            }
        }
        if let TunnResult::WriteToNetwork(d) = self.tunn.update_timers(&mut out) {
            self.udp.send_to(d, self.gateway).unwrap();
        }
        let mut datagram = vec![0; 65536];
        while let Ok((n, _)) = self.udp.recv_from(&mut datagram) {
            match self.tunn.decapsulate(None, &datagram[..n], &mut out) {
                TunnResult::WriteToNetwork(d) => {
                    self.udp.send_to(d, self.gateway).unwrap();
                    while let TunnResult::WriteToNetwork(d) =
                        self.tunn.decapsulate(None, &[], &mut out)
                    {
                        self.udp.send_to(d, self.gateway).unwrap();
                    }
                }
                TunnResult::WriteToTunnelV4(p, _) | TunnResult::WriteToTunnelV6(p, _) => {
                    self.device.rx.push_back(p.to_vec())
                }
                _ => {}
            }
        }
        self.iface
            .poll(SmolInstant::now(), &mut self.device, &mut self.sockets);
    }

    fn until<T>(&mut self, secs: u64, mut done: impl FnMut(&mut Self) -> Option<T>) -> Option<T> {
        let deadline = Instant::now() + Duration::from_secs(secs);
        while Instant::now() < deadline {
            self.step();
            if let Some(v) = done(self) {
                return Some(v);
            }
        }
        None
    }

    fn enable_v6(&mut self) {
        self.iface.update_ip_addrs(|a| {
            a.push(IpCidr::new(IpAddress::Ipv6(PEER_V6), 128)).unwrap();
        });
        self.iface
            .routes_mut()
            .add_default_ipv6_route(GATEWAY_V6)
            .unwrap();
    }

    fn port(&mut self) -> u16 {
        self.next_port += 1;
        self.next_port
    }

    /// (rcode, first A record) for `host`, asked of the gateway's resolver.
    fn resolve(&mut self, host: &str) -> (u8, Option<Ipv4Addr>) {
        self.resolve_via(GATEWAY, host)
    }

    fn resolve_via(&mut self, server: Ipv4Addr, host: &str) -> (u8, Option<Ipv4Addr>) {
        let buffer = || udp::PacketBuffer::new(vec![udp::PacketMetadata::EMPTY; 4], vec![0; 4096]);
        let mut socket = udp::Socket::new(buffer(), buffer());
        let port = self.port();
        socket.bind(port).unwrap();
        let handle = self.sockets.add(socket);
        let mut query = vec![0xab, 0xcd, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0];
        for label in host.split('.') {
            query.push(label.len() as u8);
            query.extend(label.as_bytes());
        }
        query.extend([0, 0, 1, 0, 1]);
        self.sockets
            .get_mut::<udp::Socket>(handle)
            .send_slice(&query, IpEndpoint::new(IpAddress::Ipv4(server), 53))
            .unwrap();
        let reply = self
            .until(10, |p| {
                p.sockets
                    .get_mut::<udp::Socket>(handle)
                    .recv()
                    .ok()
                    .map(|(d, _)| d.to_vec())
            })
            .expect("DNS reply");
        self.sockets.remove(handle);
        let answer = (reply.len() >= query.len() + 16).then(|| {
            let a = &reply[reply.len() - 4..];
            Ipv4Addr::new(a[0], a[1], a[2], a[3])
        });
        (reply[3] & 0x0f, answer)
    }

    /// (rcode, first AAAA record) for `host`.
    fn resolve_aaaa(&mut self, host: &str) -> (u8, Option<Ipv6Addr>) {
        let buffer = || udp::PacketBuffer::new(vec![udp::PacketMetadata::EMPTY; 4], vec![0; 4096]);
        let mut socket = udp::Socket::new(buffer(), buffer());
        let port = self.port();
        socket.bind(port).unwrap();
        let handle = self.sockets.add(socket);
        let mut query = vec![0xab, 0xcd, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0];
        for label in host.split('.') {
            query.push(label.len() as u8);
            query.extend(label.as_bytes());
        }
        query.extend([0, 0, 28, 0, 1]);
        self.sockets
            .get_mut::<udp::Socket>(handle)
            .send_slice(&query, IpEndpoint::new(IpAddress::Ipv4(GATEWAY), 53))
            .unwrap();
        let reply = self
            .until(10, |p| {
                p.sockets
                    .get_mut::<udp::Socket>(handle)
                    .recv()
                    .ok()
                    .map(|(d, _)| d.to_vec())
            })
            .expect("DNS reply");
        self.sockets.remove(handle);
        let rcode = reply[3] & 0x0f;
        let answer = (rcode == 0 && reply.len() >= query.len() + 16).then(|| {
            let start = reply.len() - 16;
            Ipv6Addr::from(<[u8; 16]>::try_from(&reply[start..]).unwrap())
        });
        (rcode, answer)
    }

    fn connect(&mut self, to: Ipv4Addr, port: u16) -> SocketHandle {
        let mut socket = tcp::Socket::new(
            tcp::SocketBuffer::new(vec![0; 65536]),
            tcp::SocketBuffer::new(vec![0; 65536]),
        );
        let local = self.port();
        socket
            .connect(self.iface.context(), (IpAddress::Ipv4(to), port), local)
            .unwrap();
        self.sockets.add(socket)
    }

    fn connect_v6(&mut self, to: Ipv6Addr, port: u16) -> SocketHandle {
        let mut socket = tcp::Socket::new(
            tcp::SocketBuffer::new(vec![0; 65536]),
            tcp::SocketBuffer::new(vec![0; 65536]),
        );
        let local = self.port();
        socket
            .connect(self.iface.context(), (IpAddress::Ipv6(to), port), local)
            .unwrap();
        self.sockets.add(socket)
    }

    fn tcp(&mut self, handle: SocketHandle) -> &mut tcp::Socket<'static> {
        self.sockets.get_mut::<tcp::Socket>(handle)
    }

    fn established(&mut self, handle: SocketHandle, secs: u64) -> bool {
        self.until(secs, |p| p.tcp(handle).may_send().then_some(()))
            .is_some()
    }

    /// One UDP datagram to `to` and its echo.
    fn udp_echo(&mut self, to: Ipv4Addr, port: u16, message: &[u8]) -> bool {
        let buffer = || udp::PacketBuffer::new(vec![udp::PacketMetadata::EMPTY; 4], vec![0; 4096]);
        let mut socket = udp::Socket::new(buffer(), buffer());
        socket.bind(self.port()).unwrap();
        let handle = self.sockets.add(socket);
        self.sockets
            .get_mut::<udp::Socket>(handle)
            .send_slice(message, IpEndpoint::new(IpAddress::Ipv4(to), port))
            .unwrap();
        let reply = self.until(5, |p| {
            p.sockets
                .get_mut::<udp::Socket>(handle)
                .recv()
                .ok()
                .map(|(d, _)| d.to_vec())
        });
        self.sockets.remove(handle);
        reply.as_deref() == Some(message)
    }

    fn udp_echo_v6(&mut self, to: Ipv6Addr, port: u16, message: &[u8]) -> bool {
        let buffer = || udp::PacketBuffer::new(vec![udp::PacketMetadata::EMPTY; 4], vec![0; 4096]);
        let mut socket = udp::Socket::new(buffer(), buffer());
        socket.bind(self.port()).unwrap();
        let handle = self.sockets.add(socket);
        self.sockets
            .get_mut::<udp::Socket>(handle)
            .send_slice(message, IpEndpoint::new(IpAddress::Ipv6(to), port))
            .unwrap();
        let reply = self.until(5, |p| {
            p.sockets
                .get_mut::<udp::Socket>(handle)
                .recv()
                .ok()
                .map(|(d, _)| d.to_vec())
        });
        self.sockets.remove(handle);
        reply.as_deref() == Some(message)
    }

    /// Send `message` and wait for the echo server to return it.
    fn echo(&mut self, handle: SocketHandle, message: &[u8]) -> bool {
        if !self.established(handle, 10) {
            return false;
        }
        self.tcp(handle).send_slice(message).unwrap();
        let mut got = Vec::new();
        self.until(10, |p| {
            let socket = p.tcp(handle);
            if socket.can_recv() {
                socket
                    .recv(|d| (d.len(), got.extend_from_slice(d)))
                    .unwrap();
            }
            (got.len() >= message.len()).then_some(())
        });
        got == message
    }
}

fn echo_server() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            thread::spawn(move || {
                let mut stream = stream;
                let mut buf = [0; 4096];
                while let Ok(n @ 1..) = stream.read(&mut buf) {
                    if stream.write_all(&buf[..n]).is_err() {
                        return;
                    }
                }
            });
        }
    });
    port
}

/// Answers one request with `reply`, then closes (like an HTTP/1.0 server).
fn reply_server(reply: &'static [u8]) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let mut buf = [0; 4096];
            if stream.read(&mut buf).is_ok() {
                let _ = stream.write_all(reply);
            }
        }
    });
    port
}

fn udp_echo_server() -> u16 {
    let socket = UdpSocket::bind("127.0.0.1:0").unwrap();
    let port = socket.local_addr().unwrap().port();
    thread::spawn(move || {
        let mut buf = [0; 1500];
        while let Ok((n, from)) = socket.recv_from(&mut buf) {
            let _ = socket.send_to(&buf[..n], from);
        }
    });
    port
}

/// Upstream resolver: every name resolves to ALLOWED.
fn dns_server() -> SocketAddr {
    let socket = UdpSocket::bind("127.0.0.1:0").unwrap();
    let addr = socket.local_addr().unwrap();
    thread::spawn(move || {
        let mut buf = [0; 1500];
        while let Ok((n, from)) = socket.recv_from(&mut buf) {
            let mut reply = buf[..n].to_vec();
            reply[2] = 0x81;
            reply[3] = 0x80;
            reply[7] = 1;
            reply.extend([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 1, 0, 0, 4]);
            reply.extend(ALLOWED.octets());
            socket.send_to(&reply, from).unwrap();
        }
    });
    addr
}

/// Upstream resolver: A queries return [`ALLOWED`], AAAA queries return [`ALLOWED_V6`].
fn dns_dual() -> SocketAddr {
    let socket = UdpSocket::bind("127.0.0.1:0").unwrap();
    let addr = socket.local_addr().unwrap();
    thread::spawn(move || {
        let mut buf = [0; 1500];
        while let Ok((n, from)) = socket.recv_from(&mut buf) {
            if n < 4 {
                continue;
            }
            let mut reply = buf[..n].to_vec();
            reply[2] = 0x81;
            reply[3] = 0x80;
            reply[7] = 1;
            let qtype = u16::from_be_bytes([buf[n - 4], buf[n - 3]]);
            if qtype == 28 {
                reply.extend([0xc0, 0x0c, 0, 28, 0, 1, 0, 0, 1, 0, 0, 16]);
                reply.extend(ALLOWED_V6.octets());
            } else {
                reply.extend([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 1, 0, 0, 4]);
                reply.extend(ALLOWED.octets());
            }
            socket.send_to(&reply, from).unwrap();
        }
    });
    addr
}

fn echo_server_v6() -> u16 {
    let listener = TcpListener::bind("[::1]:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            thread::spawn(move || {
                let mut stream = stream;
                let mut buf = [0; 4096];
                while let Ok(n @ 1..) = stream.read(&mut buf) {
                    if stream.write_all(&buf[..n]).is_err() {
                        return;
                    }
                }
            });
        }
    });
    port
}

fn udp_echo_server_v6() -> u16 {
    let socket = UdpSocket::bind("[::1]:0").unwrap();
    let port = socket.local_addr().unwrap().port();
    thread::spawn(move || {
        let mut buf = [0; 1500];
        while let Ok((n, from)) = socket.recv_from(&mut buf) {
            let _ = socket.send_to(&buf[..n], from);
        }
    });
    port
}

fn state(phone_public: &str, used: u32, rewards: Value) -> String {
    json!({
        "policy_schema": 2,
        "timezone": "UTC",
        "paused": false,
        "profiles": [{"id": 1, "name": "Riley", "filter_level": "teen", "deny": ["blocked.test"],
                      "limit": 60, "used": used, "rewards": rewards}],
        "peers": [{"id": "phone", "ip": PEER.to_string(), "public_key": phone_public, "profile_id": 1,
                   "paused": false, "managed": true}],
        "lan_devices": [],
    })
    .to_string()
}

fn start() -> (Gateway, Phone, String) {
    let gateway_key = generate_private_key();
    let phone_key = generate_private_key();
    let phone_public = public_key(&phone_key).unwrap();
    let config: Config = serde_json::from_value(json!({
        "listen": "127.0.0.1:0",
        "private_key": gateway_key,
        "dns_upstream": dns_server().to_string(),
        "idle_bytes": 0,
        "connect_map": {ALLOWED.to_string(): "127.0.0.1"},
    }))
    .unwrap();
    let gateway = Gateway::start(config).unwrap();
    gateway
        .apply_state(&state(&phone_public, 0, json!([])))
        .unwrap();
    let phone = Phone::new(&phone_key, &gateway.public_key(), gateway.local_addr());
    (gateway, phone, phone_public)
}

#[test]
fn browsing_blocking_budget_and_activity_through_the_tunnel() {
    let echo_port = echo_server();
    let (mut gateway, mut phone, phone_public) = start();

    // Allowed: the name resolves and the connection carries data both ways.
    assert_eq!(phone.resolve("allowed.test"), (0, Some(ALLOWED)));
    let open = phone.connect(ALLOWED, echo_port);
    assert!(
        phone.echo(open, b"hello through the tunnel"),
        "allowed traffic flows"
    );
    assert!(
        phone.udp_echo(ALLOWED, udp_echo_server(), b"quic-ish datagram"),
        "UDP is relayed per flow"
    );
    assert!(
        !phone.udp_echo(Ipv4Addr::new(192, 168, 1, 1), 9, b"lan"),
        "private destinations are dropped"
    );

    // Blocked by a custom rule: NXDOMAIN, no address to connect to.
    assert_eq!(phone.resolve("blocked.test"), (3, None));
    // DNS sent to another resolver is answered, and filtered, by the gateway.
    let outside = Ipv4Addr::new(8, 8, 8, 8);
    assert_eq!(phone.resolve_via(outside, "blocked.test"), (3, None));
    assert_eq!(
        phone.resolve_via(outside, "allowed.test"),
        (0, Some(ALLOWED))
    );

    // Activity is attributed to the device, its total and the host's buckets.
    let report = gateway.drain_activity();
    let entry = &report["activity"][0];
    assert_eq!(entry["device_id"], "phone");
    let buckets: Vec<&str> = entry["buckets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b.as_str().unwrap())
        .collect();
    assert_eq!(buckets, ["total", "category:other", "site:allowed.test"]);
    assert!(report["history"]
        .as_array()
        .unwrap()
        .iter()
        .any(|h| h["domain"] == "blocked.test" && h["blocked"] == true));
    assert_eq!(
        gateway.drain_activity()["activity"],
        json!([]),
        "drained once"
    );

    // The daily budget runs out: the open connection is closed, new ones fail.
    gateway
        .apply_state(&state(&phone_public, 60, json!([])))
        .unwrap();
    let closed = phone.until(10, |p| {
        (!p.tcp(open).may_recv() || !p.tcp(open).is_active()).then_some(())
    });
    assert!(
        closed.is_some(),
        "open connection closed when time runs out"
    );
    assert!(
        phone
            .until(5, |_| (gateway.open_flows() == 0).then_some(()))
            .is_some(),
        "flows are released"
    );
    let refused = phone.connect(ALLOWED, echo_port);
    assert!(
        !phone.established(refused, 3),
        "no new connections without time"
    );

    // A reward restores access.
    let today = chrono_today();
    gateway
        .apply_state(&state(
            &phone_public,
            60,
            json!([{"kind": "extra_time", "day": today, "minutes": 15}]),
        ))
        .unwrap();
    let again = phone.connect(ALLOWED, echo_port);
    assert!(
        phone.echo(again, b"back online"),
        "reward restores browsing"
    );

    // Revoking the device removes its peer: its connections and tunnel stop.
    let mut revoked: Value = serde_json::from_str(&state(&phone_public, 0, json!([]))).unwrap();
    revoked["peers"] = json!([]);
    gateway.apply_state(&revoked.to_string()).unwrap();
    assert!(
        phone
            .until(5, |_| (gateway.open_flows() == 0).then_some(()))
            .is_some(),
        "a revoked device's flows are closed"
    );
    let after = phone.connect(ALLOWED, echo_port);
    assert!(
        !phone.established(after, 3),
        "a revoked device cannot connect"
    );
    gateway.stop();
}

#[test]
fn ipv6_flows_are_forwarded_filtered_and_attributed() {
    let echo_port = echo_server_v6();
    let udp_port = udp_echo_server_v6();
    let gateway_key = generate_private_key();
    let phone_key = generate_private_key();
    let phone_public = public_key(&phone_key).unwrap();
    let config: Config = serde_json::from_value(json!({
        "listen": "127.0.0.1:0",
        "private_key": gateway_key,
        "dns_upstream": dns_dual().to_string(),
        "idle_bytes": 0,
        "connect_map": {ALLOWED_V6.to_string(): "::1"},
    }))
    .unwrap();
    let mut gateway = Gateway::start(config).unwrap();
    gateway
        .apply_state(&state(&phone_public, 0, json!([])))
        .unwrap();
    let mut phone = Phone::new(&phone_key, &gateway.public_key(), gateway.local_addr());
    phone.enable_v6();

    assert_eq!(phone.resolve_aaaa("v6.test"), (0, Some(ALLOWED_V6)));
    let open = phone.connect_v6(ALLOWED_V6, echo_port);
    assert!(
        phone.echo(open, b"hello over ipv6"),
        "public IPv6 is relayed"
    );
    assert!(
        phone.udp_echo_v6(ALLOWED_V6, udp_port, b"ipv6 datagram"),
        "IPv6 UDP is relayed per flow"
    );
    assert!(
        !phone.udp_echo_v6("fd00::1".parse().unwrap(), 9, b"ula"),
        "unique-local destinations are dropped"
    );
    assert_eq!(phone.resolve_aaaa("blocked.test"), (3, None));

    let report = gateway.drain_activity();
    let buckets: Vec<&str> = report["activity"][0]["buckets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b.as_str().unwrap())
        .collect();
    assert_eq!(buckets, ["total", "category:other", "site:v6.test"]);
    gateway.stop();
}

#[test]
fn unreachable_destinations_are_refused_at_once() {
    let closed = TcpListener::bind("[::1]:0").unwrap();
    let dead_port = closed.local_addr().unwrap().port();
    drop(closed);
    let gateway_key = generate_private_key();
    let phone_key = generate_private_key();
    let phone_public = public_key(&phone_key).unwrap();
    let config: Config = serde_json::from_value(json!({
        "listen": "127.0.0.1:0",
        "private_key": gateway_key,
        "dns_upstream": dns_dual().to_string(),
        "idle_bytes": 0,
        "connect_map": {ALLOWED_V6.to_string(): "::1", ALLOWED.to_string(): "127.0.0.1"},
    }))
    .unwrap();
    let mut gateway = Gateway::start(config).unwrap();
    gateway
        .apply_state(&state(&phone_public, 0, json!([])))
        .unwrap();
    let mut phone = Phone::new(&phone_key, &gateway.public_key(), gateway.local_addr());
    phone.enable_v6();

    let started = Instant::now();
    let v6 = phone.connect_v6(ALLOWED_V6, dead_port);
    let v4 = phone.connect(ALLOWED, dead_port);
    let refused = phone.until(5, |p| {
        (p.tcp(v6).state() == tcp::State::Closed && p.tcp(v4).state() == tcp::State::Closed)
            .then_some(())
    });
    assert!(refused.is_some(), "both connections are reset");
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "without waiting"
    );
    assert_eq!(gateway.open_flows(), 0);

    let echo_port = echo_server_v6();
    let open = phone.connect_v6(ALLOWED_V6, echo_port);
    assert!(
        phone.echo(open, b"still relayed"),
        "reachable ones still connect"
    );
    gateway.stop();
}

#[test]
fn home_dns_withholds_ipv6_answers() {
    let probe = UdpSocket::bind("127.0.0.1:0").unwrap();
    let port = probe.local_addr().unwrap().port();
    drop(probe);
    let config: Config = serde_json::from_value(json!({
        "listen": "127.0.0.1:0",
        "private_key": generate_private_key(),
        "dns_upstream": dns_dual().to_string(),
        "home_dns": format!("127.0.0.1:{port}"),
        "lan_networks": ["127.0.0.0/8"],
    }))
    .unwrap();
    let gateway = Gateway::start(config).unwrap();
    let ask = |kind: u16| {
        let socket = UdpSocket::bind("127.0.0.1:0").unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut query = vec![0x11, 0x22, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0];
        for label in "home.test".split('.') {
            query.push(label.len() as u8);
            query.extend(label.as_bytes());
        }
        query.push(0);
        query.extend(kind.to_be_bytes());
        query.extend(1u16.to_be_bytes());
        socket.send_to(&query, ("127.0.0.1", port)).unwrap();
        let mut buf = [0; 1500];
        let n = socket.recv(&mut buf).expect("DNS reply");
        buf[..n].to_vec()
    };
    let a = ask(1);
    assert_eq!(a[3] & 0x0f, 0);
    assert_eq!(&a[a.len() - 4..], &ALLOWED.octets());
    let aaaa = ask(28);
    assert_eq!(aaaa[3] & 0x0f, 0, "empty answer, not an error");
    assert_eq!(u16::from_be_bytes([aaaa[6], aaaa[7]]), 0, "no AAAA records");
    drop(gateway);
}

#[test]
fn the_server_closing_reaches_the_device() {
    let reply = b"HTTP/1.0 200 OK\r\n\r\nclose-delimited body";
    let port = reply_server(reply);
    let (mut gateway, mut phone, _) = start();
    for attempt in 0..3 {
        let open = phone.connect(ALLOWED, port);
        assert!(phone.established(open, 10), "attempt {attempt} connects");
        phone
            .tcp(open)
            .send_slice(b"GET / HTTP/1.0\r\n\r\n")
            .unwrap();
        let mut got = Vec::new();
        let finished = phone.until(5, |p| {
            let socket = p.tcp(open);
            if socket.can_recv() {
                socket
                    .recv(|d| (d.len(), got.extend_from_slice(d)))
                    .unwrap();
            }
            (!socket.may_recv()).then_some(())
        });
        assert_eq!(got, reply, "attempt {attempt} receives the reply");
        assert!(
            finished.is_some(),
            "attempt {attempt} sees the server's FIN"
        );
        phone.tcp(open).close();
    }
    gateway.stop();
}

#[test]
fn forwarding_stops_when_the_policy_lease_lapses() {
    let echo_port = echo_server();
    let (mut gateway, mut phone, _) = start();
    let open = phone.connect(ALLOWED, echo_port);
    assert!(phone.echo(open, b"before"));
    // No state for longer than the lease: the gateway fails closed.
    let closed = phone.until(temperance_gateway::LEASE.as_secs() + 5, |p| {
        (!p.tcp(open).may_recv()).then_some(())
    });
    assert!(closed.is_some(), "open connection closed after the lease");
    let refused = phone.connect(ALLOWED, echo_port);
    assert!(!phone.established(refused, 3));
    gateway.stop();
}

/// Answers each HTTP request with `body`, recording the request lines.
fn text_server(body: &'static str) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let log = seen.clone();
    thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let mut buf = [0u8; 2048];
            let n = stream.read(&mut buf).unwrap_or(0);
            let head = String::from_utf8_lossy(&buf[..n]).to_string();
            log.lock()
                .unwrap()
                .push(head.lines().next().unwrap_or("").to_string());
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    (url, seen)
}

#[test]
fn network_settings_arrive_with_the_state_and_status_returns_with_activity() {
    let (checkip, _) = text_server("Current IP Address: 198.51.100.4");
    let (dynu, updates) = text_server("good 198.51.100.4");
    let config: Config = serde_json::from_value(json!({
        "listen": "127.0.0.1:0",
        "private_key": generate_private_key(),
        "reach": {"checkip": checkip, "dynu": dynu},
    }))
    .unwrap();
    let mut gateway = Gateway::start(config).unwrap();
    let mut state: Value = serde_json::from_str(&state("", 0, json!([]))).unwrap();
    state["peers"] = json!([]);
    state["network"] = json!({"upnp": true, "ddns": {"provider": "dynu",
        "hostname": "home.example.net", "username": "u", "password": "p"}});
    gateway.apply_state(&state.to_string()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let network = loop {
        let batch = gateway.drain_activity();
        if !batch["network"].is_null() {
            break batch["network"].clone();
        }
        assert!(Instant::now() < deadline, "no network status reported");
        thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(network["ddns"]["state"], "ok");
    assert_eq!(network["ddns"]["ip"], "198.51.100.4");
    // A loopback listener is never mapped on the router.
    assert!(network["upnp"].is_null());
    assert!(updates.lock().unwrap()[0].contains("hostname=home.example.net&myip=198.51.100.4"));
    assert!(
        gateway.drain_activity()["network"].is_null(),
        "reported once"
    );
    gateway.stop();
}

fn chrono_today() -> String {
    let days = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        / 86400;
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// A stand-in dashboard: pairs code "good" when the gateway's secret comes
/// with it, and echoes every other request back as JSON.
fn dashboard(secret: &'static str) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let keys = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let paired = keys.clone();
    thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let mut data = Vec::new();
            let mut buf = [0u8; 4096];
            let (head, body) = loop {
                let n = stream.read(&mut buf).unwrap_or(0);
                if n == 0 {
                    break (String::new(), Vec::new());
                }
                data.extend_from_slice(&buf[..n]);
                let Some(end) = data.windows(4).position(|w| w == b"\r\n\r\n") else {
                    continue;
                };
                let head = String::from_utf8_lossy(&data[..end]).to_string();
                let length = head
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length: ")
                            .map(str::to_string)
                    })
                    .and_then(|l| l.parse::<usize>().ok())
                    .unwrap_or(0);
                if data.len() >= end + 4 + length {
                    break (head, data[end + 4..end + 4 + length].to_vec());
                }
            };
            let mut lines = head.lines();
            let start: Vec<&str> = lines.next().unwrap_or("").split(' ').collect();
            let headers: serde_json::Map<String, Value> = lines
                .filter_map(|l| l.split_once(": "))
                .map(|(n, v)| (n.to_ascii_lowercase(), json!(v)))
                .collect();
            let (status, reply) = if start.get(1) == Some(&"/v1/gateway/parents/pair") {
                let request: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                if headers.get("x-temperance-forwarded") == Some(&json!(secret))
                    && request["code"] == "good"
                {
                    paired
                        .lock()
                        .unwrap()
                        .push(request["key"].as_str().unwrap().to_string());
                    (200, json!({"id": "par_1", "household": "The Riveras"}))
                } else {
                    (400, json!({"error": "That pairing code has expired."}))
                }
            } else {
                (
                    200,
                    json!({"method": start[0], "path": start.get(1), "headers": headers,
                             "body": String::from_utf8_lossy(&body)}),
                )
            };
            let reply = reply.to_string();
            let _ = write!(
                stream,
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                reply.len()
            );
        }
    });
    (url, keys)
}

/// One request to the phone's loopback proxy; returns the status and body.
fn through_proxy(url: &str, request: &str) -> (u16, String) {
    let port: u16 = url
        .strip_prefix("http://127.0.0.1:")
        .and_then(|r| r.split('/').next())
        .unwrap()
        .parse()
        .unwrap();
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(15)))
        .unwrap();
    let request = request.replace(
        "{host}",
        &format!("Host: 127.0.0.1:{port}\r\nConnection: close"),
    );
    stream.write_all(request.as_bytes()).unwrap();
    let mut out = String::new();
    let _ = stream.read_to_string(&mut out);
    let status = out
        .split(' ')
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    (
        status,
        out.split_once("\r\n\r\n")
            .map(|(_, b)| b.to_string())
            .unwrap_or_default(),
    )
}

#[test]
fn parent_phones_pair_and_reach_the_dashboard_over_the_wireguard_port() {
    use temperance_core::remote::{format_pairing_link, pair_parent, PairingLink, RemoteSession};
    const SECRET: &str = "parent-forwarding-secret-0123456789abcdef";
    let (target, keys) = dashboard(SECRET);
    let dir = std::env::temp_dir().join(format!("temperance-parents-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let echo_port = echo_server();
    let phone_key = generate_private_key();
    let phone_public = public_key(&phone_key).unwrap();
    let config: Config = serde_json::from_value(json!({
        "listen": "127.0.0.1:0",
        "private_key": generate_private_key(),
        "dns_upstream": dns_server().to_string(),
        "idle_bytes": 0,
        "connect_map": {ALLOWED.to_string(): "127.0.0.1"},
        "remote": {"key_file": dir.join("parent.key"), "secret": SECRET, "target": target},
    }))
    .unwrap();
    let mut gateway = Gateway::start(config).unwrap();
    let with_parents = |parents: Value| {
        let mut state: Value = serde_json::from_str(&state(&phone_public, 0, json!([]))).unwrap();
        state["parents"] = parents;
        state.to_string()
    };
    gateway.apply_state(&with_parents(json!([]))).unwrap();
    let mut phone = Phone::new(&phone_key, &gateway.public_key(), gateway.local_addr());

    // The dashboard learns the pin for its pairing codes from the activity batch.
    let pin = gateway.drain_activity()["remote"]["pin"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(gateway.parent_pin().as_deref(), Some(pin.as_str()));
    let link = |code: &str| {
        format_pairing_link(&PairingLink {
            v: 1,
            host: "127.0.0.1".into(),
            port: gateway.local_addr().port(),
            pin: pin.clone(),
            code: code.into(),
            household: String::new(),
        })
    };
    let refused = pair_parent(link("stale"), "Sam's phone".into()).unwrap_err();
    assert!(refused.to_string().contains("expired"), "{refused}");
    let identity = pair_parent(link("good"), "Sam's phone".into()).unwrap();
    assert!(identity.contains("The Riveras"));
    let key = keys.lock().unwrap()[0].clone();

    // A child's WireGuard tunnel keeps working on the same socket.
    let open = phone.connect(ALLOWED, echo_port);
    assert!(
        phone.echo(open, b"still browsing"),
        "WireGuard shares the port"
    );

    let session = RemoteSession::start(identity).unwrap();
    let url = session.url();
    let token = url.split("t=").nth(1).unwrap().to_string();
    let cookie = format!("Cookie: temperance_proxy={token}");
    let (status, _) = through_proxy(
        &url,
        &format!("GET /__temperance/start?t={token} HTTP/1.1\r\n{{host}}\r\n\r\n"),
    );
    assert_eq!(status, 302);

    let (status, body) = through_proxy(
        &url,
        &format!("GET /api/state HTTP/1.1\r\n{{host}}\r\n{cookie}\r\nX-Temperance-Parent: admin\r\nX-Temperance-Forwarded: guess\r\n\r\n"),
    );
    assert_eq!(status, 200, "{body}");
    let echoed: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(echoed["path"], "/api/state");
    assert_eq!(
        echoed["headers"]["x-temperance-parent"], "par_1",
        "the gateway names the parent"
    );
    assert_eq!(
        echoed["headers"]["x-temperance-forwarded"], SECRET,
        "spoofed headers are replaced"
    );
    let (_, body) = through_proxy(
        &url,
        &format!("POST /api/profiles/1/pause HTTP/1.1\r\n{{host}}\r\n{cookie}\r\nContent-Type: application/json\r\nContent-Length: 15\r\n\r\n{{\"paused\":true}}"),
    );
    let echoed: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        (echoed["method"].as_str(), echoed["body"].as_str()),
        (Some("POST"), Some("{\"paused\":true}"))
    );
    let (status, _) = through_proxy(
        &url,
        &format!("GET /v1/gateway/state HTTP/1.1\r\n{{host}}\r\n{cookie}\r\n\r\n"),
    );
    assert_eq!(
        status, 404,
        "gateway routes are not reachable through a parent phone"
    );

    // Listed in the state it keeps working; once it is gone, it is cut off.
    gateway
        .apply_state(&with_parents(json!([{"id": "par_1", "key": key}])))
        .unwrap();
    let (status, _) = through_proxy(
        &url,
        &format!("GET / HTTP/1.1\r\n{{host}}\r\n{cookie}\r\n\r\n"),
    );
    assert_eq!(status, 200);
    gateway.apply_state(&with_parents(json!([]))).unwrap();
    let (status, body) = through_proxy(
        &url,
        &format!("GET / HTTP/1.1\r\n{{host}}\r\n{cookie}\r\n\r\n"),
    );
    assert_eq!(status, 502);
    assert!(body.contains("removed from the family"), "{body}");
    assert!(phone.echo(open, b"children are unaffected"));

    session.stop();
    gateway.stop();
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn children_sign_in_over_the_wireguard_port_without_pairing() {
    use temperance_core::remote::{format_pairing_link, home_send, pair_parent, PairingLink};
    use temperance_core::{format_home_link, sign_in_request, Header, HomeLink, HttpRequest};
    const SECRET: &str = "device-forwarding-secret-0123456789abcdef";
    let (target, _) = dashboard(SECRET);
    let dir = std::env::temp_dir().join(format!("temperance-devices-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let config: Config = serde_json::from_value(json!({
        "listen": "127.0.0.1:0",
        "private_key": generate_private_key(),
        "dns_upstream": dns_server().to_string(),
        "idle_bytes": 0,
        "remote": {"key_file": dir.join("parent.key"), "secret": SECRET, "target": target, "parents": false},
    }))
    .unwrap();
    let mut gateway = Gateway::start(config).unwrap();
    let pin = gateway.parent_pin().unwrap();
    let port = gateway.local_addr().port();
    let home = format_home_link(&HomeLink {
        v: 1,
        host: "127.0.0.1".into(),
        port,
        pin: pin.clone(),
        household: String::new(),
    });

    let login = sign_in_request(
        home,
        "sam".into(),
        "pw".into(),
        "Phone".into(),
        "key".into(),
    )
    .unwrap();
    let reply = home_send(login, false).unwrap();
    assert_eq!(reply.status, 200, "{}", reply.body);
    let echoed: Value = serde_json::from_str(&reply.body).unwrap();
    assert_eq!(echoed["path"], "/v1/device/login");
    assert!(echoed["body"]
        .as_str()
        .unwrap()
        .contains("\"username\":\"sam\""));
    assert_eq!(echoed["headers"]["x-forwarded-for"], "127.0.0.1");
    assert!(
        echoed["headers"].get("x-temperance-forwarded").is_none(),
        "device requests carry no parent credentials"
    );

    let request = |path: &str| HttpRequest {
        method: "GET".into(),
        url: format!("temperance://{pin}@127.0.0.1:{port}{path}"),
        headers: vec![
            Header {
                name: "Authorization".into(),
                value: "Bearer tok".into(),
            },
            Header {
                name: "X-Forwarded-For".into(),
                value: "203.0.113.9".into(),
            },
            Header {
                name: "X-Temperance-Parent".into(),
                value: "par_1".into(),
            },
        ],
        body: None,
    };
    let reply = home_send(request("/v1/device/state"), false).unwrap();
    let echoed: Value = serde_json::from_str(&reply.body).unwrap();
    assert_eq!(echoed["headers"]["authorization"], "Bearer tok");
    assert_eq!(
        echoed["headers"]["x-forwarded-for"], "127.0.0.1",
        "spoofed addresses are replaced"
    );
    assert!(echoed["headers"].get("x-temperance-parent").is_none());
    for path in ["/api/state", "/v1/gateway/state", "/v1/device/../api/state"] {
        assert_eq!(
            home_send(request(path), false).unwrap().status,
            404,
            "{path}"
        );
    }

    // With parent access off, phones cannot pair.
    let link = format_pairing_link(&PairingLink {
        v: 1,
        host: "127.0.0.1".into(),
        port,
        pin,
        code: "good".into(),
        household: String::new(),
    });
    assert!(pair_parent(link, "Sam's phone".into()).is_err());

    gateway.stop();
    std::fs::remove_dir_all(&dir).unwrap();
}
