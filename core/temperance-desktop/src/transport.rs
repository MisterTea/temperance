use std::time::Duration;

use temperance_core::HttpRequest;

use crate::app::Transport;

/// Reaches home only through its WireGuard port (`temperance_core::remote::home_send`),
/// plus a plain-HTTP agent used only for the captive-portal probe.
pub struct Home {
    pub probe: ureq::Agent,
}

impl Home {
    pub fn system() -> Self {
        Home { probe: agent(5) }
    }
}

impl Transport for Home {
    fn send(&self, request: &HttpRequest, through_tunnel: bool) -> Result<(u16, String), String> {
        temperance_core::remote::home_send(request.clone(), through_tunnel)
            .map(|reply| (reply.status, reply.body))
            .map_err(|e| e.to_string())
    }
    fn probe(&self, request: &HttpRequest) -> Result<(u16, Option<String>, String), String> {
        let mut builder = ureq::http::Request::builder()
            .method(request.method.as_str())
            .uri(&request.url);
        for header in &request.headers {
            builder = builder.header(&header.name, &header.value);
        }
        let req = builder
            .body(request.body.clone().unwrap_or_default())
            .map_err(|e| e.to_string())?;
        let mut response = self.probe.run(req).map_err(|e| e.to_string())?;
        let status = response.status().as_u16();
        let location = response
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let body = response
            .body_mut()
            .with_config()
            .limit(64 << 10)
            .read_to_string()
            .unwrap_or_default();
        Ok((status, location, body))
    }
}

pub fn agent(timeout: u64) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(timeout)))
        .max_redirects(0)
        .http_status_as_error(false)
        .build()
        .into()
}
