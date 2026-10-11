//! Connectivity and permission diagnostics shared by every client, including
//! captive-portal detection. Platforms gather facts; the core decides what
//! they mean and what the child (and parents) should be told.
use serde::Serialize;

use crate::{api::authorized, CoreError, HttpRequest, Identity};

/// How long a desktop may lower its tunnel to complete a Wi-Fi sign-in page.
pub const PORTAL_SIGN_IN_SECONDS: i64 = 300;
/// A WireGuard handshake older than this means the gateway is unreachable.
pub const STALE_HANDSHAKE_SECONDS: u64 = 180;
const RECENT_SIGN_IN_SECONDS: i64 = 3600;
const PROBE_URL: &str = "http://connectivitycheck.gstatic.com/generate_204";

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum Connectivity {
    Online,
    CaptivePortal { login_url: Option<String> },
    Offline,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, uniffi::Enum)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    Info,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, uniffi::Record)]
pub struct Diagnostic {
    pub code: String,
    pub severity: Severity,
    pub message: String,
    pub action: String,
}

/// Facts a platform can observe. `None` means not applicable or unknown.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct DeviceFacts {
    pub vpn_permission: Option<bool>,
    pub tunnel_up: bool,
    pub seconds_since_handshake: Option<u64>,
    pub connectivity: Option<Connectivity>,
    pub policy_reachable: bool,
    pub notifications_allowed: Option<bool>,
    pub location_allowed: Option<bool>,
    pub portal_sign_in_until: Option<i64>,
}

#[uniffi::export]
pub fn portal_sign_in_seconds() -> i64 {
    PORTAL_SIGN_IN_SECONDS
}

/// Plain-HTTP probe; it must be sent outside the tunnel and without following redirects.
#[uniffi::export]
pub fn captive_portal_probe() -> HttpRequest {
    HttpRequest {
        method: "GET".into(),
        url: PROBE_URL.into(),
        headers: vec![crate::Header {
            name: "Cache-Control".into(),
            value: "no-cache".into(),
        }],
        body: None,
    }
}

/// Interprets the probe. Use status 0 when the request failed entirely.
#[uniffi::export]
pub fn parse_captive_portal_probe(
    status: u16,
    location: Option<String>,
    body: String,
) -> Connectivity {
    let login_url = location
        .filter(|l| url::Url::parse(l).is_ok_and(|u| matches!(u.scheme(), "http" | "https")));
    match status {
        204 => Connectivity::Online,
        200 if body.trim().is_empty() => Connectivity::Online,
        200 | 511 => Connectivity::CaptivePortal { login_url: None },
        301 | 302 | 303 | 307 | 308 => Connectivity::CaptivePortal { login_url },
        _ => Connectivity::Offline,
    }
}

fn issue(code: &str, severity: Severity, message: &str, action: String) -> Diagnostic {
    Diagnostic {
        code: code.into(),
        severity,
        message: message.into(),
        action,
    }
}

#[uniffi::export]
pub fn diagnose(facts: DeviceFacts, now: i64) -> Vec<Diagnostic> {
    let mut found = vec![];
    let signing_in = facts.portal_sign_in_until.filter(|until| *until > now);
    if facts.vpn_permission == Some(false) {
        found.push(issue(
            "vpn_permission",
            Severity::Error,
            "VPN permission is turned off",
            "Open Temperance and allow the VPN connection.".into(),
        ));
    }
    match facts.portal_sign_in_until {
        Some(until) if until > now => {
            let minutes = ((until - now) as f64 / 60.0).ceil() as i64;
            found.push(issue(
                "portal_sign_in",
                Severity::Warning,
                "Protection is paused to sign in to Wi-Fi",
                format!(
                    "Protection resumes when the network is online, or in {minutes} min at the latest."
                ),
            ));
        }
        // Devices are usually offline during sign-in, so parents learn of it afterwards.
        Some(until) if now - until < RECENT_SIGN_IN_SECONDS => found.push(issue(
            "portal_sign_in",
            Severity::Warning,
            "Protection was recently paused to sign in to Wi-Fi",
            "Protection resumed automatically.".into(),
        )),
        _ => {}
    }
    match &facts.connectivity {
        Some(Connectivity::CaptivePortal { login_url }) => found.push(issue(
            "captive_portal",
            Severity::Warning,
            "This Wi-Fi needs a sign-in page",
            match login_url {
                Some(url) if signing_in.is_some() => format!("Open {url} to sign in."),
                Some(url) => format!("Choose “Sign in to Wi-Fi”, then open {url}."),
                None => "Choose “Sign in to Wi-Fi”, then open any website to sign in.".into(),
            },
        )),
        Some(Connectivity::Offline) => found.push(issue(
            "offline",
            Severity::Info,
            "No internet connection",
            "Connect to Wi-Fi or mobile data.".into(),
        )),
        _ => {}
    }
    let permission_off = facts.vpn_permission == Some(false);
    if !facts.tunnel_up && !permission_off && signing_in.is_none() {
        found.push(issue(
            "tunnel_down",
            Severity::Error,
            "The VPN is not running",
            "Start the VPN in Temperance.".into(),
        ));
    }
    let stale = facts.tunnel_up
        && facts
            .seconds_since_handshake
            .is_some_and(|age| age > STALE_HANDSHAKE_SECONDS);
    if stale {
        found.push(issue(
            "gateway_unreachable",
            Severity::Warning,
            "The VPN cannot reach your family's gateway",
            "This network may block VPNs or need a sign-in page; try “Sign in to Wi-Fi”.".into(),
        ));
    }
    if !facts.policy_reachable && facts.tunnel_up && !stale {
        found.push(issue(
            "policy_unreachable",
            Severity::Warning,
            "Cannot reach the policy service",
            "The last rules received stay in effect.".into(),
        ));
    }
    if facts.notifications_allowed == Some(false) {
        found.push(issue(
            "notifications_off",
            Severity::Info,
            "Alerts are turned off",
            "Allow notifications so Temperance can warn before time runs out.".into(),
        ));
    }
    if facts.location_allowed == Some(false) {
        found.push(issue(
            "location_off",
            Severity::Info,
            "Location sharing is off",
            "Parents' location requests will be declined.".into(),
        ));
    }
    found.sort_by_key(|d| d.severity.clone() as u8);
    found
}

/// Reports the current diagnostics so parents can see device health.
#[uniffi::export]
pub fn diagnostics_request(
    identity: Identity,
    diagnostics: Vec<Diagnostic>,
) -> Result<HttpRequest, CoreError> {
    let issues: Vec<_> = diagnostics.into_iter().take(10).collect();
    let body = serde_json::json!({ "issues": issues });
    authorized(
        "POST",
        &identity,
        "/v1/device/diagnostics",
        Some(body.to_string()),
    )
}
