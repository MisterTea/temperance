//! Sans-IO protocol layer: builds requests and parses responses so each
//! platform only supplies its native HTTPS transport.
use serde::{Deserialize, Serialize};
use url::Url;

use crate::{policy::Profile, policy::Window, tunnel::Tunnel, CoreError};

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct Header {
    pub name: String,
    pub value: String,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<Header>,
    pub body: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, uniffi::Record)]
pub struct DeviceStatus {
    pub reason: String,
    #[serde(default)]
    pub remaining_minutes: Option<u32>,
    #[serde(default)]
    pub active_windows: Vec<Window>,
    #[serde(default)]
    pub observed_at: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, uniffi::Record)]
pub struct TimeRequest {
    pub id: String,
    pub minutes: u32,
    #[serde(default)]
    pub message: String,
    pub status: String,
    pub at: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, uniffi::Record)]
pub struct DeviceState {
    pub device_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    pub version: u64,
    pub policy: Profile,
    pub tunnel: Tunnel,
    pub status: DeviceStatus,
    #[serde(default)]
    pub requests: Vec<TimeRequest>,
    /// A parent asked this device to share its location once.
    #[serde(default)]
    pub location_requested: bool,
}

/// Everything a device persists in its platform keychain/keystore.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, uniffi::Record)]
pub struct Identity {
    pub service: String,
    pub private_key: String,
    #[serde(default)]
    pub state: Option<DeviceState>,
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::Invalid {
        detail: message.into(),
    }
}

/// Accepts only a bare HTTPS origin (no credentials, path, query, or fragment).
#[uniffi::export]
pub fn validate_service(raw: String) -> Result<String, CoreError> {
    let trimmed = raw.trim().trim_end_matches('/');
    let url = Url::parse(trimmed).map_err(|_| invalid("Enter an HTTPS service origin"))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || (url.path() != "/" && !url.path().is_empty())
    {
        return Err(invalid("Enter an HTTPS service origin"));
    }
    Ok(url.origin().ascii_serialization())
}

fn request(
    method: &str,
    service: &str,
    path: &str,
    token: Option<&str>,
    body: Option<String>,
) -> Result<HttpRequest, CoreError> {
    let origin = validate_service(service.to_string())?;
    let mut headers = vec![Header {
        name: "Accept".into(),
        value: "application/json".into(),
    }];
    if body.is_some() {
        headers.push(Header {
            name: "Content-Type".into(),
            value: "application/json".into(),
        });
    }
    if let Some(token) = token {
        headers.push(Header {
            name: "Authorization".into(),
            value: format!("Bearer {token}"),
        });
    }
    Ok(HttpRequest {
        method: method.into(),
        url: format!("{origin}{path}"),
        headers,
        body,
    })
}

#[uniffi::export]
pub fn enroll_request(
    service: String,
    code: String,
    name: String,
    public_key: String,
) -> Result<HttpRequest, CoreError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(invalid("Enter a device name up to 80 characters"));
    }
    if code.trim().is_empty() {
        return Err(invalid("Enter the enrollment code from a parent"));
    }
    let body = serde_json::json!({ "code": code.trim(), "name": name, "public_key": public_key });
    request("POST", &service, "/v1/enroll", None, Some(body.to_string()))
}

#[uniffi::export]
pub fn state_request(identity: Identity) -> Result<HttpRequest, CoreError> {
    let token = identity
        .state
        .as_ref()
        .and_then(|s| s.token.clone())
        .ok_or_else(|| invalid("Enroll first"))?;
    request(
        "GET",
        &identity.service,
        "/v1/device/state",
        Some(&token),
        None,
    )
}

/// A child's request for more time, sent to parents for approval.
#[uniffi::export]
pub fn time_request(
    identity: Identity,
    minutes: u32,
    message: String,
) -> Result<HttpRequest, CoreError> {
    if !(1..=180).contains(&minutes) {
        return Err(invalid("Ask for 1 to 180 minutes"));
    }
    let token = identity
        .state
        .as_ref()
        .and_then(|s| s.token.clone())
        .ok_or_else(|| invalid("Enroll first"))?;
    let body = serde_json::json!({ "minutes": minutes, "message": message.trim().chars().take(300).collect::<String>() });
    request(
        "POST",
        &identity.service,
        "/v1/device/requests",
        Some(&token),
        Some(body.to_string()),
    )
}

/// Answers a parent's one-time location request.
#[uniffi::export]
pub fn location_request(
    identity: Identity,
    latitude: f64,
    longitude: f64,
    accuracy_meters: f64,
) -> Result<HttpRequest, CoreError> {
    if !(-90.0..=90.0).contains(&latitude)
        || !(-180.0..=180.0).contains(&longitude)
        || !(0.0..=1e6).contains(&accuracy_meters)
    {
        return Err(invalid("Location is out of range"));
    }
    let token = identity
        .state
        .as_ref()
        .and_then(|s| s.token.clone())
        .ok_or_else(|| invalid("Enroll first"))?;
    let body = serde_json::json!({ "latitude": latitude, "longitude": longitude, "accuracy": accuracy_meters });
    request(
        "POST",
        &identity.service,
        "/v1/device/location",
        Some(&token),
        Some(body.to_string()),
    )
}

/// Tells parents why a location request could not be answered (e.g. permission denied).
#[uniffi::export]
pub fn location_unavailable_request(
    identity: Identity,
    reason: String,
) -> Result<HttpRequest, CoreError> {
    let reason: String = reason.trim().chars().take(120).collect();
    let token = identity
        .state
        .as_ref()
        .and_then(|s| s.token.clone())
        .ok_or_else(|| invalid("Enroll first"))?;
    let body = serde_json::json!({ "unavailable": if reason.is_empty() { "unavailable".to_string() } else { reason } });
    request(
        "POST",
        &identity.service,
        "/v1/device/location",
        Some(&token),
        Some(body.to_string()),
    )
}

/// Checks a response that carries no data the client needs.
#[uniffi::export]
pub fn parse_ok(status: u16, body: String) -> Result<(), CoreError> {
    checked(status, &body)
}

fn checked(status: u16, body: &str) -> Result<(), CoreError> {
    if status == 200 {
        return Ok(());
    }
    let message = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
        .unwrap_or_else(|| format!("Policy service returned {status}"));
    Err(CoreError::Service {
        status,
        detail: message,
    })
}

#[uniffi::export]
pub fn parse_device_state(status: u16, body: String) -> Result<DeviceState, CoreError> {
    checked(status, &body)?;
    if body.len() > 1 << 20 {
        return Err(invalid("Policy response too large"));
    }
    serde_json::from_str(&body).map_err(|e| invalid(format!("Unexpected policy response: {e}")))
}

#[uniffi::export]
pub fn parse_time_request(status: u16, body: String) -> Result<TimeRequest, CoreError> {
    checked(status, &body)?;
    serde_json::from_str(&body).map_err(|e| invalid(format!("Unexpected response: {e}")))
}

/// Completes enrollment: stores the issued token and validates provisioning.
#[uniffi::export]
pub fn enrolled_identity(
    service: String,
    keys: crate::tunnel::KeyPair,
    status: u16,
    body: String,
) -> Result<Identity, CoreError> {
    let state = parse_device_state(status, body)?;
    if state.token.as_deref().unwrap_or("").is_empty() {
        return Err(invalid(
            "Enrollment response did not include a device token",
        ));
    }
    crate::tunnel::tunnel_config(keys.private_key.clone(), state.tunnel.clone())?;
    Ok(Identity {
        service: validate_service(service)?,
        private_key: keys.private_key,
        state: Some(state),
    })
}

/// Applies a refreshed state while keeping the device token. A connected
/// tunnel is never silently re-pointed at different provisioning.
#[uniffi::export]
pub fn refreshed_identity(
    identity: Identity,
    latest: DeviceState,
    connected: bool,
) -> Result<Identity, CoreError> {
    let previous = identity
        .state
        .clone()
        .ok_or_else(|| invalid("Enroll first"))?;
    crate::tunnel::tunnel_config(identity.private_key.clone(), latest.tunnel.clone())?;
    if connected && previous.tunnel != latest.tunnel {
        return Err(invalid(
            "Tunnel provisioning changed; restart with parent supervision",
        ));
    }
    if latest.version < previous.version {
        return Err(invalid("Refusing an older policy version"));
    }
    Ok(Identity {
        state: Some(DeviceState {
            token: previous.token,
            ..latest
        }),
        ..identity
    })
}

#[uniffi::export]
pub fn identity_to_json(identity: Identity) -> String {
    serde_json::to_string(&identity).expect("identity serializes")
}

#[uniffi::export]
pub fn identity_from_json(json: String) -> Result<Identity, CoreError> {
    serde_json::from_str(&json).map_err(|e| invalid(format!("Stored identity is unreadable: {e}")))
}
