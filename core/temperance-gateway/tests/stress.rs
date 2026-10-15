//! Several devices at once, each pushing a lot of traffic through one gateway.
//!
//! Run it in release — that is how the gateway ships — so the numbers mean something:
//!
//! ```sh
//! cargo test -p temperance-gateway --test stress --release -- --ignored --nocapture
//! ```
//!
//! The clients are the same shape as `tunnel.rs`: boringtun plus a userspace TCP/IP
//! stack, no root and no TUN device. What this adds is concurrency. Every allowed
//! device transfers at the same time, in both directions, while policy is refreshed
//! underneath them. Bytes are patterned per device so a mixed-up flow fails the test.
use std::collections::{BTreeSet, VecDeque};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use boringtun::noise::{Tunn, TunnResult};
use boringtun::x25519::{PublicKey, StaticSecret};
use serde_json::json;
use smoltcp::iface::{Config as IfaceConfig, Interface, SocketHandle, SocketSet};
use smoltcp::phy::{Device, DeviceCapabilities, Medium, RxToken, TxToken};
use smoltcp::socket::{tcp, udp};
use smoltcp::time::Instant as SmolInstant;
use smoltcp::wire::{HardwareAddress, IpAddress, IpCidr, IpEndpoint};
use temperance_gateway::{generate_private_key, public_key, Config, Gateway};

const ACTIVE: usize = 12;
const BULK_BYTES: usize = 1024 * 1024;
const BULK_PASSES: usize = 4;
const CHURN_CONNECTIONS: usize = 24;
const CHURN_BYTES: usize = 16 * 1024;
const UDP_DATAGRAMS: u16 = 48;
const UDP_PAYLOAD: usize = 1100;
const UDP_WINDOW: u16 = 16;
const SITE: Ipv4Addr = Ipv4Addr::new(203, 0, 113, 10);
const GATEWAY_IP: Ipv4Addr = Ipv4Addr::new(10, 77, 0, 1);

struct Peer {
    id: String,
    ip: Ipv4Addr,
    private_key: String,
    paused: bool,
}

struct Load {
    inflight: AtomicUsize,
    peak: AtomicUsize,
    bytes: AtomicU64,
}

impl Load {
    fn begin(&self) {
        let n = self.inflight.fetch_add(1, Ordering::Relaxed) + 1;
        self.peak.fetch_max(n, Ordering::Relaxed);
    }
    fn end(&self) {
        self.inflight.fetch_sub(1, Ordering::Relaxed);
    }
    fn add_bytes(&self, n: usize) {
        self.bytes.fetch_add(n as u64, Ordering::Relaxed);
    }
}

fn client_byte(id: u8, pass: u8, i: usize) -> u8 {
    id.wrapping_add(pass)
        .wrapping_add(i as u8)
        .wrapping_mul(31)
        .wrapping_add((i >> 8) as u8)
}

fn server_byte(i: usize) -> u8 {
    0xA5u8.wrapping_add(i as u8).wrapping_add((i >> 9) as u8)
}

fn paint_client(id: u8, pass: u8, buf: &mut [u8]) {
    if buf.is_empty() {
        return;
    }
    buf[0] = id;
    if buf.len() > 1 {
        buf[1] = pass;
    }
    for (i, b) in buf.iter_mut().enumerate().skip(2) {
        *b = client_byte(id, pass, i);
    }
}

fn client_payload_ok(buf: &[u8]) -> bool {
    if buf.len() < 2 {
        return false;
    }
    let (id, pass) = (buf[0], buf[1]);
    buf.iter()
        .enumerate()
        .skip(2)
        .all(|(i, b)| *b == client_byte(id, pass, i))
}

fn server_payload_ok(buf: &[u8]) -> bool {
    buf.iter().enumerate().all(|(i, b)| *b == server_byte(i))
}

fn rss_kb() -> u64 {
    let Ok(out) = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
    else {
        return 0;
    };
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse()
        .unwrap_or(0)
}

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

/// One household device: WireGuard to the gateway and a TCP/IP stack on its tunnel address.
struct Phone {
    ip: Ipv4Addr,
    tunn: Tunn,
    udp: UdpSocket,
    gateway: SocketAddr,
    device: Queue,
    iface: Interface,
    sockets: SocketSet<'static>,
    next_port: u16,
    out: Vec<u8>,
    datagram: Vec<u8>,
}

impl Phone {
    fn new(ip: Ipv4Addr, private: &str, gateway_public: &str, gateway: SocketAddr) -> Phone {
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
            None,
            u32::from(ip.octets()[3]),
            None,
        );
        let udp = UdpSocket::bind("127.0.0.1:0").unwrap();
        udp.set_nonblocking(true).unwrap();
        let mut device = Queue::default();
        let mut iface = Interface::new(
            IfaceConfig::new(HardwareAddress::Ip),
            &mut device,
            SmolInstant::now(),
        );
        iface.update_ip_addrs(|a| a.push(IpCidr::new(IpAddress::Ipv4(ip), 24)).unwrap());
        iface
            .routes_mut()
            .add_default_ipv4_route(GATEWAY_IP)
            .unwrap();
        Phone {
            ip,
            tunn,
            udp,
            gateway,
            device,
            iface,
            sockets: SocketSet::new(vec![]),
            next_port: 40_000,
            out: vec![0; 65536],
            datagram: vec![0; 65536],
        }
    }

    /// Returns whether any tunnel packet moved, so the caller can idle when it didn't.
    fn step(&mut self) -> bool {
        self.iface
            .poll(SmolInstant::now(), &mut self.device, &mut self.sockets);
        let mut busy = false;
        while let Some(packet) = self.device.tx.pop_front() {
            if let Some(d) = self.encrypt(&packet) {
                self.send_udp(&d);
                busy = true;
            }
        }
        if let Some(d) = self.timer_packet() {
            self.send_udp(&d);
            busy = true;
        }
        loop {
            let n = match self.udp.recv_from(&mut self.datagram) {
                Ok((n, _)) => n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            };
            busy = true;
            let packet = self.datagram[..n].to_vec();
            self.ingest(&packet);
        }
        self.iface
            .poll(SmolInstant::now(), &mut self.device, &mut self.sockets);
        busy
    }

    fn encrypt(&mut self, packet: &[u8]) -> Option<Vec<u8>> {
        match self.tunn.encapsulate(packet, &mut self.out) {
            TunnResult::WriteToNetwork(d) => Some(d.to_vec()),
            _ => None,
        }
    }

    fn timer_packet(&mut self) -> Option<Vec<u8>> {
        match self.tunn.update_timers(&mut self.out) {
            TunnResult::WriteToNetwork(d) => Some(d.to_vec()),
            _ => None,
        }
    }

    fn ingest(&mut self, packet: &[u8]) {
        let first = match self.tunn.decapsulate(None, packet, &mut self.out) {
            TunnResult::WriteToNetwork(d) => Some(d.to_vec()),
            TunnResult::WriteToTunnelV4(p, _) => {
                self.device.rx.push_back(p.to_vec());
                None
            }
            _ => None,
        };
        if let Some(d) = first {
            self.send_udp(&d);
            loop {
                let more = match self.tunn.decapsulate(None, &[], &mut self.out) {
                    TunnResult::WriteToNetwork(d) => Some(d.to_vec()),
                    _ => None,
                };
                let Some(d) = more else { break };
                self.send_udp(&d);
            }
        }
    }

    fn send_udp(&self, datagram: &[u8]) {
        loop {
            match self.udp.send_to(datagram, self.gateway) {
                Ok(_) => return,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => thread::yield_now(),
                Err(_) => return,
            }
        }
    }

    fn drive<T>(
        &mut self,
        limit: Duration,
        mut step: impl FnMut(&mut Self) -> Option<Result<T, String>>,
    ) -> Result<T, String> {
        let deadline = Instant::now() + limit;
        while Instant::now() < deadline {
            if !self.step() {
                thread::sleep(Duration::from_micros(50));
            }
            if let Some(result) = step(self) {
                return result;
            }
        }
        Err(format!("{} timed out after {}s", self.ip, limit.as_secs()))
    }

    fn port(&mut self) -> u16 {
        self.next_port += 1;
        self.next_port
    }

    fn connect(&mut self, to: Ipv4Addr, port: u16) -> SocketHandle {
        let mut socket = tcp::Socket::new(
            tcp::SocketBuffer::new(vec![0; 256 * 1024]),
            tcp::SocketBuffer::new(vec![0; 256 * 1024]),
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

    /// Send `upload` and read `download` bytes at the same time, then close.
    fn exchange(&mut self, port: u16, upload: &[u8], download: usize) -> Result<Vec<u8>, String> {
        let handle = self.connect(SITE, port);
        self.drive(Duration::from_secs(10), |p| {
            p.tcp(handle).may_send().then_some(Ok(()))
        })
        .map_err(|e| format!("{e} (TCP handshake)"))?;
        let mut sent = 0usize;
        let mut got = Vec::with_capacity(download);
        let transferred = self.drive(Duration::from_secs(45), |p| {
            let socket = p.tcp(handle);
            if !socket.may_send() && sent < upload.len() {
                return Some(Err("upload closed early".into()));
            }
            if sent < upload.len() && socket.can_send() {
                match socket.send_slice(&upload[sent..]) {
                    Ok(0) | Err(_) => {}
                    Ok(n) => sent += n,
                }
            }
            if socket.can_recv() {
                if let Err(e) = socket.recv(|d| {
                    got.extend_from_slice(d);
                    (d.len(), ())
                }) {
                    if got.len() < download {
                        return Some(Err(format!("download ended ({e})")));
                    }
                }
            }
            if !socket.may_recv() && got.len() < download {
                return Some(Err(format!(
                    "peer closed after {} of {download} bytes",
                    got.len()
                )));
            }
            (sent == upload.len() && socket.send_queue() == 0 && got.len() >= download)
                .then_some(Ok(()))
        });
        self.tcp(handle).close();
        let _ = self.drive(Duration::from_secs(5), |p| {
            (!p.tcp(handle).is_open()).then_some(Ok(()))
        });
        self.sockets.remove(handle);
        transferred?;
        if got.len() != download {
            return Err(format!("expected {download} bytes, got {}", got.len()));
        }
        Ok(got)
    }

    fn bulk(
        &mut self,
        port: u16,
        id: u8,
        pass: u8,
        bytes: usize,
        load: &Load,
    ) -> Result<(), String> {
        load.begin();
        let mut payload = vec![0u8; bytes];
        paint_client(id, pass, &mut payload);
        let mut upload = (bytes as u32).to_be_bytes().to_vec();
        upload.extend_from_slice(&payload);
        let result = self.exchange(port, &upload, bytes);
        load.end();
        let got = result?;
        if !server_payload_ok(&got) {
            return Err(format!(
                "device {id} pass {pass} downloaded bytes that were not the server's"
            ));
        }
        load.add_bytes(bytes * 2);
        Ok(())
    }

    fn udp_burst(&mut self, port: u16, id: u8) -> Result<(), String> {
        let buffer = || {
            udp::PacketBuffer::new(
                vec![udp::PacketMetadata::EMPTY; 64],
                vec![0; 64 * (UDP_PAYLOAD + 32)],
            )
        };
        let mut socket = udp::Socket::new(buffer(), buffer());
        socket.bind(self.port()).unwrap();
        let handle = self.sockets.add(socket);
        let mut next: u16 = 0;
        let mut inflight = 0u16;
        let mut seen = vec![false; UDP_DATAGRAMS as usize];
        let mut got = 0u16;
        let result = self.drive(Duration::from_secs(30), |p| {
            let socket = p.sockets.get_mut::<udp::Socket>(handle);
            while inflight < UDP_WINDOW && next < UDP_DATAGRAMS {
                let mut packet = vec![0u8; UDP_PAYLOAD];
                packet[0] = id;
                packet[1] = (next >> 8) as u8;
                packet[2] = next as u8;
                for (i, b) in packet.iter_mut().enumerate().skip(3) {
                    *b = client_byte(id, next as u8, i);
                }
                if socket
                    .send_slice(&packet, IpEndpoint::new(IpAddress::Ipv4(SITE), port))
                    .is_err()
                {
                    break;
                }
                next += 1;
                inflight += 1;
            }
            let socket = p.sockets.get_mut::<udp::Socket>(handle);
            while let Ok((data, _)) = socket.recv() {
                if data.len() != UDP_PAYLOAD || data[0] != id {
                    return Some(Err(format!(
                        "device {id} UDP reply was {} bytes from {}",
                        data.len(),
                        data.first().copied().unwrap_or(0)
                    )));
                }
                let seq = u16::from_be_bytes([data[1], data[2]]);
                if seq >= UDP_DATAGRAMS || seen[seq as usize] {
                    return Some(Err(format!("device {id} UDP seq {seq}")));
                }
                if data[3..]
                    .iter()
                    .enumerate()
                    .any(|(i, b)| *b != client_byte(id, seq as u8, i + 3))
                {
                    return Some(Err(format!("device {id} UDP seq {seq} corrupted")));
                }
                seen[seq as usize] = true;
                got += 1;
                inflight = inflight.saturating_sub(1);
            }
            (got == UDP_DATAGRAMS).then_some(Ok(()))
        });
        self.sockets.remove(handle);
        result
    }
}

/// Reads a length-prefixed upload, checks which device painted it, and writes a
/// different pattern back at the same time so both directions are full.
fn duplex_server(errors: Arc<Mutex<Vec<String>>>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let errors = errors.clone();
            thread::spawn(move || {
                if let Err(e) = serve_duplex(stream) {
                    errors.lock().unwrap().push(e);
                }
            });
        }
    });
    port
}

fn serve_duplex(mut stream: TcpStream) -> Result<(), String> {
    stream.set_nodelay(true).ok();
    let mut len_buf = [0u8; 4];
    stream
        .read_exact(&mut len_buf)
        .map_err(|e| format!("length: {e}"))?;
    let n = u32::from_be_bytes(len_buf) as usize;
    if n > 8 * 1024 * 1024 {
        return Err(format!("refusing {n}-byte payload"));
    }
    let upload = thread::scope(|s| -> Result<Vec<u8>, String> {
        let mut writer = stream.try_clone().map_err(|e| e.to_string())?;
        let write = s.spawn(move || -> Result<(), String> {
            let mut out = vec![0u8; n];
            for (i, b) in out.iter_mut().enumerate() {
                *b = server_byte(i);
            }
            writer.write_all(&out).map_err(|e| e.to_string())
        });
        let mut buf = vec![0u8; n];
        let mut got = 0usize;
        while got < n {
            match stream.read(&mut buf[got..]) {
                Ok(0) => {
                    return Err(format!(
                        "upload ended after {got} of {n} bytes (device {})",
                        buf.first().copied().unwrap_or(0)
                    ));
                }
                Ok(k) => got += k,
                Err(e) => return Err(format!("upload read: {e}")),
            }
        }
        write
            .join()
            .map_err(|_| "download writer panicked".to_string())??;
        Ok(buf)
    })?;
    if !client_payload_ok(&upload) {
        return Err(format!(
            "upload from device {} did not match its pattern",
            upload.first().copied().unwrap_or(0)
        ));
    }
    stream.shutdown(Shutdown::Both).ok();
    Ok(())
}

fn udp_server() -> u16 {
    let socket = UdpSocket::bind("127.0.0.1:0").unwrap();
    let port = socket.local_addr().unwrap().port();
    thread::spawn(move || {
        let mut buf = [0u8; 2048];
        while let Ok((n, from)) = socket.recv_from(&mut buf) {
            let _ = socket.send_to(&buf[..n], from);
        }
    });
    port
}

fn state(peers: &[Peer]) -> String {
    let peers: Vec<_> = peers
        .iter()
        .map(|p| {
            json!({
                "id": p.id,
                "ip": p.ip.to_string(),
                "public_key": public_key(&p.private_key).unwrap(),
                "profile_id": 1,
                "paused": p.paused,
                "managed": true,
            })
        })
        .collect();
    json!({
        "policy_schema": 2,
        "timezone": "UTC",
        "paused": false,
        "profiles": [{"id": 1, "name": "Riley", "filter_level": "teen", "deny": [],
                      "limit": 60, "used": 0, "rewards": []}],
        "peers": peers,
        "lan_devices": [],
    })
    .to_string()
}

fn wait_until(gateway: &Gateway, limit: Duration, mut done: impl FnMut(&Gateway) -> bool) -> bool {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if done(gateway) {
            return true;
        }
        thread::sleep(Duration::from_millis(20));
    }
    done(gateway)
}

/// Run `work` on every allowed device at once, refreshing policy throughout.
#[allow(clippy::too_many_arguments)]
fn all_devices(
    gateway: &Gateway,
    document: &str,
    peers: &[Peer],
    gateway_public: &str,
    gateway_addr: SocketAddr,
    peak_rss: &mut u64,
    block_paused: bool,
    tcp_port: u16,
    work: &(dyn Fn(&mut Phone, u8) -> Result<(), String> + Sync),
) -> (Duration, Vec<String>) {
    let failures: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let finished = Arc::new(AtomicUsize::new(0));
    let started = Instant::now();
    let active = peers.iter().filter(|p| !p.paused).count();
    thread::scope(|scope| {
        for peer in peers.iter().filter(|p| !p.paused) {
            let failures = failures.clone();
            let finished = finished.clone();
            let public = gateway_public.to_string();
            let private = peer.private_key.clone();
            let ip = peer.ip;
            let id = ip.octets()[3];
            scope.spawn(move || {
                let mut phone = Phone::new(ip, &private, &public, gateway_addr);
                if let Err(e) = work(&mut phone, id) {
                    failures.lock().unwrap().push(format!("{ip}: {e}"));
                }
                finished.fetch_add(1, Ordering::Relaxed);
            });
        }
        if block_paused {
            let Some(paused) = peers.iter().find(|p| p.paused) else {
                return;
            };
            let failures = failures.clone();
            let finished = finished.clone();
            let public = gateway_public.to_string();
            let private = paused.private_key.clone();
            let ip = paused.ip;
            scope.spawn(move || {
                let mut phone = Phone::new(ip, &private, &public, gateway_addr);
                let handle = phone.connect(SITE, tcp_port);
                let opened = phone
                    .drive(Duration::from_secs(3), |p| {
                        p.tcp(handle).may_send().then_some(Ok(()))
                    })
                    .is_ok();
                if opened {
                    failures.lock().unwrap().push(format!(
                        "paused device {ip} was allowed through during the load"
                    ));
                }
                finished.fetch_add(1, Ordering::Relaxed);
            });
        }
        refresh_until(
            gateway,
            document,
            &finished,
            active + usize::from(block_paused),
            Duration::from_secs(180),
            peak_rss,
        );
    });
    let failures = failures.lock().unwrap().clone();
    (started.elapsed(), failures)
}

/// Refresh policy the way the service does, and remember the busiest moment.
fn refresh_until(
    gateway: &Gateway,
    state: &str,
    finished: &AtomicUsize,
    workers: usize,
    limit: Duration,
    peak_rss: &mut u64,
) {
    let start = Instant::now();
    while finished.load(Ordering::Relaxed) < workers && start.elapsed() < limit {
        gateway.apply_state(state).expect("policy refresh");
        *peak_rss = (*peak_rss).max(rss_kb());
        thread::sleep(Duration::from_millis(200));
    }
}

#[test]
#[ignore = "multi-client bandwidth; cargo test --test stress --release -- --ignored --nocapture"]
fn many_clients_sustain_bulk_traffic() {
    let tcp_errors = Arc::new(Mutex::new(Vec::new()));
    let tcp_port = duplex_server(tcp_errors.clone());
    let udp_port = udp_server();
    let dns = UdpSocket::bind("127.0.0.1:0").unwrap();

    let mut peers = Vec::with_capacity(ACTIVE + 1);
    for i in 0..=ACTIVE {
        peers.push(Peer {
            id: format!("device-{i}"),
            ip: Ipv4Addr::new(10, 77, 0, (i + 2) as u8),
            private_key: generate_private_key(),
            paused: i == ACTIVE,
        });
    }
    let config: Config = serde_json::from_value(json!({
        "listen": "127.0.0.1:0",
        "private_key": generate_private_key(),
        "dns_upstream": dns.local_addr().unwrap().to_string(),
        "connect_map": {SITE.to_string(): "127.0.0.1"},
    }))
    .unwrap();
    let mut gateway = Gateway::start(config).unwrap();
    let document = state(&peers);
    gateway.apply_state(&document).unwrap();
    let gateway_public = gateway.public_key();
    let gateway_addr = gateway.local_addr();

    let load = Arc::new(Load {
        inflight: AtomicUsize::new(0),
        peak: AtomicUsize::new(0),
        bytes: AtomicU64::new(0),
    });
    let rss_before = rss_kb();
    let mut peak_rss = rss_before;

    let bulk = {
        let load = load.clone();
        move |phone: &mut Phone, id: u8| {
            for pass in 0..BULK_PASSES {
                phone.bulk(tcp_port, id, pass as u8, BULK_BYTES, &load)?;
            }
            Ok(())
        }
    };
    let (bulk_elapsed, mut failures) = all_devices(
        &gateway,
        &document,
        &peers,
        &gateway_public,
        gateway_addr,
        &mut peak_rss,
        true,
        tcp_port,
        &bulk,
    );
    let bulk_bytes = load.bytes.load(Ordering::Relaxed);
    let peak = load.peak.load(Ordering::Relaxed);

    let churn = {
        let load = load.clone();
        move |phone: &mut Phone, id: u8| {
            for n in 0..CHURN_CONNECTIONS {
                phone.bulk(tcp_port, id, n as u8, CHURN_BYTES, &load)?;
            }
            Ok(())
        }
    };
    let (churn_elapsed, churn_failures) = all_devices(
        &gateway,
        &document,
        &peers,
        &gateway_public,
        gateway_addr,
        &mut peak_rss,
        false,
        tcp_port,
        &churn,
    );
    failures.extend(churn_failures);
    let churn_bytes = load.bytes.load(Ordering::Relaxed) - bulk_bytes;
    let server_errors = tcp_errors.lock().unwrap().clone();
    // UDP associations linger for a minute, so the leak check is TCP-only and comes first.
    let drained = wait_until(&gateway, Duration::from_secs(10), |g| g.open_flows() == 0);
    let flows_left = gateway.open_flows();

    let udp = |phone: &mut Phone, id: u8| phone.udp_burst(udp_port, id);
    let (udp_elapsed, udp_failures) = all_devices(
        &gateway,
        &document,
        &peers,
        &gateway_public,
        gateway_addr,
        &mut peak_rss,
        false,
        tcp_port,
        &udp,
    );
    failures.extend(udp_failures);

    let activity = gateway.drain_activity();
    let devices: BTreeSet<String> = activity["activity"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| e["device_id"].as_str().map(str::to_string))
        .collect();
    let rss_after = rss_kb();
    let bulk_mbps = (bulk_bytes as f64) * 8.0 / bulk_elapsed.as_secs_f64() / 1_000_000.0;

    println!(
        "stress: {ACTIVE} devices moved {:.1} MiB each way-combined in {:.2}s ({bulk_mbps:.1} Mbit/s, peak {peak} flows); \
         then {CHURN_CONNECTIONS} short connections ({:.1} MiB in {:.2}s); \
         then {UDP_DATAGRAMS} UDP datagrams in {:.2}s; RSS {} -> {} -> {} KiB; TCP flows left {flows_left}",
        bulk_bytes as f64 / 1024.0 / 1024.0,
        bulk_elapsed.as_secs_f64(),
        churn_bytes as f64 / 1024.0 / 1024.0,
        churn_elapsed.as_secs_f64(),
        udp_elapsed.as_secs_f64(),
        rss_before,
        peak_rss,
        rss_after,
    );

    assert!(
        failures.is_empty(),
        "client failures:\n{}",
        failures.join("\n")
    );
    assert!(
        server_errors.is_empty(),
        "server saw bad uploads:\n{}",
        server_errors.join("\n")
    );
    assert!(
        peak >= ACTIVE / 2,
        "only {peak} flows overlapped; the devices did not actually run together"
    );
    assert!(
        drained,
        "{flows_left} flows still open 10s after every device finished"
    );
    let expected: BTreeSet<String> = (0..ACTIVE).map(|i| format!("device-{i}")).collect();
    assert_eq!(
        devices, expected,
        "activity was not recorded for every device that sent traffic"
    );
    if rss_before > 0 {
        assert!(
            peak_rss < rss_before + 300_000,
            "RSS grew by {} KiB under load",
            peak_rss - rss_before
        );
    }
    gateway.stop();
}
