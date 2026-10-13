use std::collections::HashMap;

use pretty_assertions::assert_eq;
use temperance_core::*;

const SERVER_KEY: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
// 2026-10-11 18:00 UTC = 13:00 in Chicago, a Sunday.
const SUNDAY_1PM: i64 = 1_791_741_600;
const PIN: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

/// The dashboard's "Set up a child's device" code.
fn home() -> String {
    format_home_link(&HomeLink {
        v: 1,
        host: "family.example".into(),
        port: 51820,
        pin: PIN.into(),
        household: "The Riveras".into(),
    })
}

fn url(path: &str) -> String {
    format!("temperance://{PIN}@family.example:51820{path}")
}

fn tunnel() -> Tunnel {
    Tunnel {
        address: "10.77.0.2/32".into(),
        address_v6: "fd77::2/128".into(),
        dns: "10.77.0.1".into(),
        endpoint: "192.0.2.1:51820".into(),
        public_key: SERVER_KEY.into(),
        allowed_ips: "0.0.0.0/0, ::/0".into(),
        keepalive: 25,
    }
}

fn state_json(reason: &str, extra_policy: &str) -> String {
    format!(
        r#"{{"token":"tok","device_id":"dev","version":3,
        "policy":{{"id":1,"name":"Alex","limit":60,"used":20,"timezone":"America/Chicago"{extra_policy}}},
        "tunnel":{{"address":"10.77.0.2/32","address_v6":"fd77::2/128","dns":"10.77.0.1","endpoint":"192.0.2.1:51820","public_key":"{SERVER_KEY}","allowed_ips":"0.0.0.0/0, ::/0","keepalive":25}},
        "status":{{"reason":"{reason}","remaining_minutes":40,"active_windows":[],"observed_at":0}},
        "requests":[]}}"#
    )
}

#[test]
fn keypairs_are_random_and_derivable() {
    let a = generate_keypair();
    let b = generate_keypair();
    assert_ne!(a.private_key, b.private_key);
    assert_eq!(public_key_for(a.private_key.clone()).unwrap(), a.public_key);
    assert!(public_key_for("short".into()).is_err());
}

#[test]
fn tunnel_config_is_full_tunnel_and_validated() {
    let keys = generate_keypair();
    let conf = tunnel_config(keys.private_key.clone(), tunnel()).unwrap();
    assert!(conf.contains("AllowedIPs = 0.0.0.0/0, ::/0"));
    assert!(conf.contains("Address = 10.77.0.2/32, fd77::2/128"));
    assert!(conf.contains(&format!("PrivateKey = {}", keys.private_key)));
    // Home gateways behind a changing IP use a dynamic-DNS name.
    for good in ["home.example.net:51820", "[2001:db8::1]:51820"] {
        let mut t = tunnel();
        t.endpoint = good.into();
        let conf = tunnel_config(keys.private_key.clone(), t).unwrap();
        assert!(conf.contains(&format!("Endpoint = {good}\n")), "{good}");
    }
    for (field, bad) in [
        ("address", "10.77.0.2"),
        ("address", "10.77.0.2/33"),
        ("address_v6", "fd77::2/129"),
        ("dns", "dns.example"),
        ("endpoint", "vpn.example:0"),
        ("endpoint", "vpn.example"),
        ("endpoint", "-vpn.example:51820"),
        ("endpoint", "vpn..example:51820"),
        ("endpoint", "999.1.1.1:51820"),
        ("endpoint", "vpn.example:51820\nPostUp = rm -rf /"),
        ("endpoint", "192.0.2.1:0"),
        ("public_key", "AAAA"),
        ("dns", "10.77.0.1\nPostUp = rm -rf /"),
    ] {
        let mut t = tunnel();
        match field {
            "address" => t.address = bad.into(),
            "address_v6" => t.address_v6 = bad.into(),
            "dns" => t.dns = bad.into(),
            "endpoint" => t.endpoint = bad.into(),
            _ => t.public_key = bad.into(),
        }
        assert!(
            tunnel_config(keys.private_key.clone(), t).is_err(),
            "{field}={bad}"
        );
    }
}

#[test]
fn the_home_setup_code_is_validated() {
    assert_eq!(validate_service(format!("  {}\n", home())).unwrap(), home());
    let parsed = parse_home_link(home()).unwrap();
    assert_eq!(
        (parsed.host.as_str(), parsed.port, parsed.household.as_str()),
        ("family.example", 51820, "The Riveras")
    );
    let with = |change: &dyn Fn(&mut HomeLink)| {
        let mut link = parse_home_link(home()).unwrap();
        change(&mut link);
        format_home_link(&link)
    };
    for bad in [
        "https://family.example".to_string(),
        "temperance://pair#e30".into(),
        "temperance://home#!!".into(),
        "temperance://home#e30".into(),
        with(&|l| l.host = "".into()),
        with(&|l| l.host = "evil.example/x".into()),
        with(&|l| l.host = "u@family.example".into()),
        with(&|l| l.port = 0),
        with(&|l| l.pin = "short".into()),
    ] {
        assert!(validate_service(bad.clone()).is_err(), "{bad}");
    }
    let newer = with(&|l| l.v = 2);
    assert!(validate_service(newer)
        .unwrap_err()
        .to_string()
        .contains("newer"));
}

#[test]
fn enrollment_flow_builds_requests_and_stores_identity() {
    let keys = generate_keypair();
    let req = enroll_request(
        home(),
        " code ".into(),
        " Phone ".into(),
        keys.public_key.clone(),
    )
    .unwrap();
    assert_eq!(req.method, "POST");
    assert_eq!(req.url, url("/v1/enroll"));
    let body: serde_json::Value = serde_json::from_str(req.body.as_deref().unwrap()).unwrap();
    assert_eq!(body["code"], "code");
    assert_eq!(body["name"], "Phone");
    assert_eq!(body["public_key"], keys.public_key.as_str());
    assert!(req.headers.iter().all(|h| h.name != "Authorization"));
    assert!(enroll_request(home(), "".into(), "Phone".into(), "k".into()).is_err());
    assert!(enroll_request(home(), "c".into(), " ".into(), "k".into()).is_err());
    assert!(enroll_request(home(), "c".into(), "x".repeat(81), "k".into()).is_err());

    let identity = enrolled_identity(home(), keys.clone(), 200, state_json("allowed", "")).unwrap();
    assert_eq!(
        identity.state.as_ref().unwrap().token.as_deref(),
        Some("tok")
    );
    let restored = identity_from_json(identity_to_json(identity.clone())).unwrap();
    assert_eq!(restored, identity);
    assert!(identity_from_json("{".into()).is_err());
    // A device set up with a web address before 0.5.4 keeps its keys but must be set up again.
    let old = identity_to_json(Identity {
        service: "https://family.example".into(),
        ..identity.clone()
    });
    let reloaded = identity_from_json(old).unwrap();
    assert_eq!(reloaded.state, None);
    assert_eq!(reloaded.private_key, identity.private_key);

    let state = state_request(identity.clone()).unwrap();
    assert_eq!(state.method, "GET");
    assert!(state.headers.contains(&Header {
        name: "Authorization".into(),
        value: "Bearer tok".into()
    }));
    let ask = time_request(identity.clone(), 20, "  homework  ".into()).unwrap();
    assert_eq!(ask.url, url("/v1/device/requests"));
    assert!(ask.body.unwrap().contains("\"homework\""));
    assert!(time_request(identity.clone(), 0, "".into()).is_err());
    assert!(time_request(identity.clone(), 181, "".into()).is_err());
    let unenrolled = Identity {
        state: None,
        ..identity.clone()
    };
    assert!(state_request(unenrolled.clone()).is_err());
    assert!(time_request(unenrolled, 5, "".into()).is_err());

    let tokenless = state_json("allowed", "").replace("\"token\":\"tok\",", "");
    assert!(enrolled_identity(home(), keys, 200, tokenless).is_err());
}

#[test]
fn responses_surface_service_errors() {
    assert_eq!(
        parse_device_state(401, r#"{"error":"Invalid or revoked device"}"#.into()).unwrap_err(),
        CoreError::Service {
            status: 401,
            detail: "Invalid or revoked device".into()
        }
    );
    assert_eq!(
        parse_device_state(502, "<html>".into())
            .unwrap_err()
            .to_string(),
        "Policy service returned 502"
    );
    assert!(parse_device_state(200, "{}".into()).is_err());
    assert!(parse_device_state(200, " ".repeat(2 << 20)).is_err());
    let request = parse_time_request(
        200,
        r#"{"id":"r","minutes":10,"message":"pls","status":"pending","at":1}"#.into(),
    )
    .unwrap();
    assert_eq!(request.status, "pending");
    assert!(parse_time_request(200, "[]".into()).is_err());
    assert!(parse_time_request(
        400,
        r#"{"error":"You already have a pending request"}"#.into()
    )
    .is_err());
}

#[test]
fn refresh_preserves_token_and_guards_live_tunnels() {
    let keys = generate_keypair();
    let identity = enrolled_identity(home(), keys, 200, state_json("allowed", "")).unwrap();
    let mut latest = parse_device_state(
        200,
        state_json("bedtime", "")
            .replace("\"token\":\"tok\",", "")
            .replace("\"version\":3", "\"version\":4"),
    )
    .unwrap();
    let next = refreshed_identity(identity.clone(), latest.clone(), true).unwrap();
    assert_eq!(next.state.as_ref().unwrap().token.as_deref(), Some("tok"));
    assert_eq!(next.state.as_ref().unwrap().version, 4);
    latest.tunnel.endpoint = "198.51.100.1:51820".into();
    assert!(refreshed_identity(identity.clone(), latest.clone(), true).is_err());
    assert!(refreshed_identity(identity.clone(), latest.clone(), false).is_ok());
    latest.version = 1;
    assert!(refreshed_identity(identity.clone(), latest.clone(), false).is_err());
    assert!(refreshed_identity(
        Identity {
            state: None,
            ..identity
        },
        latest,
        false
    )
    .is_err());
}

#[test]
fn child_status_explains_rules_and_next_change() {
    let allowed = parse_device_state(
        200,
        state_json("allowed", r#","bedtime":{"start":"13:30","end":"07:00"}"#),
    )
    .unwrap();
    let status = child_status(allowed.clone(), SUNDAY_1PM).unwrap();
    assert_eq!(status.headline, "You're online");
    assert!(status.allowed);
    assert_eq!(status.remaining_minutes, Some(40));
    assert_eq!(
        status.next_change.as_deref(),
        Some("Bedtime starts in 30 min")
    );
    assert!(status.can_request_time);

    let mut bedtime = allowed.clone();
    bedtime.status.reason = "bedtime".into();
    let s = child_status(bedtime, SUNDAY_1PM + 3600).unwrap();
    assert_eq!(s.headline, "Bedtime");
    assert!(!s.allowed);
    assert_eq!(s.next_change.as_deref(), Some("Back online in 17h 0m"));

    for (reason, headline) in [
        ("paused", "Internet paused"),
        ("household pause", "Internet paused"),
        ("device pause", "Internet paused"),
        ("off time", "Off Time"),
        ("daily limit", "Time's up for today"),
        ("focus time", "Limited right now"),
        ("unmanaged", "You're online"),
    ] {
        let mut st = allowed.clone();
        st.status.reason = reason.into();
        st.requests = vec![TimeRequest {
            id: "r".into(),
            minutes: 5,
            message: String::new(),
            status: "pending".into(),
            at: 0,
        }];
        let s = child_status(st, SUNDAY_1PM).unwrap();
        assert_eq!(s.headline, headline, "{reason}");
        assert!(!s.detail.is_empty());
        assert!(s.pending_request && !s.can_request_time);
    }
    for reason in ["paused", "household pause", "device pause"] {
        let mut st = allowed.clone();
        st.status.reason = reason.into();
        assert!(
            !child_status(st, SUNDAY_1PM).unwrap().can_request_time,
            "{reason}"
        );
    }
    let mut limit = allowed.clone();
    limit.status.reason = "daily limit".into();
    assert!(child_status(limit, SUNDAY_1PM).unwrap().can_request_time);
    let mut unknown = allowed;
    unknown.policy.timezone = Some("Mars/Base".into());
    assert!(child_status(unknown, SUNDAY_1PM).is_err());
}

#[test]
fn policy_engine_edge_cases() {
    let tz = "America/Chicago".to_string();
    let mut p = Profile {
        name: "A".into(),
        filter_level: "teen".into(),
        ..Profile::default()
    };
    assert!(domain_matches(
        "a.b.example.com".into(),
        "example.com".into()
    ));
    assert!(!domain_matches(
        "badexample.com".into(),
        "example.com".into()
    ));
    assert_eq!(
        domain_reason(
            p.clone(),
            "example.com".into(),
            tz.clone(),
            SUNDAY_1PM,
            false
        )
        .unwrap(),
        "allowed"
    );
    p.deny = vec!["example.com".into()];
    assert_eq!(
        domain_reason(
            p.clone(),
            "www.example.com".into(),
            tz.clone(),
            SUNDAY_1PM,
            false
        )
        .unwrap(),
        "custom rule"
    );
    p.allow_only = true;
    assert_eq!(
        domain_reason(
            p.clone(),
            "other.test".into(),
            tz.clone(),
            SUNDAY_1PM,
            false
        )
        .unwrap(),
        "allow-list only"
    );
    p.allow_only = false;
    p.categories = vec!["social".into()];
    assert_eq!(
        domain_reason(
            p.clone(),
            "reddit.com".into(),
            tz.clone(),
            SUNDAY_1PM,
            false
        )
        .unwrap(),
        "social"
    );
    p.site_limits = HashMap::from([("roblox.com".into(), 30)]);
    p.bucket_usage = HashMap::from([("site:roblox.com".into(), 30)]);
    assert_eq!(
        domain_reason(
            p.clone(),
            "www.roblox.com".into(),
            tz.clone(),
            SUNDAY_1PM,
            false
        )
        .unwrap(),
        "limit site:roblox.com"
    );
    p.site_limits.clear();
    p.app_limits = vec![temperance_core::AppLimit {
        id: "games".into(),
        name: "Games".into(),
        domains: vec!["roblox.com".into(), "minecraft.net".into()],
        minutes: 45,
    }];
    p.bucket_usage = HashMap::from([("group:games".into(), 45)]);
    for host in ["minecraft.net", "www.roblox.com"] {
        assert_eq!(
            domain_reason(p.clone(), host.into(), tz.clone(), SUNDAY_1PM, false).unwrap(),
            "limit group:games"
        );
    }
    p.bucket_usage = HashMap::from([("group:games".into(), 44)]);
    assert_eq!(
        domain_reason(
            p.clone(),
            "minecraft.net".into(),
            tz.clone(),
            SUNDAY_1PM,
            false
        )
        .unwrap(),
        "allowed"
    );
    p.app_limits.clear();
    p.managed = false;
    assert_eq!(
        access_reason(p.clone(), tz.clone(), SUNDAY_1PM, true).unwrap(),
        "allowed"
    );
    assert_eq!(
        domain_reason(p.clone(), "x.com".into(), tz.clone(), SUNDAY_1PM, false).unwrap(),
        "unmanaged"
    );
    assert!(access_reason(p, "Nowhere/Zone".into(), 0, false).is_err());

    let late = Profile {
        bedtime: Bedtime {
            start: "12:00".into(),
            end: "14:00".into(),
            days: (0..7).collect(),
        },
        rewards: vec![Reward {
            id: "r".into(),
            kind: "late_bedtime".into(),
            day: "2026-10-11".into(),
            minutes: None,
            bedtime: Some("13:30".into()),
            window_id: None,
            scope: None,
        }],
        ..Profile::default()
    };
    assert_eq!(
        access_reason(late, tz.clone(), SUNDAY_1PM, false).unwrap(),
        "allowed"
    );
    let off = Profile {
        schedules: vec![Window {
            id: "w".into(),
            name: "Dinner".into(),
            mode: "off".into(),
            start: "12:30".into(),
            end: "13:30".into(),
            days: vec![0],
            allow: vec![],
            allowed_categories: vec![],
        }],
        ..Profile::default()
    };
    assert_eq!(
        access_reason(off, tz, SUNDAY_1PM, false).unwrap(),
        "off time"
    );
    assert!(!core_version().is_empty());
}

#[test]
fn location_requests_are_validated_and_scoped() {
    let keys = generate_keypair();
    let identity = enrolled_identity(home(), keys, 200, state_json("allowed", "")).unwrap();
    assert!(!identity.state.as_ref().unwrap().location_requested);
    let req = location_request(identity.clone(), 41.88, -87.63, 12.5).unwrap();
    assert_eq!(req.url, url("/v1/device/location"));
    let body: serde_json::Value = serde_json::from_str(req.body.as_deref().unwrap()).unwrap();
    assert_eq!(body["latitude"], 41.88);
    assert_eq!(body["accuracy"], 12.5);
    for (lat, lon, acc) in [
        (91.0, 0.0, 1.0),
        (0.0, -181.0, 1.0),
        (0.0, 0.0, -1.0),
        (f64::NAN, 0.0, 1.0),
    ] {
        assert!(location_request(identity.clone(), lat, lon, acc).is_err());
    }
    let denied =
        location_unavailable_request(identity.clone(), "  permission denied ".into()).unwrap();
    assert!(denied.body.unwrap().contains("\"permission denied\""));
    assert!(location_unavailable_request(identity.clone(), " ".into())
        .unwrap()
        .body
        .unwrap()
        .contains("\"unavailable\""));
    assert!(location_request(
        Identity {
            state: None,
            ..identity
        },
        0.0,
        0.0,
        1.0
    )
    .is_err());
    let asked = parse_device_state(
        200,
        state_json("allowed", "").replace(
            "\"requests\":[]",
            "\"requests\":[],\"location_requested\":true",
        ),
    )
    .unwrap();
    assert!(asked.location_requested);
    assert!(parse_ok(200, "{\"ok\":true}".into()).is_ok());
    assert!(parse_ok(400, r#"{"error":"No location request is pending"}"#.into()).is_err());
}

#[test]
fn child_alerts_fire_once_on_transitions() {
    let base = parse_device_state(
        200,
        state_json("allowed", r#","bedtime":{"start":"13:30","end":"07:00"}"#),
    )
    .unwrap();
    assert!(child_alerts(None, base.clone(), SUNDAY_1PM).is_empty());

    let mut earlier = base.clone();
    earlier.status.observed_at = SUNDAY_1PM - 600; // bedtime 40 min away
    let mut soon = base.clone();
    soon.status.observed_at = SUNDAY_1PM + 1200; // 10 min away
    soon.status.remaining_minutes = Some(12);
    soon.policy.rewards = vec![Reward {
        id: "r1".into(),
        kind: "extra_time".into(),
        day: "2026-10-11".into(),
        minutes: Some(15),
        bedtime: None,
        window_id: None,
        scope: None,
    }];
    earlier.requests = vec![TimeRequest {
        id: "q".into(),
        minutes: 20,
        message: String::new(),
        status: "pending".into(),
        at: 0,
    }];
    soon.requests = vec![TimeRequest {
        status: "approved".into(),
        ..earlier.requests[0].clone()
    }];
    let alerts = child_alerts(Some(earlier), soon.clone(), SUNDAY_1PM + 1200);
    assert_eq!(
        alerts,
        vec![
            "12 minutes left today".to_string(),
            "Bedtime starts in 10 min".into(),
            "A parent gave you 15 extra minutes today".into(),
            "Your request for 20 minutes was approved".into(),
        ]
    );
    assert!(child_alerts(Some(soon.clone()), soon.clone(), SUNDAY_1PM + 1260).is_empty());

    let mut granted = soon.clone();
    granted.policy.rewards[0].minutes = Some(20);
    let mut asking = granted.clone();
    asking.policy.rewards.clear();
    asking.requests[0].status = "pending".into();
    assert_eq!(
        child_alerts(Some(asking), granted, SUNDAY_1PM),
        vec!["Your request for 20 minutes was approved".to_string()]
    );

    let mut done = soon.clone();
    done.status.reason = "daily limit".into();
    done.status.remaining_minutes = Some(0);
    done.requests[0].status = "denied".into();
    let mut asked = soon.clone();
    asked.requests[0].status = "pending".into();
    done.policy.rewards.push(Reward {
        id: "r2".into(),
        kind: "late_bedtime".into(),
        day: "2026-10-11".into(),
        minutes: None,
        bedtime: Some("21:30".into()),
        window_id: None,
        scope: None,
    });
    done.policy.rewards.push(Reward {
        id: "r3".into(),
        kind: "skip_window".into(),
        day: "2026-10-11".into(),
        minutes: None,
        bedtime: None,
        window_id: Some("w".into()),
        scope: None,
    });
    done.policy.rewards.push(Reward {
        id: "r4".into(),
        kind: "mystery".into(),
        day: "2026-10-11".into(),
        minutes: None,
        bedtime: None,
        window_id: None,
        scope: None,
    });
    assert_eq!(
        child_alerts(Some(asked), done, SUNDAY_1PM + 1300),
        vec![
            "Time's up for today".to_string(),
            "A parent moved bedtime to 21:30 tonight".into(),
            "A parent skipped a schedule for you today".into(),
            "A parent sent you a reward".into(),
            "Your request for 20 minutes was declined".into(),
        ]
    );
}

#[test]
fn client_password_sign_in_is_scoped_and_goes_to_the_home_gateway() {
    let request = sign_in_request(
        home(),
        " alex ".into(),
        "user-password".into(),
        "Phone".into(),
        "public-key".into(),
    )
    .unwrap();
    assert_eq!(request.url, url("/v1/device/login"));
    let body: serde_json::Value = serde_json::from_str(request.body.as_deref().unwrap()).unwrap();
    assert_eq!(body["username"], "alex");
    assert_eq!(body["password"], "user-password");
    assert!(body.get("profile_id").is_none());
    assert!(body.get("grant_type").is_none());
    assert!(sign_in_request(
        "https://family.example".into(),
        "alex".into(),
        "password".into(),
        "Phone".into(),
        "key".into()
    )
    .is_err());
    assert!(sign_in_request(
        home(),
        "alex".into(),
        "".into(),
        "Phone".into(),
        "key".into()
    )
    .is_err());
}
