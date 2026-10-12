//! Node-API bindings used by the Next.js server (`web/gateway-addon`).
//! State, configuration and activity cross the boundary as JSON strings.
use napi::{Error, Result};
use napi_derive::napi;

use crate::{Config, Gateway};

fn error(e: impl std::fmt::Display) -> Error {
    Error::from_reason(e.to_string())
}

#[napi]
pub struct GatewayHandle {
    inner: Option<Gateway>,
}

#[napi]
impl GatewayHandle {
    /// Bind the WireGuard socket and start forwarding once a state is applied.
    #[napi(factory)]
    pub fn start(config: String) -> Result<Self> {
        let config: Config = serde_json::from_str(&config).map_err(error)?;
        Ok(GatewayHandle {
            inner: Some(Gateway::start(config).map_err(error)?),
        })
    }

    fn gateway(&self) -> Result<&Gateway> {
        self.inner.as_ref().ok_or_else(|| error("Gateway stopped"))
    }

    #[napi]
    pub fn public_key(&self) -> Result<String> {
        Ok(self.gateway()?.public_key())
    }

    #[napi]
    pub fn port(&self) -> Result<u32> {
        Ok(u32::from(self.gateway()?.local_addr().port()))
    }

    #[napi]
    pub fn apply_state(&self, state: String) -> Result<()> {
        self.gateway()?.apply_state(&state).map_err(error)
    }

    #[napi]
    pub fn drain_activity(&self) -> Result<String> {
        Ok(self.gateway()?.drain_activity().to_string())
    }

    #[napi]
    pub fn stop(&mut self) {
        if let Some(mut gateway) = self.inner.take() {
            gateway.stop();
        }
    }
}

#[napi]
pub fn generate_private_key() -> String {
    crate::generate_private_key()
}

#[napi]
pub fn public_key(private_key: String) -> Result<String> {
    crate::public_key(&private_key).map_err(error)
}
