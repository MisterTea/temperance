//! Reachability from outside the home: a UPnP port mapping on the router for
//! the WireGuard port, and a Dynu dynamic DNS name that follows the home's
//! public address. Settings arrive with the policy state (`network`); status
//! goes back with the activity batch.
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use base64::Engine;
use igd_next::{AddPortError, PortMappingProtocol, SearchError, SearchOptions};
use serde::{Deserialize, Serialize};

const LEASE_SECONDS: u32 = 3600;
const RENEW: Duration = Duration::from_secs(20 * 60);
const RETRY: Duration = Duration::from_secs(5 * 60);
const CHECK: Duration = Duration::from_secs(5 * 60);
const REFRESH: Duration = Duration::from_secs(24 * 3600);
const SEARCH: Duration = Duration::from_secs(3);
const IDLE: Duration = Duration::from_secs(3600);
const DESCRIPTION: &str = "Temperance WireGuard";

fn yes() -> bool {
    true
}

/// `network` in `service.gatewayState()`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Settings {
    #[serde(default = "yes")]
    pub upnp: bool,
    #[serde(default)]
    pub ddns: Option<Dynu>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            upnp: true,
            ddns: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Dynu {
    pub hostname: String,
    pub username: String,
    pub password: String,
}

/// Where discovery and updates are sent; replaced by fakes in tests.
#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
pub struct Endpoints {
    pub ssdp: SocketAddr,
    /// Router addresses accepted besides the one that answered (loopback is otherwise refused).
    pub trusted: Vec<IpAddr>,
    pub checkip: String,
    pub dynu: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Endpoints {
            ssdp: "239.255.255.250:1900".parse().expect("static"),
            trusted: Vec::new(),
            checkip: "https://checkip.dynu.com/".into(),
            dynu: "https://api.dynu.com/nic/update".into(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    Ok,
    Warning,
    Error,
    Off,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Status {
    pub state: Level,
    pub ip: Option<Ipv4Addr>,
    pub message: String,
    pub at: f64,
}

/// The latest status of both features, reported once per change.
#[derive(Debug, Default, Serialize)]
pub struct Report {
    pub upnp: Option<Status>,
    pub ddns: Option<Status>,
    #[serde(skip)]
    changed: bool,
}

impl Report {
    fn set(slot: &mut Option<Status>, changed: &mut bool, status: Option<Status>) {
        let same = match (&*slot, &status) {
            (Some(a), Some(b)) => a.state == b.state && a.ip == b.ip && a.message == b.message,
            (None, None) => true,
            _ => false,
        };
        if !same {
            *slot = status;
            *changed = true;
        }
    }

    /// The report as JSON if it changed since the last call.
    pub fn take_changed(&mut self) -> Option<serde_json::Value> {
        std::mem::take(&mut self.changed)
            .then(|| serde_json::to_value(&*self).expect("serializable"))
    }
}

fn status(state: Level, ip: Option<Ipv4Addr>, message: impl Into<String>) -> Option<Status> {
    Some(Status {
        state,
        ip,
        message: message.into(),
        at: crate::now(),
    })
}

/// Whether the internet can reach this address: not private, carrier-grade NAT or local.
pub fn is_public(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || (a == 100 && (64..128).contains(&b)))
}

/// The first public IPv4 address in a "what is my IP" page.
pub fn parse_ip(text: &str) -> Option<Ipv4Addr> {
    text.split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .filter_map(|word| word.parse().ok())
        .find(|ip| is_public(*ip))
}

/// A dyndns2 reply: `Err((stop retrying, message))` on failure.
pub fn dynu_reply(body: &str, hostname: &str) -> Result<(), (bool, String)> {
    let code = body.split_whitespace().next().unwrap_or("");
    match code {
        "good" | "nochg" => Ok(()),
        "badauth" => Err((
            true,
            "Dynu rejected the username or password. Use the IP update password from Dynu's control panel.".into(),
        )),
        "nohost" | "notfqdn" | "numhost" => Err((
            true,
            format!("Dynu has no hostname {hostname} in this account."),
        )),
        "abuse" | "!donator" | "badagent" => Err((
            true,
            format!("Dynu refused updates for {hostname} ({code}). Check the Dynu control panel."),
        )),
        "911" | "dnserr" => Err((false, "Dynu is having problems; retrying.".into())),
        _ => Err((
            false,
            format!(
                "Unexpected reply from Dynu: {}",
                body.trim().chars().take(80).collect::<String>()
            ),
        )),
    }
}

fn valid_hostname(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

struct Mapping {
    gateway: igd_next::Gateway,
    port: u16,
}

pub struct Reach {
    endpoints: Endpoints,
    listen: SocketAddr,
    public_port: u16,
    settings: Option<Settings>,
    mapping: Option<Mapping>,
    external_ip: Option<Ipv4Addr>,
    upnp_due: Instant,
    ddns_due: Instant,
    ddns_sent: Option<(Ipv4Addr, Instant)>,
    ddns_halted: bool,
    report: Arc<Mutex<Report>>,
    agent: ureq::Agent,
}

impl Reach {
    pub fn new(
        endpoints: Endpoints,
        listen: SocketAddr,
        public_port: u16,
        report: Arc<Mutex<Report>>,
    ) -> Reach {
        let now = Instant::now();
        Reach {
            endpoints,
            listen,
            public_port,
            settings: None,
            mapping: None,
            external_ip: None,
            upnp_due: now,
            ddns_due: now,
            ddns_sent: None,
            ddns_halted: false,
            report,
            agent: ureq::Agent::config_builder()
                .timeout_global(Some(Duration::from_secs(10)))
                .user_agent(concat!("Temperance/", env!("CARGO_PKG_VERSION")))
                .http_status_as_error(false)
                .build()
                .into(),
        }
    }

    fn report_upnp(&self, status: Option<Status>) {
        let mut report = self.report.lock().expect("report lock");
        let Report { upnp, changed, .. } = &mut *report;
        Report::set(upnp, changed, status);
    }

    fn report_ddns(&self, status: Option<Status>) {
        let mut report = self.report.lock().expect("report lock");
        let Report { ddns, changed, .. } = &mut *report;
        Report::set(ddns, changed, status);
    }

    /// Apply the settings from the latest state; unchanged settings do nothing.
    pub fn configure(&mut self, settings: Settings, now: Instant) {
        let old = self.settings.replace(settings.clone());
        if old.as_ref() == Some(&settings) {
            return;
        }
        if old.as_ref().map(|s| s.upnp) != Some(settings.upnp) {
            self.upnp_due = now;
            if !settings.upnp {
                self.unmap();
            }
        }
        if old.and_then(|s| s.ddns) != settings.ddns {
            self.ddns_due = now;
            self.ddns_sent = None;
            self.ddns_halted = false;
        }
    }

    /// Do whatever is due.
    pub fn tick(&mut self, now: Instant) {
        let Some(settings) = self.settings.clone() else {
            return;
        };
        if now >= self.upnp_due {
            self.upnp(settings.upnp, now);
        }
        if now >= self.ddns_due {
            self.ddns(settings.ddns.as_ref(), now);
        }
    }

    /// How long the worker may sleep before something is due.
    pub fn next_wake(&self, now: Instant) -> Duration {
        if self.settings.is_none() {
            return IDLE;
        }
        self.upnp_due
            .min(self.ddns_due)
            .saturating_duration_since(now)
            .max(Duration::from_secs(1))
    }

    fn upnp(&mut self, enabled: bool, now: Instant) {
        self.upnp_due = now + RENEW;
        if !enabled {
            self.external_ip = None;
            self.report_upnp(status(
                Level::Off,
                None,
                "Automatic port forwarding is off.",
            ));
            return;
        }
        // Nothing outside this machine can reach a loopback listener.
        if self.listen.ip().is_loopback() {
            self.upnp_due = now + IDLE;
            return;
        }
        match self.map() {
            Ok(lan) => {
                let port = self.public_port;
                let mapped = format!("The router forwards UDP {port} to {lan}.");
                let report = match self.external_ip {
                    Some(ip) if !is_public(ip) => status(
                        Level::Warning,
                        Some(ip),
                        format!(
                            "{mapped} But its internet address {ip} is private: another router or the ISP's carrier-grade NAT is in front of it, so devices outside cannot connect. See the router guide."
                        ),
                    ),
                    ip => status(Level::Ok, ip, mapped),
                };
                self.report_upnp(report);
            }
            Err(message) => {
                self.mapping = None;
                self.external_ip = None;
                self.upnp_due = now + RETRY;
                self.report_upnp(status(Level::Error, None, message));
            }
        }
    }

    /// Discover the router, map the port and read its internet address.
    fn map(&mut self) -> Result<SocketAddr, String> {
        let port = self.public_port;
        let mut options = SearchOptions::default();
        options.broadcast_address = self.endpoints.ssdp;
        options.timeout = Some(SEARCH);
        options.single_search_timeout = Some(SEARCH);
        options.allowed_gateway_ips = self.endpoints.trusted.clone();
        let gateway = igd_next::search_gateway(options).map_err(|e| match e {
            SearchError::NoResponseWithinTimeout => format!(
                "No UPnP router answered. Turn on UPnP in the router, or forward UDP {port} to this machine by hand. In Docker, UPnP needs host networking."
            ),
            e => format!("UPnP discovery failed: {e}"),
        })?;
        let lan_ip = if self.listen.ip().is_unspecified() {
            let probe = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
            probe.connect(gateway.addr).map_err(|e| e.to_string())?;
            probe.local_addr().map_err(|e| e.to_string())?.ip()
        } else {
            self.listen.ip()
        };
        let lan = SocketAddr::new(lan_ip, self.listen.port());
        let refused = |e: AddPortError| {
            match e {
            AddPortError::PortInUse => format!(
                "The router already forwards UDP {port} to another device. Remove that rule, or forward the port to this machine by hand."
            ),
            AddPortError::ActionNotAuthorized => format!(
                "The router refused to forward UDP {port}; its UPnP may be read-only. Forward the port by hand."
            ),
            AddPortError::SamePortValuesRequired => format!(
                "The router can only forward UDP {port} to the same port on this machine; use port {port} for the gateway too."
            ),
            e => format!("The router refused to forward UDP {port}: {e}"),
        }
        };
        match gateway.add_port(
            PortMappingProtocol::UDP,
            port,
            lan,
            LEASE_SECONDS,
            DESCRIPTION,
        ) {
            Ok(()) => {}
            Err(AddPortError::OnlyPermanentLeasesSupported) => gateway
                .add_port(PortMappingProtocol::UDP, port, lan, 0, DESCRIPTION)
                .map_err(refused)?,
            Err(e) => return Err(refused(e)),
        }
        self.external_ip = match gateway.get_external_ip() {
            Ok(IpAddr::V4(ip)) => Some(ip),
            _ => None,
        };
        self.mapping = Some(Mapping { gateway, port });
        Ok(lan)
    }

    /// Remove the router's port mapping, if this gateway made one.
    pub fn unmap(&mut self) {
        if let Some(Mapping { gateway, port }) = self.mapping.take() {
            if let Err(e) = gateway.remove_port(PortMappingProtocol::UDP, port) {
                log::warn!("Could not remove the UPnP mapping for UDP {port}: {e}");
            }
        }
    }

    fn ddns(&mut self, dynu: Option<&Dynu>, now: Instant) {
        let Some(dynu) = dynu else {
            self.ddns_due = now + IDLE;
            self.report_ddns(None);
            return;
        };
        if self.ddns_halted {
            self.ddns_due = now + IDLE;
            return;
        }
        self.ddns_due = now + CHECK;
        let ip = match self.external_ip.filter(|ip| is_public(*ip)) {
            Some(ip) => ip,
            None => match self.public_ip() {
                Ok(ip) => ip,
                Err(e) => {
                    let message = format!("Could not find this home's internet address: {e}");
                    self.report_ddns(status(Level::Error, None, message));
                    return;
                }
            },
        };
        if self
            .ddns_sent
            .is_some_and(|(sent, at)| sent == ip && now.duration_since(at) < REFRESH)
        {
            return;
        }
        match self.update(dynu, ip) {
            Ok(()) => {
                self.ddns_sent = Some((ip, now));
                let host = dynu.hostname.trim().to_ascii_lowercase();
                let message = format!("{host} points to {ip}.");
                self.report_ddns(status(Level::Ok, Some(ip), message));
            }
            Err((stop, message)) => {
                if stop {
                    self.ddns_halted = true;
                    self.ddns_due = now + IDLE;
                }
                self.report_ddns(status(Level::Error, Some(ip), message));
            }
        }
    }

    fn get(&self, url: &str, auth: Option<&str>) -> Result<(u16, String), String> {
        let mut request = self.agent.get(url);
        if let Some(auth) = auth {
            request = request.header("Authorization", auth);
        }
        let mut response = request.call().map_err(|e| e.to_string())?;
        let code = response.status().as_u16();
        let body = response
            .body_mut()
            .with_config()
            .limit(64 * 1024)
            .read_to_string()
            .map_err(|e| e.to_string())?;
        Ok((code, body))
    }

    fn public_ip(&self) -> Result<Ipv4Addr, String> {
        let (_, body) = self.get(&self.endpoints.checkip, None)?;
        parse_ip(&body).ok_or_else(|| "the address check returned no public IPv4 address".into())
    }

    fn update(&self, dynu: &Dynu, ip: Ipv4Addr) -> Result<(), (bool, String)> {
        let host = dynu.hostname.trim().to_ascii_lowercase();
        if !valid_hostname(&host) {
            return Err((true, format!("{host} is not a valid hostname.")));
        }
        let credentials = base64::engine::general_purpose::STANDARD
            .encode(format!("{}:{}", dynu.username, dynu.password));
        let url = format!("{}?hostname={host}&myip={ip}", self.endpoints.dynu);
        let (code, body) = self
            .get(&url, Some(&format!("Basic {credentials}")))
            .map_err(|e| (false, format!("Could not reach Dynu: {e}")))?;
        if code == 401 {
            return dynu_reply("badauth", &host);
        }
        dynu_reply(&body, &host)
    }
}

pub enum Command {
    Configure(Settings),
    Stop,
}

/// Run `reach` on its own thread until `Command::Stop` or the sender is dropped.
pub fn spawn(mut reach: Reach) -> (mpsc::Sender<Command>, JoinHandle<()>) {
    let (tx, rx) = mpsc::channel();
    let thread = std::thread::Builder::new()
        .name("temperance-reach".into())
        .spawn(move || loop {
            match rx.recv_timeout(reach.next_wake(Instant::now())) {
                Ok(Command::Configure(settings)) => reach.configure(settings, Instant::now()),
                Ok(Command::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                    reach.unmap();
                    return;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            reach.tick(Instant::now());
        })
        .expect("spawn reachability thread");
    (tx, thread)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;

    /// A UPnP internet gateway device on loopback: SSDP, descriptions and SOAP control.
    struct FakeRouter {
        ssdp: SocketAddr,
        calls: Arc<Mutex<Vec<String>>>,
        add_errors: Arc<Mutex<VecDeque<u16>>>,
        external_ip: Arc<Mutex<String>>,
    }

    const SCPD: &str = r#"<?xml version="1.0"?><scpd><actionList>
<action><name>AddPortMapping</name><argumentList>
<argument><name>NewRemoteHost</name><direction>in</direction></argument>
<argument><name>NewExternalPort</name><direction>in</direction></argument>
<argument><name>NewProtocol</name><direction>in</direction></argument>
<argument><name>NewInternalPort</name><direction>in</direction></argument>
<argument><name>NewInternalClient</name><direction>in</direction></argument>
<argument><name>NewEnabled</name><direction>in</direction></argument>
<argument><name>NewPortMappingDescription</name><direction>in</direction></argument>
<argument><name>NewLeaseDuration</name><direction>in</direction></argument>
</argumentList></action>
<action><name>DeletePortMapping</name><argumentList>
<argument><name>NewRemoteHost</name><direction>in</direction></argument>
<argument><name>NewExternalPort</name><direction>in</direction></argument>
<argument><name>NewProtocol</name><direction>in</direction></argument>
</argumentList></action>
<action><name>GetExternalIPAddress</name><argumentList></argumentList></action>
</actionList></scpd>"#;

    const DESCRIPTION_XML: &str = r#"<?xml version="1.0"?><root><device>
<deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
<deviceList><device><deviceList><device><serviceList><service>
<serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
<SCPDURL>/scpd.xml</SCPDURL><controlURL>/ctl</controlURL>
</service></serviceList></device></deviceList></device></deviceList>
</device></root>"#;

    fn envelope(inner: &str) -> String {
        format!(
            r#"<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1"><s:Body>{inner}</s:Body></s:Envelope>"#
        )
    }

    impl FakeRouter {
        fn start() -> FakeRouter {
            let calls = Arc::new(Mutex::new(Vec::new()));
            let add_errors = Arc::new(Mutex::new(VecDeque::new()));
            let external_ip = Arc::new(Mutex::new("203.0.113.7".to_string()));
            let http = TcpListener::bind("127.0.0.1:0").unwrap();
            let http_port = http.local_addr().unwrap().port();
            let udp = UdpSocket::bind("127.0.0.1:0").unwrap();
            let ssdp = udp.local_addr().unwrap();
            std::thread::spawn(move || {
                let mut buf = [0u8; 1500];
                while let Ok((_, from)) = udp.recv_from(&mut buf) {
                    let reply = format!(
                        "HTTP/1.1 200 OK\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\nLOCATION: http://127.0.0.1:{http_port}/desc.xml\r\n\r\n"
                    );
                    let _ = udp.send_to(reply.as_bytes(), from);
                }
            });
            let (log, errors, ip) = (calls.clone(), add_errors.clone(), external_ip.clone());
            std::thread::spawn(move || {
                for stream in http.incoming().flatten() {
                    let mut reader = BufReader::new(stream);
                    let mut request_line = String::new();
                    reader.read_line(&mut request_line).unwrap();
                    let (mut length, mut action) = (0, String::new());
                    loop {
                        let mut line = String::new();
                        reader.read_line(&mut line).unwrap();
                        if line.trim().is_empty() {
                            break;
                        }
                        let lower = line.to_ascii_lowercase();
                        if let Some(v) = lower.strip_prefix("content-length:") {
                            length = v.trim().parse().unwrap();
                        }
                        if lower.starts_with("soapaction:") {
                            action = line
                                .split('#')
                                .nth(1)
                                .unwrap_or("")
                                .trim()
                                .trim_end_matches('"')
                                .to_string();
                        }
                    }
                    let mut body = vec![0; length];
                    reader.read_exact(&mut body).unwrap();
                    let body = String::from_utf8(body).unwrap();
                    let response = if request_line.contains("/desc.xml") {
                        DESCRIPTION_XML.to_string()
                    } else if request_line.contains("/scpd.xml") {
                        SCPD.to_string()
                    } else {
                        log.lock().unwrap().push(format!("{action} {body}"));
                        let error = (action == "AddPortMapping")
                            .then(|| errors.lock().unwrap().pop_front())
                            .flatten();
                        match error {
                            Some(code) => envelope(&format!(
                                "<s:Fault><detail><UPnPError><errorCode>{code}</errorCode><errorDescription>no</errorDescription></UPnPError></detail></s:Fault>"
                            )),
                            None if action == "GetExternalIPAddress" => envelope(&format!(
                                "<u:GetExternalIPAddressResponse><NewExternalIPAddress>{}</NewExternalIPAddress></u:GetExternalIPAddressResponse>",
                                ip.lock().unwrap()
                            )),
                            None => envelope(&format!("<u:{action}Response></u:{action}Response>")),
                        }
                    };
                    let mut stream = reader.into_inner();
                    let _ = write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Type: text/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
                        response.len()
                    );
                }
            });
            FakeRouter {
                ssdp,
                calls,
                add_errors,
                external_ip,
            }
        }

        fn actions(&self) -> Vec<String> {
            self.calls
                .lock()
                .unwrap()
                .iter()
                .map(|c| c.split(' ').next().unwrap().to_string())
                .collect()
        }
    }

    /// An HTTP server answering every request with the next canned body.
    fn fake_http(replies: Vec<(u16, &'static str)>) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            let mut replies = replies.into_iter();
            for stream in listener.incoming().flatten() {
                let mut reader = BufReader::new(stream);
                let mut head = String::new();
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line.trim().is_empty() {
                        break;
                    }
                    head.push_str(&line);
                }
                log.lock().unwrap().push(head);
                let (code, body) = replies.next().unwrap_or((500, "exhausted"));
                let _ = write!(
                    reader.into_inner(),
                    "HTTP/1.1 {code} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        (url, seen)
    }

    fn reach(endpoints: Endpoints) -> (Reach, Arc<Mutex<Report>>) {
        let report = Arc::new(Mutex::new(Report::default()));
        let reach = Reach::new(
            endpoints,
            "0.0.0.0:51820".parse().unwrap(),
            51821,
            report.clone(),
        );
        (reach, report)
    }

    fn upnp_status(report: &Arc<Mutex<Report>>) -> Status {
        report.lock().unwrap().upnp.clone().expect("upnp status")
    }

    fn ddns_status(report: &Arc<Mutex<Report>>) -> Status {
        report.lock().unwrap().ddns.clone().expect("ddns status")
    }

    fn dynu() -> Dynu {
        Dynu {
            hostname: "Home.Example.net".into(),
            username: "family".into(),
            password: "secret".into(),
        }
    }

    #[test]
    fn classifies_private_and_carrier_nat_addresses() {
        for private in [
            "10.1.2.3",
            "192.168.1.1",
            "172.16.0.1",
            "100.64.0.1",
            "100.127.255.1",
            "127.0.0.1",
            "169.254.1.1",
            "0.0.0.0",
        ] {
            assert!(!is_public(private.parse().unwrap()), "{private}");
        }
        for public in ["8.8.8.8", "100.128.0.1", "100.63.255.255", "203.0.113.7"] {
            assert!(is_public(public.parse().unwrap()), "{public}");
        }
    }

    #[test]
    fn parses_address_check_pages() {
        assert_eq!(
            parse_ip("<html>Current IP Address: 198.51.100.4</html>"),
            Some("198.51.100.4".parse().unwrap())
        );
        assert_eq!(
            parse_ip("10.0.0.1 then 8.8.4.4"),
            Some("8.8.4.4".parse().unwrap())
        );
        assert_eq!(parse_ip("no address 1.2.3"), None);
    }

    #[test]
    fn interprets_dynu_replies() {
        assert!(dynu_reply("good 1.2.3.4", "h").is_ok());
        assert!(dynu_reply("nochg", "h").is_ok());
        for (reply, stop) in [
            ("badauth", true),
            ("nohost", true),
            ("notfqdn", true),
            ("abuse", true),
            ("911", false),
            ("dnserr", false),
            ("<html>weird</html>", false),
        ] {
            assert_eq!(dynu_reply(reply, "h").unwrap_err().0, stop, "{reply}");
        }
        assert!(dynu_reply("nohost", "home.example.net")
            .unwrap_err()
            .1
            .contains("home.example.net"));
    }

    #[test]
    fn report_changes_only_when_state_changes() {
        let mut report = Report::default();
        assert!(report.take_changed().is_none());
        let Report { upnp, changed, .. } = &mut report;
        Report::set(upnp, changed, status(Level::Ok, None, "a"));
        let value = report.take_changed().unwrap();
        assert_eq!(value["upnp"]["state"], "ok");
        assert!(value["ddns"].is_null());
        let Report { upnp, changed, .. } = &mut report;
        Report::set(upnp, changed, status(Level::Ok, None, "a"));
        assert!(report.take_changed().is_none());
    }

    #[test]
    fn maps_renews_and_unmaps_the_port() {
        let router = FakeRouter::start();
        let (mut reach, report) = reach(Endpoints {
            ssdp: router.ssdp,
            trusted: vec![[127, 0, 0, 1].into()],
            ..Endpoints::default()
        });
        let t0 = Instant::now();
        assert_eq!(reach.next_wake(t0), IDLE);
        reach.tick(t0);
        assert!(
            router.actions().is_empty(),
            "nothing happens before settings arrive"
        );
        reach.configure(Settings::default(), t0);
        reach.tick(t0);
        assert_eq!(router.actions(), ["AddPortMapping", "GetExternalIPAddress"]);
        let call = router.calls.lock().unwrap()[0].clone();
        assert!(
            call.contains("<NewExternalPort>51821</NewExternalPort>"),
            "{call}"
        );
        assert!(
            call.contains("<NewInternalPort>51820</NewInternalPort>"),
            "{call}"
        );
        assert!(
            call.contains("<NewInternalClient>127.0.0.1</NewInternalClient>"),
            "{call}"
        );
        assert!(
            call.contains("<NewLeaseDuration>3600</NewLeaseDuration>"),
            "{call}"
        );
        let s = upnp_status(&report);
        assert_eq!(
            (s.state, s.ip),
            (Level::Ok, Some("203.0.113.7".parse().unwrap()))
        );
        assert!(
            s.message.contains("UDP 51821 to 127.0.0.1:51820"),
            "{}",
            s.message
        );

        // Same settings again: nothing new until the renewal is due.
        reach.configure(Settings::default(), t0);
        reach.tick(t0 + Duration::from_secs(60));
        assert_eq!(router.actions().len(), 2);
        assert_eq!(reach.next_wake(t0), RENEW);
        reach.tick(t0 + RENEW);
        assert_eq!(router.actions().len(), 4);

        reach.configure(
            Settings {
                upnp: false,
                ddns: None,
            },
            t0 + RENEW,
        );
        assert_eq!(router.actions().last().unwrap(), "DeletePortMapping");
        reach.tick(t0 + RENEW);
        assert_eq!(upnp_status(&report).state, Level::Off);
    }

    #[test]
    fn falls_back_to_permanent_leases_and_warns_about_double_nat() {
        let router = FakeRouter::start();
        router.add_errors.lock().unwrap().push_back(725);
        *router.external_ip.lock().unwrap() = "100.72.1.2".into();
        let (mut reach, report) = reach(Endpoints {
            ssdp: router.ssdp,
            trusted: vec![[127, 0, 0, 1].into()],
            ..Endpoints::default()
        });
        let t0 = Instant::now();
        reach.configure(Settings::default(), t0);
        reach.tick(t0);
        let calls = router.calls.lock().unwrap().clone();
        assert!(
            calls[1].contains("<NewLeaseDuration>0</NewLeaseDuration>"),
            "{}",
            calls[1]
        );
        let s = upnp_status(&report);
        assert_eq!(s.state, Level::Warning);
        assert!(s.message.contains("carrier-grade NAT"), "{}", s.message);
        // The stop path removes the mapping too.
        reach.unmap();
        assert_eq!(router.actions().last().unwrap(), "DeletePortMapping");
    }

    #[test]
    fn explains_refused_mappings_and_retries() {
        let router = FakeRouter::start();
        router
            .add_errors
            .lock()
            .unwrap()
            .extend([718, 606, 724, 501]);
        let (mut reach, report) = reach(Endpoints {
            ssdp: router.ssdp,
            trusted: vec![[127, 0, 0, 1].into()],
            ..Endpoints::default()
        });
        let t0 = Instant::now();
        reach.configure(Settings::default(), t0);
        let mut at = t0;
        for expected in [
            "another device",
            "read-only",
            "same port",
            "refused to forward",
        ] {
            reach.tick(at);
            let s = upnp_status(&report);
            assert_eq!(s.state, Level::Error);
            assert!(s.message.contains(expected), "{}", s.message);
            assert_eq!(reach.next_wake(at), RETRY);
            at += RETRY;
        }
        reach.tick(at);
        assert_eq!(upnp_status(&report).state, Level::Ok);
    }

    #[test]
    fn reports_a_missing_router_and_skips_loopback() {
        let silent = UdpSocket::bind("127.0.0.1:0").unwrap();
        let (mut reach, report) = reach(Endpoints {
            ssdp: silent.local_addr().unwrap(),
            ..Endpoints::default()
        });
        reach.configure(Settings::default(), Instant::now());
        reach.tick(Instant::now());
        let s = upnp_status(&report);
        assert_eq!(s.state, Level::Error);
        assert!(
            s.message.contains("No UPnP router answered"),
            "{}",
            s.message
        );

        let report = Arc::new(Mutex::new(Report::default()));
        let mut local = Reach::new(
            Endpoints::default(),
            "127.0.0.1:51820".parse().unwrap(),
            51820,
            report.clone(),
        );
        local.configure(Settings::default(), Instant::now());
        local.tick(Instant::now());
        assert!(report.lock().unwrap().upnp.is_none());
    }

    #[test]
    fn updates_dynu_only_when_the_address_changes() {
        let (checkip, _) = fake_http(vec![
            (200, "Current IP Address: 198.51.100.4"),
            (200, "Current IP Address: 198.51.100.4"),
            (200, "Current IP Address: 198.51.100.9"),
        ]);
        let (dynu_url, seen) =
            fake_http(vec![(200, "good 198.51.100.4"), (200, "good 198.51.100.9")]);
        let (mut reach, report) = reach(Endpoints {
            checkip,
            dynu: dynu_url,
            ..Endpoints::default()
        });
        let t0 = Instant::now();
        reach.configure(
            Settings {
                upnp: false,
                ddns: Some(dynu()),
            },
            t0,
        );
        reach.tick(t0);
        let s = ddns_status(&report);
        assert_eq!(
            (s.state, s.ip),
            (Level::Ok, Some("198.51.100.4".parse().unwrap()))
        );
        assert_eq!(s.message, "home.example.net points to 198.51.100.4.");
        let request = seen.lock().unwrap()[0].clone();
        assert!(
            request.starts_with("GET /?hostname=home.example.net&myip=198.51.100.4 "),
            "{request}"
        );
        assert!(request.contains("Basic ZmFtaWx5OnNlY3JldA=="), "{request}");

        reach.tick(t0 + CHECK);
        assert_eq!(seen.lock().unwrap().len(), 1, "same address, no update");
        reach.tick(t0 + CHECK * 2);
        assert_eq!(seen.lock().unwrap().len(), 2);
        assert_eq!(
            ddns_status(&report).ip,
            Some("198.51.100.9".parse().unwrap())
        );

        reach.configure(
            Settings {
                upnp: false,
                ddns: None,
            },
            t0 + CHECK * 2,
        );
        reach.tick(t0 + CHECK * 2);
        assert!(report.lock().unwrap().ddns.is_none());
    }

    #[test]
    fn uses_the_router_address_and_stops_on_bad_credentials() {
        let router = FakeRouter::start();
        let (dynu_url, seen) = fake_http(vec![(401, ""), (200, "nochg")]);
        let (mut reach, report) = reach(Endpoints {
            ssdp: router.ssdp,
            trusted: vec![[127, 0, 0, 1].into()],
            checkip: "http://127.0.0.1:9/unused".into(),
            dynu: dynu_url,
        });
        let t0 = Instant::now();
        let settings = Settings {
            upnp: true,
            ddns: Some(dynu()),
        };
        reach.configure(settings.clone(), t0);
        reach.tick(t0);
        let s = ddns_status(&report);
        assert_eq!(s.state, Level::Error);
        assert!(s.message.contains("IP update password"), "{}", s.message);
        assert!(seen.lock().unwrap()[0].contains("myip=203.0.113.7"));
        reach.tick(t0 + CHECK);
        assert_eq!(seen.lock().unwrap().len(), 1, "no retries after badauth");

        // New credentials try again.
        let mut fixed = settings;
        fixed.ddns.as_mut().unwrap().password = "right".into();
        reach.configure(fixed, t0 + CHECK);
        reach.tick(t0 + CHECK);
        assert_eq!(ddns_status(&report).state, Level::Ok);
    }

    #[test]
    fn reports_unreachable_services() {
        let (mut reach, report) = reach(Endpoints {
            checkip: "http://127.0.0.1:9/".into(),
            dynu: "http://127.0.0.1:9/".into(),
            ..Endpoints::default()
        });
        let t0 = Instant::now();
        let mut bad = dynu();
        bad.hostname = "bad host".into();
        reach.configure(
            Settings {
                upnp: false,
                ddns: Some(bad),
            },
            t0,
        );
        reach.tick(t0);
        assert!(ddns_status(&report).message.contains("internet address"));

        let (checkip, _) = fake_http(vec![(200, "8.8.8.8"), (200, "8.8.8.8")]);
        reach.endpoints.checkip = checkip;
        reach.tick(t0 + CHECK);
        assert!(ddns_status(&report)
            .message
            .contains("not a valid hostname"));

        reach.configure(
            Settings {
                upnp: false,
                ddns: Some(dynu()),
            },
            t0 + CHECK,
        );
        reach.tick(t0 + CHECK);
        assert!(ddns_status(&report)
            .message
            .contains("Could not reach Dynu"));
    }

    #[test]
    fn worker_thread_applies_settings_and_stops() {
        let router = FakeRouter::start();
        let (reach, report) = reach(Endpoints {
            ssdp: router.ssdp,
            trusted: vec![[127, 0, 0, 1].into()],
            ..Endpoints::default()
        });
        let (tx, thread) = spawn(reach);
        tx.send(Command::Configure(Settings::default())).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while report.lock().unwrap().upnp.is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(upnp_status(&report).state, Level::Ok);
        tx.send(Command::Stop).unwrap();
        thread.join().unwrap();
        assert_eq!(router.actions().last().unwrap(), "DeletePortMapping");
    }
}
