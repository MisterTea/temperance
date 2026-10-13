import {
  useEffect,
  useId,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import * as api from "./api";
import type { Action, Child, View } from "./api";

type Run = (action: Action) => Promise<void>;

/** Shown while the slower actions wait on the network or the VPN service. */
const progress: Partial<Record<Action["action"], string>> = {
  enroll: "Signing in and turning on protection…",
  connect: "Starting protection…",
  pair_parent: "Pairing with your home…",
};

export function App() {
  const [view, setView] = useState<View>();
  const [busy, setBusy] = useState<Action["action"]>();
  const [error, setError] = useState("");
  useEffect(() => {
    api.view().then(setView, (e) => setError(String(e)));
    const off = api.onView(setView);
    return () => {
      off.then((stop) => stop());
    };
  }, []);
  const run: Run = async (action) => {
    setBusy(action.action);
    try {
      setView(await api.act(action));
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(undefined);
    }
  };
  const status = (busy && progress[busy]) || error || view?.status;
  return (
    <main aria-busy={!!busy}>
      <header className="brand">
        <span aria-hidden="true">◒</span>
        <span>
          temperance<small>FAMILY BALANCE</small>
        </span>
      </header>
      {status ? (
        <p className="status" role="status">
          {status}
        </p>
      ) : null}
      <fieldset disabled={!!busy}>
        {view ? <Screen view={view} run={run} /> : null}
      </fieldset>
    </main>
  );
}

function Screen({ view, run }: { view: View; run: Run }) {
  switch (view.screen) {
    case "choose":
      return <Choose childAllowed={view.child_allowed} run={run} />;
    case "child":
      return <ChildStatus child={view} run={run} />;
    case "parent":
      return (
        <section>
          <h1>
            {view.household
              ? `Paired with ${view.household}`
              : "Paired with your home"}
          </h1>
          <p>
            This computer opens the family dashboard through your home&apos;s
            Temperance gateway at <strong>{view.host}</strong>, wherever you
            are. No VPN is installed.
          </p>
          <div className="actions">
            <button onClick={() => run({ action: "open_dashboard" })}>
              Open family dashboard
            </button>
            <button
              className="secondary"
              onClick={() =>
                confirm(
                  "Unpair this computer? You can pair it again from the dashboard.",
                ) && run({ action: "unpair_parent" })
              }
            >
              Unpair this computer
            </button>
          </div>
        </section>
      );
    case "parent_broken":
      return (
        <section>
          <h1>This pairing can&apos;t be used</h1>
          <p>{view.error}</p>
          <button
            className="secondary"
            onClick={() => run({ action: "unpair_parent" })}
          >
            Forget this pairing
          </button>
        </section>
      );
  }
}

function Choose({ childAllowed, run }: { childAllowed: boolean; run: Run }) {
  const [mode, setMode] = useState<"child" | "parent">();
  if (!childAllowed) return <ParentPair run={run} />;
  if (mode === "child")
    return <ChildSetup run={run} back={() => setMode(undefined)} />;
  if (mode === "parent")
    return <ParentPair run={run} back={() => setMode(undefined)} />;
  return (
    <section>
      <h1>Is this your child&apos;s computer, or are you a parent?</h1>
      <div className="choices">
        <button className="choice" onClick={() => setMode("child")}>
          <strong>This is my child&apos;s computer</strong>
          <span>Installs your family&apos;s VPN so the rules apply here.</span>
        </button>
        <button className="choice" onClick={() => setMode("parent")}>
          <strong>I&apos;m a parent</strong>
          <span>Opens the family dashboard from anywhere. No VPN.</span>
        </button>
      </div>
    </section>
  );
}

function Field(props: {
  label: string;
  name: string;
  hint?: ReactNode;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
  multiline?: boolean;
}) {
  const { label, hint, multiline, ...input } = props;
  // An empty title keeps WebView2 from showing "Please fill out this field" on hover.
  return (
    <label>
      {label}
      {multiline ? (
        <textarea
          name={input.name}
          placeholder={input.placeholder}
          rows={3}
          title=""
          required
        />
      ) : (
        <input {...input} title="" required />
      )}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

/** WebView2 (Windows) draws its own show/hide button in password fields. */
const nativeReveal = () =>
  typeof CSS !== "undefined" && CSS.supports("selector(::-ms-reveal)");

/** A password input with a button that shows or masks what was typed,
 * unless the web engine already provides one. */
function PasswordField({ label, name }: { label: string; name: string }) {
  const [shown, setShown] = useState(false);
  const id = useId();
  if (nativeReveal())
    return (
      <Field
        label={label}
        name={name}
        type="password"
        autoComplete="current-password"
      />
    );
  return (
    <label>
      <span id={id}>{label}</span>
      <span className="reveal">
        <input
          name={name}
          type={shown ? "text" : "password"}
          autoComplete="current-password"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-labelledby={id}
          title=""
          required
        />
        <button
          type="button"
          className="reveal-toggle"
          aria-label={shown ? "Hide password" : "Show password"}
          aria-pressed={shown}
          title={shown ? "Hide password" : "Show password"}
          onClick={() => setShown(!shown)}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
            <circle cx="12" cy="12" r="3" />
            {shown ? <path d="M3 3l18 18" /> : null}
          </svg>
        </button>
      </span>
    </label>
  );
}

const values = (event: FormEvent<HTMLFormElement>) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  return (name: string) => String(data.get(name) ?? "");
};

function ChildSetup({ run, back }: { run: Run; back: () => void }) {
  return (
    <section>
      <h1>Sign in this computer</h1>
      <p>
        On the family dashboard at home, open Devices and copy the setup code
        for a child&apos;s device. Then use the username and password a parent
        created under Clients.
      </p>
      <form
        onSubmit={(event) => {
          const get = values(event);
          run({
            action: "enroll",
            service: get("service"),
            username: get("username"),
            password: get("password"),
            name: get("name"),
          });
        }}
      >
        <Field
          label="Setup code"
          name="service"
          placeholder="temperance://home#…"
          multiline
        />
        <Field label="Username" name="username" autoComplete="username" />
        <PasswordField label="Password" name="password" />
        <Field
          label="Name for this computer"
          name="name"
          placeholder="Alex's laptop"
          autoComplete="off"
        />
        <button type="submit">Sign in</button>
      </form>
      <button className="link" onClick={back}>
        I&apos;m a parent instead
      </button>
    </section>
  );
}

function ParentPair({ run, back }: { run: Run; back?: () => void }) {
  return (
    <section>
      <h1>Open the family dashboard from anywhere</h1>
      <p>
        At home, open the dashboard&apos;s{" "}
        <strong>Settings → Parent devices</strong>, choose{" "}
        <strong>Pair a parent device</strong>, then{" "}
        <strong>Copy pairing link</strong>.
      </p>
      <form
        onSubmit={(event) => {
          const get = values(event);
          run({ action: "pair_parent", link: get("link"), name: get("name") });
        }}
      >
        <Field
          label="Pairing link"
          name="link"
          placeholder="temperance://pair#…"
          multiline
          hint="Each link works once, for ten minutes."
        />
        <Field
          label="Name for this computer"
          name="name"
          placeholder="Robin's PC"
          autoComplete="off"
        />
        <button type="submit">Pair and open the dashboard</button>
      </form>
      {back ? (
        <button className="link" onClick={back}>
          This is my child&apos;s computer instead
        </button>
      ) : (
        <p className="meta">
          A child&apos;s computer running Linux or macOS is protected through
          your home network instead; see the dashboard&apos;s Devices page.
        </p>
      )}
    </section>
  );
}

function ChildStatus({ child, run }: { child: Child; run: Run }) {
  const [asking, setAsking] = useState(false);
  const [message, setMessage] = useState("");
  // A sent request closes the form; the next one starts from the button again.
  useEffect(() => {
    if (child.pending) setAsking(false);
  }, [child.pending]);
  return (
    <>
      <section className={child.connected ? "" : "warning"}>
        <h1>{child.headline}</h1>
        <p>{child.detail}</p>
        {child.remaining ? <p className="big">{child.remaining}</p> : null}
        {child.next_change ? <p className="meta">{child.next_change}</p> : null}
        {child.connected ? null : (
          <>
            <p>Protection isn&apos;t running on this computer yet.</p>
            <button onClick={() => run({ action: "connect" })}>
              Start protection
            </button>
          </>
        )}
      </section>
      {child.health.length ? (
        <section aria-label="Device health">
          <h2>Needs attention</h2>
          <ul className="issues">
            {child.health.map((issue) => (
              <li key={issue.code}>
                <strong>{issue.message}</strong>
                <span>{issue.action}</span>
              </li>
            ))}
          </ul>
          {child.portal_url ? (
            <button onClick={() => run({ action: "open_portal" })}>
              Open the Wi-Fi sign-in page
            </button>
          ) : null}
          {child.can_sign_in ? (
            <button
              className="secondary"
              onClick={() => run({ action: "sign_in" })}
            >
              Sign in to Wi-Fi
            </button>
          ) : null}
        </section>
      ) : null}
      {child.alerts.length ? (
        <section aria-label="Alerts">
          <h2>Recent alerts</h2>
          <ul>
            {child.alerts.map((alert, i) => (
              <li key={i}>{alert}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {child.pending ? (
        <section>
          <p>Your request for more time is waiting for a parent.</p>
        </section>
      ) : child.can_ask && !asking ? (
        <div className="actions ask">
          <button className="secondary" onClick={() => setAsking(true)}>
            Ask for more time
          </button>
        </div>
      ) : child.can_ask ? (
        <section>
          <h2>Need more time?</h2>
          <label>
            Why do you need more time?
            <input
              name="message"
              maxLength={300}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Finishing my science project"
              autoComplete="off"
            />
          </label>
          <div className="actions">
            {[15, 30, 60].map((minutes) => (
              <button
                key={minutes}
                className="secondary"
                onClick={() =>
                  run({ action: "request_time", minutes, message })
                }
              >
                Ask for {minutes} min
              </button>
            ))}
          </div>
        </section>
      ) : null}
      <footer className="meta">
        Policy {child.version} ·{" "}
        <button className="link" onClick={() => run({ action: "refresh" })}>
          Check for changes
        </button>
      </footer>
    </>
  );
}
