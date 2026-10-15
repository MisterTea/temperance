"use client";
import { BrandMark } from "./brand-mark";
import { useState } from "react";
import { clientUsername } from "@/lib/accounts";
import { CATALOG, DAYS, PRESETS, type Category } from "@/lib/policy";
import { api } from "./api";
import { DomainList } from "./profile-editor";

const STEPS = ["Welcome", "Admin account", "Client", "Finish"];
const AGES = [
  { value: "kid", label: "Young child", limit: 90, games: 45 },
  { value: "teen", label: "Teen", limit: 180, games: 90 },
  { value: "adult", label: "Adult", limit: 0, games: 0 },
] as const;
const OPTIONAL: Category[] = ["social", "video", "gaming", "shopping", "ads"];
type Age = (typeof AGES)[number]["value"];
const minutes = (text: string) => (text === "" ? "" : Number(text));

/**
 * First-run experience. `mode="account"` starts on a fresh install (no admin
 * account); `mode="rules"` resumes after the owner exists but no rules do.
 */
export function Onboarding({
  mode,
  onAccountCreated,
  onDone,
}: {
  mode: "account" | "rules";
  onAccountCreated: () => Promise<void>;
  onDone: (next: "devices" | "overview") => void;
}) {
  const [step, setStep] = useState(mode === "account" ? 0 : 2);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [age, setAge] = useState<Age>("kid");
  const [limit, setLimit] = useState<number | "">(90);
  const [bedtime, setBedtime] = useState(true);
  const [start, setStart] = useState("21:00");
  const [end, setEnd] = useState("07:00");
  const [blocked, setBlocked] = useState<Category[]>([]);
  const [safe, setSafe] = useState(true);
  const [games, setGames] = useState(true);
  const [gameMinutes, setGameMinutes] = useState<number | "">(45);
  const [gameDomains, setGameDomains] = useState([...CATALOG.gaming.domains]);
  const [saved, setSaved] = useState<string>();

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };
  const chooseAge = (value: Age) => {
    const preset = AGES.find((a) => a.value === value)!;
    setAge(value);
    setLimit(preset.limit);
    setSafe(value !== "adult");
    setGames(preset.games > 0);
    if (preset.games) setGameMinutes(preset.games);
  };
  const finish = (next: "devices" | "overview") =>
    run(async () => {
      await api("/api/setup/complete", {});
      onDone(next);
    });

  return (
    <main className="onboarding">
      <div className="brand">
        <BrandMark />
        <span>
          temperance<small>FAMILY BALANCE</small>
        </span>
      </div>
      <span className="eyebrow">WELCOME TO TEMPERANCE</span>
      <ol className="steps" aria-label="Setup progress">
        {STEPS.map((name, i) => (
          <li
            key={name}
            className={i === step ? "current" : i < step ? "done" : ""}
            aria-current={i === step ? "step" : undefined}
          >
            <span>{i < step ? "✓" : i + 1}</span> {name}
          </li>
        ))}
      </ol>

      {step === 0 ? (
        <section aria-labelledby="welcome">
          <h1 id="welcome">Let’s set up your home.</h1>
          <p>
            This Temperance server is freshly installed. In about two minutes
            you will:
          </p>
          <ol className="plan">
            <li>sign in with your server’s admin password,</li>
            <li>choose starting rules for your first client, and</li>
            <li>connect their first device.</li>
          </ol>
          <p className="hint">
            Everything can be changed later from the dashboard.
          </p>
          <button className="primary" onClick={() => setStep(1)}>
            Get started
          </button>
        </section>
      ) : null}

      {step === 1 ? (
        <form
          aria-labelledby="account"
          onSubmit={(e) => {
            e.preventDefault();
            const f = Object.fromEntries(new FormData(e.currentTarget));
            run(async () => {
              await api("/v1/login", { password: f.password });
              setStep(2);
              await onAccountCreated();
            });
          }}
        >
          <h1 id="account">Sign in with the admin password</h1>
          <label>
            Admin password
            <input
              name="password"
              type="password"
              required
              autoComplete="current-password"
            />
            <small>
              The TEMPERANCE_ADMIN_PASSWORD value configured on your server.
            </small>
          </label>
          <div className="actions">
            <button type="button" className="quiet" onClick={() => setStep(0)}>
              Back
            </button>
            <button className="primary" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </div>
        </form>
      ) : null}

      {step === 2 ? (
        <form
          aria-labelledby="rules"
          onSubmit={(e) => {
            e.preventDefault();
            const entered = String(new FormData(e.currentTarget).get("name"));
            run(async () => {
              const name = clientUsername(entered);
              await api("/api/profiles", {
                name,
                filter_level: age,
                limit: Number(limit),
                categories: blocked,
                safe_search: safe,
                youtube_restricted: safe,
                bedtime: {
                  enabled: bedtime,
                  start,
                  end,
                  days: DAYS,
                },
                app_limits:
                  games && gameDomains.length
                    ? [
                        {
                          id: "games",
                          name: "Games",
                          domains: gameDomains,
                          minutes: Number(gameMinutes),
                        },
                      ]
                    : [],
              });
              setSaved(name);
              setStep(3);
            });
          }}
        >
          <h1 id="rules">Starting rules for your first client</h1>
          <label>
            Username
            <input
              name="name"
              required
              maxLength={40}
              autoCapitalize="none"
              autoCorrect="off"
              placeholder="avery"
            />
          </label>
          <fieldset>
            <legend>Age group</legend>
            <div className="choices">
              {AGES.map((a) => (
                <label key={a.value} className="choice">
                  <input
                    type="radio"
                    name="age"
                    checked={age === a.value}
                    onChange={() => chooseAge(a.value)}
                  />
                  <span>
                    {a.label}
                    <small>
                      Blocks{" "}
                      {PRESETS[a.value]
                        .map((c) => CATALOG[c].name)
                        .map((n) =>
                          /^[A-Z]{2}/.test(n)
                            ? n
                            : n[0].toLowerCase() + n.slice(1),
                        )
                        .join(", ")}
                    </small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="two">
            <label>
              Daily screen-time limit (minutes)
              <input
                type="number"
                min={0}
                max={1440}
                required
                value={limit}
                onChange={(e) => setLimit(minutes(e.target.value))}
              />
              <small>0 means no daily limit.</small>
            </label>
            <fieldset className="inline">
              <legend>Bedtime</legend>
              <label className="check">
                <input
                  type="checkbox"
                  checked={bedtime}
                  onChange={(e) => setBedtime(e.target.checked)}
                />
                Enable bedtime rules
              </label>
              {bedtime ? (
                <div className="two">
                  <label>
                    From
                    <input
                      type="time"
                      value={start}
                      required
                      onChange={(e) => setStart(e.target.value)}
                    />
                  </label>
                  <label>
                    Until
                    <input
                      type="time"
                      value={end}
                      required
                      onChange={(e) => setEnd(e.target.value)}
                    />
                  </label>
                </div>
              ) : (
                <small>Bedtime rules are off for this client.</small>
              )}
            </fieldset>
          </div>
          <fieldset>
            <legend>Also block</legend>
            <div className="choices">
              {OPTIONAL.map((c) => (
                <label key={c} className="check">
                  <input
                    type="checkbox"
                    checked={blocked.includes(c)}
                    onChange={(e) =>
                      setBlocked(
                        e.target.checked
                          ? [...blocked, c]
                          : blocked.filter((x) => x !== c),
                      )
                    }
                  />
                  {CATALOG[c].name}
                </label>
              ))}
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={safe}
                onChange={(e) => setSafe(e.target.checked)}
              />
              Enforce SafeSearch and YouTube Restricted Mode
            </label>
          </fieldset>
          <fieldset>
            <legend>
              <label className="check">
                <input
                  type="checkbox"
                  checked={games}
                  onChange={(e) => setGames(e.target.checked)}
                />
                Share one time limit across games
              </label>
            </legend>
            {games ? (
              <>
                <label>
                  Minutes per day for all games together
                  <input
                    type="number"
                    min={1}
                    max={1440}
                    required
                    value={gameMinutes}
                    onChange={(e) => setGameMinutes(minutes(e.target.value))}
                  />
                </label>
                <DomainList
                  label="Games in the group"
                  value={gameDomains}
                  onChange={setGameDomains}
                />
              </>
            ) : null}
          </fieldset>
          <div className="actions">
            <button
              type="button"
              className="quiet"
              disabled={busy}
              onClick={() => finish("overview")}
            >
              Skip for now
            </button>
            <button className="primary" disabled={busy}>
              {busy ? "Saving…" : "Save rules"}
            </button>
          </div>
        </form>
      ) : null}

      {step === 3 ? (
        <section aria-labelledby="done">
          <h1 id="done">{saved}’s rules are ready.</h1>
          <p>
            {saved} has the rules and the time budget. Add a sign-in on their
            card so a phone can use the app, then scan the setup code under
            Devices. A TV or console is added there and assigned to this client.
          </p>
          <div className="actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => finish("overview")}
            >
              Go to dashboard
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() => finish("devices")}
            >
              Add a device
            </button>
          </div>
        </section>
      ) : null}

      <p role="alert" className="error">
        {error}
      </p>
    </main>
  );
}
