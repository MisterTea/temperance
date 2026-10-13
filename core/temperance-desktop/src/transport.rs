use std::time::Duration;

use temperance_core::HttpRequest;

use crate::app::Transport;

/// HTTPS-only agent for the policy service, plus a plain-HTTP agent used only for
/// the captive-portal probe.
pub struct Https {
    pub policy: ureq::Agent,
    pub probe: ureq::Agent,
}

impl Https {
    pub fn system() -> Self {
        Https {
            policy: agent(15, true),
            probe: agent(5, false),
        }
    }
}

fn run(
    agent: &ureq::Agent,
    request: &HttpRequest,
    limit: u64,
) -> Result<(u16, Option<String>, String), String> {
    let mut builder = ureq::http::Request::builder()
        .method(request.method.as_str())
        .uri(&request.url);
    for header in &request.headers {
        builder = builder.header(&header.name, &header.value);
    }
    let req = builder
        .body(request.body.clone().unwrap_or_default())
        .map_err(|e| e.to_string())?;
    let mut response = agent.run(req).map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let location = response
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let body = response
        .body_mut()
        .with_config()
        .limit(limit)
        .read_to_string()
        .unwrap_or_default();
    Ok((status, location, body))
}

impl Transport for Https {
    fn send(&self, request: &HttpRequest) -> Result<(u16, String), String> {
        run(&self.policy, request, 1 << 20).map(|(status, _, body)| (status, body))
    }
    fn probe(&self, request: &HttpRequest) -> Result<(u16, Option<String>, String), String> {
        run(&self.probe, request, 64 << 10)
    }
}

pub fn agent(timeout: u64, https_only: bool) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(timeout)))
        .max_redirects(0)
        .http_status_as_error(false)
        .https_only(https_only)
        .build()
        .into()
}
