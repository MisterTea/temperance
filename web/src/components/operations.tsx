"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { Check } from "@/lib/readiness";
import type { notificationStatus } from "@/lib/notifications";
import type { feedStatus } from "@/lib/feeds";

type Maintenance = {
  email: ReturnType<typeof notificationStatus>;
  feeds: ReturnType<typeof feedStatus>;
  recovery: {
    configured: boolean;
    last_backup_at: number | null;
    error: string | null;
  };
};
export function Operations() {
  const [maintenance, setMaintenance] = useState<Maintenance>();
  const [checks, setChecks] = useState<Check[]>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [m, response] = await Promise.all([
        api<Maintenance>("/api/maintenance"),
        fetch("/api/readiness?report=1", { cache: "no-store", signal }),
      ]);
      if (signal?.aborted) return;
      const report = await response.json();
      if (!Array.isArray(report.checks))
        throw new Error(report.error || "Readiness is unavailable");
      setMaintenance(m);
      setChecks(report.checks);
      setError("");
    } catch (e) {
      if (!signal?.aborted)
        setError(
          e instanceof Error ? e.message : "Could not load server status",
        );
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const action = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Operation failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <section aria-labelledby="server-readiness">
        <h2 id="server-readiness">Server readiness</h2>
        {!checks && !error ? <p role="status">Checking the server…</p> : null}
        <ul>
          {checks?.map((check) => (
            <li key={check.id}>
              <strong>
                {check.state === "ok"
                  ? "Ready"
                  : check.state === "warning"
                    ? "Check"
                    : "Needs attention"}
                :
              </strong>{" "}
              {check.message}
            </li>
          ))}
        </ul>
        <p>
          Beta reference setup: Linux with Docker and SQLite. Other server
          platforms, DNS-only, router and access-point modes are experimental.
          DNS-only mode cannot reliably stop existing connections or measure
          usage.
        </p>
        <p className="actions">
          <button
            disabled={busy}
            onClick={() =>
              action(async () => {
                await load();
              })
            }
          >
            Refresh server status
          </button>
          <a className="button secondary" href="/api/support">
            Download support report
          </a>
        </p>
        <p className="hint">
          The support report contains versions, counts, and health checks. It
          excludes household names, browsing history, locations, network
          addresses, and credentials. Review it before sharing.
        </p>
      </section>
      <section aria-labelledby="email-notifications">
        <h2 id="email-notifications">Email notifications</h2>
        {maintenance?.email.configured && !maintenance.email.worker_enabled ? (
          <p className="notice warning">
            Background email delivery is off. On a persistent Node server,
            enable TEMPERANCE_MAINTENANCE=on and restart.
          </p>
        ) : null}
        <p>
          {maintenance?.email.configured
            ? "SMTP is configured. New requests and important household events are queued for email delivery."
            : "Configure TEMPERANCE_SMTP_HOST, PORT, FROM, TO and optional USER/PASSWORD on the server, then restart. TLS is required."}
        </p>
        <p>
          Email contains a generic event notice. Open the dashboard or paired
          admin app to review details. A stopped server cannot send mail; use an
          external uptime monitor.
        </p>
        {maintenance?.email.error ? (
          <p className="notice warning">{maintenance.email.error}</p>
        ) : null}
        {maintenance ? (
          <p>
            {maintenance.email.pending} queued; {maintenance.email.failed}{" "}
            exhausted retries. Last successful delivery:{" "}
            {maintenance.email.last_sent_at
              ? new Date(maintenance.email.last_sent_at * 1000).toLocaleString()
              : "none yet"}
            .
          </p>
        ) : null}
        <button
          disabled={busy || !maintenance?.email.configured}
          onClick={() =>
            action(async () => {
              await api("/api/notifications/test", {});
              setNotice(
                "Test email accepted by your SMTP server. Check the recipient inbox.",
              );
            })
          }
        >
          Send test email
        </button>
        {maintenance?.email.failed ? (
          <button
            className="secondary"
            disabled={busy || !maintenance.email.configured}
            onClick={() =>
              action(async () => {
                const { retried } = await api<{ retried: number }>(
                  "/api/notifications/retry",
                  {},
                );
                setNotice(
                  `${retried} failed email notices queued for another delivery attempt.`,
                );
              })
            }
          >
            Retry failed email
          </button>
        ) : null}
      </section>
      <section aria-labelledby="recovery-backups">
        <h2 id="recovery-backups">Disaster recovery</h2>
        <p>
          Encrypted recovery includes the SQLite database, gateway keys, and
          Temperance configuration. A configuration export alone cannot restore
          device connectivity on a replacement server.
        </p>
        <p>
          {maintenance?.recovery.configured
            ? "Daily recovery backups are enabled. Keep the passphrase and copies of the archives off this server."
            : "Set TEMPERANCE_BACKUP_PASSPHRASE to at least 16 characters, save it separately, then restart. Recovery archives currently require SQLite."}
        </p>
        <p>
          Last scheduled or pre-update backup:{" "}
          {maintenance?.recovery.last_backup_at
            ? new Date(
                maintenance.recovery.last_backup_at * 1000,
              ).toLocaleString()
            : "none yet"}
          .
        </p>
        {maintenance?.recovery.error ? (
          <p className="notice warning">{maintenance.recovery.error}</p>
        ) : null}
        <button
          disabled={busy || !maintenance?.recovery.configured}
          onClick={() =>
            action(async () => {
              const response = await fetch("/api/recovery", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}",
              });
              if (!response.ok)
                throw new Error(
                  (await response.json()).error || "Recovery download failed",
                );
              const href = URL.createObjectURL(await response.blob());
              const link = document.createElement("a");
              link.href = href;
              link.download = "temperance-recovery.json";
              link.click();
              setTimeout(() => URL.revokeObjectURL(href), 1000);
              setNotice(
                "Encrypted recovery archive downloaded. Keep it and its passphrase in separate safe places.",
              );
            })
          }
        >
          Download encrypted recovery
        </button>
        <p className="hint">
          Restore offline into a new directory using the recovery tool in the
          server package. Keep your original server intact until the replacement
          passes device checks.
        </p>
      </section>
      <section aria-labelledby="feed-health">
        <h2 id="feed-health">Automatic category feeds</h2>
        <p>
          Configure TEMPERANCE_FEEDS with reviewed HTTPS sources, categories,
          license and attribution. Downloads are checked hourly; invalid or
          unexpectedly truncated lists retain their previous domains. Automatic
          refresh replaces manual imports for that category.
        </p>
        {maintenance?.feeds.error ? (
          <p className="notice warning">{maintenance.feeds.error}</p>
        ) : null}
        {maintenance?.feeds.feeds.length ? (
          <ul>
            {maintenance.feeds.feeds.map((f) => (
              <li key={f.category}>
                {f.category}: {f.count} domains.{" "}
                {f.stale ? "Stale or not yet downloaded." : "Current."}{" "}
                {f.attribution} ({f.license}). {f.error}
              </li>
            ))}
          </ul>
        ) : (
          <p>
            No automatic feeds configured. Starter lists have limited coverage.
          </p>
        )}
        <p>
          To fix a false block, inspect History and allow the domain for that
          client. Shared hosting and encrypted DNS limit domain attribution and
          filtering.
        </p>
      </section>
      {error ? (
        <p role="alert" className="notice warning">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="notice success">
          {notice}
        </p>
      ) : null}
    </>
  );
}
