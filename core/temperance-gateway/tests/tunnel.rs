//! End to end without root or a TUN device: an in-test WireGuard client
//! (boringtun + smoltcp) browses through the gateway to a local server.
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, UdpSocket};
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
const PEER: Ipv4Addr = Ipv4Addr::new(10, 77, 0, 2);
const GATEWAY: Ipv4Addr = Ipv4Addr::new(10, 77, 0, 1);

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
                TunnResult::WriteToTunnelV4(p, _) => self.device.rx.push_back(p.to_vec()),
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
