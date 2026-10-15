use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Arc, Mutex};

use temperance_core::HttpRequest;

use crate::app::{write_private, Action, App, Child, Screen, Transport, TunnelControl, View};

const SERVER_KEY: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
/// The dashboard's setup code for family.example:51820.
const HOME: &str = "temperance://home#eyJ2IjoxLCJob3N0IjoiZmFtaWx5LmV4YW1wbGUiLCJwb3J0Ijo1MTgyMCwicGluIjoiQUFFQ0F3UUZCZ2NJQ1FvTERBME9EeEFSRWhNVUZSWVhHQmthR3h3ZEhoOCIsImhvdXNlaG9sZCI6IlRoZSBSaXZlcmFzIn0";

type Shared<T> = Arc<Mutex<T>>;

#[derive(Clone, Default)]
struct Fake {
    replies: Shared<VecDeque<Result<(u16, String), String>>>,
    probes: Shared<VecDeque<(u16, Option<String>, String)>>,
    sent: Shared<Vec<HttpRequest>>,
    /// Whether each request was sent through the tunnel.
    tunneled: Shared<Vec<bool>>,
}
impl Fake {
    fn reply(&self, reply: Result<(u16, String), String>) {
        self.replies.lock().unwrap().push_back(reply);
    }
    fn ok(&self, version: u32) {
        self.reply(Ok((200, state(version, "allowed", ""))));
    }
    fn probe_reply(&self, status: u16, location: Option<&str>, body: &str) {
        self.probes
            .lock()
            .unwrap()
            .push_back((status, location.map(Into::into), body.into()));
    }
    fn sent(&self) -> Vec<HttpRequest> {
        self.sent.lock().unwrap().clone()
    }
}
impl Transport for Fake {
    fn send(&self, request: &HttpRequest, through_tunnel: bool) -> Result<(u16, String), String> {
        self.sent.lock().unwrap().push(request.clone());
        self.tunneled.lock().unwrap().push(through_tunnel);
        self.replies
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Err("no reply".into()))
    }
    fn probe(&self, request: &HttpRequest) -> Result<(u16, Option<String>, String), String> {
        assert!(request.url.starts_with("http://"));
        self.probes
            .lock()
            .unwrap()
            .pop_front()
            .ok_or_else(|| "timed out".into())
    }
}

#[derive(Clone, Default)]
struct FakeTunnel {
    up: Shared<bool>,
    age: Shared<Option<u64>>,
    downs: Shared<u32>,
    fail: bool,
}
impl FakeTunnel {
    fn is(&self) -> bool {
        *self.up.lock().unwrap()
    }
    fn set_age(&self, age: Option<u64>) {
        *self.age.lock().unwrap() = age;
    }
}
impl TunnelControl for FakeTunnel {
    fn up(&self, config: &Path) -> Result<(), String> {
        assert!(config.ends_with("temperance.conf"));
        if self.fail {
            return Err("WireGuard: denied".into());
        }
        *self.up.lock().unwrap() = true;
        Ok(())
    }
    fn down(&self, config: &Path) -> Result<(), String> {
        assert!(config.ends_with("temperance.conf"));
        *self.downs.lock().unwrap() += 1;
        *self.up.lock().unwrap() = false;
        Ok(())
    }
    fn is_up(&self) -> bool {
        self.is()
    }
    fn handshake_age(&self) -> Option<u64> {
        *self.age.lock().unwrap()
    }
}

fn state(version: u32, reason: &str, requests: &str) -> String {
    format!(
        r#"{{"token":"tok","device_id":"dev","version":{version},"policy":{{"name":"Alex","limit":60,"used":5,"timezone":"UTC"}},
        "tunnel":{{"address":"10.77.0.2/32","address_v6":"fd77::2/128","dns":"10.77.0.1","endpoint":"192.0.2.1:51820","public_key":"{SERVER_KEY}"}},
        "status":{{"reason":"{reason}","remaining_minutes":55}},"requests":[{requests}]}}"#
    )
}

type TestApp = App<Fake, FakeTunnel>;

fn app() -> (TestApp, Fake, FakeTunnel, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::default();
    let tunnel = FakeTunnel::default();
    let mut app = App::new(dir.path().join("data"), fake.clone(), tunnel.clone()).unwrap();
    app.child_allowed = true;
    (app, fake, tunnel, dir)
}

fn enroll(service: &str) -> Action {
    Action::Enroll {
        service: service.into(),
        username: "alex".into(),
        password: "user-password".into(),
        name: "Laptop".into(),
    }
}

fn child(app: &TestApp) -> Child {
    match app.view().screen {
        Screen::Child(child) => child,
        other => panic!("not a child view: {other:?}"),
    }
}

fn issues(app: &TestApp) -> Vec<String> {
    child(app).health.into_iter().map(|i| i.message).collect()
}

fn enrolled() -> (TestApp, Fake, FakeTunnel, tempfile::TempDir) {
    let (mut app, fake, tunnel, dir) = app();
    fake.ok(1);
    app.act(enroll(HOME));
    (app, fake, tunnel, dir)
}

fn reports(fake: &Fake) -> Vec<serde_json::Value> {
    fake.sent()
        .iter()
        .filter(|r| r.url.ends_with("/v1/device/diagnostics"))
        .map(|r| serde_json::from_str(r.body.as_deref().unwrap()).unwrap())
        .collect()
}

#[test]
fn enrolls_connects_refreshes_and_requests_time() {
    let (mut app, fake, tunnel, dir) = app();
    assert_eq!(
        app.view(),
        View {
            status: String::new(),
            screen: Screen::Choose {
                child_allowed: true
            }
        }
    );
    fake.ok(1);
    app.act(enroll(HOME));
    // Signing in starts protection: the elevated app needs no OS prompt.
    assert_eq!(
        app.status,
        "Protected. Your family's rules apply on this computer."
    );
    assert!(tunnel.is());
    assert_eq!(fake.sent().len(), 1);
    let sent = fake.sent()[0].clone();
    assert_eq!(
        sent.url,
        "temperance://AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8@family.example:51820/v1/device/login"
    );
    // Signing in happens before there is a tunnel; later requests go through it.
    assert!(!fake.tunneled.lock().unwrap()[0]);
    assert!(!sent.body.unwrap().contains("private"));

    let conf = std::fs::read_to_string(dir.path().join("data/temperance.conf")).unwrap();
    assert!(conf.contains("AllowedIPs = 0.0.0.0/0, ::/0"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(dir.path().join("data/identity.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    let shown = child(&app);
    assert_eq!(shown.headline, "You're online");
    assert_eq!(shown.remaining, "55 min left today");
    assert!(shown.can_ask && !shown.pending && shown.connected);
    assert!(shown.health.is_empty());
    assert_eq!(shown.version, 1);

    // The tunnel service stopped; Start protection brings it back.
    *tunnel.up.lock().unwrap() = false;
    fake.ok(2);
    app.act(Action::Connect);
    assert!(tunnel.is());
    assert!(child(&app).connected);
    assert_eq!(
        app.status,
        "Protected. Your family's rules apply on this computer."
    );
    assert_eq!(fake.tunneled.lock().unwrap().last(), Some(&true));

    fake.reply(Ok((
        200,
        r#"{"id":"r","minutes":15,"message":"","status":"pending","at":1}"#.into(),
    )));
    fake.reply(Ok((
        200,
        state(
            3,
            "daily limit",
            r#"{"id":"r","minutes":15,"status":"pending","at":1}"#,
        ),
    )));
    app.act(Action::RequestTime {
        minutes: 15,
        message: "homework".into(),
    });
    assert_eq!(app.status, "Request sent to your admins.");
    assert!(child(&app).pending);

    fake.reply(Ok((401, r#"{"error":"Invalid or revoked device"}"#.into())));
    app.act(Action::Refresh);
    assert_eq!(app.status, "Invalid or revoked device");

    // A restarted app finds the identity, and the tunnel service still running.
    let reloaded = App::new(dir.path().join("data"), Fake::default(), tunnel.clone()).unwrap();
    assert_eq!(reloaded.identity.clone().unwrap().state.unwrap().version, 3);
    assert!(reloaded.connected);
}

#[test]
fn rejects_bad_input_and_actions_out_of_order() {
    let (mut app, fake, _tunnel, _dir) = app();
    app.act(enroll("https://family.example"));
    assert!(app.status.starts_with("Scan or paste the setup code"));
    app.act(Action::Connect);
    assert_eq!(app.status, "Enroll first");
    app.act(Action::RequestTime {
        minutes: 15,
        message: String::new(),
    });
    assert_eq!(app.status, "Enroll first");
    app.act(Action::OpenPortal);
    assert_eq!(
        app.status,
        "This Wi-Fi network has no sign-in page to open."
    );
    fake.reply(Err("timeout".into()));
    app.act(enroll(HOME));
    assert_eq!(app.status, "timeout");
    assert!(app.identity.is_none());

    fake.ok(1);
    app.act(enroll(HOME));
    app.act(enroll(HOME));
    assert_eq!(app.status, "Already enrolled");

    // The UI sends actions as JSON; anything else is refused before it reaches the app.
    let parse = |json: &str| serde_json::from_str::<Action>(json);
    assert!(matches!(
        parse(r#"{"action":"request_time","minutes":30}"#).unwrap(),
        Action::RequestTime { minutes: 30, .. }
    ));
    assert!(parse(r#"{"action":"request_time","minutes":"lots"}"#).is_err());
    assert!(parse(r#"{"action":"format_disk"}"#).is_err());
}

#[test]
fn only_windows_installs_the_vpn() {
    let (mut app, fake, _tunnel, _dir) = app();
    app.child_allowed = false;
    assert_eq!(
        app.view().screen,
        Screen::Choose {
            child_allowed: false
        }
    );
    app.act(enroll(HOME));
    assert_eq!(app.status, crate::app::CHILD_UNSUPPORTED);
    assert!(fake.sent().is_empty());

    let none = crate::platform::NoTunnel;
    let config = Path::new("temperance.conf");
    assert_eq!(none.up(config).unwrap_err(), crate::app::CHILD_UNSUPPORTED);
    assert!(none.down(config).is_ok());
    assert!(!none.is_up());
    assert_eq!(none.handshake_age(), None);
    assert_eq!(
        cfg!(windows),
        App::new(_dir.path().into(), Fake::default(), none)
            .unwrap()
            .child_allowed
    );
}

#[test]
fn tunnel_failures_and_provisioning_changes_are_reported() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::default();
    let tunnel = FakeTunnel {
        fail: true,
        ..FakeTunnel::default()
    };
    let mut app = App::new(dir.path().to_path_buf(), fake.clone(), tunnel).unwrap();
    app.child_allowed = true;
    fake.ok(1);
    fake.ok(1);
    app.act(enroll(HOME));
    app.act(Action::Connect);
    assert_eq!(app.status, "WireGuard: denied");
    app.connected = true;
    fake.reply(Ok((
        200,
        state(2, "allowed", "").replace("192.0.2.1", "198.51.100.7"),
    )));
    app.act(Action::Refresh);
    assert!(app.status.contains("Tunnel provisioning changed"));
}

#[test]
fn identity_files_are_written_atomically_and_damage_is_reported() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("file.json");
    write_private(&path, "one").unwrap();
    write_private(&path, "two").unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "two");
    let (app, _, _, _dir) = app();
    std::fs::create_dir_all(&app.dir).unwrap();
    std::fs::write(app.dir.join("identity.json"), "{").unwrap();
    assert!(App::new(app.dir.clone(), Fake::default(), FakeTunnel::default()).is_err());
}

#[test]
fn shows_alerts_and_declines_location_requests() {
    let (mut app, fake, _tunnel, _dir) = app();
    fake.reply(Ok((
        200,
        state(
            1,
            "allowed",
            r#"{"id":"r","minutes":20,"status":"pending","at":1}"#,
        ),
    )));
    app.act(enroll(HOME));
    let asked = state(
        2,
        "allowed",
        r#"{"id":"r","minutes":20,"status":"approved","at":1}"#,
    )
    .replace(r#""requests""#, r#""location_requested":true,"requests""#);
    fake.reply(Ok((200, asked)));
    fake.reply(Ok((200, r#"{"ok":true}"#.into())));
    app.act(Action::Refresh);
    let sent = fake
        .sent()
        .into_iter()
        .find(|r| r.url.ends_with("/v1/device/location"))
        .unwrap();
    assert!(sent.body.unwrap().contains("cannot share its location"));
    assert!(child(&app)
        .alerts
        .iter()
        .any(|a| a.contains("Your request for 20 minutes was approved")));

    fake.reply(Ok((
        200,
        state(3, "allowed", "").replace(r#""requests""#, r#""location_requested":true,"requests""#),
    )));
    fake.reply(Ok((
        400,
        r#"{"error":"No location request is pending"}"#.into(),
    )));
    app.act(Action::Refresh);
    assert_eq!(app.status, "No location request is pending");
}

#[test]
fn reports_device_health_only_when_it_changes() {
    let (mut app, fake, tunnel, _dir) = enrolled();
    *tunnel.up.lock().unwrap() = false;
    let ok = || Ok((200, r#"{"ok":true}"#.to_string()));
    fake.ok(2);
    fake.reply(ok());
    app.act(Action::Refresh);
    assert_eq!(reports(&fake)[0]["issues"][0]["code"], "tunnel_down");
    assert!(issues(&app)
        .iter()
        .any(|m| m.contains("The VPN is not running")));

    // Unchanged issues are not re-sent.
    fake.ok(3);
    app.act(Action::Refresh);
    assert_eq!(reports(&fake).len(), 1);

    fake.ok(4);
    fake.reply(ok());
    app.act(Action::Connect);
    assert!(tunnel.is());
    assert_eq!(reports(&fake)[1]["issues"], serde_json::json!([]));
    assert!(issues(&app).is_empty());

    // Issues found while the service is unreachable cannot be reported.
    tunnel.set_age(Some(20));
    fake.reply(Err("connection refused".into()));
    app.act(Action::Refresh);
    assert!(issues(&app)
        .iter()
        .any(|m| m.contains("Cannot reach the policy service")));
    assert_eq!(reports(&fake).len(), 2);

    // A failed report is retried on the next refresh.
    tunnel.set_age(Some(600));
    fake.ok(5);
    fake.reply(Ok((500, "{}".into())));
    fake.ok(6);
    fake.reply(ok());
    app.act(Action::Refresh);
    app.act(Action::Refresh);
    let sent = reports(&fake);
    assert_eq!(sent.len(), 4);
    assert_eq!(sent[3]["issues"][0]["code"], "gateway_unreachable");
}

#[test]
fn wifi_sign_in_lowers_the_tunnel_only_while_a_portal_blocks_it() {
    let (mut app, fake, tunnel, _dir) = enrolled();
    let opened = Arc::new(Mutex::new(vec![]));
    let seen = opened.clone();
    app.browser = Box::new(move |url| {
        seen.lock().unwrap().push(url.to_string());
        Ok(())
    });
    fake.ok(2);
    app.act(Action::Connect);
    tunnel.set_age(Some(30));
    app.act(Action::SignIn);
    assert_eq!(
        app.status,
        "This network is working through the VPN; no Wi-Fi sign-in is needed."
    );
    assert_eq!(*tunnel.downs.lock().unwrap(), 0);
    assert!(!child(&app).can_sign_in);

    // The gateway is unreachable: offer sign-in.
    tunnel.set_age(Some(600));
    fake.reply(Err("timed out".into()));
    app.act(Action::Refresh);
    assert!(issues(&app)
        .iter()
        .any(|m| m.contains("cannot reach your family's gateway")));
    assert!(child(&app).can_sign_in);

    fake.probe_reply(302, Some("http://portal.example/login?a=1&b=2"), "");
    app.act(Action::SignIn);
    assert_eq!(*tunnel.downs.lock().unwrap(), 1);
    assert!(!tunnel.is());
    assert_eq!(
        app.status,
        "Protection is paused while you sign in to this Wi-Fi."
    );
    let shown = child(&app);
    assert_eq!(
        shown.portal_url.as_deref(),
        Some("http://portal.example/login?a=1&b=2")
    );
    assert!(shown.health.iter().any(|i| i
        .message
        .contains("Protection is paused to sign in to Wi-Fi")));
    assert!(!shown
        .health
        .iter()
        .any(|i| i.message.contains("The VPN is not running")));
    assert!(!shown.can_sign_in);
    app.act(Action::OpenPortal);
    assert_eq!(
        *opened.lock().unwrap(),
        vec!["http://portal.example/login?a=1&b=2".to_string()]
    );
    assert_eq!(app.status, "The Wi-Fi sign-in page opened in your browser.");
    // Pressing again does not extend the window.
    let until = app.portal_until;
    app.act(Action::SignIn);
    assert_eq!(app.portal_until, until);

    // Still behind the portal: stay lowered. Once online: restore immediately.
    fake.probe_reply(200, None, "<html>Accept terms</html>");
    app.check_portal().unwrap();
    assert!(!tunnel.is());
    fake.probe_reply(204, None, "");
    app.check_portal().unwrap();
    assert!(tunnel.is());
    assert!(app.portal_until.is_none());
    app.check_portal().unwrap();

    // Parents learn about the sign-in on the next successful refresh.
    tunnel.set_age(Some(10));
    fake.ok(3);
    fake.reply(Ok((200, r#"{"ok":true}"#.into())));
    app.act(Action::Refresh);
    let last = reports(&fake).pop().unwrap();
    assert_eq!(last["issues"][0]["code"], "portal_sign_in");
    assert_eq!(
        last["issues"][0]["message"],
        "Protection was recently paused to sign in to Wi-Fi"
    );
}

#[test]
fn wifi_sign_in_window_expires_and_restores_protection() {
    let (mut app, fake, tunnel, _dir) = enrolled();
    fake.ok(2);
    app.act(Action::Connect);
    tunnel.set_age(Some(u64::MAX));
    app.sign_in_to_network().unwrap();
    assert!(!tunnel.is());
    assert!(issues(&app)
        .iter()
        .any(|m| m.contains("No internet connection")));
    app.portal_until = Some(0);
    app.check_portal().unwrap();
    assert!(tunnel.is());
    assert!(app.portal_until.is_none());
}

#[test]
fn data_dir_prefers_the_flag_then_program_data_then_config_directories() {
    use crate::platform::data_dir;
    use std::ffi::OsString;
    use std::path::PathBuf;
    let args = |a: &[&str]| {
        a.iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>()
            .into_iter()
    };
    let env = |pairs: &'static [(&'static str, &'static str)]| {
        move |name: &str| {
            pairs
                .iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| OsString::from(v))
        }
    };
    assert_eq!(
        data_dir(args(&["--verbose", "--data", "/srv/t"]), env(&[])),
        PathBuf::from("/srv/t")
    );
    assert_eq!(
        data_dir(args(&["--data"]), env(&[("HOME", "/home/a")])),
        PathBuf::from("/home/a/.config/temperance")
    );
    assert_eq!(
        data_dir(
            args(&[]),
            env(&[("ProgramData", "C:/ProgramData"), ("HOME", "/h")])
        ),
        PathBuf::from("C:/ProgramData/Temperance")
    );
    assert_eq!(
        data_dir(args(&[]), env(&[("XDG_CONFIG_HOME", "/x"), ("HOME", "/h")])),
        PathBuf::from("/x/temperance")
    );
    assert_eq!(data_dir(args(&[]), env(&[])), PathBuf::from("./temperance"));
}

#[test]
fn request_sent_clears_once_a_parent_answers() {
    let (mut app, fake, _tunnel, _dir) = enrolled();
    let pending = r#"{"id":"r","minutes":30,"status":"pending","at":1}"#;
    fake.reply(Ok((
        200,
        r#"{"id":"r","minutes":30,"message":"","status":"pending","at":1}"#.into(),
    )));
    fake.reply(Ok((200, state(2, "daily limit", pending))));
    app.act(Action::RequestTime {
        minutes: 30,
        message: String::new(),
    });
    assert_eq!(app.status, crate::app::REQUEST_SENT);

    fake.reply(Ok((200, state(3, "daily limit", pending))));
    app.background_refresh();
    assert_eq!(app.status, crate::app::REQUEST_SENT, "still waiting");

    fake.reply(Ok((
        200,
        state(
            4,
            "allowed",
            r#"{"id":"r","minutes":30,"status":"approved","at":1}"#,
        ),
    )));
    app.background_refresh();
    assert_eq!(
        app.status,
        "Protected. Your family's rules apply on this computer."
    );
}

#[test]
fn background_tick_refreshes_every_thirty_seconds_and_reports_failures() {
    let (mut app, fake, _tunnel, _dir) = enrolled();
    let sent = fake.sent().len();
    crate::shell::tick(&mut app, 1);
    assert_eq!(fake.sent().len(), sent, "no refresh between 30 s marks");
    fake.reply(Err("io: timed out".into()));
    crate::shell::tick(&mut app, 6);
    assert!(fake.sent()[sent].url.ends_with("/v1/device/state"));
    assert_eq!(app.status, crate::app::UNREACHABLE);

    // The note goes away once the service answers again.
    fake.ok(2);
    crate::shell::tick(&mut app, 12);
    assert_eq!(
        app.status,
        "Protected. Your family's rules apply on this computer."
    );

    // Other failures still say what went wrong; a manual check is as plain as the timer.
    fake.reply(Ok((401, r#"{"error":"revoked"}"#.into())));
    crate::shell::tick(&mut app, 18);
    assert_ne!(app.status, crate::app::UNREACHABLE);
    fake.reply(Err("io: timed out".into()));
    app.act(Action::Refresh);
    assert_eq!(app.status, crate::app::UNREACHABLE);

    fake.ok(3);
    app.portal_until = Some(i64::MAX);
    let sent = fake.sent().len();
    crate::shell::tick(&mut app, 12);
    assert!(
        fake.sent()[sent..]
            .iter()
            .all(|r| !r.url.ends_with("/v1/device/state")),
        "no refresh while the tunnel is lowered for Wi-Fi sign-in"
    );
}

#[test]
fn background_tick_shows_a_tunnel_that_cannot_come_back() {
    let dir = tempfile::tempdir().unwrap();
    let tunnel = FakeTunnel {
        fail: true,
        ..Default::default()
    };
    let mut app = App::new(dir.path().into(), Fake::default(), tunnel).unwrap();
    app.portal_until = Some(0);
    crate::shell::tick(&mut app, 1);
    assert_eq!(app.status, "WireGuard: denied");
    assert!(app.portal_until.is_none());
}

#[test]
fn home_transport_probes_over_plain_http_but_reaches_home_only_by_its_wireguard_port() {
    use crate::transport::{agent, Home};
    use temperance_core::Header;
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let host = server.server_addr().to_ip().unwrap().to_string();
    let portal = std::thread::spawn(move || {
        let mut request = server.recv().unwrap();
        let seen = (
            request.method().to_string(),
            request
                .headers()
                .iter()
                .find(|h| h.field.equiv("X-Test"))
                .map(|h| h.value.to_string()),
        );
        let mut body = String::new();
        std::io::Read::read_to_string(request.as_reader(), &mut body).unwrap();
        request
            .respond(
                tiny_http::Response::from_string("sign in here")
                    .with_status_code(302)
                    .with_header(
                        tiny_http::Header::from_bytes("Location", "http://portal.example/")
                            .unwrap(),
                    ),
            )
            .unwrap();
        (seen, body)
    });
    let home = Home { probe: agent(5) };
    let request = HttpRequest {
        method: "POST".into(),
        url: format!("http://{host}/generate_204"),
        headers: vec![Header {
            name: "X-Test".into(),
            value: "1".into(),
        }],
        body: Some("hello".into()),
    };
    assert_eq!(
        home.probe(&request).unwrap(),
        (
            302,
            Some("http://portal.example/".into()),
            "sign in here".into()
        )
    );
    let ((method, header), body) = portal.join().unwrap();
    assert_eq!(
        (method.as_str(), header.as_deref(), body.as_str()),
        ("POST", Some("1"), "hello")
    );
    assert!(home.send(&request, false).is_err(), "a web address");
    let bad = HttpRequest {
        url: "not a url".into(),
        ..request
    };
    assert!(home.probe(&bad).is_err());
    assert!(Home::system().send(&bad, true).is_err());
}

const IDENTITY: &str = r#"{"v":1,"host":"parkers.ddnsfree.com","port":51820,"pin":"PIN","key":"KEY","id":"par_1","name":"Robin's PC","household":"The Parkers"}"#;

fn pairing_link() -> String {
    use base64::Engine;
    let json = r#"{"v":1,"host":"parkers.ddnsfree.com","port":51820,"pin":"PIN","code":"CODE","household":"The Parkers"}"#;
    format!(
        "temperance://pair#{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json)
    )
}

#[derive(Clone, Default)]
struct ParentFakes {
    paired: Shared<Vec<(String, String)>>,
    stopped: Shared<u32>,
    starts: Shared<u32>,
}

struct FakeRemote(Shared<u32>);
impl crate::app::Remote for FakeRemote {
    fn url(&self) -> String {
        "http://127.0.0.1:5555/__temperance/start?t=token".into()
    }
    fn stop(&self) {
        *self.0.lock().unwrap() += 1;
    }
}

fn parent_mode(fakes: &ParentFakes) -> crate::app::ParentMode {
    let (paired, stopped, starts) = (
        fakes.paired.clone(),
        fakes.stopped.clone(),
        fakes.starts.clone(),
    );
    crate::app::ParentMode {
        pair: Box::new(move |link, name| {
            paired.lock().unwrap().push((link.into(), name.into()));
            if name == "expired" {
                Err("That pairing code has expired or was already used.".into())
            } else {
                Ok(IDENTITY.into())
            }
        }),
        start: Box::new(move |identity| {
            assert_eq!(identity, IDENTITY);
            // Like the real session, which panics if started on an async runtime's thread.
            tauri::async_runtime::block_on(async {});
            *starts.lock().unwrap() += 1;
            Ok(Box::new(FakeRemote(stopped.clone())) as Box<dyn crate::app::Remote>)
        }),
    }
}

fn parent_app() -> (TestApp, ParentFakes, tempfile::TempDir) {
    let (mut app, _, _, dir) = app();
    let fakes = ParentFakes::default();
    app.parent_mode = parent_mode(&fakes);
    (app, fakes, dir)
}

fn pair(link: &str, name: &str) -> Action {
    Action::PairParent {
        link: link.into(),
        name: name.into(),
    }
}

#[test]
fn a_parent_pastes_the_link_and_the_dashboard_opens_in_its_own_window() {
    let (mut app, fakes, _dir) = parent_app();
    app.act(pair("nonsense", "PC"));
    assert!(
        app.status.contains("not a Temperance pairing code"),
        "{}",
        app.status
    );
    app.act(pair(&pairing_link(), "expired"));
    assert_eq!(
        app.status,
        "That pairing code has expired or was already used."
    );
    assert!(app.parent.is_none());

    app.act(pair(&format!(" {} ", pairing_link()), "Robin's PC "));
    assert_eq!(app.status, "The family dashboard opened in its own window.");
    assert_eq!(
        fakes.paired.lock().unwrap()[1],
        (pairing_link(), "Robin's PC".into())
    );
    assert_eq!(
        app.dashboard.take().as_deref(),
        Some("http://127.0.0.1:5555/__temperance/start?t=token")
    );
    let saved = app.dir.join("parent.json");
    assert_eq!(std::fs::read_to_string(&saved).unwrap(), IDENTITY);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&saved).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    assert_eq!(
        app.view().screen,
        Screen::Parent {
            household: "The Parkers".into(),
            host: "parkers.ddnsfree.com".into()
        }
    );
    // A parent's computer can't also become a child's.
    app.act(enroll(HOME));
    assert_eq!(
        app.status,
        "This computer is paired as an admin device. Unpair it first."
    );

    // Opening again reuses the running session.
    app.act(Action::OpenDashboard);
    assert_eq!(*fakes.starts.lock().unwrap(), 1);
    assert!(app.dashboard.is_some());
    // Closing the window takes back "opened", but not other news.
    app.dashboard_closed();
    assert_eq!(app.status, "");
    app.status = "Pair this computer first".into();
    app.dashboard_closed();
    assert_eq!(app.status, "Pair this computer first");

    let reloaded = App::new(app.dir.clone(), Fake::default(), FakeTunnel::default()).unwrap();
    assert_eq!(reloaded.parent.as_deref(), Some(IDENTITY));

    app.act(Action::UnpairParent);
    assert_eq!(
        app.status,
        "This computer no longer opens the family dashboard."
    );
    assert_eq!(*fakes.stopped.lock().unwrap(), 1);
    assert!(!saved.exists());
    app.act(Action::OpenDashboard);
    assert_eq!(app.status, "Pair this computer first");
    app.act(Action::UnpairParent);
    assert!(matches!(app.view().screen, Screen::Choose { .. }));
}

#[test]
fn a_child_computer_cannot_pair_and_a_damaged_pairing_can_be_forgotten() {
    let (mut app, fakes, _dir) = parent_app();
    app.parent = Some("{broken".into());
    match app.view().screen {
        Screen::ParentBroken { error } => assert!(error.contains("damaged"), "{error}"),
        other => panic!("{other:?}"),
    }
    app.act(Action::UnpairParent);
    assert!(app.parent.is_none());

    let (mut child, _, _, _dir2) = enrolled();
    child.parent_mode = parent_mode(&fakes);
    child.act(pair(&pairing_link(), "PC"));
    assert_eq!(
        child.status,
        "This computer is enrolled as a client's device."
    );
    assert!(fakes.paired.lock().unwrap().is_empty());
}

#[test]
fn the_system_parent_mode_reports_unreachable_homes() {
    let mode = crate::app::ParentMode::system();
    assert!((mode.pair)("nonsense", "PC")
        .unwrap_err()
        .contains("pairing code"));
    assert!((mode.start)("{broken").err().unwrap().contains("damaged"));
}

#[test]
fn the_dashboard_window_only_loads_the_local_proxy() {
    use crate::shell::same_origin;
    let start: tauri::Url = "http://127.0.0.1:5555/__temperance/start?t=x"
        .parse()
        .unwrap();
    let ok = |u: &str| same_origin(&start, &u.parse().unwrap());
    assert!(ok("http://127.0.0.1:5555/"));
    assert!(ok("http://127.0.0.1:5555/api/state"));
    assert!(!ok("http://127.0.0.1:5556/"));
    assert!(!ok("https://127.0.0.1:5555/"));
    assert!(!ok("http://localhost:5555/"));
    assert!(!ok("https://www.dynu.com/"));

    let browsed = std::cell::RefCell::new(Vec::new());
    let follow = |u: &str| {
        crate::shell::navigation_allowed(&start, &u.parse().unwrap(), |link| {
            browsed.borrow_mut().push(link.to_string())
        })
    };
    assert!(follow("http://127.0.0.1:5555/devices"));
    assert!(!follow("https://www.dynu.com/"));
    assert!(!follow("mailto:help@example.com"));
    assert_eq!(*browsed.borrow(), ["https://www.dynu.com/"]);
}

#[test]
fn boxed_transports_and_tunnels_forward_every_call() {
    let fake = Fake::default();
    fake.probe_reply(302, Some("http://portal.example/"), "");
    let transport: Box<dyn Transport + Send> = Box::new(fake.clone());
    let request = HttpRequest {
        method: "GET".into(),
        url: "http://neverssl.com/".into(),
        headers: vec![],
        body: None,
    };
    assert_eq!(
        transport.probe(&request).unwrap(),
        (302, Some("http://portal.example/".into()), String::new())
    );
    assert_eq!(transport.send(&request, false), Err("no reply".into()));

    let fake_tunnel = FakeTunnel::default();
    fake_tunnel.set_age(Some(7));
    let tunnel: Box<dyn TunnelControl + Send> = Box::new(fake_tunnel.clone());
    let config = Path::new("temperance.conf");
    tunnel.up(config).unwrap();
    assert!(tunnel.is_up());
    assert_eq!(tunnel.handshake_age(), Some(7));
    tunnel.down(config).unwrap();
    assert!(!tunnel.is_up());
    assert_eq!(*fake_tunnel.downs.lock().unwrap(), 1);
}

mod commands {
    use super::*;
    use crate::shell::{builder, DesktopApp, DASHBOARD};
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{
        get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY,
    };
    use tauri::webview::InvokeRequest;
    use tauri::{Listener, Manager, WebviewWindowBuilder};

    fn call(
        webview: &tauri::WebviewWindow<MockRuntime>,
        cmd: &str,
        body: serde_json::Value,
    ) -> serde_json::Value {
        get_ipc_response(
            webview,
            InvokeRequest {
                cmd: cmd.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: if cfg!(windows) {
                    "http://tauri.localhost"
                } else {
                    "tauri://localhost"
                }
                .parse()
                .unwrap(),
                body: InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|b| b.deserialize::<serde_json::Value>().unwrap())
        .unwrap_or_else(|e| panic!("{cmd}: {e}"))
    }

    #[test]
    fn the_ui_reads_the_view_acts_and_opens_the_dashboard_window() {
        let dir = tempfile::tempdir().unwrap();
        let fakes = ParentFakes::default();
        let mut desktop: DesktopApp = App::new(
            dir.path().into(),
            Box::new(Fake::default()) as Box<dyn Transport + Send>,
            Box::new(FakeTunnel::default()) as Box<dyn TunnelControl + Send>,
        )
        .unwrap();
        desktop.parent_mode = parent_mode(&fakes);
        let app = builder(mock_builder(), desktop)
            .enable_macos_default_menu(false)
            .build(mock_context(noop_assets()))
            .unwrap();
        let main = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();

        let view = call(&main, "view", serde_json::json!({}));
        assert_eq!(view["screen"], "choose");
        assert_eq!(view["child_allowed"], cfg!(windows));

        let view = call(
            &main,
            "act",
            serde_json::json!({"action": {"action": "pair_parent", "link": pairing_link(), "name": "Robin's PC"}}),
        );
        assert_eq!(view["screen"], "parent", "{view}");
        assert_eq!(view["household"], "The Parkers");
        assert_eq!(
            view["status"],
            "The family dashboard opened in its own window."
        );
        let dashboard = app.get_webview_window(DASHBOARD).expect("dashboard window");
        assert_eq!(
            dashboard.url().unwrap().as_str(),
            "http://127.0.0.1:5555/__temperance/start?t=token"
        );
        // Opening again reuses the window.
        let view = call(
            &main,
            "act",
            serde_json::json!({"action": {"action": "open_dashboard"}}),
        );
        assert_eq!(
            view["status"],
            "The family dashboard opened in its own window."
        );
        assert_eq!(app.webview_windows().len(), 2);

        let (sent, views) = std::sync::mpsc::channel();
        app.listen("view", move |event| {
            let _ = sent.send(serde_json::from_str::<serde_json::Value>(event.payload()).unwrap());
        });
        crate::shell::dashboard_event(app.handle(), &tauri::WindowEvent::Focused(true));
        crate::shell::dashboard_event(app.handle(), &tauri::WindowEvent::Destroyed);
        let view = views
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("a view after the dashboard closes");
        assert_eq!(view["screen"], "parent");
        assert_eq!(view["status"], "");

        crate::shell::push_view(app.handle(), |desktop| {
            desktop.status = "Checked just now".into()
        });
        let view = views
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        assert_eq!(view["status"], "Checked just now");
    }

    #[test]
    fn a_child_signs_in_and_starts_protection_through_the_ui() {
        let dir = tempfile::tempdir().unwrap();
        let fake = Fake::default();
        let tunnel = FakeTunnel::default();
        let mut desktop: DesktopApp = App::new(
            dir.path().into(),
            Box::new(fake.clone()) as Box<dyn Transport + Send>,
            Box::new(tunnel.clone()) as Box<dyn TunnelControl + Send>,
        )
        .unwrap();
        desktop.child_allowed = true;
        let app = builder(mock_builder(), desktop)
            .enable_macos_default_menu(false)
            .build(mock_context(noop_assets()))
            .unwrap();
        let main = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        fake.ok(1);
        let view = call(
            &main,
            "act",
            serde_json::json!({"action": {"action": "enroll", "service": HOME,
                "username": "alex", "password": "user-password", "name": "Laptop"}}),
        );
        assert_eq!(view["screen"], "child", "{view}");
        assert_eq!(view["remaining"], "55 min left today");
        assert_eq!(view["connected"], true);
        assert!(view["health"].as_array().unwrap().is_empty(), "{view}");
        *tunnel.up.lock().unwrap() = false;
        fake.ok(2);
        let view = call(
            &main,
            "act",
            serde_json::json!({"action": {"action": "connect"}}),
        );
        assert_eq!(view["connected"], true);
        assert!(tunnel.is());
        assert!(view["health"].as_array().unwrap().is_empty(), "{view}");
        assert!(app.get_webview_window(DASHBOARD).is_none());
    }
}
