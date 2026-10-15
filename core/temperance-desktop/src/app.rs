//! Desktop application state machine. Business rules live in `temperance_core`;
//! this module only handles persistence, what the UI shows, and OS tunnel tools.
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use temperance_core::{self as core, Connectivity, CoreError, Diagnostic, HttpRequest, Identity};

pub trait Transport {
    /// Sends a request to home's WireGuard port and returns (status, body): inside
    /// the tunnel while it is up, otherwise over the pinned QUIC channel.
    fn send(&self, request: &HttpRequest, through_tunnel: bool) -> Result<(u16, String), String>;
    /// Sends the plain-HTTP captive-portal probe; returns (status, Location header, body).
    fn probe(&self, request: &HttpRequest) -> Result<(u16, Option<String>, String), String>;
}

pub trait TunnelControl {
    fn up(&self, config: &Path) -> Result<(), String>;
    fn down(&self, config: &Path) -> Result<(), String>;
    fn is_up(&self) -> bool;
    /// Seconds since the last WireGuard handshake; `None` if unknown.
    fn handshake_age(&self) -> Option<u64>;
}

/// A running parent session's loopback proxy (`core::remote::RemoteSession`).
pub trait Remote: Send {
    fn url(&self) -> String;
    fn stop(&self);
}

impl Remote for std::sync::Arc<core::remote::RemoteSession> {
    fn url(&self) -> String {
        core::remote::RemoteSession::url(self)
    }
    fn stop(&self) {
        core::remote::RemoteSession::stop(self)
    }
}

type Pairing = Box<dyn Fn(&str, &str) -> Result<String, String> + Send>;
type Starting = Box<dyn Fn(&str) -> Result<Box<dyn Remote>, String> + Send>;
pub type Opening = Box<dyn Fn(&str) -> Result<(), String> + Send>;

/// How a parent's computer reaches home; replaced in tests.
pub struct ParentMode {
    pub pair: Pairing,
    pub start: Starting,
}

impl ParentMode {
    pub fn system() -> Self {
        ParentMode {
            pair: Box::new(|link, name| {
                core::remote::pair_parent(link.into(), name.into()).map_err(|e| e.to_string())
            }),
            start: Box::new(|identity| {
                core::remote::RemoteSession::start(identity.into())
                    .map(|s| Box::new(s) as Box<dyn Remote>)
                    .map_err(|e| e.to_string())
            }),
        }
    }
}

/// Opens a page in the default browser.
pub fn open_browser(url: &str) -> Result<(), String> {
    let mut command = if cfg!(windows) {
        let mut c = std::process::Command::new("rundll32");
        c.arg("url.dll,FileProtocolHandler");
        c
    } else if cfg!(target_os = "macos") {
        std::process::Command::new("open")
    } else {
        std::process::Command::new("xdg-open")
    };
    command
        .arg(url)
        .spawn()
        .map(drop)
        .map_err(|e| format!("Can't open the browser: {e}"))
}

/// What the UI asks for. Each action leaves a status line for the next view.
#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum Action {
    Enroll {
        service: String,
        username: String,
        password: String,
        name: String,
    },
    Connect,
    Refresh,
    SignIn,
    OpenPortal,
    RequestTime {
        minutes: u32,
        #[serde(default)]
        message: String,
    },
    PairParent {
        link: String,
        name: String,
    },
    OpenDashboard,
    UnpairParent,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Issue {
    pub code: String,
    pub message: String,
    pub action: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Child {
    pub headline: String,
    pub detail: String,
    /// "55 min left today" or "No daily limit"; empty when the status is unavailable.
    pub remaining: String,
    pub next_change: String,
    pub version: u64,
    pub connected: bool,
    pub alerts: Vec<String>,
    pub health: Vec<Issue>,
    /// The Wi-Fi network's sign-in page, while one blocks the internet.
    pub portal_url: Option<String>,
    pub can_sign_in: bool,
    pub can_ask: bool,
    pub pending: bool,
}

/// Everything the UI shows; it renders this and nothing else.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "screen", rename_all = "snake_case")]
pub enum Screen {
    /// First run: a client's computer (where the VPN is supported) or an admin's.
    Choose {
        child_allowed: bool,
    },
    Child(Child),
    Parent {
        household: String,
        host: String,
    },
    ParentBroken {
        error: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct View {
    pub status: String,
    #[serde(flatten)]
    pub screen: Screen,
}

pub const UNREACHABLE: &str =
    "Can't reach your family's Temperance right now. The last rules stay in effect.";

pub const REQUEST_SENT: &str = "Request sent to your admins.";

pub const DASHBOARD_OPENED: &str = "The family dashboard opened in its own window.";

pub const CHILD_UNSUPPORTED: &str = "Only Windows computers install the family VPN. Protect this computer as a home-network device behind your gateway instead.";

pub struct App<T: Transport, W: TunnelControl> {
    pub dir: PathBuf,
    pub status: String,
    /// Whether this OS can install the family VPN (Windows only).
    pub child_allowed: bool,
    /// Opens outside pages such as a Wi-Fi sign-in page; replaced in tests.
    pub browser: Opening,
    pub identity: Option<Identity>,
    pub connected: bool,
    /// Recent child alerts, newest first, shown in the local UI.
    pub alerts: Vec<String>,
    pub diagnostics: Vec<Diagnostic>,
    /// Deadline while the tunnel is lowered for a Wi-Fi sign-in page.
    pub portal_until: Option<i64>,
    portal_ended: Option<i64>,
    connectivity: Option<Connectivity>,
    policy_reachable: bool,
    reported: Option<Vec<String>>,
    transport: T,
    tunnel: W,
    /// A parent's pairing (`parent.json`): this computer opens the family dashboard instead.
    pub parent: Option<String>,
    pub parent_mode: ParentMode,
    remote: Option<Box<dyn Remote>>,
    /// The dashboard address for the shell to open in its own window.
    pub dashboard: Option<String>,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

impl<T: Transport, W: TunnelControl> App<T, W> {
    pub fn new(dir: PathBuf, transport: T, tunnel: W) -> Result<Self, String> {
        let parent = fs::read_to_string(parent_file(&dir)).ok();
        let identity = match fs::read_to_string(dir.join("identity.json")) {
            Ok(text) => Some(core::identity_from_json(text).map_err(|e| e.to_string())?),
            Err(_) => None,
        };
        // The tunnel service outlives the app; a running one is ours.
        let connected = identity.is_some() && tunnel.is_up();
        Ok(App {
            dir,
            status: String::new(),
            child_allowed: cfg!(windows),
            browser: Box::new(open_browser),
            identity,
            connected,
            alerts: vec![],
            diagnostics: vec![],
            portal_until: None,
            portal_ended: None,
            connectivity: None,
            policy_reachable: true,
            reported: None,
            transport,
            tunnel,
            parent,
            parent_mode: ParentMode::system(),
            remote: None,
            dashboard: None,
        })
    }

    /// Pairs this computer as an admin's, using the link under Devices → Admin devices.
    pub fn pair_parent(&mut self, link: &str, name: &str) -> Result<(), String> {
        if self.identity.as_ref().is_some_and(|i| i.state.is_some()) {
            return Err("This computer is enrolled as a client's device.".into());
        }
        let link = link.trim();
        core::remote::parse_pairing_link(link.into()).map_err(|e| e.to_string())?;
        let identity = (self.parent_mode.pair)(link, name.trim())?;
        fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        write_private(&parent_file(&self.dir), &identity).map_err(|e| e.to_string())?;
        self.parent = Some(identity);
        self.open_dashboard()
    }

    /// Starts the local proxy once, then asks the shell to show the dashboard.
    pub fn open_dashboard(&mut self) -> Result<(), String> {
        let identity = self.parent.clone().ok_or("Pair this computer first")?;
        if self.remote.is_none() {
            self.remote = Some((self.parent_mode.start)(&identity)?);
        }
        self.dashboard = Some(self.remote.as_ref().expect("started").url());
        Ok(())
    }

    pub fn unpair_parent(&mut self) -> Result<(), String> {
        if let Some(remote) = self.remote.take() {
            remote.stop();
        }
        self.parent = None;
        match fs::remove_file(parent_file(&self.dir)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }

    fn update_diagnostics(&mut self) {
        let facts = core::DeviceFacts {
            vpn_permission: None,
            tunnel_up: self.tunnel.is_up(),
            seconds_since_handshake: self.tunnel.handshake_age(),
            connectivity: self.connectivity.clone(),
            policy_reachable: self.policy_reachable,
            notifications_allowed: None,
            location_allowed: None,
            portal_sign_in_until: self.portal_until.or(self.portal_ended),
        };
        self.diagnostics = core::diagnose(facts, now());
    }

    /// Sends diagnostics to admins when the set of issues changes; failures retry next refresh.
    fn report_diagnostics(&mut self) {
        let codes: Vec<String> = self.diagnostics.iter().map(|d| d.code.clone()).collect();
        if self.reported.as_ref() == Some(&codes) {
            return;
        }
        let Some(identity) = self.identity.clone() else {
            return;
        };
        let Ok(request) = core::diagnostics_request(identity, self.diagnostics.clone()) else {
            return;
        };
        if let Ok((status, body)) = self.transport.send(&request, self.tunnel.is_up()) {
            if core::parse_ok(status, body).is_ok() {
                self.reported = Some(codes);
            }
        }
    }

    fn probe(&mut self) {
        let (status, location, body) = self
            .transport
            .probe(&core::captive_portal_probe())
            .unwrap_or((0, None, String::new()));
        self.connectivity = Some(core::parse_captive_portal_probe(status, location, body));
    }

    /// Lowers the tunnel so a Wi-Fi sign-in page can load. Only allowed when the
    /// tunnel cannot reach the gateway, and never for longer than the core's limit.
    pub fn sign_in_to_network(&mut self) -> Result<(), String> {
        if self.portal_until.is_some() {
            return Ok(());
        }
        let stale = self.tunnel.is_up()
            && self
                .tunnel
                .handshake_age()
                .is_some_and(|age| age > core::diagnostics::STALE_HANDSHAKE_SECONDS);
        if !stale {
            return Err(
                "This network is working through the VPN; no Wi-Fi sign-in is needed.".into(),
            );
        }
        self.tunnel.down(&self.dir.join("temperance.conf"))?;
        self.portal_until = Some(now() + core::PORTAL_SIGN_IN_SECONDS);
        self.check_portal()
    }

    /// While signing in, restores the tunnel once the network is online or time is up.
    pub fn check_portal(&mut self) -> Result<(), String> {
        let Some(until) = self.portal_until else {
            return Ok(());
        };
        if until > now() {
            self.probe();
            if self.connectivity != Some(Connectivity::Online) {
                self.update_diagnostics();
                return Ok(());
            }
        }
        self.portal_until = None;
        self.portal_ended = Some(now().min(until));
        self.connectivity = None;
        let restored = if self.tunnel.is_up() {
            Ok(())
        } else {
            self.tunnel.up(&self.dir.join("temperance.conf"))
        };
        self.update_diagnostics();
        restored
    }

    fn call(&self, request: HttpRequest) -> Result<(u16, String), CoreError> {
        self.transport
            .send(&request, self.tunnel.is_up())
            .map_err(|e| CoreError::Invalid { detail: e })
    }

    fn save(&self) -> Result<(), String> {
        let identity = self.identity.as_ref().ok_or("Enroll first")?;
        let state = identity.state.as_ref().ok_or("Enroll first")?;
        let conf = core::tunnel_config(identity.private_key.clone(), state.tunnel.clone())
            .map_err(|e| e.to_string())?;
        fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        for (name, body) in [
            ("identity.json", core::identity_to_json(identity.clone())),
            ("temperance.conf", conf),
        ] {
            write_private(&self.dir.join(name), &body).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn enroll(
        &mut self,
        service: &str,
        username: &str,
        password: &str,
        name: &str,
    ) -> Result<(), String> {
        if !self.child_allowed {
            return Err(CHILD_UNSUPPORTED.into());
        }
        if self.identity.as_ref().is_some_and(|i| i.state.is_some()) {
            return Err("Already enrolled".into());
        }
        if self.parent.is_some() {
            return Err("This computer is paired as an admin device. Unpair it first.".into());
        }
        let service = core::validate_service(service.into()).map_err(|e| e.to_string())?;
        let keys = core::generate_keypair();
        let request = core::sign_in_request(
            service.clone(),
            username.into(),
            password.into(),
            name.into(),
            keys.public_key.clone(),
        )
        .map_err(|e| e.to_string())?;
        let (status, body) = self.call(request).map_err(|e| e.to_string())?;
        self.identity =
            Some(core::enrolled_identity(service, keys, status, body).map_err(|e| e.to_string())?);
        self.save()
    }

    pub fn refresh(&mut self) -> Result<(), String> {
        let identity = self.identity.clone().ok_or("Enroll first")?;
        let reply = self.call(core::state_request(identity.clone()).map_err(|e| e.to_string())?);
        self.policy_reachable = reply.is_ok();
        self.update_diagnostics();
        let (status, body) = reply.map_err(|e| e.to_string())?;
        let latest = core::parse_device_state(status, body).map_err(|e| e.to_string())?;
        let alerts = core::child_alerts(identity.state.clone(), latest.clone(), now());
        let location_requested = latest.location_requested;
        self.identity = Some(
            core::refreshed_identity(identity, latest, self.connected)
                .map_err(|e| e.to_string())?,
        );
        self.save()?;
        for alert in alerts.into_iter().rev() {
            self.alerts.insert(0, alert);
        }
        self.alerts.truncate(5);
        if location_requested {
            self.decline_location()?;
        }
        self.report_diagnostics();
        Ok(())
    }

    /// The periodic refresh. Losing the service leaves a plain note that clears
    /// once it answers again, and "Request sent" clears once an admin answers.
    pub fn background_refresh(&mut self) {
        match self.refresh() {
            Err(_) if !self.policy_reachable => self.status = UNREACHABLE.into(),
            Err(e) => self.status = e,
            Ok(()) if self.status == UNREACHABLE => self.status = self.settled_status(),
            Ok(()) if self.status == REQUEST_SENT && !self.request_pending() => {
                self.status = self.settled_status()
            }
            Ok(()) => {}
        }
    }

    fn request_pending(&self) -> bool {
        self.identity
            .as_ref()
            .and_then(|i| i.state.clone())
            .and_then(|state| core::child_status(state, now()).ok())
            .is_some_and(|c| c.pending_request)
    }

    /// Desktop computers have no trustworthy location source; tell the parent.
    fn decline_location(&mut self) -> Result<(), String> {
        let identity = self.identity.clone().ok_or("Enroll first")?;
        let request = core::location_unavailable_request(
            identity,
            "this computer cannot share its location".into(),
        )
        .map_err(|e| e.to_string())?;
        let (status, body) = self.call(request).map_err(|e| e.to_string())?;
        core::parse_ok(status, body).map_err(|e| e.to_string())
    }

    pub fn connect(&mut self) -> Result<(), String> {
        self.refresh()?;
        self.protect()?;
        self.report_diagnostics();
        Ok(())
    }

    /// Raises the tunnel with the policy already saved; the elevated app needs no OS prompt.
    fn protect(&mut self) -> Result<(), String> {
        if !self.tunnel.is_up() {
            self.tunnel.up(&self.dir.join("temperance.conf"))?;
        }
        self.connected = true;
        self.update_diagnostics();
        Ok(())
    }

    pub fn ask_for_time(&mut self, minutes: u32, message: &str) -> Result<(), String> {
        let identity = self.identity.clone().ok_or("Enroll first")?;
        let request =
            core::time_request(identity, minutes, message.into()).map_err(|e| e.to_string())?;
        let (status, body) = self.call(request).map_err(|e| e.to_string())?;
        core::parse_time_request(status, body).map_err(|e| e.to_string())?;
        self.refresh()
    }

    pub fn act(&mut self, action: Action) {
        let done = match &action {
            Action::RequestTime { .. } => Some(REQUEST_SENT),
            Action::UnpairParent => Some("This computer no longer opens the family dashboard."),
            Action::OpenPortal => Some("The Wi-Fi sign-in page opened in your browser."),
            _ => None,
        };
        let refreshing = matches!(action, Action::Refresh);
        let result = match action {
            Action::Enroll {
                service,
                username,
                password,
                name,
            } => self
                .enroll(&service, &username, &password, &name)
                .and_then(|()| self.protect()),
            Action::Connect => self.connect(),
            Action::Refresh => self.refresh(),
            Action::SignIn => self.sign_in_to_network(),
            Action::OpenPortal => self.open_portal(),
            Action::RequestTime { minutes, message } => self.ask_for_time(minutes, &message),
            Action::PairParent { link, name } => self.pair_parent(&link, &name),
            Action::OpenDashboard => self.open_dashboard(),
            Action::UnpairParent => self.unpair_parent(),
        };
        self.status = match result {
            Ok(()) => done.map_or_else(|| self.settled_status(), str::to_string),
            Err(_) if refreshing && !self.policy_reachable => UNREACHABLE.into(),
            Err(e) => e,
        };
    }

    /// Once the dashboard window is closed, saying it opened is stale.
    pub fn dashboard_closed(&mut self) {
        if self.status == DASHBOARD_OPENED {
            self.status.clear();
        }
    }

    /// The status after a successful action: what is true now.
    fn settled_status(&self) -> String {
        if self.parent.is_some() {
            DASHBOARD_OPENED.into()
        } else if self.portal_until.is_some() {
            "Protection is paused while you sign in to this Wi-Fi.".into()
        } else if self.connected {
            "Protected. Your family's rules apply on this computer.".into()
        } else {
            "Signed in. Start protection to apply your family's rules.".into()
        }
    }

    fn open_portal(&mut self) -> Result<(), String> {
        match &self.connectivity {
            Some(Connectivity::CaptivePortal {
                login_url: Some(url),
            }) => (self.browser)(url),
            _ => Err("This Wi-Fi network has no sign-in page to open.".into()),
        }
    }

    fn health(&self) -> Vec<Issue> {
        self.diagnostics
            .iter()
            .map(|d| Issue {
                code: d.code.clone(),
                message: d.message.clone(),
                action: d.action.clone(),
            })
            .collect()
    }

    fn child(&self, state: core::DeviceState) -> Child {
        let version = state.version;
        let (headline, detail, next_change, remaining, can_ask, pending) =
            match core::child_status(state, now()) {
                Ok(c) => (
                    c.headline,
                    c.detail,
                    c.next_change.unwrap_or_default(),
                    c.remaining_minutes
                        .map(|m| format!("{m} min left today"))
                        .unwrap_or_else(|| "No daily limit".into()),
                    c.can_request_time,
                    c.pending_request,
                ),
                Err(e) => (
                    "Status unavailable".into(),
                    e.to_string(),
                    String::new(),
                    String::new(),
                    false,
                    false,
                ),
            };
        let portal_url = match &self.connectivity {
            Some(Connectivity::CaptivePortal { login_url }) => login_url.clone(),
            _ => None,
        };
        Child {
            headline,
            detail,
            remaining,
            next_change,
            version,
            connected: self.connected,
            alerts: self.alerts.clone(),
            health: self.health(),
            portal_url,
            can_sign_in: self.portal_until.is_none()
                && self
                    .diagnostics
                    .iter()
                    .any(|d| d.code == "gateway_unreachable" || d.code == "captive_portal"),
            can_ask,
            pending,
        }
    }

    pub fn view(&self) -> View {
        let screen = match self.identity.as_ref().and_then(|i| i.state.clone()) {
            Some(state) => Screen::Child(self.child(state)),
            None => match self
                .parent
                .clone()
                .map(core::remote::describe_parent_identity)
            {
                Some(Ok(p)) => Screen::Parent {
                    household: p.household,
                    host: p.host,
                },
                Some(Err(e)) => Screen::ParentBroken {
                    error: e.to_string(),
                },
                None => Screen::Choose {
                    child_allowed: self.child_allowed,
                },
            },
        };
        View {
            status: self.status.clone(),
            screen,
        }
    }
}

fn parent_file(dir: &Path) -> PathBuf {
    dir.join("parent.json")
}

pub fn write_private(path: &Path, body: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        file.write_all(body.as_bytes())?;
        file.sync_all()?;
    }
    #[cfg(not(unix))]
    fs::write(&tmp, body)?;
    // Windows rename does not replace existing files.
    if cfg!(windows) && path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(tmp, path)
}
