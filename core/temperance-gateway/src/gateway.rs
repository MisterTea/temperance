//! The running gateway: WireGuard in, a userspace TCP/UDP stack, policy per
//! flow, and relays to the real network with per-bucket accounting.
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use ipstack::{IpStack, IpStackConfig, IpStackStream, IpStackTcpStream, IpStackUdpStream};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::runtime::Runtime;
use tokio::sync::{mpsc, watch};
use tokio::time::timeout;

use crate::dns::{self, Destinations};
use crate::home::{self, Router};
use crate::net::{self, forwardable, Net, GATEWAY_IP, MTU, TCP, UDP};
use crate::parent::{self, Parents};
use crate::policy::{HistoryEntry, Policy, State, Verdict};
use crate::reach;
use crate::wg::{decode_key, Wireguard};

/// Without a fresh policy for this long, nothing is forwarded.
pub const LEASE: Duration = Duration::from_secs(15);

fn default_upstream() -> SocketAddr {
    "1.1.1.1:53".parse().expect("static")
}

/// Traffic quieter than this in a minute is idle (pings, keepalives) and is not
/// charged against the client's time. Zero counts any byte.
fn default_idle_bytes() -> u64 {
    32 * 1024
}

#[derive(Clone, Debug, Deserialize)]
pub struct Config {
    /// UDP address WireGuard listens on, e.g. `0.0.0.0:51820`.
    pub listen: SocketAddr,
    /// The gateway's WireGuard private key (base64).
    pub private_key: String,
    #[serde(default = "default_upstream")]
    pub dns_upstream: SocketAddr,
    /// Bytes in one minute before that bucket counts as in use.
    #[serde(default = "default_idle_bytes")]
    pub idle_bytes: u64,
    /// Hostnames of this Temperance server; reachable even when a device is blocked.
    #[serde(default)]
    pub management_domains: Vec<String>,
    /// The dashboard, served to devices at `http://10.77.0.1`.
    #[serde(default)]
    pub web: Option<SocketAddr>,
    /// Answer DNS for home-network devices here (DNS mode), e.g. `0.0.0.0:53`.
    #[serde(default)]
    pub home_dns: Option<SocketAddr>,
    #[serde(default)]
    pub lan_networks: Vec<Net>,
    /// Linux only: also route and enforce home-network devices (router mode).
    #[serde(default)]
    pub router: Option<Router>,
    /// Rewrite destination addresses after the policy decision (tests, split horizon).
    #[serde(default)]
    pub connect_map: HashMap<IpAddr, IpAddr>,
    /// The UDP port the router exposes to the internet; defaults to the listen port.
    #[serde(default)]
    pub public_port: Option<u16>,
    /// UPnP discovery and dynamic DNS addresses (tests).
    #[serde(default)]
    pub reach: reach::Endpoints,
    /// Parent phones reaching the dashboard over QUIC on the listen port.
    #[serde(default)]
    pub remote: Option<parent::Config>,
    /// Wi-Fi interface to run as an access point. Linux only.
    #[serde(default)]
    pub ap: Option<crate::ap::AccessPoint>,
    /// Where the hosts each device resolved are kept across restarts.
    #[serde(default)]
    pub destinations_file: Option<std::path::PathBuf>,
}

pub struct Flow {
    src: Ipv4Addr,
    dst: IpAddr,
    port: u16,
    hosts: Vec<String>,
    verdict: Mutex<Verdict>,
    close: watch::Sender<bool>,
}

#[derive(Default)]
struct MinuteUse {
    bytes: BTreeMap<String, u64>,
    reported: BTreeSet<String>,
}

impl MinuteUse {
    fn add(&mut self, bucket: &str, bytes: u64) {
        if bytes == 0 {
            return;
        }
        *self.bytes.entry(bucket.to_string()).or_default() += bytes;
    }

    /// Buckets that have crossed `minimum` and have not been reported yet.
    fn take_ready(&mut self, minimum: u64) -> Vec<String> {
        let mut ready = Vec::new();
        for (bucket, bytes) in &self.bytes {
            let counts = bytes > &0 && (minimum == 0 || *bytes >= minimum);
            if counts && self.reported.insert(bucket.clone()) {
                ready.push(bucket.clone());
            }
        }
        ready
    }
}

pub struct Shared {
    pub config: Config,
    wg: Arc<Wireguard>,
    policy: RwLock<Option<Arc<Policy>>>,
    applied: Mutex<Option<Instant>>,
    destinations: Mutex<Destinations>,
    history: Mutex<Vec<HistoryEntry>>,
    /// Bytes carried this minute, per device and bucket.
    usage: Mutex<BTreeMap<(String, i64), MinuteUse>>,
    flows: Mutex<HashMap<u64, Arc<Flow>>>,
    next_flow: AtomicU64,
    router_counters: Mutex<(home::Counters, home::Seen)>,
    reach: Mutex<Option<std::sync::mpsc::Sender<reach::Command>>>,
    reach_report: Arc<Mutex<reach::Report>>,
    parents: Option<Arc<Parents>>,
}

impl Shared {
    fn live(&self) -> bool {
        self.applied
            .lock()
            .expect("lease lock")
            .is_some_and(|at| at.elapsed() < LEASE)
    }

    /// The current policy, or `None` once the lease has lapsed.
    pub fn policy(&self) -> Option<Arc<Policy>> {
        if !self.live() {
            return None;
        }
        self.policy.read().expect("policy lock").clone()
    }

    pub fn record_history(&self, entry: HistoryEntry) {
        let mut history = self.history.lock().expect("history lock");
        history.push(entry);
        let excess = history.len().saturating_sub(500);
        history.drain(..excess);
    }

    pub fn observe(&self, client: Ipv4Addr, host: &str, answers: &[(IpAddr, u32)]) {
        self.destinations
            .lock()
            .expect("destinations lock")
            .observe(client, host, answers, Instant::now());
    }

    fn hosts(&self, client: Ipv4Addr, address: IpAddr) -> Vec<String> {
        self.destinations
            .lock()
            .expect("destinations lock")
            .hosts(client, address, Instant::now())
    }

    fn decide(
        &self,
        policy: Option<&Policy>,
        src: Ipv4Addr,
        dst: IpAddr,
        port: u16,
        hosts: &[String],
    ) -> Verdict {
        match policy {
            Some(p) if forwardable(dst) && port != 853 => p.flow(src, hosts, crate::now()),
            _ => Verdict::Drop,
        }
    }

    fn verdict(&self, src: Ipv4Addr, dst: IpAddr, port: u16) -> (Verdict, Vec<String>) {
        let hosts = self.hosts(src, dst);
        (
            self.decide(self.policy().as_deref(), src, dst, port, &hosts),
            hosts,
        )
    }

    fn open(&self, src: Ipv4Addr, dst: IpAddr, port: u16) -> Option<(u64, Arc<Flow>)> {
        let (verdict, hosts) = self.verdict(src, dst, port);
        if verdict == Verdict::Drop {
            return None;
        }
        let id = self.next_flow.fetch_add(1, Ordering::Relaxed);
        let flow = Arc::new(Flow {
            src,
            dst,
            port,
            hosts,
            verdict: Mutex::new(verdict),
            close: watch::channel(false).0,
        });
        self.flows
            .lock()
            .expect("flows lock")
            .insert(id, flow.clone());
        Some((id, flow))
    }

    fn finish(&self, id: u64) {
        self.flows.lock().expect("flows lock").remove(&id);
    }

    fn touch(&self, flow: &Flow, bytes: u64) {
        let Verdict::Allow { device, buckets } = &*flow.verdict.lock().expect("verdict lock")
        else {
            return;
        };
        if buckets.is_empty() || bytes == 0 {
            return;
        }
        let minute = (crate::now() / 60.0).floor() as i64;
        let mut usage = self.usage.lock().expect("usage lock");
        let entry = usage.entry((device.clone(), minute)).or_default();
        for bucket in buckets {
            entry.add(bucket, bytes);
        }
    }

    fn note(&self, device: &str, bucket: &str, bytes: u64) {
        if bytes == 0 {
            return;
        }
        let minute = (crate::now() / 60.0).floor() as i64;
        self.usage
            .lock()
            .expect("usage lock")
            .entry((device.to_string(), minute))
            .or_default()
            .add(bucket, bytes);
    }

    /// Re-decide every open flow; flows that are no longer allowed are closed.
    fn reevaluate(&self) {
        let policy = self.policy();
        let flows: Vec<Arc<Flow>> = self
            .flows
            .lock()
            .expect("flows lock")
            .values()
            .cloned()
            .collect();
        {
            // An open flow is in use: its addresses keep their hosts past the TTL,
            // so a reconnect from a cached DNS answer is still attributed.
            let mut destinations = self.destinations.lock().expect("destinations lock");
            let now = Instant::now();
            for flow in &flows {
                destinations.keep(flow.src, flow.dst, now);
            }
        }
        for flow in flows {
            let mut hosts = flow.hosts.clone();
            hosts.extend(self.hosts(flow.src, flow.dst));
            hosts.sort();
            hosts.dedup();
            match self.decide(policy.as_deref(), flow.src, flow.dst, flow.port, &hosts) {
                Verdict::Drop => {
                    flow.close.send_replace(true);
                }
                allowed => *flow.verdict.lock().expect("verdict lock") = allowed,
            }
        }
    }

    pub fn open_flows(&self) -> usize {
        self.flows.lock().expect("flows lock").len()
    }

    fn save_destinations(&self) {
        let Some(path) = &self.config.destinations_file else {
            return;
        };
        let destinations = self.destinations.lock().expect("destinations lock");
        if let Err(e) = destinations.save(path, Instant::now(), crate::now()) {
            eprintln!("Could not save {}: {e}", path.display());
        }
    }

    fn apply(&self, state: &str) -> Result<(), String> {
        let state: State =
            serde_json::from_str(state).map_err(|e| format!("Invalid gateway state: {e}"))?;
        if let Some(tx) = &*self.reach.lock().expect("reach lock") {
            let network = state.network.clone().unwrap_or_default();
            let _ = tx.send(reach::Command::Configure(network));
        }
        if let Some(parents) = &self.parents {
            parents.set_paired(&state.parents);
        }
        let policy = Policy::new(
            state,
            &self.config.lan_networks,
            &self.config.management_domains,
        )?;
        let peers = policy
            .state
            .peers
            .iter()
            .filter_map(|p| Some((decode_key(p.public_key.as_deref()?).ok()?, p.ip)))
            .collect::<Vec<_>>();
        self.wg.set_peers(&peers);
        let policy = Arc::new(policy);
        *self.policy.write().expect("policy lock") = Some(policy.clone());
        *self.applied.lock().expect("lease lock") = Some(Instant::now());
        self.reevaluate();
        self.route_home(false)
    }

    /// Router mode: report the outgoing table's counters, then replace it.
    fn route_home(&self, expired: bool) -> Result<(), String> {
        let Some(router) = &self.config.router else {
            return Ok(());
        };
        let Some(policy) = self.policy.read().expect("policy lock").clone() else {
            return Ok(());
        };
        let mut installed = self.router_counters.lock().expect("counters lock");
        let (counters, seen) = &*installed;
        let bytes = if counters.is_empty() && seen.is_empty() {
            HashMap::new()
        } else {
            home::counter_bytes()
        };
        for (device, samples) in home::activity(counters, &bytes) {
            for (bucket, bytes) in samples {
                self.note(&device, &bucket, bytes);
            }
        }
        let script = {
            let mut destinations = self.destinations.lock().expect("destinations lock");
            let now = Instant::now();
            for (client, address) in home::in_use(seen, &bytes) {
                destinations.keep(client, IpAddr::from(address), now);
            }
            home::script(router, &policy, &destinations, expired)?
        };
        home::install(script.as_ref().map(|(s, _, _)| s.as_str()))?;
        home::accept_through_docker(&self.config.lan_networks);
        *installed = script.map(|(_, c, s)| (c, s)).unwrap_or_default();
        Ok(())
    }

    fn drain(&self) -> Value {
        let now_minute = (crate::now() / 60.0).floor() as i64;
        let minimum = self.config.idle_bytes;
        let mut usage = self.usage.lock().expect("usage lock");
        let mut activity = Vec::new();
        usage.retain(|(device, minute), use_| {
            if activity.len() < 1000 {
                let mut valid: Vec<String> = use_
                    .take_ready(minimum)
                    .into_iter()
                    .filter(|b| valid_bucket(b))
                    .collect();
                valid.sort_by_key(|b| b != "total");
                valid.truncate(40);
                if !valid.is_empty() {
                    activity.push(json!({"device_id": device, "minute": minute, "buckets": valid}));
                }
            }
            *minute + 1 >= now_minute
        });
        drop(usage);
        let mut history = self.history.lock().expect("history lock");
        let count = history.len().min(500);
        let reported: Vec<HistoryEntry> = history.drain(..count).collect();
        let mut batch = json!({"active_devices": [], "activity": activity, "history": reported});
        if let Some(network) = self
            .reach_report
            .lock()
            .expect("report lock")
            .take_changed()
        {
            batch["network"] = network;
        }
        if let Some(parents) = &self.parents {
            batch["remote"] = json!({"pin": parents.pin()});
        }
        batch
    }
}

/// The buckets `service.account()` accepts; anything else would reject the batch.
fn valid_bucket(bucket: &str) -> bool {
    let name = |s: &str, extra: &[char]| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || extra.contains(&c))
    };
    bucket.len() <= 300
        && (bucket == "total"
            || bucket
                .strip_prefix("category:")
                .is_some_and(|s| name(s, &['.', '-']))
            || bucket
                .strip_prefix("site:")
                .is_some_and(|s| name(s, &['.', '-']))
            || bucket
                .strip_prefix("group:")
                .is_some_and(|s| name(s, &['-'])))
}

/// Packets between WireGuard and the userspace stack.
struct Device {
    rx: mpsc::Receiver<Vec<u8>>,
    tx: mpsc::UnboundedSender<Vec<u8>>,
}

impl AsyncRead for Device {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.rx.poll_recv(cx) {
            Poll::Ready(Some(p)) => {
                let n = p.len().min(buf.remaining());
                buf.put_slice(&p[..n]);
                Poll::Ready(Ok(()))
            }
            // A closed channel means the gateway is stopping; never report EOF to the stack.
            Poll::Ready(None) | Poll::Pending => Poll::Pending,
        }
    }
}

impl AsyncWrite for Device {
    fn poll_write(
        self: Pin<&mut Self>,
        _: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        self.tx
            .send(buf.to_vec())
            .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?;
        Poll::Ready(Ok(buf.len()))
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

/// Decide at the packet level what reaches the stack: TCP/UDP from the
/// peer's own tunnel address, DNS, the dashboard, and connections policy allows.
fn admit(shared: &Shared, peer: Ipv4Addr, packet: &mut [u8]) -> bool {
    let Some(h) = net::parse(packet) else {
        return false;
    };
    let own = match h.src {
        IpAddr::V4(ip) => ip == peer,
        IpAddr::V6(ip) => net::peer_v6(peer) == Some(ip),
    };
    if !own || (h.protocol != TCP && h.protocol != UDP) {
        return false;
    }
    if h.syn {
        net::clamp_mss(packet, &h);
    }
    if h.dst_port == 53 {
        return true;
    }
    if h.dst == IpAddr::V4(GATEWAY_IP) {
        return h.protocol == TCP && h.dst_port == 80 && shared.config.web.is_some();
    }
    !h.syn || shared.verdict(peer, h.dst, h.dst_port).0 != Verdict::Drop
}

/// Policy and DNS attribution key off the peer's IPv4 tunnel address.
fn tunnel_client(ip: IpAddr) -> Option<Ipv4Addr> {
    match ip {
        IpAddr::V4(ip) => Some(ip),
        IpAddr::V6(ip) => net::peer_v4(ip),
    }
}

fn target(shared: &Shared, dst: SocketAddr) -> SocketAddr {
    let ip = shared
        .config
        .connect_map
        .get(&dst.ip())
        .copied()
        .unwrap_or(dst.ip());
    SocketAddr::new(ip, dst.port())
}

async fn pipe<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    mut from: R,
    mut to: W,
    touch: &(dyn Fn(usize) + Sync),
) {
    let mut buf = vec![0; 16384];
    loop {
        match from.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if to.write_all(&buf[..n]).await.is_err() {
                    break;
                }
                touch(n);
            }
        }
    }
    shutdown(&mut to, Duration::from_secs(60)).await;
}

/// ipstack sends its FIN only once in-flight data is acknowledged, and nothing wakes a
/// pending shutdown when that happens, so keep polling it on a backoff.
async fn shutdown<W: AsyncWrite + Unpin>(to: &mut W, limit: Duration) {
    let start = Instant::now();
    let mut delay = Duration::from_millis(5);
    while start.elapsed() < limit {
        if timeout(delay, to.shutdown()).await.is_ok() {
            return;
        }
        delay = (delay * 2).min(Duration::from_secs(1));
    }
}

async fn closed(rx: Option<watch::Receiver<bool>>) {
    match rx {
        Some(mut rx) => {
            let _ = rx.wait_for(|c| *c).await;
        }
        None => std::future::pending().await,
    }
}

async fn splice<C, U>(
    client: C,
    upstream: U,
    touch: &(dyn Fn(usize) + Sync),
    close: Option<watch::Receiver<bool>>,
) where
    C: AsyncRead + AsyncWrite + Unpin,
    U: AsyncRead + AsyncWrite + Unpin,
{
    let (mut cr, mut cw) = tokio::io::split(client);
    let (mut ur, mut uw) = tokio::io::split(upstream);
    let revoked = tokio::select! {
        _ = async { tokio::join!(pipe(&mut cr, &mut uw, touch), pipe(&mut ur, &mut cw, touch)) } => false,
        _ = closed(close) => true,
    };
    if revoked {
        // Dropping the stream alone is silent until the device sends again.
        shutdown(&mut cw, Duration::from_secs(1)).await;
    }
}

async fn connect(addr: SocketAddr) -> Option<TcpStream> {
    timeout(Duration::from_secs(10), TcpStream::connect(addr))
        .await
        .ok()?
        .ok()
}

async fn handle_tcp(shared: Arc<Shared>, stream: IpStackTcpStream) {
    let (src, dst) = (stream.local_addr(), stream.peer_addr());
    let Some(client) = tunnel_client(src.ip()) else {
        return;
    };
    if dst.port() == 53 {
        return dns::serve_stream(&shared, stream, client).await;
    }
    if dst.ip() == IpAddr::V4(GATEWAY_IP) {
        if let Some(web) = shared.config.web.filter(|_| dst.port() == 80) {
            if let Some(upstream) = connect(web).await {
                splice(stream, upstream, &|_| {}, None).await;
            }
        }
        return;
    }
    let Some((id, flow)) = shared.open(client, dst.ip(), dst.port()) else {
        return;
    };
    if let Some(upstream) = connect(target(&shared, dst)).await {
        let rx = flow.close.subscribe();
        splice(
            stream,
            upstream,
            &|n| shared.touch(&flow, n as u64),
            Some(rx),
        )
        .await;
    }
    shared.finish(id);
}

async fn handle_udp(shared: Arc<Shared>, mut stream: IpStackUdpStream) {
    let (src, dst) = (stream.local_addr(), stream.peer_addr());
    let Some(client) = tunnel_client(src.ip()) else {
        return;
    };
    let mut inbound = vec![0; 65536];
    if dst.port() == 53 {
        while let Ok(n @ 1..) = stream.read(&mut inbound).await {
            let response = dns::resolve(&shared, &inbound[..n], client, false).await;
            if !response.is_empty() && stream.write_all(&response).await.is_err() {
                return;
            }
        }
        return;
    }
    let Some((id, flow)) = shared.open(client, dst.ip(), dst.port()) else {
        return;
    };
    let relay = async {
        let bind = if target(&shared, dst).is_ipv4() {
            "0.0.0.0:0"
        } else {
            "[::]:0"
        };
        let sock = UdpSocket::bind(bind).await.ok()?;
        sock.connect(target(&shared, dst)).await.ok()?;
        let close = closed(Some(flow.close.subscribe()));
        tokio::pin!(close);
        let mut outbound = vec![0; 65536];
        loop {
            tokio::select! {
                r = stream.read(&mut inbound) => match r {
                    Ok(n @ 1..) => { let _ = sock.send(&inbound[..n]).await; shared.touch(&flow, n as u64); }
                    _ => return Some(()),
                },
                r = sock.recv(&mut outbound) => match r {
                    Ok(n) => { if stream.write_all(&outbound[..n]).await.is_err() { return Some(()) } shared.touch(&flow, n as u64); }
                    Err(_) => return Some(()),
                },
                _ = &mut close => return Some(()),
            }
        }
    };
    relay.await;
    shared.finish(id);
}

async fn serve_home_dns(shared: Arc<Shared>, udp: UdpSocket, tcp: TcpListener) {
    let udp = Arc::new(udp);
    let tcp_shared = shared.clone();
    tokio::spawn(async move {
        while let Ok((stream, from)) = tcp.accept().await {
            if let IpAddr::V4(ip) = from.ip() {
                let shared = tcp_shared.clone();
                tokio::spawn(async move { dns::serve_stream(&shared, stream, ip).await });
            }
        }
    });
    let mut buf = vec![0; 65536];
    loop {
        let Ok((n, from)) = udp.recv_from(&mut buf).await else {
            continue;
        };
        let IpAddr::V4(ip) = from.ip() else { continue };
        let (shared, udp, query) = (shared.clone(), udp.clone(), buf[..n].to_vec());
        tokio::spawn(async move {
            let response = dns::resolve(&shared, &query, ip, false).await;
            if !response.is_empty() {
                let _ = udp.send_to(&response, from).await;
            }
        });
    }
}

async fn run(shared: Arc<Shared>) {
    let (inbound_tx, mut inbound_rx) = mpsc::channel::<(Ipv4Addr, Vec<u8>)>(1024);
    let (stack_tx, stack_rx) = mpsc::channel::<Vec<u8>>(1024);
    let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    tokio::spawn(shared.wg.clone().receive(inbound_tx));
    tokio::spawn(shared.wg.clone().timers());
    let wg = shared.wg.clone();
    tokio::spawn(async move {
        while let Some(packet) = outbound_rx.recv().await {
            wg.send(&packet).await;
        }
    });
    let admitting = shared.clone();
    tokio::spawn(async move {
        while let Some((peer, mut packet)) = inbound_rx.recv().await {
            if admit(&admitting, peer, &mut packet) && stack_tx.send(packet).await.is_err() {
                return;
            }
        }
    });
    let ticking = shared.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(2));
        let mut was_live = false;
        let mut ticks = 0u64;
        loop {
            tick.tick().await;
            ticking.reevaluate();
            ticks += 1;
            if ticks % 30 == 0 {
                ticking.save_destinations();
            }
            let live = ticking.live();
            if was_live && !live {
                let _ = ticking.route_home(true);
            }
            was_live = live;
        }
    });
    let mut config = IpStackConfig::default();
    config
        .mtu_unchecked(MTU)
        .udp_timeout(Duration::from_secs(60));
    let mut stack = IpStack::new(
        config,
        Device {
            rx: stack_rx,
            tx: outbound_tx,
        },
    );
    while let Ok(stream) = stack.accept().await {
        match stream {
            IpStackStream::Tcp(tcp) => drop(tokio::spawn(handle_tcp(shared.clone(), tcp))),
            IpStackStream::Udp(udp) => drop(tokio::spawn(handle_udp(shared.clone(), udp))),
            _ => {}
        }
    }
}

pub struct Gateway {
    shared: Arc<Shared>,
    runtime: Option<Runtime>,
    local_addr: SocketAddr,
    reach_thread: Option<std::thread::JoinHandle<()>>,
}

impl Gateway {
    pub fn start(mut config: Config) -> Result<Gateway, String> {
        let key = decode_key(&config.private_key)?;
        if config.ap.is_some() && !cfg!(target_os = "linux") {
            return Err("An access point is only available on Linux".into());
        }
        crate::ap::configure(&mut config)?;
        if let Some(router) = config.router.as_mut() {
            if router.uplink.is_empty() {
                router.uplink = crate::ap::default_uplink(&router.lan_interface)?;
            }
        }
        if config.router.is_some() && !cfg!(target_os = "linux") {
            return Err("Router mode is only available on Linux".into());
        }
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name("temperance-gateway")
            .build()
            .map_err(|e| e.to_string())?;
        let socket = runtime
            .block_on(UdpSocket::bind(config.listen))
            .map_err(|e| format!("Cannot listen on {}: {e}", config.listen))?;
        let local_addr = socket.local_addr().map_err(|e| e.to_string())?;
        let home_dns = match config.home_dns {
            Some(addr) => Some(
                runtime
                    .block_on(async {
                        let udp = UdpSocket::bind(addr).await?;
                        let tcp = TcpListener::bind(udp.local_addr()?).await?;
                        io::Result::Ok((udp, tcp))
                    })
                    .map_err(|e| format!("Cannot serve home DNS on {addr}: {e}"))?,
            ),
            None => None,
        };
        let reach_report = Arc::new(Mutex::new(reach::Report::default()));
        let (reach_tx, reach_thread) = reach::spawn(reach::Reach::new(
            config.reach.clone(),
            SocketAddr::new(config.listen.ip(), local_addr.port()),
            config.public_port.unwrap_or(local_addr.port()),
            reach_report.clone(),
        ));
        let wg = Arc::new(Wireguard::new(key, socket));
        let parents = match &config.remote {
            Some(remote) => {
                let _entered = runtime.enter();
                let (parents, quic) = Parents::start(remote.clone(), wg.socket.clone())?;
                wg.hand_quic_to(quic);
                Some(parents)
            }
            None => None,
        };
        let destinations = config
            .destinations_file
            .as_deref()
            .map(|path| Destinations::load(path, Instant::now(), crate::now()))
            .unwrap_or_default();
        let shared = Arc::new(Shared {
            wg,
            parents,
            config,
            policy: RwLock::default(),
            applied: Mutex::default(),
            destinations: Mutex::new(destinations),
            history: Mutex::default(),
            usage: Mutex::default(),
            flows: Mutex::default(),
            next_flow: AtomicU64::new(1),
            router_counters: Mutex::default(),
            reach: Mutex::new(Some(reach_tx)),
            reach_report,
        });
        runtime.spawn(run(shared.clone()));
        if let Some((udp, tcp)) = home_dns {
            runtime.spawn(serve_home_dns(shared.clone(), udp, tcp));
        }
        Ok(Gateway {
            shared,
            runtime: Some(runtime),
            local_addr,
            reach_thread: Some(reach_thread),
        })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    pub fn public_key(&self) -> String {
        self.shared.wg.public_key()
    }

    /// Install `service.gatewayState()` (JSON) and renew the forwarding lease.
    pub fn apply_state(&self, state: &str) -> Result<(), String> {
        self.shared.apply(state)
    }

    /// `{active_devices, activity, history}` for `service.account()` since the last call.
    pub fn drain_activity(&self) -> Value {
        self.shared.drain()
    }

    pub fn open_flows(&self) -> usize {
        self.shared.open_flows()
    }

    /// Fingerprint parent phones pin, when parent access is on.
    pub fn parent_pin(&self) -> Option<String> {
        self.shared.parents.as_ref().map(|p| p.pin().to_string())
    }

    pub fn stop(&mut self) {
        if let Some(parents) = &self.shared.parents {
            parents.stop();
        }
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_timeout(Duration::from_secs(1));
            let _ = self.shared.route_home(true);
            self.shared.save_destinations();
        }
        if let Some(tx) = self.shared.reach.lock().expect("reach lock").take() {
            let _ = tx.send(reach::Command::Stop);
        }
        if let Some(thread) = self.reach_thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quiet_traffic_is_not_usage_until_it_passes_the_threshold() {
        let mut minute = MinuteUse::default();
        minute.add("total", 1000);
        minute.add("site:ping.example", 1000);
        assert!(minute.take_ready(32 * 1024).is_empty());
        minute.add("total", 40_000);
        minute.add("site:video.example", 40_000);
        assert_eq!(
            minute.take_ready(32 * 1024),
            vec!["site:video.example".to_string(), "total".to_string()]
        );
        assert!(minute.take_ready(32 * 1024).is_empty());
        assert_eq!(minute.take_ready(0), vec!["site:ping.example".to_string()]);
    }

    #[test]
    fn only_accepted_buckets_are_reported() {
        for ok in [
            "total",
            "category:video",
            "site:www.youtube.com",
            "group:a1-b2",
        ] {
            assert!(valid_bucket(ok), "{ok}");
        }
        for bad in [
            "site:under_score.example",
            "group:has.dot",
            "category:",
            "other",
        ] {
            assert!(!valid_bucket(bad), "{bad}");
        }
    }
}
