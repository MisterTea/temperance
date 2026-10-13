import { act as react, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import { expect, test, vi } from "vitest";
import type { Action, Child, View } from "../src/api";
import { App } from "../src/App";

const child: Child = {
  headline: "You're online",
  detail: "Your family's rules apply.",
  remaining: "55 min left today",
  next_change: "Bedtime starts at 21:00",
  version: 3,
  connected: true,
  alerts: [],
  health: [],
  portal_url: null,
  can_sign_in: false,
  can_ask: true,
  pending: false,
};

/** Answers the app's two commands; `act` replies come from `next`. */
function backend(
  first: View,
  next: (action: Action) => View | Error = () => first,
) {
  const actions: Action[] = [];
  mockIPC(
    (cmd, args) => {
      if (cmd === "view") return first;
      if (cmd === "act") {
        const action = (args as { action: Action }).action;
        actions.push(action);
        const reply = next(action);
        if (reply instanceof Error) throw reply.message;
        return reply;
      }
    },
    { shouldMockEvents: true },
  );
  return actions;
}

test("a parent chooses parent mode, pastes the link and opens the dashboard", async () => {
  const actions = backend(
    { status: "", screen: "choose", child_allowed: true },
    () => ({
      status: "The family dashboard opened in its own window.",
      screen: "parent",
      household: "The Parkers",
      host: "parkers.ddnsfree.com",
    }),
  );
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: /I'm a parent/ }));
  // No "Please fill out this field" tooltip while the pointer rests on an empty field.
  expect(screen.getByLabelText(/Pairing link/).getAttribute("title")).toBe("");
  expect(
    screen.getByLabelText("Name for this computer").getAttribute("title"),
  ).toBe("");
  await user.type(
    screen.getByLabelText(/Pairing link/),
    "temperance://pair#abc",
  );
  await user.type(
    screen.getByLabelText("Name for this computer"),
    "Robin's PC",
  );
  await user.click(
    screen.getByRole("button", { name: "Pair and open the dashboard" }),
  );
  expect(actions).toEqual([
    {
      action: "pair_parent",
      link: "temperance://pair#abc",
      name: "Robin's PC",
    },
  ]);
  expect(
    await screen.findByRole("heading", { name: "Paired with The Parkers" }),
  ).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain(
    "opened in its own window",
  );
  expect(screen.getByText("parkers.ddnsfree.com")).toBeTruthy();

  await user.click(
    screen.getByRole("button", { name: "Open family dashboard" }),
  );
  expect(actions.at(-1)).toEqual({ action: "open_dashboard" });
  vi.spyOn(window, "confirm")
    .mockReturnValueOnce(false)
    .mockReturnValueOnce(true);
  await user.click(
    screen.getByRole("button", { name: "Unpair this computer" }),
  );
  expect(actions).toHaveLength(2);
  await user.click(
    screen.getByRole("button", { name: "Unpair this computer" }),
  );
  expect(actions.at(-1)).toEqual({ action: "unpair_parent" });
});

test("a child's computer signs in, and protection can be restarted if it stops", async () => {
  const actions = backend(
    { status: "", screen: "choose", child_allowed: true },
    (action) =>
      action.action === "enroll"
        ? {
            status: "WireGuard: the tunnel service did not start",
            screen: "child",
            ...child,
            connected: false,
          }
        : { status: "Protected.", screen: "child", ...child },
  );
  const user = userEvent.setup();
  render(<App />);
  await user.click(
    await screen.findByRole("button", { name: /This is my child's computer/ }),
  );
  await user.click(
    screen.getByRole("button", { name: "I'm a parent instead" }),
  );
  await user.click(
    screen.getByRole("button", { name: /This is my child's computer/ }),
  );
  await user.type(
    screen.getByLabelText("Setup code"),
    "temperance://home#CODE",
  );
  await user.type(screen.getByLabelText("Username"), "alex");
  await user.type(screen.getByLabelText("Password"), "secret");
  await user.type(screen.getByLabelText("Name for this computer"), "Laptop");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  expect(actions[0]).toEqual({
    action: "enroll",
    service: "temperance://home#CODE",
    username: "alex",
    password: "secret",
    name: "Laptop",
  });
  expect(await screen.findByText(/Protection isn.t running/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Start protection" }));
  expect(actions[1]).toEqual({ action: "connect" });
  await waitFor(() =>
    expect(screen.queryByText(/Protection isn.t running/)).toBeNull(),
  );
  expect(screen.getByText("55 min left today")).toBeTruthy();
  expect(screen.getByText("Bedtime starts at 21:00")).toBeTruthy();
});

test("the password can be shown and masked again", async () => {
  mockIPC(
    (cmd) => {
      if (cmd === "view")
        return { status: "", screen: "choose", child_allowed: true };
    },
    { shouldMockEvents: true },
  );
  const user = userEvent.setup();
  render(<App />);
  await user.click(
    await screen.findByRole("button", { name: /This is my child's computer/ }),
  );
  const password = screen.getByLabelText("Password") as HTMLInputElement;
  await user.type(password, "secret");
  expect(password.type).toBe("password");
  await user.click(screen.getByRole("button", { name: "Show password" }));
  expect(password.type).toBe("text");
  expect(password.value).toBe("secret");
  const hide = screen.getByRole("button", { name: "Hide password" });
  expect(hide.getAttribute("aria-pressed")).toBe("true");
  await user.click(hide);
  expect(password.type).toBe("password");
});

test("WebView2's own password reveal button is used instead of ours", async () => {
  vi.stubGlobal("CSS", {
    supports: (query: string) => query === "selector(::-ms-reveal)",
  });
  mockIPC(
    (cmd) => {
      if (cmd === "view")
        return { status: "", screen: "choose", child_allowed: true };
    },
    { shouldMockEvents: true },
  );
  try {
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", {
        name: /This is my child's computer/,
      }),
    );
    const password = screen.getByLabelText("Password") as HTMLInputElement;
    expect(password.type).toBe("password");
    expect(screen.queryByRole("button", { name: "Show password" })).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});

test("signing in says what it is doing until the reply arrives", async () => {
  let reply: (view: View) => void = () => {};
  mockIPC(
    (cmd) => {
      if (cmd === "view")
        return { status: "", screen: "choose", child_allowed: true };
      if (cmd === "act") return new Promise<View>((ok) => (reply = ok));
    },
    { shouldMockEvents: true },
  );
  const user = userEvent.setup();
  render(<App />);
  await user.click(
    await screen.findByRole("button", { name: /This is my child's computer/ }),
  );
  await user.type(
    screen.getByLabelText("Setup code"),
    "temperance://home#CODE",
  );
  await user.type(screen.getByLabelText("Username"), "alex");
  await user.type(screen.getByLabelText("Password"), "secret");
  await user.type(screen.getByLabelText("Name for this computer"), "Laptop");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  expect(screen.getByRole("status").textContent).toBe(
    "Signing in and turning on protection…",
  );
  expect(screen.getByRole("main").getAttribute("aria-busy")).toBe("true");
  await react(async () =>
    reply({ status: "Protected.", screen: "child", ...child }),
  );
  expect(screen.getByRole("status").textContent).toBe("Protected.");
  expect(screen.getByRole("main").getAttribute("aria-busy")).toBe("false");
});

test("a child asks for more time with a reason, then sees it is waiting", async () => {
  const actions = backend({ status: "", screen: "child", ...child }, () => ({
    status: "Request sent to your parents.",
    screen: "child",
    ...child,
    can_ask: false,
    pending: true,
  }));
  const user = userEvent.setup();
  render(<App />);
  await user.click(
    await screen.findByRole("button", { name: "Ask for more time" }),
  );
  expect(
    screen.queryByRole("button", { name: "Ask for more time" }),
  ).toBeNull();
  const reason = screen.getByLabelText("Why do you need more time?");
  // Earlier reasons aren't offered back as autofill suggestions.
  expect(reason.getAttribute("autocomplete")).toBe("off");
  await user.type(reason, "Science project");
  await user.click(screen.getByRole("button", { name: "Ask for 30 min" }));
  expect(actions).toEqual([
    { action: "request_time", minutes: 30, message: "Science project" },
  ]);
  expect(await screen.findByText(/waiting for a parent/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Ask for/ })).toBeNull();

  // Once a parent answers, the form starts closed again.
  await react(() => emit("view", { status: "", screen: "child", ...child }));
  expect(
    await screen.findByRole("button", { name: "Ask for more time" }),
  ).toBeTruthy();
  expect(screen.queryByLabelText("Why do you need more time?")).toBeNull();
});

test("health problems, Wi-Fi sign-in and parent alerts are shown with their fixes", async () => {
  const actions = backend({
    status: "",
    screen: "child",
    ...child,
    alerts: ["Your request for 20 minutes was approved"],
    health: [
      {
        code: "captive_portal",
        message: "This Wi-Fi needs you to sign in",
        action: "Open the sign-in page",
      },
    ],
    portal_url: "http://portal.example/login",
    can_sign_in: true,
    can_ask: false,
  });
  const user = userEvent.setup();
  render(<App />);
  const health = await screen.findByRole("region", { name: "Device health" });
  expect(health.textContent).toContain("This Wi-Fi needs you to sign in");
  expect(health.textContent).toContain("Open the sign-in page");
  expect(screen.getByRole("region", { name: "Alerts" }).textContent).toContain(
    "approved",
  );
  await user.click(
    screen.getByRole("button", { name: "Open the Wi-Fi sign-in page" }),
  );
  await user.click(screen.getByRole("button", { name: "Sign in to Wi-Fi" }));
  await user.click(screen.getByRole("button", { name: "Check for changes" }));
  expect(actions.map((a) => a.action)).toEqual([
    "open_portal",
    "sign_in",
    "refresh",
  ]);
});

test("Linux and macOS go straight to parent pairing, and errors show in the status line", async () => {
  backend(
    { status: "", screen: "choose", child_allowed: false },
    () => new Error("no network"),
  );
  const user = userEvent.setup();
  render(<App />);
  expect(
    await screen.findByRole("heading", { name: /from anywhere/ }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: /child's computer/ })).toBeNull();
  expect(screen.getByText(/protected through your home network/)).toBeTruthy();
  await user.type(screen.getByLabelText(/Pairing link/), "x");
  await user.type(screen.getByLabelText("Name for this computer"), "PC");
  await user.click(
    screen.getByRole("button", { name: "Pair and open the dashboard" }),
  );
  expect((await screen.findByRole("status")).textContent).toBe("no network");
});

test("background updates replace the view, and a damaged pairing can be forgotten", async () => {
  const actions = backend({
    status: "",
    screen: "parent_broken",
    error: "This pairing is damaged",
  });
  const user = userEvent.setup();
  render(<App />);
  expect(await screen.findByText("This pairing is damaged")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Forget this pairing" }));
  expect(actions).toEqual([{ action: "unpair_parent" }]);
  await react(() =>
    emit("view", {
      status: "Policy refreshed",
      screen: "parent",
      household: "",
      host: "h.example",
    }),
  );
  expect(
    await screen.findByRole("heading", { name: "Paired with your home" }),
  ).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("Policy refreshed");
});

test("a failing first read shows the error", async () => {
  mockIPC(
    (cmd) => {
      if (cmd === "view") throw "backend unavailable";
    },
    { shouldMockEvents: true },
  );
  render(<App />);
  expect((await screen.findByRole("status")).textContent).toBe(
    "backend unavailable",
  );
});
