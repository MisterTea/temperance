use std::cell::RefCell;
use std::collections::VecDeque;
use std::path::Path;
use std::rc::Rc;

use temperance_core::HttpRequest;

use crate::app::{form_value, write_private, App, Transport, TunnelControl};

const SERVER_KEY: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const HOST: &str = "127.0.0.1:4000";

type Replies = Rc<RefCell<VecDeque<Result<(u16, String), String>>>>;
type Probes = Rc<RefCell<VecDeque<(u16, Option<String>, String)>>>;

#[derive(Clone, Default)]
struct Fake {
    replies: Replies,
    probes: Probes,
    sent: Rc<RefCell<Vec<HttpRequest>>>,
}
impl Transport for Fake {
    fn send(&self, request: &HttpRequest) -> Result<(u16, String), String> {
        self.sent.borrow_mut().push(request.clone());
        self.replies
            .borrow_mut()
            .pop_front()
            .unwrap_or(Err("no reply".into()))
    }
    fn probe(&self, request: &HttpRequest) -> Result<(u16, Option<String>, String), String> {
        assert!(request.url.starts_with("http://"));
        self.probes
            .borrow_mut()
            .pop_front()
            .ok_or_else(|| "timed out".into())
    }
}
#[derive(Clone, Default)]
struct FakeTunnel {
    up: Rc<RefCell<bool>>,
    age: Rc<RefCell<Option<u64>>>,
    downs: Rc<RefCell<u32>>,
    fail: bool,
}
impl TunnelControl for FakeTunnel {
    fn up(&self, config: &Path) -> Result<(), String> {
        assert!(config.ends_with("temperance.conf"));
        if self.fail {
            return Err("WireGuard: denied".into());
        }
        *self.up.borrow_mut() = true;
        Ok(())
    }
    fn down(&self, config: &Path) -> Result<(), String> {
        assert!(config.ends_with("temperance.conf"));
        *self.downs.borrow_mut() += 1;
        *self.up.borrow_mut() = false;
        Ok(())
    }
    fn is_up(&self) -> bool {
        *self.up.borrow()
    }
    fn handshake_age(&self) -> Option<u64> {
        *self.age.borrow()
    }
}

fn state(version: u32, reason: &str, requests: &str) -> String {
    format!(
        r#"{{"token":"tok","device_id":"dev","version":{version},"policy":{{"name":"Alex","limit":60,"used":5,"timezone":"UTC"}},
        "tunnel":{{"address":"10.77.0.2/32","address_v6":"fd77::2/128","dns":"10.77.0.1","endpoint":"192.0.2.1:51820","public_key":"{SERVER_KEY}"}},
        "status":{{"reason":"{reason}","remaining_minutes":55}},"requests":[{requests}]}}"#
    )
}

fn post(app: &mut App<Fake, FakeTunnel>, path: &str, fields: &str) -> u16 {
    let body = format!("nonce=n0nce&{fields}");
    app.handle(
        "POST",
        path,
        HOST,
        HOST,
        Some(&format!("http://{HOST}")),
        &body,
    )
    .status
}

fn app() -> (App<Fake, FakeTunnel>, Fake, FakeTunnel, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::default();
    let tunnel = FakeTunnel::default();
    let app = App::new(
        dir.path().join("data"),
        "n0nce".into(),
        fake.clone(),
        tunnel.clone(),
    )
    .unwrap();
    (app, fake, tunnel, dir)
}

#[test]
fn enrolls_connects_refreshes_and_requests_time() {
    let (mut app, fake, tunnel, dir) = app();
    assert!(app.render().contains("Enroll this device"));
    fake.replies
        .borrow_mut()
        .push_back(Ok((200, state(1, "allowed", ""))));
    assert_eq!(
        post(
            &mut app,
            "/enroll",
            "service=https%3A%2F%2Ffamily.example&username=alex&password=user-password&name=Laptop"
        ),
        303
    );
    assert_eq!(
        app.status,
        "Ready. Rules are enforced by your family's gateway."
    );
    let sent = fake.sent.borrow()[0].clone();
    assert_eq!(sent.url, "https://family.example/v1/device/login");
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
    let page = app.handle("GET", "/", HOST, HOST, None, "").body;
    assert!(page.contains("You&#39;re online"));
    assert!(page.contains("55 min left today"));
    assert!(page.contains("Ask for more time"));

    fake.replies
        .borrow_mut()
        .push_back(Ok((200, state(2, "allowed", ""))));
    assert_eq!(post(&mut app, "/connect", ""), 303);
    assert!(*tunnel.up.borrow());
    assert!(app.connected);

    fake.replies.borrow_mut().extend([
        Ok((
            200,
            r#"{"id":"r","minutes":15,"message":"","status":"pending","at":1}"#.to_string(),
        )),
        Ok((
            200,
            state(
                3,
                "daily limit",
                r#"{"id":"r","minutes":15,"status":"pending","at":1}"#,
            ),
        )),
    ]);
    assert_eq!(
        post(&mut app, "/request", "minutes=15&message=homework"),
        303
    );
    assert_eq!(app.status, "Request sent to your parents.");
    assert!(app.render().contains("waiting for a parent"));

    fake.replies
        .borrow_mut()
        .push_back(Ok((401, r#"{"error":"Invalid or revoked device"}"#.into())));
    post(&mut app, "/refresh", "");
    assert_eq!(app.status, "Invalid or revoked device");

    let reloaded = App::new(
        dir.path().join("data"),
        "x".into(),
        Fake::default(),
        FakeTunnel::default(),
    )
    .unwrap();
    assert_eq!(reloaded.identity.unwrap().state.unwrap().version, 3);
}

#[test]
fn rejects_cross_origin_wrong_host_and_bad_input() {
    let (mut app, fake, _tunnel, _dir) = app();
    assert_eq!(
        app.handle("GET", "/", "evil.test", HOST, None, "").status,
        403
    );
    assert_eq!(
        app.handle(
            "POST",
            "/enroll",
            HOST,
            HOST,
            Some("http://evil.test"),
            "nonce=n0nce"
        )
        .status,
        403
    );
    assert_eq!(
        app.handle(
            "POST",
            "/enroll",
            HOST,
            HOST,
            Some(&format!("http://{HOST}")),
            "nonce=wrong"
        )
        .status,
        403
    );
    assert_eq!(
        app.handle("GET", "/missing", HOST, HOST, None, "").status,
        404
    );
    assert_eq!(post(&mut app, "/missing", ""), 404);
    post(
        &mut app,
        "/enroll",
        "service=http%3A%2F%2Finsecure.example&username=alex&password=user-password&name=b",
    );
    assert_eq!(app.status, "Enter an HTTPS service origin");
    post(&mut app, "/connect", "");
    assert_eq!(app.status, "Enroll first");
    post(&mut app, "/request", "minutes=15");
    assert_eq!(app.status, "Enroll first");
    fake.replies.borrow_mut().push_back(Err("timeout".into()));
    post(
        &mut app,
        "/enroll",
        "service=https%3A%2F%2Ff.example&username=alex&password=user-password&name=b",
    );
    assert!(app.status.starts_with("Cannot reach policy service"));
    assert!(app.identity.is_none());

    fake.replies
        .borrow_mut()
        .push_back(Ok((200, state(1, "allowed", ""))));
    post(
        &mut app,
        "/enroll",
        "service=https%3A%2F%2Ff.example&username=alex&password=user-password&name=b",
    );
    post(
        &mut app,
        "/enroll",
        "service=https%3A%2F%2Ff.example&username=alex&password=user-password&name=b",
    );
    assert_eq!(app.status, "Already enrolled");
    post(&mut app, "/request", "minutes=lots");
    assert_eq!(app.status, "Choose how many minutes");
    let html = app.render();
    assert!(!html.contains("<script"));
}

#[test]
fn tunnel_failures_and_provisioning_changes_are_reported() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::default();
    let tunnel = FakeTunnel {
        fail: true,
        ..FakeTunnel::default()
    };
    let mut app = App::new(
        dir.path().to_path_buf(),
        "n0nce".into(),
        fake.clone(),
        tunnel,
    )
    .unwrap();
    fake.replies.borrow_mut().extend([
        Ok((200, state(1, "allowed", ""))),
        Ok((200, state(1, "allowed", ""))),
    ]);
    post(
        &mut app,
        "/enroll",
        "service=https%3A%2F%2Ff.example&username=alex&password=user-password&name=b",
    );
    post(&mut app, "/connect", "");
    assert_eq!(app.status, "WireGuard: denied");
    app.connected = true;
    fake.replies.borrow_mut().push_back(Ok((
        200,
        state(2, "allowed", "").replace("192.0.2.1", "198.51.100.7"),
    )));
    post(&mut app, "/refresh", "");
    assert!(app.status.contains("Tunnel provisioning changed"));
}

#[test]
fn helpers_parse_forms_escape_and_write_atomically() {
    assert_eq!(form_value("a=1&name=J%C3%BCrgen+K", "name"), "Jürgen K");
    assert_eq!(form_value("a=1", "missing"), "");
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("file.json");
    write_private(&path, "one").unwrap();
    write_private(&path, "two").unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "two");
    let (mut app, _, _, _dir) = app();
    app.status = "<b>bad</b>".into();
    assert!(app.render().contains("&lt;b&gt;bad&lt;/b&gt;"));
    std::fs::create_dir_all(&app.dir).unwrap();
    std::fs::write(app.dir.join("identity.json"), "{").unwrap();
    assert!(App::new(
        app.dir.clone(),
        "n".into(),
        Fake::default(),
        FakeTunnel::default()
    )
    .is_err());
}

#[test]
fn shows_alerts_and_declines_location_requests() {
    let (mut app, fake, _tunnel, _dir) = app();
    fake.replies.borrow_mut().push_back(Ok((
        200,
        state(
            1,
            "allowed",
            r#"{"id":"r","minutes":20,"status":"pending","at":1}"#,
        ),
    )));
    post(
        &mut app,
        "/enroll",
        "service=https%3A%2F%2Ffamily.example&username=alex&password=user-password&name=Laptop",
    );
    let asked = state(
        2,
        "allowed",
        r#"{"id":"r","minutes":20,"status":"approved","at":1}"#,
    )
    .replace(r#""requests""#, r#""location_requested":true,"requests""#);
    fake.replies
        .borrow_mut()
        .extend([Ok((200, asked)), Ok((200, r#"{"ok":true}"#.to_string()))]);
    assert_eq!(post(&mut app, "/refresh", ""), 303);
    let sent = fake
        .sent
        .borrow()
        .iter()
        .find(|r| r.url == "https://family.example/v1/device/location")
        .cloned()
        .unwrap();
    assert!(sent.body.unwrap().contains("cannot share its location"));
    assert!(app
        .render()
        .contains("Your request for 20 minutes was approved"));

    fake.replies.borrow_mut().extend([
        Ok((
            200,
            state(3, "allowed", "")
                .replace(r#""requests""#, r#""location_requested":true,"requests""#),
        )),
        Ok((
            400,
            r#"{"error":"No location request is pending"}"#.to_string(),
        )),
    ]);
    post(&mut app, "/refresh", "");
    assert_eq!(app.status, "No location request is pending");
}

fn enrolled() -> (App<Fake, FakeTunnel>, Fake, FakeTunnel, tempfile::TempDir) {
    let (mut app, fake, tunnel, dir) = app();
    fake.replies
        .borrow_mut()
        .push_back(Ok((200, state(1, "allowed", ""))));
    post(
        &mut app,
        "/enroll",
        "service=https%3A%2F%2Ffamily.example&username=alex&password=user-password&name=Laptop",
    );
    (app, fake, tunnel, dir)
}

fn reports(fake: &Fake) -> Vec<serde_json::Value> {
    fake.sent
        .borrow()
        .iter()
        .filter(|r| r.url.ends_with("/v1/device/diagnostics"))
        .map(|r| serde_json::from_str(r.body.as_deref().unwrap()).unwrap())
        .collect()
}

#[test]
fn reports_device_health_only_when_it_changes() {
    let (mut app, fake, tunnel, _dir) = enrolled();
    let ok = || Ok((200, r#"{"ok":true}"#.to_string()));
    fake.replies
        .borrow_mut()
        .extend([Ok((200, state(2, "allowed", ""))), ok()]);
    post(&mut app, "/refresh", "");
    assert_eq!(reports(&fake)[0]["issues"][0]["code"], "tunnel_down");
    assert!(app.render().contains("The VPN is not running"));

    // Unchanged issues are not re-sent.
    fake.replies
        .borrow_mut()
        .push_back(Ok((200, state(3, "allowed", ""))));
    post(&mut app, "/refresh", "");
    assert_eq!(reports(&fake).len(), 1);

    fake.replies
        .borrow_mut()
        .extend([Ok((200, state(4, "allowed", ""))), ok()]);
    post(&mut app, "/connect", "");
    assert!(*tunnel.up.borrow());
    assert_eq!(reports(&fake)[1]["issues"], serde_json::json!([]));
    assert!(!app.render().contains("Device health"));

    // Issues found while the service is unreachable cannot be reported.
    *tunnel.age.borrow_mut() = Some(20);
    fake.replies
        .borrow_mut()
        .push_back(Err("connection refused".into()));
    post(&mut app, "/refresh", "");
    assert!(app.render().contains("Cannot reach the policy service"));
    assert_eq!(reports(&fake).len(), 2);

    // A failed report is retried on the next refresh.
    *tunnel.age.borrow_mut() = Some(600);
    fake.replies.borrow_mut().extend([
        Ok((200, state(5, "allowed", ""))),
        Ok((500, "{}".into())),
        Ok((200, state(6, "allowed", ""))),
        ok(),
    ]);
    post(&mut app, "/refresh", "");
    post(&mut app, "/refresh", "");
    let sent = reports(&fake);
    assert_eq!(sent.len(), 4);
    assert_eq!(sent[3]["issues"][0]["code"], "gateway_unreachable");
}

#[test]
fn wifi_sign_in_lowers_the_tunnel_only_while_a_portal_blocks_it() {
    let (mut app, fake, tunnel, _dir) = enrolled();
    fake.replies
        .borrow_mut()
        .push_back(Ok((200, state(2, "allowed", ""))));
    post(&mut app, "/connect", "");
    *tunnel.age.borrow_mut() = Some(30);
    assert_eq!(post(&mut app, "/sign-in", ""), 303);
    assert_eq!(
        app.status,
        "This network is working through the VPN; no Wi-Fi sign-in is needed."
    );
    assert_eq!(*tunnel.downs.borrow(), 0);

    // The gateway is unreachable: offer sign-in.
    *tunnel.age.borrow_mut() = Some(600);
    fake.replies.borrow_mut().push_back(Err("timed out".into()));
    post(&mut app, "/refresh", "");
    let page = app.render();
    assert!(page.contains("cannot reach your family&#39;s gateway"));
    assert!(page.contains("Sign in to Wi-Fi"));

    fake.probes.borrow_mut().push_back((
        302,
        Some("http://portal.example/login?a=1&b=2".into()),
        String::new(),
    ));
    post(&mut app, "/sign-in", "");
    assert_eq!(*tunnel.downs.borrow(), 1);
    assert!(!*tunnel.up.borrow());
    assert_eq!(
        app.status,
        "Protection is paused while you sign in to this Wi-Fi."
    );
    let page = app.render();
    assert!(page.contains(r#"href="http://portal.example/login?a=1&amp;b=2""#));
    assert!(page.contains("Protection is paused to sign in to Wi-Fi"));
    assert!(!page.contains("The VPN is not running"));
    assert!(!page.contains(r#"action="/sign-in""#));
    // Pressing again does not extend the window.
    let until = app.portal_until;
    post(&mut app, "/sign-in", "");
    assert_eq!(app.portal_until, until);

    // Still behind the portal: stay lowered. Once online: restore immediately.
    fake.probes
        .borrow_mut()
        .push_back((200, None, "<html>Accept terms</html>".into()));
    app.check_portal().unwrap();
    assert!(!*tunnel.up.borrow());
    fake.probes
        .borrow_mut()
        .push_back((204, None, String::new()));
    app.check_portal().unwrap();
    assert!(*tunnel.up.borrow());
    assert!(app.portal_until.is_none());
    app.check_portal().unwrap();

    // Parents learn about the sign-in on the next successful refresh.
    *tunnel.age.borrow_mut() = Some(10);
    fake.replies.borrow_mut().extend([
        Ok((200, state(3, "allowed", ""))),
        Ok((200, r#"{"ok":true}"#.to_string())),
    ]);
    post(&mut app, "/refresh", "");
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
    fake.replies
        .borrow_mut()
        .push_back(Ok((200, state(2, "allowed", ""))));
    post(&mut app, "/connect", "");
    *tunnel.age.borrow_mut() = Some(u64::MAX);
    app.sign_in_to_network().unwrap();
    assert!(!*tunnel.up.borrow());
    assert!(app.render().contains("No internet connection"));
    app.portal_until = Some(0);
    app.check_portal().unwrap();
    assert!(*tunnel.up.borrow());
    assert!(app.portal_until.is_none());
}

#[test]
fn platform_helpers_parse_handshakes_and_command_results() {
    use crate::{command_result, handshake_age};
    assert_eq!(handshake_age("key=\t1000\n", 1030), Some(30));
    assert_eq!(handshake_age("a\t0\n", 1030), Some(u64::MAX));
    assert_eq!(handshake_age("a\t900\nb\t1000\n", 1030), Some(30));
    assert_eq!(handshake_age("", 1030), None);
    assert_eq!(handshake_age("a\t2000\n", 1030), Some(0));
    if !cfg!(windows) {
        assert!(command_result(std::process::Command::new("true").output()).is_ok());
        assert!(command_result(std::process::Command::new("false").output()).is_err());
    }
    assert!(command_result(Err(std::io::Error::other("missing"))).is_err());
}

#[test]
fn data_dir_prefers_the_flag_then_platform_config_directories() {
    use crate::data_dir;
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
            env(&[("APPDATA", "C:/Users/a/AppData"), ("HOME", "/h")])
        ),
        PathBuf::from("C:/Users/a/AppData/temperance")
    );
    assert_eq!(
        data_dir(args(&[]), env(&[("XDG_CONFIG_HOME", "/x"), ("HOME", "/h")])),
        PathBuf::from("/x/temperance")
    );
    assert_eq!(data_dir(args(&[]), env(&[])), PathBuf::from("./temperance"));
}

#[test]
fn background_tick_refreshes_every_thirty_seconds_and_reports_failures() {
    let (mut app, fake, _tunnel, _dir) = enrolled();
    let sent = fake.sent.borrow().len();
    crate::tick(&mut app, 1);
    assert_eq!(
        fake.sent.borrow().len(),
        sent,
        "no refresh between 30 s marks"
    );
    crate::tick(&mut app, 6);
    assert!(fake.sent.borrow()[sent].url.ends_with("/v1/device/state"));
    assert!(
        app.status.ends_with("; existing VPN remains installed"),
        "{}",
        app.status
    );
    fake.replies
        .borrow_mut()
        .push_back(Ok((200, state(2, "allowed", ""))));
    app.portal_until = Some(i64::MAX);
    let sent = fake.sent.borrow().len();
    crate::tick(&mut app, 12);
    assert!(
        fake.sent.borrow()[sent..]
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
    let mut app = App::new(dir.path().into(), "n".into(), Fake::default(), tunnel).unwrap();
    app.portal_until = Some(0);
    crate::tick(&mut app, 1);
    assert_eq!(app.status, "WireGuard: denied");
    assert!(app.portal_until.is_none());
}

fn local_server() -> (tiny_http::Server, String) {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let host = server.server_addr().to_ip().unwrap().to_string();
    (server, host)
}

#[test]
fn local_ui_server_sends_security_headers_and_redirects_after_posts() {
    let (mut app, _fake, _tunnel, _dir) = app();
    let (server, host) = local_server();
    let url = format!("http://{host}");
    let client = std::thread::spawn(move || {
        let agent = crate::agent(5, false);
        let page = agent.get(format!("{url}/?tab=1")).call().unwrap();
        let header = |r: &ureq::http::Response<ureq::Body>, name: &str| {
            r.headers()
                .get(name)
                .map(|v| v.to_str().unwrap().to_string())
        };
        let headers = [
            "content-type",
            "cache-control",
            "x-frame-options",
            "content-security-policy",
        ]
        .map(|name| header(&page, name).unwrap_or_default());
        let html = page.into_body().read_to_string().unwrap();
        let post = agent
            .post(format!("{url}/refresh"))
            .header("Origin", &url)
            .send("nonce=n0nce")
            .unwrap();
        let missing = agent.get(format!("{url}/missing")).call().unwrap();
        (
            headers,
            html,
            post.status().as_u16(),
            header(&post, "location"),
            missing.status().as_u16(),
        )
    });
    for _ in 0..3 {
        crate::respond(&mut app, server.recv().unwrap(), &host);
    }
    let (headers, html, post, location, missing) = client.join().unwrap();
    assert_eq!(headers[0], "text/html; charset=utf-8");
    assert_eq!(headers[1], "no-store");
    assert_eq!(headers[2], "DENY");
    assert!(headers[3].starts_with("default-src 'none'"));
    assert!(html.contains("n0nce"));
    assert_eq!((post, location.as_deref()), (303, Some("/")));
    assert_eq!(app.status, "Enroll first");
    assert_eq!(missing, 404);
}

#[test]
fn https_transport_sends_requests_and_keeps_the_policy_service_on_https() {
    use crate::{agent, Https};
    use temperance_core::Header;
    let (server, host) = local_server();
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
    let https = Https {
        policy: agent(5, true),
        probe: agent(5, false),
    };
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
        https.probe(&request).unwrap(),
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
    assert!(https.send(&request).is_err(), "plain HTTP policy service");
    let bad = HttpRequest {
        url: "not a url".into(),
        ..request
    };
    assert!(https.probe(&bad).is_err());
}

#[cfg(unix)]
#[test]
fn wireguard_runs_the_official_tools() {
    use crate::WireGuard;
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("log");
    let script = |name: &str, body: &str| {
        let path = dir.path().join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    };
    script(
        "wg",
        r#"[ "$3" = latest-handshakes ] && printf 'peer\t%s\n' $(($(date +%s) - 10)); exit 0"#,
    );
    script(
        "wg-quick",
        &format!(
            r#"echo "$@" >> {}; [ "$1" = up ] || {{ echo busy >&2; exit 1; }}"#,
            log.display()
        ),
    );
    let config = dir.path().join("temperance.conf");
    let tools = WireGuard {
        tools: Some(dir.path().into()),
    };
    assert!(tools.is_up());
    assert!(tools
        .handshake_age()
        .is_some_and(|age| (10..60).contains(&age)));
    tools.up(&config).unwrap();
    assert_eq!(tools.down(&config).unwrap_err(), "WireGuard: busy\n");
    assert_eq!(
        std::fs::read_to_string(&log).unwrap(),
        format!("up {0}\ndown {0}\n", config.display())
    );

    let missing = WireGuard {
        tools: Some(dir.path().join("absent")),
    };
    assert!(!missing.is_up());
    assert_eq!(missing.handshake_age(), None);
    assert!(missing.up(&config).unwrap_err().starts_with("WireGuard: "));
    assert!(WireGuard::system().tools.is_none());
}
