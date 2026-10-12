//! Desktop application state machine. Business rules live in `temperance_core`;
//! this module only handles persistence, the localhost UI, and OS tunnel tools.
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use temperance_core::{self as core, Connectivity, CoreError, Diagnostic, HttpRequest, Identity};

pub trait Transport {
    /// Executes a request and returns (status, body). Redirects must not be followed.
    fn send(&self, request: &HttpRequest) -> Result<(u16, String), String>;
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

pub struct App<T: Transport, W: TunnelControl> {
    pub dir: PathBuf,
    pub nonce: String,
    pub status: String,
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
}

pub struct Response {
    pub status: u16,
    pub content_type: &'static str,
    pub location: Option<String>,
    pub body: String,
}

impl Response {
    fn redirect() -> Self {
        Response {
            status: 303,
            content_type: "text/plain",
            location: Some("/".into()),
            body: String::new(),
        }
    }
    fn text(status: u16, body: &str) -> Self {
        Response {
            status,
            content_type: "text/plain; charset=utf-8",
            location: None,
            body: body.into(),
        }
    }
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

pub fn form_value(body: &str, key: &str) -> String {
    url::form_urlencoded::parse(body.as_bytes())
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
        .unwrap_or_default()
}

impl<T: Transport, W: TunnelControl> App<T, W> {
    pub fn new(dir: PathBuf, nonce: String, transport: T, tunnel: W) -> Result<Self, String> {
        let identity = match fs::read_to_string(dir.join("identity.json")) {
            Ok(text) => Some(core::identity_from_json(text).map_err(|e| e.to_string())?),
            Err(_) => None,
        };
        Ok(App {
            dir,
            nonce,
            status: "Enroll to install your family's VPN.".into(),
            identity,
            connected: false,
            alerts: vec![],
            diagnostics: vec![],
            portal_until: None,
            portal_ended: None,
            connectivity: None,
            policy_reachable: true,
            reported: None,
            transport,
            tunnel,
        })
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

    /// Sends diagnostics to parents when the set of issues changes; failures retry next refresh.
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
        if let Ok((status, body)) = self.transport.send(&request) {
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
            .send(&request)
            .map_err(|e| CoreError::Invalid {
                detail: format!("Cannot reach policy service: {e}"),
            })
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
        if self.identity.as_ref().is_some_and(|i| i.state.is_some()) {
            return Err("Already enrolled".into());
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
        if !self.tunnel.is_up() {
            self.tunnel.up(&self.dir.join("temperance.conf"))?;
        }
        self.connected = true;
        self.update_diagnostics();
        self.report_diagnostics();
        Ok(())
    }

    pub fn ask_for_time(&mut self, minutes: &str, message: &str) -> Result<(), String> {
        let identity = self.identity.clone().ok_or("Enroll first")?;
        let minutes: u32 = minutes.parse().map_err(|_| "Choose how many minutes")?;
        let request =
            core::time_request(identity, minutes, message.into()).map_err(|e| e.to_string())?;
        let (status, body) = self.call(request).map_err(|e| e.to_string())?;
        core::parse_time_request(status, body).map_err(|e| e.to_string())?;
        self.refresh()
    }

    pub fn handle(
        &mut self,
        method: &str,
        path: &str,
        host: &str,
        expected_host: &str,
        origin: Option<&str>,
        body: &str,
    ) -> Response {
        if host != expected_host {
            return Response::text(403, "Use the local application URL");
        }
        if method == "POST" {
            if body.len() > 8192
                || form_value(body, "nonce") != self.nonce
                || origin != Some(&format!("http://{host}"))
            {
                return Response::text(403, "Invalid origin");
            }
            let result = match path {
                "/enroll" => self.enroll(
                    &form_value(body, "service"),
                    &form_value(body, "username"),
                    &form_value(body, "password"),
                    &form_value(body, "name"),
                ),
                "/connect" => self.connect(),
                "/refresh" => self.refresh(),
                "/sign-in" => self.sign_in_to_network(),
                "/request" => {
                    self.ask_for_time(&form_value(body, "minutes"), &form_value(body, "message"))
                }
                _ => return Response::text(404, "Not found"),
            };
            self.status = match result {
                Ok(()) if path == "/request" => "Request sent to your parents.".into(),
                Ok(()) if path == "/sign-in" && self.portal_until.is_some() => {
                    "Protection is paused while you sign in to this Wi-Fi.".into()
                }
                Ok(()) if path == "/sign-in" => {
                    "This network is online; protection is back on.".into()
                }
                Ok(()) => "Ready. Rules are enforced by your family's gateway.".into(),
                Err(e) => e,
            };
            return Response::redirect();
        }
        if path != "/" {
            return Response::text(404, "Not found");
        }
        Response {
            status: 200,
            content_type: "text/html; charset=utf-8",
            location: None,
            body: self.render(),
        }
    }

    fn health(&self, hidden: &str) -> String {
        let items: String = self
            .diagnostics
            .iter()
            .map(|d| {
                format!(
                    "<li><strong>{}</strong> {}</li>",
                    escape(&d.message),
                    escape(&d.action)
                )
            })
            .collect();
        let mut html = if items.is_empty() {
            String::new()
        } else {
            format!(r#"<ul aria-label="Device health">{items}</ul>"#)
        };
        if let Some(Connectivity::CaptivePortal {
            login_url: Some(url),
        }) = &self.connectivity
        {
            html += &format!(
                r#"<p><a href="{0}" target="_blank" rel="noreferrer">Open the Wi-Fi sign-in page</a></p>"#,
                escape(url)
            );
        }
        let can_sign_in = self.portal_until.is_none()
            && self
                .diagnostics
                .iter()
                .any(|d| d.code == "gateway_unreachable" || d.code == "captive_portal");
        if can_sign_in {
            html += &format!(
                r#"<form method="post" action="/sign-in">{hidden}<button class="secondary">Sign in to Wi-Fi</button></form>"#
            );
        }
        html
    }

    pub fn render(&self) -> String {
        let nonce = escape(&self.nonce);
        let hidden = format!(r#"<input type="hidden" name="nonce" value="{nonce}">"#);
        let content = match self.identity.as_ref().and_then(|i| i.state.clone()) {
            Some(state) => {
                let version = state.version;
                let child = core::child_status(state, now());
                let (headline, detail, next, remaining, can_ask, pending) = match child {
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
                let alerts: String = self
                    .alerts
                    .iter()
                    .map(|a| format!("<li>{}</li>", escape(a)))
                    .collect();
                let alerts = if alerts.is_empty() {
                    String::new()
                } else {
                    format!(r#"<ul aria-label="Alerts">{alerts}</ul>"#)
                };
                let health = self.health(&hidden);
                format!(
                    r#"<h2>{}</h2><p>{}</p>{alerts}{health}<p class="meta">{} · {} · Policy {version} · VPN {}</p>
<form method="post" action="/connect">{hidden}<button>Install / start VPN</button></form>
<form method="post" action="/refresh">{hidden}<button class="secondary">Refresh policy</button></form>
{}"#,
                    escape(&headline),
                    escape(&detail),
                    escape(&remaining),
                    escape(&next),
                    if self.connected {
                        "connected"
                    } else {
                        "not started"
                    },
                    if pending {
                        "<p>Your request for more time is waiting for a parent.</p>".to_string()
                    } else if can_ask {
                        format!(
                            r#"<form method="post" action="/request">{hidden}<label>Ask for more time<select name="minutes"><option>15</option><option>30</option><option>60</option></select></label><label>Message<input name="message" maxlength="300"></label><button class="secondary">Send request</button></form>"#
                        )
                    } else {
                        String::new()
                    }
                )
            }
            None => format!(
                r#"<form method="post" action="/enroll">{hidden}<label>Policy service<input name="service" type="url" placeholder="https://policy.example.com" required></label><label>Username<input name="username" required autocomplete="username"></label><label>Password<input name="password" type="password" required autocomplete="current-password"></label><label>Device name<input name="name" required maxlength="80"></label><button>Enroll this device</button></form>"#
            ),
        };
        format!(
            r#"<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Temperance</title>
<style>body{{font:16px system-ui;background:#eef3ed;color:#254436;max-width:650px;margin:40px auto;padding:20px;box-sizing:border-box}}h1{{font:42px Georgia}}label{{display:block}}input,select,button{{font:inherit;padding:12px;box-sizing:border-box;border:1px solid #cbd9cc;border-radius:8px;max-width:100%}}input,select{{width:100%;margin:7px 0 16px}}button{{background:#26715d;color:#fff;cursor:pointer;margin:4px 0}}button.secondary{{background:#fff;color:#26715d}}section{{background:#fff;padding:24px;border-radius:12px;overflow-wrap:anywhere}}.meta{{color:#587064;font-size:14px}}</style>
<h1>Temperance</h1><p role="status">{}</p><section>{content}</section>
<p>Rules are enforced at your family's VPN gateway. Administrator rights are needed to install the tunnel.</p></html>"#,
            escape(&self.status)
        )
    }
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
