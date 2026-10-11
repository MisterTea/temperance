use pretty_assertions::assert_eq;
use temperance_core::*;

const NOW: i64 = 1_791_741_600;

fn healthy() -> DeviceFacts {
    DeviceFacts {
        vpn_permission: Some(true),
        tunnel_up: true,
        seconds_since_handshake: Some(20),
        connectivity: Some(Connectivity::Online),
        policy_reachable: true,
        notifications_allowed: Some(true),
        location_allowed: Some(true),
        portal_sign_in_until: None,
    }
}

fn codes(facts: DeviceFacts) -> Vec<String> {
    diagnose(facts, NOW).into_iter().map(|d| d.code).collect()
}

#[test]
fn captive_portal_probe_is_plain_http_and_classified() {
    let probe = captive_portal_probe();
    assert_eq!(probe.method, "GET");
    assert!(probe.url.starts_with("http://"));
    assert_eq!(
        parse_captive_portal_probe(204, None, String::new()),
        Connectivity::Online
    );
    assert_eq!(
        parse_captive_portal_probe(200, None, " ".into()),
        Connectivity::Online
    );
    assert_eq!(
        parse_captive_portal_probe(200, None, "<html>Hotel Wi-Fi</html>".into()),
        Connectivity::CaptivePortal { login_url: None }
    );
    assert_eq!(
        parse_captive_portal_probe(511, None, String::new()),
        Connectivity::CaptivePortal { login_url: None }
    );
    assert_eq!(
        parse_captive_portal_probe(
            302,
            Some("https://portal.example/login".into()),
            String::new()
        ),
        Connectivity::CaptivePortal {
            login_url: Some("https://portal.example/login".into())
        }
    );
    // Only web links are offered to the child.
    assert_eq!(
        parse_captive_portal_probe(302, Some("javascript:alert(1)".into()), String::new()),
        Connectivity::CaptivePortal { login_url: None }
    );
    assert_eq!(
        parse_captive_portal_probe(0, None, String::new()),
        Connectivity::Offline
    );
    assert_eq!(
        parse_captive_portal_probe(503, None, String::new()),
        Connectivity::Offline
    );
}

#[test]
fn healthy_devices_have_no_issues() {
    assert!(diagnose(healthy(), NOW).is_empty());
    assert!(diagnose(
        DeviceFacts {
            vpn_permission: None,
            notifications_allowed: None,
            location_allowed: None,
            connectivity: None,
            seconds_since_handshake: None,
            ..healthy()
        },
        NOW
    )
    .is_empty());
}

#[test]
fn permission_and_tunnel_problems_are_errors_first() {
    let found = diagnose(
        DeviceFacts {
            vpn_permission: Some(false),
            tunnel_up: false,
            notifications_allowed: Some(false),
            location_allowed: Some(false),
            ..healthy()
        },
        NOW,
    );
    assert_eq!(
        found.iter().map(|d| d.code.as_str()).collect::<Vec<_>>(),
        ["vpn_permission", "notifications_off", "location_off"]
    );
    assert_eq!(found[0].severity, Severity::Error);
    assert_eq!(found[2].severity, Severity::Info);
    assert_eq!(
        codes(DeviceFacts {
            tunnel_up: false,
            ..healthy()
        }),
        ["tunnel_down"]
    );
}

#[test]
fn captive_portals_and_stale_tunnels_explain_the_sign_in_path() {
    let stale = diagnose(
        DeviceFacts {
            seconds_since_handshake: Some(600),
            policy_reachable: false,
            connectivity: None,
            ..healthy()
        },
        NOW,
    );
    assert_eq!(stale.len(), 1, "a dead tunnel explains the policy outage");
    assert_eq!(stale[0].code, "gateway_unreachable");
    assert!(stale[0].action.contains("Sign in to Wi-Fi"));

    let portal = diagnose(
        DeviceFacts {
            connectivity: Some(Connectivity::CaptivePortal {
                login_url: Some("http://portal.example/".into()),
            }),
            ..healthy()
        },
        NOW,
    );
    assert_eq!(portal[0].code, "captive_portal");
    assert_eq!(
        portal[0].action,
        "Choose “Sign in to Wi-Fi”, then open http://portal.example/."
    );

    let signing_in = diagnose(
        DeviceFacts {
            tunnel_up: false,
            connectivity: Some(Connectivity::CaptivePortal {
                login_url: Some("http://portal.example/".into()),
            }),
            portal_sign_in_until: Some(NOW + PORTAL_SIGN_IN_SECONDS - 30),
            ..healthy()
        },
        NOW,
    );
    assert_eq!(
        signing_in
            .iter()
            .map(|d| d.code.as_str())
            .collect::<Vec<_>>(),
        ["portal_sign_in", "captive_portal"],
        "a lowered tunnel during sign-in is expected, not an error"
    );
    assert!(signing_in[0].action.ends_with("in 5 min at the latest."));
    assert_eq!(
        signing_in[1].action,
        "Open http://portal.example/ to sign in."
    );

    let unknown_login = diagnose(
        DeviceFacts {
            connectivity: Some(Connectivity::CaptivePortal { login_url: None }),
            ..healthy()
        },
        NOW,
    );
    assert!(unknown_login[0].action.contains("open any website"));
    let ended = diagnose(
        DeviceFacts {
            portal_sign_in_until: Some(NOW - 1),
            ..healthy()
        },
        NOW,
    );
    assert_eq!(ended.len(), 1);
    assert_eq!(
        ended[0].message,
        "Protection was recently paused to sign in to Wi-Fi"
    );
    let expired = codes(DeviceFacts {
        tunnel_up: false,
        portal_sign_in_until: Some(NOW - 3600),
        ..healthy()
    });
    assert_eq!(expired, ["tunnel_down"]);
    assert_eq!(
        codes(DeviceFacts {
            connectivity: Some(Connectivity::Offline),
            ..healthy()
        }),
        ["offline"]
    );
    assert_eq!(
        codes(DeviceFacts {
            policy_reachable: false,
            ..healthy()
        }),
        ["policy_unreachable"]
    );
    assert_eq!(portal_sign_in_seconds(), PORTAL_SIGN_IN_SECONDS);
}

#[test]
fn diagnostics_are_reported_with_the_device_token() {
    let identity = Identity {
        service: "https://family.example".into(),
        private_key: String::new(),
        state: None,
    };
    let issues = diagnose(
        DeviceFacts {
            tunnel_up: false,
            ..healthy()
        },
        NOW,
    );
    assert!(diagnostics_request(identity.clone(), issues.clone()).is_err());
    let state = parse_device_state(
        200,
        r#"{"token":"tok","device_id":"dev","version":1,"policy":{"id":1,"name":"A"},
        "tunnel":{"address":"10.77.0.2/32","address_v6":"fd77::2/128","dns":"10.77.0.1","endpoint":"192.0.2.1:51820","public_key":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=","allowed_ips":"0.0.0.0/0, ::/0","keepalive":25},
        "status":{"reason":"allowed"}}"#
            .into(),
    )
    .unwrap();
    let req = diagnostics_request(
        Identity {
            state: Some(state),
            ..identity
        },
        issues,
    )
    .unwrap();
    assert_eq!(req.url, "https://family.example/v1/device/diagnostics");
    assert!(req
        .headers
        .iter()
        .any(|h| h.name == "Authorization" && h.value == "Bearer tok"));
    let body: serde_json::Value = serde_json::from_str(req.body.as_deref().unwrap()).unwrap();
    assert_eq!(body["issues"][0]["code"], "tunnel_down");
    assert_eq!(body["issues"][0]["severity"], "error");
}
