//! What differs per OS: where data lives and how the tunnel is controlled.
use std::path::{Path, PathBuf};

use crate::app::TunnelControl;

#[cfg(windows)]
mod windows;

/// Windows runs the official WireGuard tunnel service; other systems have no
/// tunnel and open only the parent's dashboard.
pub fn tunnel() -> Box<dyn TunnelControl + Send> {
    #[cfg(windows)]
    return Box::new(windows::WireGuard::system());
    #[cfg(not(windows))]
    Box::new(NoTunnel)
}

pub struct NoTunnel;

impl TunnelControl for NoTunnel {
    fn up(&self, _config: &Path) -> Result<(), String> {
        Err(crate::app::CHILD_UNSUPPORTED.into())
    }
    fn down(&self, _config: &Path) -> Result<(), String> {
        Ok(())
    }
    fn is_up(&self) -> bool {
        false
    }
    fn handshake_age(&self) -> Option<u64> {
        None
    }
}

/// `--data <dir>`, else `%ProgramData%\Temperance` on Windows (the installer
/// limits it to administrators), else `temperance` under the user's config directory.
pub fn data_dir(
    mut args: impl Iterator<Item = String>,
    var: impl Fn(&str) -> Option<std::ffi::OsString>,
) -> PathBuf {
    while let Some(arg) = args.next() {
        if arg == "--data" {
            if let Some(dir) = args.next() {
                return PathBuf::from(dir);
            }
        }
    }
    if let Some(data) = var("ProgramData") {
        return PathBuf::from(data).join("Temperance");
    }
    let base = var("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| var("HOME").map(|h| PathBuf::from(h).join(".config")))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("temperance")
}
