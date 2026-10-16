"use client";
import { useEffect, useId, useRef, useState } from "react";
import { clientUsername } from "@/lib/accounts";
import { CATALOG, DAYS, type AppLimit, type Profile } from "@/lib/policy";
/** `crypto.randomUUID` exists only on HTTPS. A LAN dashboard is usually plain HTTP, where `getRandomValues` still works. */
function browserId(bytes = 16) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
type Span = { name: string; start: string; end: string; days: number[] };
const WEEK = 7 * 1440;
const clock = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
function weekIntervals(w: Span): [number, number][] {
  if (!w.start || !w.end || w.start === w.end) return [];
  const start = clock(w.start),
    end = clock(w.end),
    length = end > start ? end - start : end + 1440 - start;
  return w.days.flatMap((day): [number, number][] => {
    const from = day * 1440 + start,
      to = from + length;
    return to > WEEK
      ? [
          [from, WEEK],
          [0, to - WEEK],
        ]
      : [[from, to]];
  });
}
/** Pairs of windows that are active at the same time, with the days the overlap starts. */
export function scheduleConflicts(spans: Span[]) {
  const found: string[] = [];
  spans.forEach((a, i) =>
    spans.slice(i + 1).forEach((b) => {
      const days = new Set<number>();
      for (const [a0, a1] of weekIntervals(a))
        for (const [b0, b1] of weekIntervals(b)) {
          const from = Math.max(a0, b0);
          if (from < Math.min(a1, b1)) days.add(Math.floor(from / 1440));
        }
      if (days.size)
        found.push(
          `${a.name} and ${b.name} overlap on ${[...days]
            .sort()
            .map((d) => DAY_NAMES[d])
            .join(", ")}`,
        );
    }),
  );
  return found;
}
const fresh = (): Omit<Profile, "id"> => ({
  name: "",
  avatar: "◒",
  filter_level: "kid",
  managed: true,
  paused: false,
  limit: 0,
  weekday_limits: {},
  categories: [],
  allow: [],
  deny: [],
  unmanaged: [],
  allow_only: false,
  safe_search: true,
  youtube_restricted: true,
  bedtime: { enabled: true, start: "", end: "", days: DAYS },
  schedules: [],
  category_limits: {},
  site_limits: {},
  app_limits: [],
});
/** One domain per line (commas also work); keeps the typed text so new lines can be started. */
export function DomainList({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string[];
  onChange: (domains: string[]) => void;
  placeholder?: string;
}) {
  const [text, setText] = useState(value.join("\n"));
  return (
    <label>
      {label}
      <textarea
        rows={Math.min(8, Math.max(3, text.split("\n").length))}
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          onChange(
            e.target.value
              .split(/[\s,]+/)
              .map((s) => s.trim())
              .filter(Boolean),
          );
        }}
      />
    </label>
  );
}
export function ProfileEditor({
  profile,
  onClose,
  onSave,
  onDelete,
}: {
  profile?: Profile;
  onClose: () => void;
  onSave: (value: unknown) => Promise<unknown>;
  onDelete?: () => Promise<unknown>;
}) {
  const [value, setValue] = useState(() =>
    profile
      ? { ...structuredClone(profile), app_limits: profile.app_limits ?? [] }
      : fresh(),
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const bedtimeOn = value.bedtime.enabled !== false;
  const conflicts = scheduleConflicts([
    ...value.schedules,
    ...(bedtimeOn ? [{ name: "Bedtime", ...value.bedtime }] : []),
  ]);
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const field = <K extends keyof typeof value>(
    key: K,
    next: (typeof value)[K],
  ) => setValue((v) => ({ ...v, [key]: next }));
  return (
    <dialog ref={dialog} onCancel={onClose} className="editor">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await onSave({ ...value, name: clientUsername(value.name) });
            onClose();
          } catch (e) {
            setError(e instanceof Error ? e.message : "Could not save");
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="section-title">
          <h2>{profile ? "Edit client" : "Add a client"}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close editor"
            className="quiet"
          >
            ×
          </button>
        </div>
        <div className="two">
          <label>
            Username
            <input
              value={value.name}
              maxLength={40}
              autoCapitalize="none"
              autoCorrect="off"
              onChange={(e) => field("name", e.target.value)}
              required
            />
          </label>
          <label>
            Avatar
            <input
              value={value.avatar}
              maxLength={12}
              onChange={(e) => field("avatar", e.target.value)}
            />
          </label>
        </div>
        <div className="two">
          <label>
            Filter preset
            <select
              value={value.filter_level}
              onChange={(e) =>
                field("filter_level", e.target.value as Profile["filter_level"])
              }
            >
              {(
                [
                  ["kid", "Young child"],
                  ["teen", "Teen"],
                  ["adult", "Adult"],
                  ["none", "No filtering"],
                ] as const
              ).map(([level, label]) => (
                <option key={level} value={level}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Daily network-minute limit
            <input
              type="number"
              min={0}
              max={1440}
              value={value.limit}
              onChange={(e) => field("limit", Number(e.target.value))}
            />
            <small>
              0 = unlimited. Network estimates include background traffic.
            </small>
          </label>
        </div>
        <fieldset>
          <legend>Weekday limits</legend>
          <div className="day-limits">
            {DAY_NAMES.map((name, n) => (
              <label key={name}>
                {name}
                <input
                  aria-label={`${name} limit`}
                  type="number"
                  min={0}
                  max={1440}
                  placeholder="Default"
                  value={value.weekday_limits[n] ?? ""}
                  onChange={(e) => {
                    const limits = { ...value.weekday_limits };
                    if (e.target.value === "") delete limits[n];
                    else limits[n] = Number(e.target.value);
                    field("weekday_limits", limits);
                  }}
                />
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>Additional category blocks</legend>
          <div className="checks">
            {Object.entries(CATALOG).map(([key, category]) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={value.categories.includes(
                    key as keyof typeof CATALOG,
                  )}
                  onChange={(e) =>
                    field(
                      "categories",
                      e.target.checked
                        ? [...value.categories, key as keyof typeof CATALOG]
                        : value.categories.filter((k) => k !== key),
                    )
                  }
                />
                {category.name}
              </label>
            ))}
          </div>
          <small>
            Preset blocks apply too. Category coverage comes from starter
            domains and operator-imported feeds. YouTube is part of Video &amp;
            streaming: blocking video blocks YouTube too.
          </small>
        </fieldset>
        <div className="checks">
          <label>
            <input
              type="checkbox"
              checked={value.safe_search}
              onChange={(e) => field("safe_search", e.target.checked)}
            />
            Force supported SafeSearch DNS
          </label>
          <label>
            <input
              type="checkbox"
              checked={value.youtube_restricted}
              onChange={(e) => field("youtube_restricted", e.target.checked)}
            />
            YouTube restricted mode
          </label>
          <label>
            <input
              type="checkbox"
              checked={value.allow_only}
              onChange={(e) => field("allow_only", e.target.checked)}
            />
            Allow-list only
          </label>
        </div>
        <fieldset>
          <legend>Bedtime</legend>
          <label className="check">
            <input
              type="checkbox"
              checked={bedtimeOn}
              onChange={(e) =>
                field("bedtime", { ...value.bedtime, enabled: e.target.checked })
              }
            />
            Enable bedtime rules
          </label>
          {bedtimeOn ? (
            <>
              <div className="two">
                <label>
                  Starts
                  <input
                    type="time"
                    value={value.bedtime.start}
                    onChange={(e) =>
                      field("bedtime", {
                        ...value.bedtime,
                        start: e.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  Ends
                  <input
                    type="time"
                    value={value.bedtime.end}
                    onChange={(e) =>
                      field("bedtime", { ...value.bedtime, end: e.target.value })
                    }
                  />
                </label>
              </div>
              <div className="checks">
                {DAY_NAMES.map((name, n) => (
                  <label key={name}>
                    <input
                      type="checkbox"
                      checked={value.bedtime.days.includes(n)}
                      onChange={(e) =>
                        field("bedtime", {
                          ...value.bedtime,
                          days: e.target.checked
                            ? [...value.bedtime.days, n]
                            : value.bedtime.days.filter((d) => d !== n),
                        })
                      }
                    />
                    {name}
                  </label>
                ))}
              </div>
              <small>
                Days identify the night the window starts. Overnight windows
                continue into the following day.
              </small>
            </>
          ) : (
            <small>Bedtime rules are off for this client.</small>
          )}
        </fieldset>
        <fieldset>
          <legend>Off Time & Focus Time</legend>
          {value.schedules.map((window, i) => (
            <section key={window.id} className="schedule">
              <div className="two">
                <label>
                  Window name
                  <input
                    value={window.name}
                    required
                    onChange={(e) =>
                      field(
                        "schedules",
                        value.schedules.map((s, n) =>
                          n === i ? { ...s, name: e.target.value } : s,
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  Mode
                  <select
                    value={window.mode}
                    onChange={(e) =>
                      field(
                        "schedules",
                        value.schedules.map((s, n) =>
                          n === i
                            ? { ...s, mode: e.target.value as "off" | "focus" }
                            : s,
                        ),
                      )
                    }
                  >
                    <option value="off">Off Time</option>
                    <option value="focus">Focus Time</option>
                  </select>
                </label>
              </div>
              <div className="two">
                {(["start", "end"] as const).map((key) => (
                  <label key={key}>
                    {key}
                    <input
                      type="time"
                      required
                      value={window[key]}
                      onChange={(e) =>
                        field(
                          "schedules",
                          value.schedules.map((s, n) =>
                            n === i ? { ...s, [key]: e.target.value } : s,
                          ),
                        )
                      }
                    />
                  </label>
                ))}
              </div>
              <div className="checks">
                {DAY_NAMES.map((name, day) => (
                  <label key={name}>
                    <input
                      type="checkbox"
                      checked={window.days.includes(day)}
                      onChange={(e) =>
                        field(
                          "schedules",
                          value.schedules.map((s, n) =>
                            n === i
                              ? {
                                  ...s,
                                  days: e.target.checked
                                    ? [...s.days, day]
                                    : s.days.filter((d) => d !== day),
                                }
                              : s,
                          ),
                        )
                      }
                    />
                    {name}
                  </label>
                ))}
              </div>
              {window.mode === "focus" ? (
                <>
                  <label>
                    Allowed learning domains
                    <textarea
                      value={window.allow.join("\n")}
                      onChange={(e) =>
                        field(
                          "schedules",
                          value.schedules.map((s, n) =>
                            n === i
                              ? {
                                  ...s,
                                  allow: e.target.value
                                    .split("\n")
                                    .filter(Boolean),
                                }
                              : s,
                          ),
                        )
                      }
                    />
                  </label>
                  <div className="checks">
                    {Object.entries(CATALOG).map(([key, c]) => (
                      <label key={key}>
                        <input
                          type="checkbox"
                          checked={window.allowed_categories.includes(
                            key as keyof typeof CATALOG,
                          )}
                          onChange={(e) =>
                            field(
                              "schedules",
                              value.schedules.map((s, n) =>
                                n === i
                                  ? {
                                      ...s,
                                      allowed_categories: e.target.checked
                                        ? [
                                            ...s.allowed_categories,
                                            key as keyof typeof CATALOG,
                                          ]
                                        : s.allowed_categories.filter(
                                            (k) => k !== key,
                                          ),
                                    }
                                  : s,
                              ),
                            )
                          }
                        />
                        {c.name}
                      </label>
                    ))}
                  </div>
                </>
              ) : null}
              <button
                type="button"
                className="quiet"
                onClick={() =>
                  field(
                    "schedules",
                    value.schedules.filter((_, n) => n !== i),
                  )
                }
              >
                Remove window
              </button>
            </section>
          ))}
          {conflicts.length ? (
            <p className="notice warning" aria-live="polite">
              {conflicts.join(". ")}. The stricter rule applies while both are
              active.
            </p>
          ) : null}
          <button
            type="button"
            className="secondary"
            onClick={() =>
              field("schedules", [
                ...value.schedules,
                {
                  id: browserId(),
                  name: "Homework",
                  mode: "focus",
                  start: "16:00",
                  end: "17:00",
                  days: [1, 2, 3, 4, 5],
                  allow: [],
                  allowed_categories: ["education"],
                },
              ])
            }
          >
            + Add schedule
          </button>
        </fieldset>
        <fieldset>
          <legend>Category budgets</legend>
          <div className="two">
            {Object.entries(CATALOG).map(([key, c]) => (
              <label key={key}>
                {c.name}
                <input
                  type="number"
                  min={0}
                  max={1440}
                  value={
                    value.category_limits[key as keyof typeof CATALOG] ?? 0
                  }
                  onChange={(e) =>
                    field("category_limits", {
                      ...value.category_limits,
                      [key]: Number(e.target.value),
                    })
                  }
                />
              </label>
            ))}
          </div>
          <small>
            YouTube minutes count toward both YouTube and Video &amp; streaming,
            so YouTube can have a smaller budget inside the video one.
          </small>
        </fieldset>
        <fieldset>
          <legend>Site/app budgets</legend>
          {Object.entries(value.site_limits).map(([site, limit]) => (
            <div key={site} className="site-budget">
              <label>
                {site}
                <input
                  type="number"
                  min={0}
                  max={1440}
                  value={limit}
                  onChange={(e) =>
                    field("site_limits", {
                      ...value.site_limits,
                      [site]: Number(e.target.value),
                    })
                  }
                />
              </label>
              <button
                type="button"
                className="quiet"
                aria-label={`Remove ${site} budget`}
                onClick={() => {
                  const next = { ...value.site_limits };
                  delete next[site];
                  field("site_limits", next);
                }}
              >
                Remove
              </button>
            </div>
          ))}
          <label>
            Add a site budget
            <input id={id + "site"} placeholder="youtube.com" />
          </label>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              const input = document.getElementById(
                id + "site",
              ) as HTMLInputElement;
              if (input.value.trim()) {
                field("site_limits", {
                  ...value.site_limits,
                  [input.value.trim()]: 30,
                });
                input.value = "";
              }
            }}
          >
            Add site
          </button>
        </fieldset>
        <fieldset>
          <legend>Shared app limits</legend>
          <p className="hint">
            Apps in a group draw from one daily budget: 60 minutes for Games
            means 60 minutes across all of them, not 60 each.
          </p>
          {value.app_limits.map((group, index) => {
            const update = (next: Partial<AppLimit>) =>
              field(
                "app_limits",
                value.app_limits.map((g, i) =>
                  i === index ? { ...g, ...next } : g,
                ),
              );
            return (
              <div
                key={group.id}
                className="app-group"
                role="group"
                aria-label={`App group ${index + 1}`}
              >
                <div className="two">
                  <label>
                    Group name
                    <input
                      value={group.name}
                      maxLength={60}
                      required
                      onChange={(e) => update({ name: e.target.value })}
                    />
                  </label>
                  <label>
                    Shared minutes per day
                    <input
                      type="number"
                      min={1}
                      max={1440}
                      required
                      value={group.minutes}
                      onChange={(e) =>
                        update({ minutes: Number(e.target.value) })
                      }
                    />
                  </label>
                </div>
                <DomainList
                  label="Apps and sites in this group"
                  placeholder={"roblox.com\nminecraft.net"}
                  value={group.domains}
                  onChange={(domains) => update({ domains })}
                />
                <button
                  type="button"
                  className="quiet"
                  onClick={() =>
                    field(
                      "app_limits",
                      value.app_limits.filter((_, i) => i !== index),
                    )
                  }
                >
                  Remove {group.name || "group"}
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="secondary"
            disabled={value.app_limits.length >= 20}
            onClick={() =>
              field("app_limits", [
                ...value.app_limits,
                {
                  id: browserId(4),
                  name: "",
                  domains: [],
                  minutes: 60,
                },
              ])
            }
          >
            + Add app group
          </button>
        </fieldset>
        {(["allow", "deny", "unmanaged"] as const).map((key) => (
          <DomainList
            key={key}
            label={
              key === "allow"
                ? "Always allowed domains"
                : key === "deny"
                  ? "Blocked domains"
                  : "Unmanaged domains (bypass pauses and budgets)"
            }
            value={value[key]}
            onChange={(next) => field(key, next)}
          />
        ))}
        <p role="alert" className="error">
          {error}
        </p>
        <button className="primary full" disabled={busy}>
          {busy ? "Saving…" : "Save client"}
        </button>
        {onDelete ? (
          <button
            type="button"
            className="danger full"
            disabled={busy}
            onClick={async () => {
              if (!confirm(`Delete ${value.name}? This removes their rules and time.`))
                return;
              setBusy(true);
              try {
                await onDelete();
                onClose();
              } catch (e) {
                setError(e instanceof Error ? e.message : "Could not delete");
              } finally {
                setBusy(false);
              }
            }}
          >
            Delete client
          </button>
        ) : null}
      </form>
    </dialog>
  );
}
