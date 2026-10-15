"use client";
import { BrandMark } from "./brand-mark";
import { useCallback, useEffect, useRef, useState } from "react";
import type { snapshot } from "@/lib/service";
import { clientUsername } from "@/lib/accounts";
import { CATALOG, dailyLimit, type Profile } from "@/lib/policy";
import type { History } from "@/lib/model";
import type { UpdateStatus } from "@/lib/updates";
import { ProfileEditor } from "./profile-editor";
import { UsageCharts } from "./usage-charts";
import { Onboarding } from "./onboarding";
import { api } from "./api";
import { nextHomeAddress, type HomeNetwork } from "@/lib/home-lan";
type DashboardState = ReturnType<typeof snapshot>;
type ParentAccount = {
  id: string;
  username: string;
  role?: string;
  profile_id?: number;
  disabled?: boolean;
};
const ago = (at: number) => {
  const minutes = Math.max(0, Math.round((Date.now() / 1000 - at) / 60));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} d ago`;
};
const capitalize = (text: string) => text[0].toUpperCase() + text.slice(1);
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
/** The dashboard is often opened over plain HTTP on the home network, where `navigator.clipboard` cannot write. The copy has to happen in the click itself. */
function copyWithCommand(text: string) {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.fontSize = "16px";
  area.style.width = "2em";
  area.style.height = "2em";
  area.style.padding = "0";
  area.style.border = "none";
  area.style.outline = "none";
  area.style.boxShadow = "none";
  area.style.background = "transparent";
  document.body.appendChild(area);
  area.focus();
  area.select();
  area.setSelectionRange(0, area.value.length);
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  area.remove();
  return copied;
}
function copyText(text: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard?.writeText)
    return navigator.clipboard.writeText(text);
  return copyWithCommand(text)
    ? Promise.resolve()
    : Promise.reject(new Error("Could not copy"));
}
const categoryName = (key: string) =>
  (CATALOG as Record<string, { name: string } | undefined>)[key]?.name;
const bucketLabel = (bucket: string, profile?: Profile) =>
  bucket.startsWith("group:")
    ? ((profile?.app_limits ?? []).find((g) => "group:" + g.id === bucket)
        ?.name ?? "App group")
    : bucket.startsWith("category:")
      ? (categoryName(bucket.slice(9)) ?? bucket.slice(9))
      : bucket.replace(/^site:/, "");
const reasonLabel = (reason: string, profile?: Profile) => {
  const limit = /^limit (.+)$/.exec(reason);
  return capitalize(
    limit
      ? `${bucketLabel(limit[1], profile)} limit`
      : (categoryName(reason) ?? reason),
  );
};
const formatDay = (day: string, options: Intl.DateTimeFormatOptions) =>
  new Date(day + "T12:00:00Z").toLocaleDateString(undefined, {
    ...options,
    timeZone: "UTC",
  });
const clock = (time: string) => {
  const [h, m] = time.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
function HomeSetup({ network, ip }: { network: HomeNetwork; ip: string }) {
  return (
    <div className="setup-steps">
      <p>On the device, set the network by hand:</p>
      <ol>
        {network.ssid ? (
          <li>
            Join the Wi-Fi network <strong>{network.ssid}</strong>. Password:{" "}
            <strong>{network.passphrase}</strong>
          </li>
        ) : null}
        <li>Choose a manual or static address.</li>
        <li>
          IP address: <strong>{ip}</strong>
        </li>
        <li>
          Subnet mask: <strong>{network.mask}</strong>
        </li>
        <li>
          Router: <strong>{network.gateway}</strong>
        </li>
        {network.dns ? (
          <li>
            DNS: <strong>{network.dns}</strong>
          </li>
        ) : null}
      </ol>
    </div>
  );
}
const INTROS: Record<string, string> = {
  overview: "Make room for the things that matter.",
  devices: "Phones, tablets, TVs, consoles and parent phones.",
  usage: "How much time each person spent online, and on what.",
  history: "Sites your family’s devices looked up, and why.",
  requests: "Answer requests for more time and hand out rewards.",
  settings: "Remote access, backups and data retention.",
};
const ROUTER_GUIDE =
  "https://github.com/MisterTea/temperance/blob/main/docs/routers.md";
type NetworkInput = {
  upnp: boolean;
  ddns: { hostname: string; username: string; password: string } | null;
};
function RemoteAccess({
  state,
  onSave,
}: {
  state: DashboardState;
  onSave: (network: NetworkInput) => void;
}) {
  const { network, network_status: status, vpn_endpoint: endpoint } = state;
  const ddns = network.ddns;
  const [host, port] = endpoint?.split(":") ?? [];
  const lines = [
    { label: "Port forwarding", report: status?.upnp },
    { label: "Dynamic DNS", report: status?.ddns },
  ].filter((l) => l.report);
  return (
    <section>
      <h2>Remote access</h2>
      <p>
        Phones and laptops reach this gateway from outside the home on UDP port{" "}
        {port ?? "51820"}
        {endpoint ? (
          <>
            {" "}
            at <strong>{host}</strong>
          </>
        ) : null}
        . Temperance asks your router to forward that port (UPnP) and can keep a
        free Dynu hostname pointed at your home&apos;s changing address. If your
        router has no UPnP, the router guide shows how to forward the port by
        hand on TP-Link, eero and Netgear routers.
      </p>
      <p className="actions">
        <a
          className="button secondary"
          href={ROUTER_GUIDE}
          target="_blank"
          rel="noreferrer"
        >
          Router guide
        </a>
        <a
          className="button secondary"
          href="https://www.dynu.com/"
          target="_blank"
          rel="noreferrer"
        >
          Create a free Dynu hostname
        </a>
      </p>
      {lines.length ? (
        <ul className="issues reach" aria-label="Remote access status">
          {lines.map(({ label, report }) => (
            <li key={label} className={report!.state}>
              <strong>{label}:</strong> {report!.message}{" "}
              <small>{ago(report!.at)}</small>
            </li>
          ))}
        </ul>
      ) : (
        <p>
          <small>
            {state.gateway_seen
              ? "Waiting for the gateway to report on port forwarding."
              : "The gateway has not connected yet."}
          </small>
        </p>
      )}
      {ddns && host && ddns.hostname !== host ? (
        <p className="notice warning" role="status">
          Devices connect to {endpoint}. Set TEMPERANCE_VPN_ENDPOINT to{" "}
          {ddns.hostname}:{port} and restart Temperance so they follow the Dynu
          hostname.
        </p>
      ) : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const text = (name: string) => String(f.get(name) ?? "").trim();
          onSave({
            upnp: f.get("upnp") === "on",
            ddns: text("ddns_host")
              ? {
                  hostname: text("ddns_host"),
                  username: text("ddns_user"),
                  password: String(f.get("ddns_password") ?? ""),
                }
              : null,
          });
        }}
      >
        <label className="check">
          <input name="upnp" type="checkbox" defaultChecked={network.upnp} />
          Forward the VPN port automatically with UPnP
        </label>
        <div className="two">
          <label>
            Dynu hostname
            <input
              name="ddns_host"
              placeholder="myhome.ddnsfree.com"
              defaultValue={ddns?.hostname ?? ""}
            />
            <small>Leave empty to turn dynamic DNS off.</small>
          </label>
          <label>
            Dynu username
            <input
              name="ddns_user"
              autoComplete="off"
              defaultValue={ddns?.username ?? ""}
            />
          </label>
          <label>
            Dynu IP update password
            <input
              name="ddns_password"
              type="password"
              autoComplete="new-password"
              placeholder={
                ddns?.has_password ? "Saved; leave blank to keep" : ""
              }
            />
            <small>
              Set it under Control Panel → My Account → Username/Password in
              Dynu.
            </small>
          </label>
        </div>
        <button className="primary">Save remote access</button>
      </form>
    </section>
  );
}
function DeviceSetup({
  state,
  act,
}: {
  state: DashboardState;
  act: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const link = state.device_setup;
  const [qr, setQr] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!link) return;
    let live = true;
    import("qrcode")
      .then((QRCode) => QRCode.toDataURL(link, { margin: 1, width: 240 }))
      .then((url) => live && setQr(url));
    return () => {
      live = false;
    };
  }, [link]);
  return (
    <section>
      <h2>Set up a child&apos;s device</h2>
      <p>
        Devices find home through the family VPN&apos;s UDP port, so they need
        no web address. This code says where home is; the device still signs in
        with that client’s username and password.
      </p>
      {!link ? (
        <p className="notice" role="status">
          {state.gateway_seen
            ? "Set TEMPERANCE_VPN_ENDPOINT so devices know where to find home."
            : "Devices connect through the home gateway, which hasn’t checked in yet."}
        </p>
      ) : (
        <div className="pairing" aria-label="Device setup code">
          {qr ? (
            <img
              src={qr}
              alt="QR code to set up a child's device"
              width={240}
              height={240}
            />
          ) : null}
          <div>
            <ol>
              <li>Install Temperance on the phone, tablet or computer.</li>
              <li>
                Choose the child&apos;s device option, then scan this code. On a
                computer, paste the setup code instead.
              </li>
              <li>
                Sign in with the child&apos;s client username and password.
              </li>
            </ol>
            <p className="actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => {
                  const pending = copyText(link);
                  void act(async () => {
                    await pending;
                    setCopied(true);
                  });
                }}
              >
                {copied ? "Copied" : "Copy setup code"}
              </button>
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
function updateCommands({ install, arch, latest }: UpdateStatus) {
  const v = latest?.version ?? "<version>";
  const arm = arch === "arm64";
  if (install === "docker")
    return ["cd ~/temperance && docker compose pull && docker compose up -d"];
  if (install === "linux")
    return [
      `sudo apt install ./temperance_${v}_${arm ? "arm64" : "amd64"}.deb   # Debian, Ubuntu, Raspberry Pi OS`,
      `sudo dnf install ./temperance-${v}-1.${arm ? "aarch64" : "x86_64"}.rpm   # Fedora, RHEL`,
      `tar xzf temperance-${v}-linux-${arch}.tar.gz && sudo ./temperance-${v}-linux-${arch}/install.sh   # tarball`,
    ];
  return [];
}
function SoftwareUpdates({
  update,
  onCheck,
  onUpdate,
  updating,
}: {
  update?: UpdateStatus;
  onCheck: () => void;
  onUpdate: () => void;
  updating: boolean;
}) {
  if (!update) return null;
  const { latest } = update;
  const commands = updateCommands(update);
  return (
    <section>
      <h2>Software updates</h2>
      <p>
        This server runs Temperance <strong>{update.current}</strong>.{" "}
        {!update.checks
          ? "Update checks are off (TEMPERANCE_UPDATE_CHECK)."
          : update.available
            ? `Version ${latest!.version} is available.`
            : latest
              ? `The newest release is ${latest.version}.`
              : null}
        {update.checked_at ? (
          <small> Checked {ago(update.checked_at)}.</small>
        ) : null}
      </p>
      {update.error ? (
        <p className="notice warning" role="status">
          Could not check for updates: {update.error}
        </p>
      ) : null}
      {updating ? (
        <p className="notice" role="status">
          Updating to {latest?.version}. Temperance restarts when the new
          version is ready, and this page reconnects by itself.
        </p>
      ) : update.available && update.can_update ? (
        <p>
          Updating takes a minute or two. Devices keep their rules while
          Temperance restarts.
        </p>
      ) : update.available && commands.length ? (
        <>
          <p>
            {update.install === "docker"
              ? "Run this on the server, or rerun the Docker installer to let this page install updates:"
              : "Download the new package from the release page, then install it over this one. Settings, data and keys are kept."}
          </p>
          <pre className="commands">{commands.join("\n")}</pre>
        </>
      ) : update.available ? (
        <p>
          Update this checkout with <code>git pull</code>, then rerun the
          installer you used.
        </p>
      ) : null}
      <p className="actions">
        {update.available && update.can_update ? (
          <button
            className="primary"
            disabled={updating}
            onClick={() => {
              if (confirm(`Update Temperance to ${latest!.version} now?`))
                onUpdate();
            }}
          >
            {updating ? "Updating…" : `Update to ${latest!.version}`}
          </button>
        ) : null}
        {latest ? (
          <a
            className="button secondary"
            href={latest.url}
            target="_blank"
            rel="noreferrer"
          >
            Release notes
          </a>
        ) : null}
        {update.checks ? (
          <button className="secondary" disabled={updating} onClick={onCheck}>
            Check now
          </button>
        ) : null}
      </p>
    </section>
  );
}
type Viewer = { role: "admin" } | { role: "parent"; id: string; name: string };
type Pairing = { link: string; qr: string; expires: number; count: number };
function ParentPhones({
  state,
  viewer,
  refresh,
  act,
}: {
  state: DashboardState;
  viewer?: Viewer;
  refresh: () => Promise<void>;
  act: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [pairing, setPairing] = useState<Pairing>();
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [paired, setPaired] = useState("");
  const { parents, parent_access: access } = state;
  const left = pairing ? Math.max(0, pairing.expires - now) : 0;
  useEffect(() => {
    if (!pairing) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(refresh, 3000);
    return () => {
      clearInterval(timer);
      clearInterval(poll);
    };
  }, [pairing, refresh]);
  useEffect(() => {
    if (!pairing || parents.length <= pairing.count) return;
    setPaired(parents.at(-1)!.name);
    setPairing(undefined);
  }, [pairing, parents]);
  const start = () =>
    act(async () => {
      const { link, expires_in } = await api<{
        link: string;
        expires_in: number;
      }>("/api/parents/pairing", {});
      const QRCode = await import("qrcode");
      setPaired("");
      setCopied(false);
      setNow(Date.now());
      setPairing({
        link,
        qr: await QRCode.toDataURL(link, { margin: 1, width: 240 }),
        expires: Date.now() + expires_in * 1000,
        count: parents.length,
      });
    });
  return (
    <section>
      <h2>Parent devices</h2>
      <p>
        Pair a parent&apos;s phone or computer once, and the Temperance app
        opens this dashboard from anywhere: at work, on mobile data, on someone
        else&apos;s Wi-Fi. It travels through the same UDP port as the family
        VPN, so there is nothing else to forward and no VPN to turn on.
      </p>
      {!access.available ? (
        <p className="notice" role="status">
          {state.gateway_seen
            ? "Set TEMPERANCE_VPN_ENDPOINT so parent devices know where to find home, then pair."
            : "Parent devices connect through the home gateway, which hasn’t checked in yet."}
        </p>
      ) : pairing && left > 0 ? (
        <div className="pairing" aria-label="Pairing code">
          <img
            src={pairing.qr}
            alt="QR code to pair a parent device"
            width={240}
            height={240}
          />
          <div>
            <ol>
              <li>
                Install Temperance on the parent&apos;s phone or computer.
              </li>
              <li>
                Choose <strong>I&apos;m a parent</strong>, then scan this code.
                On a computer, paste the link instead.
              </li>
            </ol>
            <p className="actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => {
                  const pending = copyText(pairing.link);
                  void act(async () => {
                    await pending;
                    setCopied(true);
                  });
                }}
              >
                {copied ? "Copied" : "Copy pairing link"}
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={() => setPairing(undefined)}
              >
                Cancel
              </button>
            </p>
            <small role="timer">
              Works once, for {Math.floor(left / 60000)}:
              {String(Math.floor(left / 1000) % 60).padStart(2, "0")} more.
            </small>
          </div>
        </div>
      ) : (
        <p className="actions">
          <button className="primary" onClick={start}>
            {pairing ? "Code expired, make a new one" : "Pair a parent device"}
          </button>
        </p>
      )}
      {paired ? (
        <p className="notice success" role="status">
          {paired} is paired and can open the dashboard away from home.
        </p>
      ) : null}
      {parents.map((p) => {
        const self = viewer?.role === "parent" && viewer.id === p.id;
        return (
          <article className="row-card" key={p.id}>
            <div>
              <strong>{p.name}</strong>
              <small>
                Paired {ago(p.created_at)}
                {p.last_seen ? ` · last used ${ago(p.last_seen)}` : ""}
              </small>
            </div>
            {self ? (
              <small>This phone</small>
            ) : (
              <button
                className="button secondary"
                onClick={() =>
                  act(async () => {
                    if (
                      !confirm(
                        `Revoke ${p.name}? It will stop reaching the dashboard right away.`,
                      )
                    )
                      return;
                    await api("/api/parents/revoke", { id: p.id });
                    await refresh();
                  })
                }
              >
                Revoke
              </button>
            )}
          </article>
        );
      })}
    </section>
  );
}
export function Dashboard() {
  const [state, setState] = useState<DashboardState>();
  const [error, setError] = useState("");
  const [signedIn, setSignedIn] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [onboarding, setOnboarding] = useState<boolean>();
  const [resetUser, setResetUser] = useState<ParentAccount>();
  const [resetError, setResetError] = useState("");
  const [passwordSet, setPasswordSet] = useState("");
  const [signInFor, setSignInFor] = useState<number>();
  const [accountsReady, setAccountsReady] = useState(false);
  const resetDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (resetUser) resetDialog.current?.showModal();
  }, [resetUser]);
  const [parents, setParents] = useState<ParentAccount[]>([]);
  const [me, setMe] = useState<ParentAccount>();
  const [viewer, setViewer] = useState<Viewer>();
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Profile | true>();
  const [renaming, setRenaming] = useState<number>();
  const [tab, setTab] = useState("overview");
  const [homeSetup, setHomeSetup] = useState<{ name: string; ip: string }>();
  const homeDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (homeSetup) homeDialog.current?.showModal();
  }, [homeSetup]);
  const [selected, setSelected] = useState<number>();
  const [rewardKind, setRewardKind] = useState("extra_time");
  const [history, setHistory] = useState<History[]>([]);
  const [date, setDate] = useState("");
  const [blocked, setBlocked] = useState("all");
  const [historyProfile, setHistoryProfile] = useState("");
  const [usage, setUsage] = useState<
    { day: string; profiles: Record<string, Record<string, number>> }[]
  >([]);
  const [period, setPeriod] = useState(7);
  const [restarting, setRestarting] = useState(false);
  const [update, setUpdate] = useState<UpdateStatus>();
  const [updatingFrom, setUpdatingFrom] = useState<string>();
  const refresh = useCallback(async () => {
    try {
      const next = await api<DashboardState>("/api/state");
      setState(next);
      setSignedIn(true);
      setError("");
    } catch (error) {
      const text = error instanceof Error ? error.message : "Could not load";
      if (text.includes("sign-in")) {
        setSignedIn(false);
        const setup = await api<{ needs_setup: boolean }>("/v1/setup").catch(
          () => ({ needs_setup: false }),
        );
        setNeedsSetup(setup.needs_setup);
      } else setError(text);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 10000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (state?.needs_onboarding) setOnboarding((o) => o ?? true);
  }, [state?.needs_onboarding]);
  const save = async (path: string, value: unknown) => {
    const next = await api<DashboardState>(path, value);
    setState(next);
    setError("");
    return next;
  };
  const act = async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    }
  };
  const restart = () =>
    act(async () => {
      setRestarting(true);
      try {
        await api("/api/restart", {});
        const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
        await pause(1500);
        for (let i = 0; i < 60; i++) {
          const up = await fetch("/healthz", { cache: "no-store" }).then(
            (r) => r.ok,
            () => false,
          );
          if (up) break;
          await pause(1000);
        }
        await refresh();
      } finally {
        setRestarting(false);
      }
    });
  const answer = (id: string, approve: boolean) =>
    act(() => save("/api/requests", { id, approve }));
  const loadHistory = useCallback(async () => {
    if (!state) return;
    const q = new URLSearchParams({
      start: date || state.day,
      end: date || state.day,
    });
    if (historyProfile) q.set("profile_id", historyProfile);
    if (blocked !== "all") q.set("blocked", blocked);
    try {
      setHistory(await api<History[]>("/api/history?" + q));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load history");
    }
  }, [state, date, historyProfile, blocked]);
  useEffect(() => {
    if (tab === "history") loadHistory();
  }, [tab, loadHistory]);
  const loadParents = useCallback(async () => {
    try {
      setParents(await api<ParentAccount[]>("/api/users"));
      setMe(await api<ParentAccount>("/api/me"));
      setAccountsReady(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load accounts");
    }
  }, []);
  useEffect(() => {
    if (signedIn) loadParents();
  }, [tab, signedIn, loadParents]);
  const loadUpdate = useCallback(
    (check = false) =>
      api<UpdateStatus>("/api/update" + (check ? "?check=now" : "")).then(
        setUpdate,
      ),
    [],
  );
  useEffect(() => {
    if (signedIn) loadUpdate().catch(() => undefined);
  }, [signedIn, loadUpdate]);
  useEffect(() => {
    if (!updatingFrom) return;
    const started = Date.now();
    const timer = setInterval(async () => {
      const next = await api<UpdateStatus>("/api/update").catch(
        () => undefined,
      );
      if (next && next.current !== updatingFrom) {
        setUpdate(next);
        setUpdatingFrom(undefined);
        refresh();
      } else if (Date.now() - started > 10 * 60_000) {
        setUpdatingFrom(undefined);
        setError(
          "The update has not finished after 10 minutes. Check the updater container's logs.",
        );
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [updatingFrom, refresh]);
  useEffect(() => {
    if (!signedIn) return setViewer(undefined);
    api<Viewer>("/api/me")
      .then(setViewer)
      .catch(() => setViewer(undefined));
  }, [signedIn]);
  useEffect(() => {
    if (tab !== "usage" || !state) return;
    const start = new Date(state.day + "T12:00:00Z");
    start.setUTCDate(start.getUTCDate() - 2 * period + 1);
    api<typeof usage>(
      "/api/usage?" +
        new URLSearchParams({
          start: start.toISOString().slice(0, 10),
          end: state.day,
        }),
    )
      .then(setUsage)
      .catch((e) => setError(e.message));
  }, [tab, state, period]);
  const finishOnboarding = (next: "devices" | "overview") => {
    setOnboarding(false);
    setNeedsSetup(false);
    setTab(next);
    refresh();
  };
  if (!signedIn && needsSetup && !loading)
    return (
      <Onboarding
        mode="account"
        onAccountCreated={refresh}
        onDone={finishOnboarding}
      />
    );
  if (signedIn && state && (onboarding ?? state.needs_onboarding))
    return (
      <Onboarding
        mode="rules"
        onAccountCreated={refresh}
        onDone={finishOnboarding}
      />
    );
  if (!signedIn)
    return (
      <main className="sign-in">
        <span className="eyebrow">YOUR HOME. YOUR RULES.</span>
        <h1 className="sign-in-brand"><BrandMark />Temperance</h1>
        <p>Open source family balance, wherever you connect.</p>
        {loading ? (
          <p>Loading…</p>
        ) : (
          <form
            aria-label="Sign in"
            onSubmit={(e) => {
              e.preventDefault();
              const f = Object.fromEntries(new FormData(e.currentTarget));
              act(async () => {
                await api("/v1/login", f);
                await refresh();
              });
            }}
          >
            <label>
              Admin password
              <input
                name="password"
                type="password"
                required
                autoComplete="current-password"
              />
            </label>
            <button className="primary">Sign in</button>
          </form>
        )}
        <p role="alert" className="error">
          {error}
        </p>
      </main>
    );
  if (!state)
    return (
      <main>
        <p>Loading family settings…</p>
        <p role="alert">{error}</p>
      </main>
    );
  const profileById = new Map(state.profiles.map((p) => [p.id, p]));
  const clientName = (p?: { id: number; name: string }) =>
    (p && parents.find((u) => u.profile_id === p.id)?.username) || p?.name;
  const usageStart = new Date(state.day + "T12:00:00Z");
  usageStart.setUTCDate(usageStart.getUTCDate() - period + 1);
  const currentUsage = usage.filter(
    (d) => d.day >= usageStart.toISOString().slice(0, 10),
  );
  return (
    <>
      <aside>
        <a href="#" className="brand">
          <BrandMark />
          <span>
            temperance<small>FAMILY BALANCE</small>
          </span>
        </a>
        <div className="nav-label">YOUR HOME</div>
        {[
          "overview",
          "devices",
          "usage",
          "history",
          "requests",
          "settings",
        ].map((name) => (
          <button
            key={name}
            onClick={() => setTab(name)}
            className={"nav " + (tab === name ? "active" : "")}
          >
            {name[0].toUpperCase() + name.slice(1)}
            {name === "requests" &&
            state.requests.some((r) => r.status === "pending") ? (
              <span className="dot" />
            ) : null}
          </button>
        ))}
        {viewer?.role === "parent" ? null : (
          <button
            className="nav"
            onClick={() =>
              act(async () => {
                await api("/v1/logout", {});
                setSignedIn(false);
                setState(undefined);
              })
            }
          >
            Sign out
          </button>
        )}
        <div className="aside-footer">
          Open source · no vendor account
          <small>Your data stays in your chosen service.</small>
        </div>
      </aside>
      <main>
        <header>
          <div className="eyebrow">
            {viewer?.role === "parent"
              ? `PARENT · ${(
                  state.parents.find((p) => p.id === viewer.id)?.name ??
                  viewer.name
                ).toUpperCase()}`
              : "A LITTLE MORE BALANCE"}
          </div>
          <div className="heading">
            <h1>
              {tab === "overview"
                ? "Your family's digital day."
                : tab[0].toUpperCase() + tab.slice(1)}
            </h1>
            <span className="date">
              {formatDay(state.day, {
                weekday: "long",
                month: "long",
                day: "numeric",
              })}{" "}
              · {state.timezone}
            </span>
          </div>
          <p className="intro">{INTROS[tab]}</p>
        </header>
        {error ? (
          <p className="error banner" role="alert">
            {error}
          </p>
        ) : null}
        {tab === "overview" ? (
          <>
            {state.devices.length && !state.gateway_seen ? (
              <p className="notice warning" role="status">
                The VPN gateway has not connected yet. Enrolled devices cannot
                reach the internet until it does.
              </p>
            ) : state.gateway_seen &&
              Date.now() / 1000 - state.gateway_seen > 180 ? (
              <p className="notice warning" role="status">
                VPN gateway offline since {ago(state.gateway_seen)}. Devices on
                the family VPN have no internet access until it reconnects.
              </p>
            ) : null}
            {update?.available ? (
              <p className="notice" role="status">
                Temperance {update.latest!.version} is available.{" "}
                <button className="link" onClick={() => setTab("settings")}>
                  See how to update
                </button>
              </p>
            ) : null}
            {state.requests.some((r) => r.status === "pending") ? (
              <section aria-label="Waiting for you">
                <h2>Waiting for you</h2>
                {state.requests
                  .filter((r) => r.status === "pending")
                  .map((r) => (
                    <article className="row-card" key={r.id}>
                      <div>
                        <strong>
                          {state.devices.find((d) => d.id === r.device_id)
                            ?.name ??
                            clientName(profileById.get(r.profile_id))}{" "}
                          asks for {r.minutes} more minutes
                        </strong>
                        {r.message ? <p>“{r.message}”</p> : null}
                      </div>
                      <div>
                        <button onClick={() => answer(r.id, true)}>
                          Approve
                        </button>
                        <button onClick={() => answer(r.id, false)}>
                          Decline
                        </button>
                      </div>
                    </article>
                  ))}
              </section>
            ) : null}
            <section className="stats">
              <article>
                <span>Network activity minutes</span>
                <strong>{state.total}</strong>
                <small>Estimated allowed traffic across clients</small>
              </article>
              <article>
                <span>Offline right now</span>
                <strong>{state.blocked}</strong>
                <small>Paused, bedtime, Off Time, or out of time</small>
              </article>
              <article>
                <span>Family devices</span>
                <strong>{state.devices.length}</strong>
                <small>Enrolled with private device keys</small>
              </article>
            </section>
            <div className="section-title">
              <div>
                <h2>Clients</h2>
                <p>Each client has the rules and the time budget.</p>
              </div>
              <div className="actions">
                <button
                  className="secondary"
                  onClick={() =>
                    act(() => save("/api/settings", { paused: !state.paused }))
                  }
                >
                  {state.paused ? "Resume family" : "Pause family"}
                </button>
                <button className="primary" onClick={() => setEditing(true)}>
                  + Add client
                </button>
              </div>
            </div>
            {passwordSet ? (
              <p className="notice success" role="status">
                Password set for {passwordSet}. Its devices must sign in again
                with the new password.
              </p>
            ) : null}
            <section className="profiles">
              {state.profiles.length ? (
                state.profiles.map((p) => {
                  const signIn = parents.find((u) => u.profile_id === p.id);
                  const label = signIn?.username ?? p.name;
                  return (
                  <article className="profile" key={p.id}>
                    <div className="profile-head">
                      <span className="avatar">{p.avatar === "◒" ? <BrandMark /> : p.avatar}</span>
                      <div>
                        {renaming === p.id ? (
                          <input
                            aria-label={`New username for ${label}`}
                            className="profile-name"
                            defaultValue={label}
                            maxLength={40}
                            autoCapitalize="none"
                            autoCorrect="off"
                            autoFocus
                            onFocus={(e) => e.currentTarget.select()}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") e.currentTarget.blur();
                              if (e.key === "Escape") {
                                e.currentTarget.value = label;
                                e.currentTarget.blur();
                              }
                            }}
                            onBlur={(e) => {
                              const name = e.target.value.trim();
                              setRenaming(undefined);
                              if (!name || name.toLowerCase() === label.toLowerCase())
                                return;
                              act(() =>
                                save("/api/profiles", {
                                  ...p,
                                  name: clientUsername(name),
                                }),
                              );
                            }}
                          />
                        ) : (
                          <div className="profile-name-row">
                            <h3>{label}</h3>
                            <button
                              className="quiet rename"
                              aria-label={`Rename ${label}`}
                              title="Rename"
                              onClick={() => setRenaming(p.id)}
                            >
                              ✎
                            </button>
                          </div>
                        )}
                        <small>
                          {plural(
                            state.devices.filter((d) => d.profile_id === p.id)
                              .length,
                            "device",
                          )}{" "}
                          · {p.filter_level} preset
                          {accountsReady && !signIn ? " · no sign-in" : ""}
                          {signIn
                            ? signIn.disabled
                              ? " · sign-in disabled"
                              : " · sign-in enabled"
                            : ""}
                        </small>
                      </div>
                      <span
                        className={
                          "badge " +
                          (p.access_reason === "allowed"
                            ? "allowed"
                            : "blocked")
                        }
                      >
                        {p.access_reason === "allowed"
                          ? "Rules active"
                          : capitalize(p.access_reason)}
                      </span>
                    </div>
                    <div className="usage">
                      <strong>{p.used}</strong>
                      <span>
                        {p.effective_limit
                          ? `of ${p.effective_limit} min used · ${Math.max(
                              0,
                              p.effective_limit - p.used,
                            )} min left`
                          : "min used · no daily limit"}
                      </span>
                    </div>
                    <progress
                      max={p.effective_limit || 1440}
                      value={p.used}
                      aria-label={`${label} daily budget`}
                    />
                    <p className="profile-info">
                      {plural(p.schedules.length, "schedule")} ·{" "}
                      {p.bedtime.enabled !== false && p.bedtime.start
                        ? `Bedtime ${clock(p.bedtime.start)}–${clock(p.bedtime.end)}`
                        : "No bedtime"}
                      <br />
                      {plural(p.unmanaged.length, "unmanaged site")} ·{" "}
                      {plural(p.rewards.length, "reward")} today
                    </p>
                    {(p.app_limits ?? []).length ? (
                      <ul
                        className="app-groups"
                        aria-label={`${label} shared app limits`}
                      >
                        {p.app_limits.map((g) => (
                          <li key={g.id}>
                            {g.name}{" "}
                            <span>
                              {p.bucket_usage["group:" + g.id] ?? 0} /{" "}
                              {dailyLimit(
                                p,
                                Date.now() / 1000,
                                state.timezone,
                                p.rewards,
                                "group:" + g.id,
                              )}{" "}
                              min
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {Object.keys(p.site_limits).length ? (
                      <ul
                        className="app-groups"
                        aria-label={`${label} site budgets`}
                      >
                        {Object.entries(p.site_limits)
                          .sort(([a], [b]) => a.localeCompare(b))
                          .map(([site]) => (
                            <li key={site}>
                              {site}{" "}
                              <span>
                                {p.bucket_usage["site:" + site] ?? 0} /{" "}
                                {dailyLimit(
                                  p,
                                  Date.now() / 1000,
                                  state.timezone,
                                  p.rewards,
                                  "site:" + site,
                                )}{" "}
                                min
                              </span>
                            </li>
                          ))}
                      </ul>
                    ) : null}
                    <div className="actions">
                      <button
                        className="secondary"
                        onClick={() =>
                          act(() =>
                            save("/api/profiles", { ...p, paused: !p.paused }),
                          )
                        }
                      >
                        {p.paused ? "Resume" : "Pause"}
                      </button>
                      <button
                        className="secondary"
                        onClick={() =>
                          setEditing({ ...p, name: label })
                        }
                      >
                        Edit rules
                      </button>
                      {!signIn &&
                      accountsReady &&
                      me?.role !== "parent" &&
                      signInFor !== p.id ? (
                        <button
                          className="secondary"
                          onClick={() => setSignInFor(p.id)}
                        >
                          Add sign-in
                        </button>
                      ) : null}
                      {signIn && me?.role !== "parent" ? (
                        <>
                          <button
                            className="secondary"
                            onClick={() =>
                              act(async () => {
                                await api("/api/users/update", {
                                  id: signIn.id,
                                  disabled: !signIn.disabled,
                                });
                                await loadParents();
                              })
                            }
                          >
                            {signIn.disabled ? "Enable" : "Disable"}
                          </button>
                          <button
                            className="secondary"
                            onClick={() => {
                              setResetError("");
                              setPasswordSet("");
                              setResetUser(signIn);
                            }}
                          >
                            Set password
                          </button>
                          <button
                            className="secondary"
                            onClick={() => {
                              if (
                                confirm(
                                  `Remove ${signIn.username}’s sign-in and revoke its devices? The client’s rules stay.`,
                                )
                              )
                                act(async () => {
                                  setParents(
                                    await api<ParentAccount[]>(
                                      "/api/users/delete",
                                      { id: signIn.id },
                                    ),
                                  );
                                  await refresh();
                                });
                            }}
                          >
                            Delete sign-in
                          </button>
                        </>
                      ) : null}
                      <button
                        className="secondary"
                        onClick={() => {
                          setSelected(p.id);
                          setTab("requests");
                        }}
                      >
                        Reward
                      </button>
                    </div>
                    {signInFor === p.id ? (
                      <form
                        aria-label={`Sign-in for ${label}`}
                        onSubmit={(e) => {
                          e.preventDefault();
                          const form = e.currentTarget;
                          const data = new FormData(form);
                          act(async () => {
                            await api("/api/users", {
                              username: data.get("username"),
                              password: data.get("password"),
                              profile_id: p.id,
                            });
                            form.reset();
                            setSignInFor(undefined);
                            await loadParents();
                            await refresh();
                          });
                        }}
                      >
                        <label>
                          Username
                          <input
                            name="username"
                            required
                            autoComplete="off"
                            autoCapitalize="none"
                          />
                        </label>
                        <label>
                          Password
                          <input
                            name="password"
                            type="password"
                            minLength={6}
                            required
                            autoComplete="new-password"
                          />
                        </label>
                        <button className="secondary">Add sign-in</button>
                      </form>
                    ) : null}
                  </article>
                  );
                })
              ) : (
                <div className="empty">
                  Welcome home. Add a client, then connect a device.
                </div>
              )}
            </section>
            <div className="notice">
              <strong>Activity is an estimate, not exact screen time.</strong>
              <p>
                Background pings under 32 KB in a minute are not counted.
                Larger traffic is still an estimate, not exact screen time.
                Domain and category attribution depends on DNS visibility. Use
                History to understand a decision before changing a rule.
              </p>
            </div>
          </>
        ) : null}
        {tab === "devices" ? (
          <>
            <DeviceSetup state={state} act={act} />
            <ParentPhones
              state={state}
              viewer={viewer}
              refresh={refresh}
              act={act}
            />
            <section>
              <h2>Add a home-network device</h2>
              {state.home_network ? (
                <>
                  <p>
                    For a TV, console, or speaker. Temperance assigns a free
                    address when you add the device.
                  </p>
                  {nextHomeAddress(
                    state.home_network,
                    state.devices.map((d) => d.ip),
                  ) ? (
                    <form
                      className="enrollment"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const form = e.currentTarget,
                          data = new FormData(form);
                        const known = new Set(state.devices.map((d) => d.id));
                        act(async () => {
                          const next = await save("/api/devices/home", {
                            name: data.get("name"),
                            profile_id: Number(data.get("profile_id")),
                          });
                          form.reset();
                          const added = next.devices.find(
                            (d) => d.kind === "home" && !known.has(d.id),
                          );
                          if (added)
                            setHomeSetup({ name: added.name, ip: added.ip });
                        });
                      }}
                    >
                      <label>
                        Device name
                        <input name="name" required maxLength={80} />
                      </label>
                      <label>
                        Client
                        <select name="profile_id" required>
                          {state.profiles.map((p) => (
                            <option key={p.id} value={p.id}>
                              {clientName(p)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button className="primary">Add home device</button>
                    </form>
                  ) : (
                    <p>Every address on the access point is already assigned.</p>
                  )}
                </>
              ) : (
                <p>
                  Access point mode is off, so a TV or console cannot be added.
                  Turn on the access point, then restart Temperance.
                </p>
              )}
            </section>
            <div className="table-wrap">
              <table className="devices">
                <thead>
                  <tr>
                    <th>Device</th>
                    <th>Client</th>
                    <th>Address</th>
                    <th>Last active</th>
                    <th>Location</th>
                    <th>Controls</th>
                  </tr>
                </thead>
                <tbody>
                  {state.devices.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <input
                          aria-label={`${d.name} name`}
                          defaultValue={d.name}
                          maxLength={80}
                          className="inline-name"
                          onKeyDown={(e) => {
                            if (e.key === "Enter") e.currentTarget.blur();
                          }}
                          onBlur={(e) => {
                            const name = e.target.value.trim();
                            if (!name || name === d.name) {
                              e.target.value = d.name;
                              return;
                            }
                            const previous = d.name;
                            act(async () => {
                              await save("/api/devices", { ...d, name });
                              const match = (state.parents ?? []).filter(
                                (p) => p.name === previous,
                              );
                              if (match.length === 1)
                                await save("/api/parents/rename", {
                                  id: match[0].id,
                                  name,
                                });
                            });
                          }}
                        />
                      </td>
                      <td>
                        {d.admin ? (
                          <select
                            aria-label={`${d.name} client`}
                            value="admin"
                            disabled
                          >
                            <option value="admin">admin</option>
                          </select>
                        ) : (
                          <select
                            aria-label={`${d.name} client`}
                            disabled={!!d.user_id}
                            value={String(d.profile_id)}
                            onChange={(e) =>
                              act(() =>
                                save("/api/devices", {
                                  ...d,
                                  profile_id: Number(e.target.value),
                                }),
                              )
                            }
                          >
                            {state.profiles.map((p) => (
                              <option key={p.id} value={p.id}>
                                {clientName(p)}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td>
                        {d.ip}
                        <small>
                          {d.kind === "home" ? "Home network" : "VPN"}
                        </small>
                        {d.kind === "home" && state.home_network ? (
                          <details>
                            <summary>How to connect</summary>
                            <HomeSetup network={state.home_network} ip={d.ip} />
                          </details>
                        ) : null}
                      </td>
                      <td>
                        {d.admin ? null : d.last_seen ? ago(d.last_seen) : "Never"}
                        {!d.admin && d.diagnostics?.issues.length ? (
                          <ul
                            className="issues"
                            aria-label={`${d.name} health`}
                          >
                            {d.diagnostics.issues.map((i) => (
                              <li key={i.code} className={i.severity}>
                                {i.message}
                                {i.action ? <small>{i.action}</small> : null}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </td>
                      <td>
                        {d.admin ? null : d.kind === "home" ? (
                          <small>Not available</small>
                        ) : d.location ? (
                          <a
                            href={`https://www.openstreetmap.org/?mlat=${d.location.latitude}&mlon=${d.location.longitude}#map=16/${d.location.latitude}/${d.location.longitude}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            ±{Math.round(d.location.accuracy)} m ·{" "}
                            {ago(d.location.at)}
                          </a>
                        ) : (
                          <small>None shared</small>
                        )}
                        {!d.admin &&
                        d.location_requested &&
                        Date.now() / 1000 - d.location_requested < 3600 ? (
                          <small> · waiting for device…</small>
                        ) : null}
                      </td>
                      <td className="controls">
                        {d.admin ? null : (
                          <>
                            {d.kind === "home" ? null : (
                              <button
                                onClick={() =>
                                  act(() =>
                                    save("/api/devices/locate", { ip: d.ip }),
                                  )
                                }
                              >
                                Locate
                              </button>
                            )}
                            <button
                              onClick={() =>
                                act(() =>
                                  save("/api/devices", {
                                    ...d,
                                    paused: !d.paused,
                                  }),
                                )
                              }
                            >
                              {d.paused ? "Resume" : "Pause"}
                            </button>
                            <button
                              onClick={() =>
                                act(() =>
                                  save("/api/devices", {
                                    ...d,
                                    managed: !d.managed,
                                  }),
                                )
                              }
                            >
                              {d.managed ? "Set unmanaged" : "Manage"}
                            </button>
                            <button
                              onClick={() => {
                                if (
                                  confirm(
                                    d.kind === "home"
                                      ? `Stop managing ${d.name}?`
                                      : `Revoke ${d.name}'s VPN and device token?`,
                                  )
                                )
                                  act(() =>
                                    save("/api/devices/delete", { ip: d.ip }),
                                  );
                              }}
                            >
                              {d.kind === "home" ? "Remove" : "Revoke"}
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
        {tab === "usage" ? (
          <>
            <div className="section-title">
              <div>
                <h2>Observed usage by day</h2>
                <p>
                  Distinct allowed traffic minutes, shared across each client’s
                  devices.
                </p>
              </div>
              <select
                aria-label="Usage period"
                value={period}
                onChange={(e) => setPeriod(Number(e.target.value))}
              >
                <option value={1}>Today</option>
                <option value={7}>Last 7 days</option>
                <option value={30}>Last 30 days</option>
              </select>
            </div>
            <UsageCharts
              days={currentUsage}
              start={usageStart.toISOString().slice(0, 10)}
              end={state.day}
            />
            <section className="comparison">
              {state.profiles.map((p) => {
                const cutoff = new Date(state.day + "T12:00:00Z");
                cutoff.setUTCDate(cutoff.getUTCDate() - period + 1);
                const boundary = cutoff.toISOString().slice(0, 10);
                const sum = (current: boolean) => {
                  const totals: Record<string, number> = {};
                  for (const day of usage)
                    if (day.day >= boundary === current)
                      for (const [bucket, n] of Object.entries(
                        day.profiles[p.id] ?? {},
                      ))
                        totals[bucket] = (totals[bucket] ?? 0) + n;
                  return totals;
                };
                const now = sum(true),
                  before = sum(false),
                  total = now.total ?? 0,
                  previous = before.total ?? 0;
                const top = Object.entries(now)
                  .filter(([bucket]) => bucket !== "total")
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 3);
                return (
                  <article key={p.id} aria-label={`${clientName(p)} usage summary`}>
                    <h3>
                      {p.avatar === "◒" ? <BrandMark /> : p.avatar} {clientName(p)}
                    </h3>
                    <strong>{total} min</strong>
                    <small>
                      {previous
                        ? `${total >= previous ? "▲" : "▼"} ${Math.abs(
                            Math.round(((total - previous) / previous) * 100),
                          )}% vs previous ${period === 1 ? "day" : `${period} days`}`
                        : `Nothing to compare: no activity ${period === 1 ? "the day" : `in the ${period} days`} before`}
                    </small>
                    <ol>
                      {top.map(([bucket, n]) => (
                        <li key={bucket}>
                          {bucketLabel(bucket, p)} <span>{n} min</span>
                        </li>
                      ))}
                    </ol>
                  </article>
                );
              })}
            </section>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    {state.profiles.map((p) => (
                      <th key={p.id}>{clientName(p)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {currentUsage.map((day) => (
                    <tr key={day.day}>
                      <td>
                        {formatDay(day.day, {
                          weekday: "short",
                          month: "short",
                          day: "numeric",
                        })}
                      </td>
                      {state.profiles.map((p) => (
                        <td key={p.id}>
                          {day.profiles[p.id]?.total ?? 0} min
                          <small>
                            {Object.entries(day.profiles[p.id] ?? {})
                              .filter(([bucket]) => bucket !== "total")
                              .map(
                                ([bucket, count]) =>
                                  `${bucketLabel(bucket, p)} ${count} min`,
                              )
                              .join(" · ")}
                          </small>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {currentUsage.length === 0 ? (
              <div className="empty">No observed activity in this period.</div>
            ) : null}
          </>
        ) : null}
        {tab === "history" ? (
          <>
            <div className="filters">
              <label>
                Date
                <input
                  type="date"
                  value={date || state.day}
                  onChange={(e) => setDate(e.target.value)}
                />
              </label>
              <label>
                Client
                <select
                  value={historyProfile}
                  onChange={(e) => setHistoryProfile(e.target.value)}
                >
                  <option value="">All clients</option>
                  {state.profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {clientName(p)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Decision
                <select
                  value={blocked}
                  onChange={(e) => setBlocked(e.target.value)}
                >
                  <option value="all">All</option>
                  <option value="true">Blocked</option>
                  <option value="false">Allowed</option>
                </select>
              </label>
              <a
                className="button secondary"
                href={
                  "/api/history?" +
                  new URLSearchParams({
                    start: date || state.day,
                    end: date || state.day,
                    format: "csv",
                    ...(historyProfile ? { profile_id: historyProfile } : {}),
                    ...(blocked === "all" ? {} : { blocked }),
                  })
                }
              >
                Export CSV
              </a>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Client</th>
                    <th>Domain</th>
                    <th>Decision</th>
                    <th>Rule action</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => {
                    const profile = profileById.get(h.profile_id);
                    return (
                      <tr key={h.id}>
                        <td>
                          {new Date(h.at * 1000).toLocaleTimeString(undefined, {
                            timeZone: state.timezone,
                          })}
                        </td>
                        <td>{profile?.name}</td>
                        <td className="domain">{h.domain}</td>
                        <td>
                          <span
                            className={
                              "badge " + (h.blocked ? "blocked" : "allowed")
                            }
                          >
                            {h.blocked
                              ? `Blocked · ${reasonLabel(h.reason, profile)}`
                              : reasonLabel(h.reason, profile)}
                          </span>
                        </td>
                        <td className="controls">
                          {(["allow", "deny", "unmanaged"] as const).map(
                            (key) => (
                              <button
                                key={key}
                                className={
                                  profile?.[key].includes(h.domain)
                                    ? "on"
                                    : undefined
                                }
                                aria-pressed={
                                  !!profile?.[key].includes(h.domain)
                                }
                                onClick={() =>
                                  act(async () => {
                                    const p = profileById.get(h.profile_id);
                                    if (!p) return;
                                    const next = {
                                      ...p,
                                      allow: p.allow.filter(
                                        (d) => d !== h.domain,
                                      ),
                                      deny: p.deny.filter(
                                        (d) => d !== h.domain,
                                      ),
                                      unmanaged: p.unmanaged.filter(
                                        (d) => d !== h.domain,
                                      ),
                                    };
                                    next[key] = [...next[key], h.domain];
                                    await save("/api/profiles", next);
                                  })
                                }
                              >
                                {capitalize(key)}
                              </button>
                            ),
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!history.length ? (
              <div className="empty">
                No recorded domain requests for these filters.
              </div>
            ) : null}
          </>
        ) : null}
        {tab === "requests" ? (
          <>
            <section>
              <h2>Time requests</h2>
              {state.requests.map((r) => (
                <article className="row-card" key={r.id}>
                  <div>
                    <strong>
                      {clientName(profileById.get(r.profile_id))} · {r.minutes} extra
                      minutes
                    </strong>
                    <p>{r.message}</p>
                    <span
                      className={
                        "badge " +
                        (r.status === "approved"
                          ? "allowed"
                          : r.status === "denied"
                            ? "blocked"
                            : "")
                      }
                    >
                      {r.status === "pending"
                        ? "Waiting for an answer"
                        : r.status === "approved"
                          ? "Approved"
                          : "Declined"}
                    </span>
                  </div>
                  {r.status === "pending" ? (
                    <div>
                      <button onClick={() => answer(r.id, true)}>
                        Approve
                      </button>
                      <button onClick={() => answer(r.id, false)}>
                        Decline
                      </button>
                    </div>
                  ) : null}
                </article>
              ))}
              {state.requests.length ? null : (
                <p className="hint">No requests yet.</p>
              )}
            </section>
            <section>
              <h2>Send a reward</h2>
              <p>Rewards expire at midnight in the household timezone.</p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  const kind = f.get("kind");
                  act(() =>
                    save("/api/rewards", {
                      profile_id: Number(f.get("profile_id")),
                      kind,
                      ...(kind === "extra_time"
                        ? {
                            minutes: Number(f.get("minutes")),
                            scope: f.get("scope") || "total",
                          }
                        : kind === "late_bedtime"
                          ? { bedtime: f.get("bedtime") || undefined }
                          : { window_id: f.get("window_id") || undefined }),
                    }),
                  );
                }}
              >
                <div className="two">
                  <label>
                    Client
                    <select
                      name="profile_id"
                      value={selected ?? state.profiles[0]?.id ?? ""}
                      onChange={(e) => setSelected(Number(e.target.value))}
                    >
                      {state.profiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {clientName(p)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Reward
                    <select
                      name="kind"
                      value={rewardKind}
                      onChange={(e) => setRewardKind(e.target.value)}
                    >
                      <option value="extra_time">Extra time</option>
                      {profileById.get(selected ?? state.profiles[0]?.id)
                        ?.bedtime.enabled === false ? null : (
                        <option value="late_bedtime">Late bedtime</option>
                      )}
                      <option value="skip_window">Skip a schedule today</option>
                    </select>
                  </label>
                  {rewardKind === "extra_time" ? (
                    <>
                      <label>
                        Extra minutes
                        <input
                          name="minutes"
                          type="number"
                          min={1}
                          max={1440}
                          defaultValue={15}
                        />
                      </label>
                      <label>
                        Extra time for
                        <select name="scope">
                          <option value="total">Daily allowance</option>
                          {(
                            profileById.get(selected ?? state.profiles[0]?.id)
                              ?.app_limits ?? []
                          ).map((g) => (
                            <option key={g.id} value={"group:" + g.id}>
                              {g.name} (shared app limit)
                            </option>
                          ))}
                        </select>
                      </label>
                    </>
                  ) : rewardKind === "late_bedtime" ? (
                    <label>
                      New bedtime
                      <input name="bedtime" type="time" />
                    </label>
                  ) : (
                    <label>
                      Schedule
                      <select name="window_id">
                        <option value="">Choose a window</option>
                        {(
                          profileById.get(selected ?? state.profiles[0]?.id)
                            ?.schedules ?? []
                        ).map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
                <button className="primary">Send reward</button>
              </form>
            </section>
            <section>
              <h2>Today’s rewards</h2>
              {state.rewards.map((r) => (
                <article className="row-card" key={r.id}>
                  <span>
                    {clientName(profileById.get(r.profile_id))}:{" "}
                    {r.kind === "extra_time"
                      ? `${r.minutes} extra minutes`
                      : r.kind === "late_bedtime"
                        ? `late bedtime ${r.bedtime}`
                        : `skip ${
                            profileById
                              .get(r.profile_id)
                              ?.schedules.find((s) => s.id === r.window_id)
                              ?.name ?? "schedule"
                          }`}
                  </span>
                  <button
                    onClick={() =>
                      act(() => save("/api/rewards/delete", { id: r.id }))
                    }
                  >
                    Cancel reward
                  </button>
                </article>
              ))}
              {state.rewards.length ? null : (
                <p className="hint">No rewards yet today.</p>
              )}
            </section>
            <section>
              <h2>Family notifications</h2>
              <button
                className="secondary"
                onClick={() => act(() => save("/api/events/read", {}))}
              >
                Mark all read
              </button>
              {state.events
                .slice(-20)
                .reverse()
                .map((e) => (
                  <p key={e.id}>
                    {e.read ? "" : "● "}
                    {e.message}{" "}
                    <small>{new Date(e.at * 1000).toLocaleString()}</small>
                  </p>
                ))}
            </section>
          </>
        ) : null}
        {tab === "settings" ? (
          <>
            <section>
              <h2>Household resilience & privacy</h2>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  act(() =>
                    save("/api/settings", {
                      retention_days: Number(f.get("retention")),
                      offline_grace_seconds: Number(f.get("grace")) * 3600,
                    }),
                  );
                }}
              >
                <div className="two">
                  <label>
                    History retention (days)
                    <input
                      name="retention"
                      type="number"
                      min={1}
                      max={90}
                      defaultValue={state.retention_days}
                    />
                  </label>
                  <label>
                    Cached-policy offline grace (hours)
                    <input
                      name="grace"
                      type="number"
                      min={0}
                      max={168}
                      defaultValue={state.offline_grace_seconds / 3600}
                    />
                    <small>
                      Agent keeps enforcing saved policy during an outage;
                      crashes still expire firewall leases.
                    </small>
                  </label>
                </div>
                <button className="primary">Save settings</button>
              </form>
            </section>
            <RemoteAccess
              state={state}
              onSave={(network) =>
                act(() => save("/api/settings", { network }))
              }
            />
            <section>
              <h2>Portable backup</h2>
              <p>
                Keep your policy and history independent of a hosting provider.
              </p>
              <a className="button secondary" href="/api/export">
                Download backup
              </a>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  const input = e.currentTarget.elements.namedItem(
                    "backup",
                  ) as HTMLInputElement;
                  const file = input.files?.[0];
                  act(async () => {
                    if (!file) throw new Error("Choose a backup file");
                    await save("/api/import", {
                      confirm: f.get("confirm"),
                      backup: JSON.parse(await file.text()),
                    });
                  });
                }}
              >
                <label>
                  Restore backup
                  <input
                    name="backup"
                    type="file"
                    accept="application/json"
                    required
                  />
                </label>
                <label>
                  Type RESTORE to replace this household’s data
                  <input name="confirm" required pattern="RESTORE" />
                </label>
                <button className="secondary">Restore backup</button>
              </form>
            </section>
            <section>
              <h2>Category feeds</h2>
              <p>
                Import an operator-reviewed domain list. Starter lists do not
                provide complete category coverage.
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  act(() =>
                    save("/api/feeds", {
                      category: f.get("category"),
                      domains: String(f.get("domains"))
                        .split(/\s+/)
                        .filter(Boolean),
                    }),
                  );
                }}
              >
                <label>
                  Category
                  <select name="category">
                    {Object.entries(state.catalog).map(([key, c]) => (
                      <option value={key} key={key}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Domains
                  <textarea
                    name="domains"
                    rows={6}
                    placeholder="One domain per line"
                    required
                  />
                </label>
                <button className="secondary">Import feed</button>
              </form>
            </section>
            <section>
              <h2>Delete domain history</h2>
              <p>This does not remove clients, rules, or minute totals.</p>
              <button
                className="secondary"
                onClick={() => {
                  if (
                    confirm(
                      "Permanently delete this household’s domain history?",
                    )
                  )
                    act(() =>
                      save("/api/history/delete", { confirm: "DELETE" }),
                    );
                }}
              >
                Delete history
              </button>
            </section>
            <SoftwareUpdates
              update={update}
              updating={!!updatingFrom}
              onCheck={() => act(() => loadUpdate(true))}
              onUpdate={() =>
                act(async () => {
                  await api("/api/update", {});
                  setUpdatingFrom(update!.current);
                })
              }
            />
            <section>
              <h2>Restart Temperance</h2>
              <p>
                Reloads the settings file, for example after changing the VPN
                endpoint. Devices and this page reconnect within a few seconds.
              </p>
              <button
                className="secondary"
                disabled={restarting}
                onClick={() => {
                  if (confirm("Restart Temperance now?")) restart();
                }}
              >
                {restarting ? "Restarting…" : "Restart"}
              </button>
            </section>
          </>
        ) : null}
        <footer>
          Temperance{update ? ` ${update.current}` : ""} · open source family
          VPN controls
          <span>Policy version {state.version}</span>
        </footer>
      </main>
      {homeSetup && state?.home_network ? (
        <dialog
          className="editor"
          ref={homeDialog}
          aria-labelledby="home-setup-title"
          onCancel={() => setHomeSetup(undefined)}
        >
          <div className="dialog-heading">
            <h2 id="home-setup-title">Set up {homeSetup.name}</h2>
            <button
              type="button"
              className="close"
              aria-label="Close"
              onClick={() => setHomeSetup(undefined)}
            >
              ×
            </button>
          </div>
          <HomeSetup network={state.home_network} ip={homeSetup.ip} />
          <div className="actions">
            <button
              className="primary"
              type="button"
              onClick={() => setHomeSetup(undefined)}
            >
              Done
            </button>
          </div>
        </dialog>
      ) : null}
      {resetUser ? (
        <dialog
          className="editor"
          ref={resetDialog}
          onCancel={() => setResetUser(undefined)}
        >
          <form
            aria-label="Set client password"
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const password = f.get("password");
              if (password !== f.get("confirm"))
                return setResetError("The passwords do not match");
              try {
                await api("/api/users/update", { id: resetUser.id, password });
                await loadParents();
                setPasswordSet(resetUser.username);
                setResetUser(undefined);
              } catch (error) {
                setResetError(
                  error instanceof Error
                    ? error.message
                    : "Could not set password",
                );
              }
            }}
          >
            <h2>Set password for {resetUser.username}</h2>
            <p>Existing devices will be revoked and must sign in again.</p>
            <label>
              New password
              <input
                name="password"
                type="password"
                minLength={6}
                maxLength={200}
                autoComplete="new-password"
                required
              />
            </label>
            <label>
              Confirm password
              <input
                name="confirm"
                type="password"
                minLength={6}
                maxLength={200}
                autoComplete="new-password"
                required
              />
            </label>
            <p className="error" role="alert">
              {resetError}
            </p>
            <div className="actions">
              <button className="primary">Set password</button>
              <button
                className="secondary"
                type="button"
                onClick={() => setResetUser(undefined)}
              >
                Cancel
              </button>
            </div>
          </form>
        </dialog>
      ) : null}
      {editing ? (
        <ProfileEditor
          profile={editing === true ? undefined : editing}
          onClose={() => setEditing(undefined)}
          onSave={(value) => save("/api/profiles", value)}
          onDelete={
            editing === true
              ? undefined
              : () => save("/api/profiles/delete", { id: editing.id })
          }
        />
      ) : null}
    </>
  );
}
