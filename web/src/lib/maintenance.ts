import { mutate, type Repository } from "./database";
import { deliverNotifications } from "./notifications";
import { refreshFeeds } from "./feeds";
import { recoveryJob } from "./recovery";
import { reconcileAttempt } from "./updates";

export async function backupNow(repo: Repository) {
  try {
    const file = await recoveryJob("backup");
    await mutate(repo, (s) => {
      const m = (s.maintenance ??= {});
      m.backup_at = Math.floor(Date.now() / 1000);
      delete m.backup_error;
    });
    return file;
  } catch {
    await mutate(repo, (s) => {
      (s.maintenance ??= {}).backup_error =
        "Recovery backup failed. Verify SQLite storage, gateway keys, disk space, and a recovery passphrase of at least 16 characters.";
    });
    throw new Error(
      "Recovery backup failed. Check recovery settings before updating.",
    );
  }
}
export async function maintenanceTick(
  repo: Repository,
  at = Math.floor(Date.now() / 1000),
) {
  await mutate(repo, (s) => {
    reconcileAttempt(s, undefined, at);
    const offline = !!s.gateway_seen && at - s.gateway_seen > 90;
    const m = (s.maintenance ??= {});
    if (offline !== !!m.gateway_offline) {
      m.gateway_offline = offline;
      s.events.push({
        id: crypto.randomUUID(),
        at,
        kind: "gateway",
        message: offline
          ? "VPN gateway is offline"
          : "VPN gateway is available again",
        read: false,
      });
      s.events = s.events.slice(-500);
    }
  });
  // Each job is isolated: feed/SMTP outages must not interrupt policy refresh or backups.
  try {
    await deliverNotifications(repo);
  } catch {
    console.error("Email maintenance failed; verify SMTP configuration.");
  }
  try {
    await refreshFeeds(repo);
  } catch {
    console.error(
      "Feed maintenance failed; verify TEMPERANCE_FEEDS configuration.",
    );
  }
  const { state } = await repo.read();
  if (
    process.env.TEMPERANCE_BACKUP_PASSPHRASE &&
    at - (state.maintenance?.backup_at || 0) >= 86400
  ) {
    try {
      await backupNow(repo);
    } catch {
      /* Recorded for the admin; retried next tick. */
    }
  }
}
export function startMaintenance(repo: Repository, intervalMs = 60000) {
  let running: Promise<void> | undefined;
  const tick = () =>
    (running ??= maintenanceTick(repo)
      .catch(() =>
        console.error(
          "Household maintenance unavailable; check server readiness.",
        ),
      )
      .finally(() => {
        running = undefined;
      }));
  void tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
