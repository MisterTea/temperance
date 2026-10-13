//! The official WireGuard for Windows tunnel service.
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use crate::app::TunnelControl;

const SERVICE: &str = "WireGuardTunnel$temperance";

pub struct WireGuard {
    tools: PathBuf,
}

impl WireGuard {
    pub fn system() -> Self {
        WireGuard {
            tools: PathBuf::from(std::env::var("ProgramFiles").unwrap_or_default())
                .join("WireGuard"),
        }
    }
    fn tool(&self, name: &str) -> Command {
        Command::new(self.tools.join(format!("{name}.exe")))
    }
}

impl TunnelControl for WireGuard {
    fn is_up(&self) -> bool {
        Command::new("sc.exe")
            .args(["query", SERVICE])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains("RUNNING"))
            .unwrap_or(false)
    }
    /// Returns once the service runs, so the next view doesn't call it stopped,
    /// and gives the first handshake a moment so it isn't reported as stale.
    fn up(&self, config: &Path) -> Result<(), String> {
        command_result(
            self.tool("wireguard")
                .arg("/installtunnelservice")
                .arg(config)
                .output(),
        )?;
        if !wait_until(Duration::from_secs(15), || self.is_up()) {
            return Err("WireGuard: the tunnel service did not start".into());
        }
        wait_until(Duration::from_secs(5), || {
            self.handshake_age().is_some_and(|age| age != u64::MAX)
        });
        Ok(())
    }
    fn down(&self, _config: &Path) -> Result<(), String> {
        command_result(
            self.tool("wireguard")
                .args(["/uninstalltunnelservice", "temperance"])
                .output(),
        )
    }
    fn handshake_age(&self) -> Option<u64> {
        let output = self
            .tool("wg")
            .args(["show", "temperance", "latest-handshakes"])
            .output()
            .ok()
            .filter(|o| o.status.success())?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_secs();
        handshake_age(&String::from_utf8_lossy(&output.stdout), now)
    }
}

/// Parses `wg show <if> latest-handshakes` ("<peer key>\t<unix seconds>" per line).
fn handshake_age(output: &str, now: u64) -> Option<u64> {
    let latest: u64 = output
        .lines()
        .filter_map(|line| line.split_whitespace().nth(1)?.parse().ok())
        .max()?;
    // Zero means no handshake has ever completed.
    Some(if latest == 0 {
        u64::MAX
    } else {
        now.saturating_sub(latest)
    })
}

fn wait_until(limit: Duration, mut done: impl FnMut() -> bool) -> bool {
    let end = Instant::now() + limit;
    loop {
        if done() {
            return true;
        }
        if Instant::now() >= end {
            return false;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

fn command_result(output: std::io::Result<std::process::Output>) -> Result<(), String> {
    let output = output.map_err(|e| format!("WireGuard: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "WireGuard: {}",
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_handshakes_and_command_results() {
        assert_eq!(handshake_age("key=\t1000\n", 1030), Some(30));
        assert_eq!(handshake_age("a\t0\n", 1030), Some(u64::MAX));
        assert_eq!(handshake_age("a\t900\nb\t1000\n", 1030), Some(30));
        assert_eq!(handshake_age("", 1030), None);
        assert_eq!(handshake_age("a\t2000\n", 1030), Some(0));
        assert!(command_result(Command::new("cmd").args(["/c", "exit 0"]).output()).is_ok());
        assert!(command_result(Command::new("cmd").args(["/c", "exit 1"]).output()).is_err());
        assert!(command_result(Err(std::io::Error::other("missing"))).is_err());
        let mut calls = 0;
        assert!(wait_until(Duration::from_secs(5), || {
            calls += 1;
            calls == 2
        }));
        assert!(!wait_until(Duration::ZERO, || false));
    }

    #[test]
    fn a_missing_wireguard_install_is_reported_not_fatal() {
        let tools = WireGuard {
            tools: PathBuf::from(r"C:\nowhere"),
        };
        let config = Path::new("temperance.conf");
        assert!(tools.up(&config).unwrap_err().starts_with("WireGuard: "));
        assert!(tools.down(&config).is_err());
        assert_eq!(tools.handshake_age(), None);
        assert!(!tools.is_up());
        assert!(WireGuard::system().tools.ends_with("WireGuard"));
    }
}
