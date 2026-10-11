"use client";
import { useEffect, useId, useRef, useState } from "react";
import { CATALOG, DAYS, type Profile } from "@/lib/policy";
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
  bedtime: { start: "", end: "", days: DAYS },
  schedules: [],
  category_limits: {},
  site_limits: {},
});
export function ProfileEditor({
  profile,
  onClose,
  onSave,
  onDelete,
}: {
  profile?: Profile;
  onClose: () => void;
  onSave: (value: unknown) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [value, setValue] = useState(() =>
    profile ? structuredClone(profile) : fresh(),
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const conflicts = scheduleConflicts([
    ...value.schedules,
    { name: "Bedtime", ...value.bedtime },
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
            await onSave(value);
            onClose();
          } catch (e) {
            setError(e instanceof Error ? e.message : "Could not save");
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="section-title">
          <h2>{profile ? "Edit family rules" : "Add family profile"}</h2>
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
            Name
            <input
              value={value.name}
              maxLength={60}
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
              {["kid", "teen", "adult", "none"].map((level) => (
                <option key={level}>{level}</option>
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
            domains and operator-imported feeds.
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
          <label>
            <input
              type="checkbox"
              checked={!value.managed}
              onChange={(e) => field("managed", !e.target.checked)}
            />
            Unmanaged profile (no controls or history)
          </label>
        </div>
        <fieldset>
          <legend>Bedtime</legend>
          <div className="two">
            <label>
              Starts
              <input
                type="time"
                value={value.bedtime.start}
                onChange={(e) =>
                  field("bedtime", { ...value.bedtime, start: e.target.value })
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
                  id: crypto.randomUUID(),
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
        {(["allow", "deny", "unmanaged"] as const).map((key) => (
          <label key={key}>
            {key === "allow"
              ? "Always allowed domains"
              : key === "deny"
                ? "Blocked domains"
                : "Unmanaged domains (bypass pauses and budgets)"}
            <textarea
              rows={3}
              value={value[key].join("\n")}
              onChange={(e) =>
                field(
                  key,
                  e.target.value
                    .split("\n")
                    .map((s) => s.trim())
                    .filter(Boolean),
                )
              }
            />
          </label>
        ))}
        <p role="alert" className="error">
          {error}
        </p>
        <button className="primary full" disabled={busy}>
          {busy ? "Saving…" : "Save profile"}
        </button>
        {onDelete ? (
          <button
            type="button"
            className="danger full"
            disabled={busy}
            onClick={async () => {
              if (!confirm(`Delete ${value.name}? This removes its rules.`))
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
            Delete profile
          </button>
        ) : null}
      </form>
    </dialog>
  );
}
