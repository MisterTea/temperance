"use client";
import { useCallback, useEffect, useState } from "react";
import type { snapshot } from "@/lib/service";
import { dailyLimit, type Profile } from "@/lib/policy";
import type { History } from "@/lib/model";
import { ProfileEditor } from "./profile-editor";
import { Onboarding } from "./onboarding";
import { api } from "./api";
type DashboardState = ReturnType<typeof snapshot>;
type ParentAccount = { id: string; username: string; role: string };
const ago = (at: number) => {
  const minutes = Math.max(0, Math.round((Date.now() / 1000 - at) / 60));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} d ago`;
};
const bucketLabel = (bucket: string, profile?: Profile) =>
  bucket.startsWith("group:")
    ? ((profile?.app_limits ?? []).find((g) => "group:" + g.id === bucket)
        ?.name ?? "App group")
    : bucket.replace(/^(category|site):/, "");
export function Dashboard() {
  const [state, setState] = useState<DashboardState>();
  const [error, setError] = useState("");
  const [signedIn, setSignedIn] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [onboarding, setOnboarding] = useState<boolean>();
  const [parents, setParents] = useState<ParentAccount[]>([]);
  const [me, setMe] = useState<ParentAccount>();
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Profile | true>();
  const [tab, setTab] = useState("overview");
  const [code, setCode] = useState("");
  const [selected, setSelected] = useState<number>();
  const [history, setHistory] = useState<History[]>([]);
  const [date, setDate] = useState("");
  const [blocked, setBlocked] = useState("all");
  const [historyProfile, setHistoryProfile] = useState("");
  const [usage, setUsage] = useState<
    { day: string; profiles: Record<string, Record<string, number>> }[]
  >([]);
  const [period, setPeriod] = useState(7);
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
  };
  const act = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    }
  };
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
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load accounts");
    }
  }, []);
  useEffect(() => {
    if (tab === "settings" && signedIn) loadParents();
  }, [tab, signedIn, loadParents]);
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
        <h1>Temperance</h1>
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
              Username
              <input
                name="username"
                required
                autoComplete="username"
                autoCapitalize="none"
              />
            </label>
            <label>
              Password
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
  const usageStart = new Date(state.day + "T12:00:00Z");
  usageStart.setUTCDate(usageStart.getUTCDate() - period + 1);
  const currentUsage = usage.filter(
    (d) => d.day >= usageStart.toISOString().slice(0, 10),
  );
  return (
    <>
      <aside>
        <a href="#" className="brand">
          ◒{" "}
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
        <div className="aside-footer">
          Open source · no vendor account
          <small>Your data stays in your chosen service.</small>
        </div>
      </aside>
      <main>
        <header>
          <div className="eyebrow">A LITTLE MORE BALANCE</div>
          <div className="heading">
            <h1>
              {tab === "overview"
                ? "Your family's digital day."
                : tab[0].toUpperCase() + tab.slice(1)}
            </h1>
            <span className="date">
              {state.day} · {state.timezone}
            </span>
          </div>
          <p className="intro">Make room for the things that matter.</p>
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
            <section className="stats">
              <article>
                <span>Network activity minutes</span>
                <strong>{state.total}</strong>
                <small>Estimated allowed traffic across profiles</small>
              </article>
              <article>
                <span>Restricted profiles</span>
                <strong>{state.blocked}</strong>
                <small>Pause, schedule, or daily allowance</small>
              </article>
              <article>
                <span>Family devices</span>
                <strong>{state.devices.length}</strong>
                <small>Enrolled with private device keys</small>
              </article>
            </section>
            <div className="section-title">
              <div>
                <h2>Family profiles</h2>
                <p>A little structure, tailored to each person.</p>
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
                  + Add profile
                </button>
              </div>
            </div>
            <section className="profiles">
              {state.profiles.length ? (
                state.profiles.map((p) => (
                  <article className="profile" key={p.id}>
                    <div className="profile-head">
                      <span className="avatar">{p.avatar}</span>
                      <div>
                        <h3>{p.name}</h3>
                        <small>
                          {
                            state.devices.filter((d) => d.profile_id === p.id)
                              .length
                          }{" "}
                          devices · {p.filter_level} preset
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
                          : p.access_reason}
                      </span>
                    </div>
                    <div className="usage">
                      <strong>{p.used}</strong>
                      <span>
                        min observed{" "}
                        {p.effective_limit
                          ? `/ ${p.effective_limit} allowance`
                          : "· unlimited"}
                      </span>
                    </div>
                    <progress
                      max={p.effective_limit || 1440}
                      value={p.used}
                      aria-label={`${p.name} daily budget`}
                    />
                    <p className="profile-info">
                      {p.schedules.length} schedule windows ·{" "}
                      {p.bedtime.start
                        ? `Bedtime ${p.bedtime.start}–${p.bedtime.end}`
                        : "No bedtime"}
                      <br />
                      {p.unmanaged.length} unmanaged exceptions ·{" "}
                      {p.rewards.length} rewards today
                    </p>
                    {(p.app_limits ?? []).length ? (
                      <ul
                        className="app-groups"
                        aria-label={`${p.name} shared app limits`}
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
                        onClick={() => setEditing(p)}
                      >
                        Edit rules
                      </button>
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
                  </article>
                ))
              ) : (
                <div className="empty">
                  Welcome home. Add a profile, then enroll a device.
                </div>
              )}
            </section>
            <div className="notice">
              <strong>Activity is an estimate, not exact screen time.</strong>
              <p>
                Background traffic can count. Domain/category attribution
                depends on DNS visibility. Use History to understand a decision
                before changing a rule.
              </p>
            </div>
          </>
        ) : null}
        {tab === "devices" ? (
          <>
            <section>
              <h2>Enroll a VPN device</h2>
              <p>Create a one-use code valid for ten minutes.</p>
              <form
                className="enrollment"
                onSubmit={(e) => {
                  e.preventDefault();
                  act(async () => {
                    const pid = Number(
                      new FormData(e.currentTarget).get("profile_id"),
                    );
                    setCode(
                      (
                        await api<{ code: string }>("/api/enrollment", {
                          profile_id: pid,
                        })
                      ).code,
                    );
                  });
                }}
              >
                <label>
                  Family profile
                  <select name="profile_id" required>
                    {state.profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="primary">Create enrollment code</button>
              </form>
              {code ? (
                <label>
                  Enter this code in the Temperance app
                  <input value={code} readOnly />
                  <small>Policy service: {window.location.origin}</small>
                </label>
              ) : null}
            </section>
            <section>
              <h2>Add a home-network device</h2>
              <p>
                For TVs, consoles and speakers that cannot run the app. Reserve
                its address in your router, then run the gateway on your home
                network as its DNS server (and router, for time limits and
                pause).
              </p>
              <form
                className="enrollment"
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = e.currentTarget,
                    data = new FormData(form);
                  act(async () => {
                    await save("/api/devices/home", {
                      name: data.get("name"),
                      ip: data.get("ip"),
                      profile_id: Number(data.get("profile_id")),
                    });
                    form.reset();
                  });
                }}
              >
                <label>
                  Device name
                  <input name="name" required maxLength={80} />
                </label>
                <label>
                  Home-network IPv4 address
                  <input
                    name="ip"
                    required
                    inputMode="decimal"
                    placeholder="192.168.1.50"
                  />
                </label>
                <label>
                  Home device profile
                  <select name="profile_id" required>
                    {state.profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="primary">Add home device</button>
              </form>
            </section>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Device</th>
                    <th>Profile</th>
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
                            if (name && name !== d.name)
                              act(() => save("/api/devices", { ...d, name }));
                            else e.target.value = d.name;
                          }}
                        />
                      </td>
                      <td>
                        <select
                          aria-label={`${d.name} profile`}
                          value={d.profile_id}
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
                              {p.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        {d.ip}
                        <small>
                          {d.kind === "home" ? "Home network" : "VPN"}
                        </small>
                      </td>
                      <td>
                        {d.last_seen ? ago(d.last_seen) : "Never"}
                        {d.diagnostics?.issues.length ? (
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
                        {d.kind === "home" ? (
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
                        {d.location_requested &&
                        Date.now() / 1000 - d.location_requested < 3600 ? (
                          <small> · waiting for device…</small>
                        ) : null}
                      </td>
                      <td>
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
                              save("/api/devices", { ...d, paused: !d.paused }),
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
                  Distinct allowed traffic minutes, shared across each profile’s
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
                  <article key={p.id} aria-label={`${p.name} usage summary`}>
                    <h3>
                      {p.avatar} {p.name}
                    </h3>
                    <strong>{total} min</strong>
                    <small>
                      {previous
                        ? `${total >= previous ? "▲" : "▼"} ${Math.abs(
                            Math.round(((total - previous) / previous) * 100),
                          )}% vs previous ${period === 1 ? "day" : `${period} days`}`
                        : `No activity in the previous ${period === 1 ? "day" : `${period} days`}`}
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
                      <th key={p.id}>{p.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {currentUsage.map((day) => (
                    <tr key={day.day}>
                      <td>{day.day}</td>
                      {state.profiles.map((p) => (
                        <td key={p.id}>
                          {day.profiles[p.id]?.total ?? 0} min
                          <small>
                            {Object.entries(day.profiles[p.id] ?? {})
                              .filter(([bucket]) => bucket !== "total")
                              .map(([bucket, count]) => `${bucket}: ${count}m`)
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
                Profile
                <select
                  value={historyProfile}
                  onChange={(e) => setHistoryProfile(e.target.value)}
                >
                  <option value="">All profiles</option>
                  {state.profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
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
                    <th>Profile</th>
                    <th>Domain</th>
                    <th>Decision</th>
                    <th>Rule action</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id}>
                      <td>
                        {new Date(h.at * 1000).toLocaleTimeString(undefined, {
                          timeZone: state.timezone,
                        })}
                      </td>
                      <td>{profileById.get(h.profile_id)?.name}</td>
                      <td className="domain">{h.domain}</td>
                      <td>
                        <span
                          className={
                            "badge " + (h.blocked ? "blocked" : "allowed")
                          }
                        >
                          {h.reason}
                        </span>
                      </td>
                      <td>
                        {(["allow", "deny", "unmanaged"] as const).map(
                          (key) => (
                            <button
                              key={key}
                              onClick={() =>
                                act(async () => {
                                  const p = profileById.get(h.profile_id);
                                  if (!p) return;
                                  const next = {
                                    ...p,
                                    allow: p.allow.filter(
                                      (d) => d !== h.domain,
                                    ),
                                    deny: p.deny.filter((d) => d !== h.domain),
                                    unmanaged: p.unmanaged.filter(
                                      (d) => d !== h.domain,
                                    ),
                                  };
                                  next[key] = [...next[key], h.domain];
                                  await save("/api/profiles", next);
                                })
                              }
                            >
                              {key}
                            </button>
                          ),
                        )}
                      </td>
                    </tr>
                  ))}
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
                    Profile
                    <select
                      name="profile_id"
                      value={selected ?? state.profiles[0]?.id ?? ""}
                      onChange={(e) => setSelected(Number(e.target.value))}
                    >
                      {state.profiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Reward
                    <select name="kind">
                      <option value="extra_time">Extra time</option>
                      <option value="late_bedtime">Late bedtime</option>
                      <option value="skip_window">Skip a schedule today</option>
                    </select>
                  </label>
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
                  <label>
                    New bedtime
                    <input name="bedtime" type="time" />
                  </label>
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
                </div>
                <button className="primary">Send reward</button>
              </form>
            </section>
            <section>
              <h2>Today’s rewards</h2>
              {state.rewards.map((r) => (
                <article className="row-card" key={r.id}>
                  <span>
                    {profileById.get(r.profile_id)?.name}:{" "}
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
            </section>
            <section>
              <h2>Time requests</h2>
              {state.requests.map((r) => (
                <article className="row-card" key={r.id}>
                  <div>
                    <strong>
                      {profileById.get(r.profile_id)?.name} · {r.minutes} extra
                      minutes
                    </strong>
                    <p>{r.message}</p>
                    <small>{r.status}</small>
                  </div>
                  {r.status === "pending" ? (
                    <div>
                      <button
                        onClick={() =>
                          act(() =>
                            save("/api/requests", { id: r.id, approve: true }),
                          )
                        }
                      >
                        Approve
                      </button>
                      <button
                        onClick={() =>
                          act(() =>
                            save("/api/requests", { id: r.id, approve: false }),
                          )
                        }
                      >
                        Decline
                      </button>
                    </div>
                  ) : null}
                </article>
              ))}
            </section>
            <section>
              <h2>Family notifications</h2>
              <button onClick={() => act(() => save("/api/events/read", {}))}>
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
                      home_profile_id: f.get("home")
                        ? Number(f.get("home"))
                        : null,
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
                  <label>
                    Home/default profile
                    <select
                      name="home"
                      defaultValue={state.home_profile_id ?? ""}
                    >
                      <option value="">No default</option>
                      {state.profiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <button className="primary">Save settings</button>
              </form>
            </section>
            <section>
              <h2>Family administrators</h2>
              <p>
                Co-parents sign in with their own username and password.
                Passwords are stored only as salted PBKDF2 hashes.
              </p>
              {parents.map((u) => (
                <article className="row-card" key={u.id}>
                  <span>
                    <strong>{u.username}</strong> <small>{u.role}</small>
                  </span>
                  {me?.role === "owner" && u.id !== me.id ? (
                    <button
                      onClick={() => {
                        if (confirm(`Remove ${u.username}'s access?`))
                          act(async () => {
                            setParents(
                              await api<ParentAccount[]>("/api/users/delete", {
                                id: u.id,
                              }),
                            );
                          });
                      }}
                    >
                      Remove
                    </button>
                  ) : null}
                </article>
              ))}
              {me?.role === "owner" ? (
                <form
                  aria-label="Add parent"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const target = e.currentTarget;
                    const f = Object.fromEntries(new FormData(target));
                    act(async () => {
                      await api("/api/users", f);
                      target.reset();
                      await loadParents();
                    });
                  }}
                >
                  <div className="two">
                    <label>
                      Co-parent username
                      <input
                        name="username"
                        required
                        autoComplete="off"
                        autoCapitalize="none"
                      />
                    </label>
                    <label>
                      Initial password
                      <input
                        name="password"
                        type="password"
                        minLength={10}
                        required
                        autoComplete="new-password"
                      />
                    </label>
                  </div>
                  <button className="secondary">Add parent</button>
                </form>
              ) : null}
              {me && me.role !== "service" ? (
                <form
                  aria-label="Change password"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = Object.fromEntries(new FormData(e.currentTarget));
                    act(async () => {
                      await api("/api/password", f);
                      setSignedIn(false);
                      setState(undefined);
                    });
                  }}
                >
                  <div className="two">
                    <label>
                      Current password
                      <input
                        name="current_password"
                        type="password"
                        required
                        autoComplete="current-password"
                      />
                    </label>
                    <label>
                      New password
                      <input
                        name="new_password"
                        type="password"
                        minLength={10}
                        required
                        autoComplete="new-password"
                      />
                    </label>
                  </div>
                  <button className="secondary">Change password</button>
                </form>
              ) : null}
            </section>
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
              <p>This does not remove profiles, rules, or minute totals.</p>
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
          </>
        ) : null}
        <footer>
          Temperance · open source family VPN controls
          <span>Policy version {state.version}</span>
        </footer>
      </main>
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
