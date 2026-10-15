// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://127.0.0.1:3000/"}
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../src/components/dashboard";
import * as accounts from "../src/lib/accounts";
import * as updates from "../src/lib/updates";
import { TestRepository } from "../src/lib/database";
import { handle } from "../src/lib/http";

const ORIGIN = "http://127.0.0.1:3000";
const ADMIN = "a".repeat(48),
  GATEWAY = "g".repeat(48);
const OWNER = { username: "robin", password: "kitchen-table-42" };
const key = (seed: number) =>
  btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, n) => n + seed)));

let repo: TestRepository;
let cookie = "";

/** Routes the dashboard's fetch calls to the real API handler, like a browser would. */
async function browserFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const url = new URL(String(input), ORIGIN);
  const headers = new Headers(init.headers);
  if (cookie) headers.set("Cookie", cookie);
  if (init.method === "POST") headers.set("Origin", ORIGIN);
  const response = await handle(
    new Request(url, { method: init.method, headers, body: init.body }),
    url.pathname.slice(1),
    repo,
  );
  const set = response.headers.get("set-cookie");
  if (set) {
    const pair = set.split(";")[0];
    cookie = pair.endsWith("=") ? "" : pair;
  }
  return response;
}

async function api(path: string, body?: unknown, token?: string) {
  const response = await handle(
    new Request(`${ORIGIN}/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    path,
    repo,
  );
  return response.json();
}

/** An owner who already finished the first-run wizard. */
async function setupOwner() {
  await api("v1/login", { password: ADMIN });
  await api("api/setup/complete", {}, ADMIN);
}

/** A household with an owner, two profiles, an enrolled phone, usage, history and a request. */
async function seedHousehold() {
  await setupOwner();
  await api(
    "api/profiles",
    {
      name: "Alex",
      avatar: "🦊",
      limit: 90,
      bedtime: { start: "21:00", end: "07:00", days: [0, 1, 2, 3, 4, 5, 6] },
      schedules: [
        {
          id: "homework",
          name: "Homework",
          mode: "focus",
          start: "16:00",
          end: "17:00",
          days: [1, 2, 3, 4, 5],
          allow: [],
          allowed_categories: ["education"],
        },
      ],
    },
    ADMIN,
  );
  await api("api/profiles", { name: "Sam" }, ADMIN);
  const { code } = await api("api/enrollment", { profile_id: 1 }, ADMIN);
  const phone = await api("v1/enroll", {
    code,
    name: "Alex phone",
    public_key: key(1),
  });
  const now = Math.floor(Date.now() / 1000);
  await api(
    "v1/gateway/activity",
    {
      activity: [
        ...Array.from({ length: 30 }, (_, n) => ({
          device_id: phone.device_id,
          minute: Math.floor(now / 60) - n,
          buckets: ["total", "category:video", "site:youtube.com"],
        })),
        ...Array.from({ length: 20 }, (_, n) => ({
          device_id: phone.device_id,
          minute: Math.floor(now / 60) - 7 * 1440 + 20 - n,
          buckets: ["total"],
        })),
      ],
      history: [
        {
          id: "h1",
          device_id: phone.device_id,
          at: now - 60,
          domain: "games.example",
          blocked: true,
          reason: "gaming",
          category: "gaming",
        },
        {
          id: "h2",
          device_id: phone.device_id,
          at: now - 30,
          domain: "school.example",
          blocked: false,
          reason: "allowed",
          category: "education",
        },
      ],
    },
    GATEWAY,
  );
  await api(
    "v1/device/requests",
    { minutes: 20, message: "Finishing a project" },
    phone.token,
  );
  return phone;
}

async function signIn() {
  await browserFetch("/v1/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: ADMIN }),
  });
}

async function openDashboard() {
  const user = userEvent.setup();
  render(<Dashboard />);
  await screen.findByRole("heading", { name: "Your family's digital day." });
  return user;
}

const tab = (user: ReturnType<typeof userEvent.setup>, name: string) =>
  user.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }));

const state = async () => (await repo.read()).state;

beforeEach(() => {
  vi.setSystemTime(new Date("2026-10-11T18:00:00Z"));
  Object.assign(process.env, {
    TEMPERANCE_ADMIN_TOKEN: ADMIN,
    TEMPERANCE_GATEWAY_TOKEN: GATEWAY,
    TEMPERANCE_VPN_ENDPOINT: "192.0.2.1:51820",
    TEMPERANCE_VPN_PUBLIC_KEY: key(0),
    TEMPERANCE_TIMEZONE: "America/Chicago",
    TEMPERANCE_PUBLIC_URL: ORIGIN,
    TEMPERANCE_UPDATE_CHECK: "off",
    TEMPERANCE_BUILD_VERSION: "0.5.4",
    TEMPERANCE_INSTALL: "",
    TEMPERANCE_UPDATER_TOKEN: "",
  });
  delete process.env.TEMPERANCE_GATEWAY_AP;
  delete process.env.TEMPERANCE_GATEWAY_ROUTER;
  delete process.env.TEMPERANCE_GATEWAY_LAN_NETWORKS;
  delete process.env.TEMPERANCE_GATEWAY_HOME_DNS;
  updates.resetForTests();
  repo = new TestRepository();
  cookie = "";
  vi.stubGlobal("fetch", browserFetch);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("sign-in", () => {
  it("walks a fresh install through the admin account and first rules", async () => {
    const user = userEvent.setup();
    render(<Dashboard />);
    const signIn = await screen.findByRole("form", { name: "Sign in" });
    expect(within(signIn).queryByLabelText("Username")).toBeNull();
    await user.type(within(signIn).getByLabelText("Admin password"), ADMIN);
    await user.click(within(signIn).getByRole("button", { name: "Sign in" }));

    const rules = await screen.findByRole("form", {
      name: "Starting rules for your first client",
    });
    expect((await state()).users ?? []).toHaveLength(0);
    await user.type(within(rules).getByLabelText("Username"), "Avery");
    await user.click(within(rules).getByLabelText(/^Teen/));
    expect(
      (
        within(rules).getByLabelText(
          /Daily screen-time limit/,
        ) as HTMLInputElement
      ).value,
    ).toBe("180");
    await user.click(within(rules).getByLabelText("Social media"));
    const minutes = within(rules).getByLabelText(
      "Minutes per day for all games together",
    );
    await user.clear(minutes);
    await user.type(minutes, "60");
    const games = within(rules).getByLabelText("Games in the group");
    await user.type(games, "{Enter}fortnite.com");
    await user.click(within(rules).getByRole("button", { name: "Save rules" }));

    await screen.findByRole("heading", { name: "avery’s rules are ready." });
    const avery = (await state()).profiles[0];
    expect(avery).toMatchObject({
      name: "avery",
      filter_level: "teen",
      limit: 180,
      categories: ["social"],
      safe_search: true,
      bedtime: { start: "21:00", end: "07:00" },
    });
    expect(avery.app_limits).toEqual([
      {
        id: "games",
        name: "Games",
        minutes: 60,
        domains: [
          "roblox.com",
          "epicgames.com",
          "steampowered.com",
          "minecraft.net",
          "fortnite.com",
        ],
      },
    ]);
    expect((await state()).setup_completed_at).toBeUndefined();

    await user.click(screen.getByRole("button", { name: "Add a device" }));
    await screen.findByRole("heading", { name: "Devices" });
    expect((await state()).setup_completed_at).toBeGreaterThan(0);
  });

  it("resumes the rules step after sign-in and can be skipped", async () => {
    await api("v1/login", { password: ADMIN });
    await signIn();
    const user = userEvent.setup();
    render(<Dashboard />);
    await screen.findByRole("form", {
      name: "Starting rules for your first client",
    });
    await user.click(
      within(screen.getByRole("list", { name: "Setup progress" })).getByText(
        "Client",
      ),
    );
    await user.click(within(screen.getByRole("form")).getByLabelText(/^Adult/));
    expect(
      (
        screen.getByLabelText(
          "Enforce SafeSearch and YouTube Restricted Mode",
        ) as HTMLInputElement
      ).checked,
    ).toBe(false);
    await user.click(screen.getByLabelText("Enable bedtime rules"));
    expect(screen.queryByLabelText("From")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Skip for now" }));
    await screen.findByRole("heading", { name: "Your family's digital day." });
    expect((await state()).profiles).toHaveLength(0);
    expect((await state()).setup_completed_at).toBeGreaterThan(0);
  });

  it("rejects a wrong password, then signs in and out", async () => {
    await setupOwner();
    cookie = "";
    const user = userEvent.setup();
    render(<Dashboard />);
    const form = await screen.findByRole("form", { name: "Sign in" });
    await user.type(
      within(form).getByLabelText("Admin password"),
      "nope-nope-nope",
    );
    await user.click(within(form).getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/invalid/i),
    );
    await user.clear(within(form).getByLabelText("Admin password"));
    await user.type(within(form).getByLabelText("Admin password"), ADMIN);
    await user.click(within(form).getByRole("button", { name: "Sign in" }));
    await screen.findByRole("heading", { name: "Your family's digital day." });

    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByRole("form", { name: "Sign in" });
    expect(cookie).toBe("");
  });
});

describe("overview", () => {
  it("pauses the family and profiles, and warns when the gateway is missing", async () => {
    await seedHousehold();
    await signIn();
    const user = await openDashboard();
    expect(screen.getByRole("status").textContent).toMatch(
      /gateway has not connected yet/,
    );
    const alex = screen
      .getByRole("heading", { name: "Alex" })
      .closest("article")!;
    expect(alex.textContent).toContain("30");
    expect(alex.textContent).toContain("Bedtime 9:00 PM–7:00 AM");

    await user.click(screen.getByRole("button", { name: "Pause family" }));
    await screen.findByRole("button", { name: "Resume family" });
    expect((await state()).paused).toBe(true);
    await user.click(
      within(alex as HTMLElement).getByRole("button", { name: "Pause" }),
    );
    await waitFor(async () =>
      expect((await state()).profiles[0].paused).toBe(true),
    );

    await user.click(
      within(alex as HTMLElement).getByRole("button", { name: "Reward" }),
    );
    await screen.findByRole("heading", { name: "Send a reward" });
  });

  it("renames a family profile from its card", async () => {
    await seedHousehold();
    await signIn();
    const user = await openDashboard();
    const rename = async () => {
      await user.click(screen.getByRole("button", { name: "Rename Alex" }));
      return screen.getByRole("textbox", { name: "New username for Alex" });
    };

    let input = await rename();
    await user.clear(input);
    await user.type(input, "Lexi{Escape}");
    expect(screen.getByRole("heading", { name: "Alex" })).toBeTruthy();

    input = await rename();
    await user.clear(input);
    await user.tab();
    expect(screen.getByRole("heading", { name: "Alex" })).toBeTruthy();

    input = await rename();
    await user.clear(input);
    await user.type(input, "  Lexi  {Enter}");
    expect(await screen.findByRole("heading", { name: "lexi" })).toBeTruthy();
    const saved = (await state()).profiles[0];
    expect(saved.name).toBe("lexi");
    expect(saved.limit).toBe(90);
    expect(saved.bedtime.start).toBe("21:00");
  });

  it("shows when a gateway went offline", async () => {
    await seedHousehold();
    await api("v1/gateway/state", undefined, GATEWAY);
    vi.setSystemTime(new Date("2026-10-11T18:10:00Z"));
    await signIn();
    await openDashboard();
    expect(screen.getByRole("status").textContent).toMatch(
      /offline since 10 min ago/,
    );
  });
});

describe("profile editor", () => {
  it("creates a profile with every rule type", async () => {
    await setupOwner();
    await signIn();
    const user = await openDashboard();
    await user.click(screen.getByRole("button", { name: "+ Add client" }));
    const dialog = screen.getByRole("dialog");
    const d = within(dialog);
    await user.type(d.getByLabelText("Username"), "Riley");
    await user.clear(d.getByLabelText("Avatar"));
    await user.type(d.getByLabelText("Avatar"), "🐢");
    await user.selectOptions(d.getByLabelText("Filter preset"), "teen");
    await user.clear(d.getByLabelText(/Daily network-minute limit/));
    await user.type(d.getByLabelText(/Daily network-minute limit/), "120");
    await user.type(d.getByLabelText("Sat limit"), "180");
    await user.type(d.getByLabelText("Sun limit"), "1");
    await user.clear(d.getByLabelText("Sun limit"));
    await user.click(d.getByRole("checkbox", { name: "Social media" }));
    await user.click(d.getByRole("checkbox", { name: "Gaming" }));
    await user.click(d.getByRole("checkbox", { name: "Gaming" }));
    await user.click(d.getByRole("checkbox", { name: /SafeSearch/ }));
    await user.click(d.getByRole("checkbox", { name: /YouTube restricted/ }));
    await user.click(d.getByRole("checkbox", { name: /Allow-list only/ }));
    await user.click(d.getByRole("checkbox", { name: /Unmanaged client/ }));
    await user.click(d.getByRole("checkbox", { name: /Unmanaged client/ }));
    const bedtime = within(d.getByRole("group", { name: "Bedtime" }));
    fireEvent.change(bedtime.getByLabelText("Starts"), {
      target: { value: "21:30" },
    });
    fireEvent.change(bedtime.getByLabelText("Ends"), {
      target: { value: "06:45" },
    });
    await user.click(bedtime.getByRole("checkbox", { name: "Fri" }));
    await user.click(bedtime.getByRole("checkbox", { name: "Fri" }));
    await user.click(bedtime.getByRole("checkbox", { name: "Sat" }));
    await user.click(
      bedtime.getByRole("checkbox", { name: "Enable bedtime rules" }),
    );
    expect(bedtime.queryByLabelText("Starts")).toBeNull();
    await user.click(
      bedtime.getByRole("checkbox", { name: "Enable bedtime rules" }),
    );
    expect(bedtime.getByLabelText("Starts")).toHaveProperty("value", "21:30");

    const windows = within(
      d.getByRole("group", { name: "Off Time & Focus Time" }),
    );
    await user.click(windows.getByRole("button", { name: "+ Add schedule" }));
    await user.click(windows.getByRole("button", { name: "+ Add schedule" }));
    expect(
      windows.getByText(/Homework and Homework overlap on Mon, Tue/)
        .textContent,
    ).toContain("The stricter rule applies");
    await user.click(
      windows.getAllByRole("button", { name: "Remove window" })[1],
    );
    expect(windows.queryByText(/overlap on/)).toBeNull();
    await user.clear(windows.getByLabelText("Window name"));
    await user.type(windows.getByLabelText("Window name"), "Study");
    await user.type(
      windows.getByLabelText("Allowed learning domains"),
      "khanacademy.org",
    );
    await user.click(windows.getByRole("checkbox", { name: "News" }));
    await user.click(windows.getByRole("checkbox", { name: "Education" }));
    await user.click(windows.getAllByRole("checkbox", { name: "Sun" })[0]);
    await user.click(windows.getAllByRole("checkbox", { name: "Mon" })[0]);
    fireEvent.change(windows.getByLabelText("start"), {
      target: { value: "15:30" },
    });
    await user.selectOptions(windows.getByLabelText("Mode"), "off");
    expect(windows.queryByLabelText("Allowed learning domains")).toBeNull();

    const budgets = within(d.getByRole("group", { name: "Category budgets" }));
    await user.clear(budgets.getByLabelText("Video & streaming"));
    await user.type(budgets.getByLabelText("Video & streaming"), "45");
    const sites = within(d.getByRole("group", { name: "Site/app budgets" }));
    await user.click(sites.getByRole("button", { name: "Add site" }));
    await user.type(sites.getByLabelText("Add a site budget"), "roblox.com");
    await user.click(sites.getByRole("button", { name: "Add site" }));
    await user.type(sites.getByLabelText("Add a site budget"), "tiktok.com");
    await user.click(sites.getByRole("button", { name: "Add site" }));
    await user.clear(sites.getByLabelText("roblox.com"));
    await user.type(sites.getByLabelText("roblox.com"), "20");
    await user.click(
      sites.getByRole("button", { name: "Remove tiktok.com budget" }),
    );
    const shared = within(d.getByRole("group", { name: "Shared app limits" }));
    await user.click(shared.getByRole("button", { name: "+ Add app group" }));
    await user.click(shared.getByRole("button", { name: "+ Add app group" }));
    await user.click(
      shared.getAllByRole("button", { name: "Remove group" })[1],
    );
    const group = within(shared.getByRole("group", { name: "App group 1" }));
    await user.type(group.getByLabelText("Group name"), "Games");
    await user.clear(group.getByLabelText("Shared minutes per day"));
    await user.type(group.getByLabelText("Shared minutes per day"), "40");
    await user.type(
      group.getByLabelText("Apps and sites in this group"),
      "roblox.com{Enter}minecraft.net, fortnite.com",
    );
    await user.type(
      d.getByLabelText("Always allowed domains"),
      "school.example",
    );
    await user.type(
      d.getByLabelText("Blocked domains"),
      "bad.example{enter}worse.example",
    );
    await user.type(d.getByLabelText(/Unmanaged domains/), "bank.example");
    await user.click(d.getByRole("button", { name: "Save client" }));

    await screen.findByRole("heading", { name: "riley" });
    const saved = (await state()).profiles[0];
    expect(saved).toMatchObject({
      name: "riley",
      avatar: "🐢",
      filter_level: "teen",
      limit: 120,
      weekday_limits: { 6: 180 },
      categories: ["social"],
      safe_search: false,
      youtube_restricted: false,
      allow_only: true,
      managed: true,
      category_limits: { video: 45 },
      site_limits: { "roblox.com": 20 },
      allow: ["school.example"],
      deny: ["bad.example", "worse.example"],
      unmanaged: ["bank.example"],
    });
    expect(saved.app_limits).toEqual([
      {
        id: expect.stringMatching(/^[a-z0-9-]+$/),
        name: "Games",
        minutes: 40,
        domains: ["roblox.com", "minecraft.net", "fortnite.com"],
      },
    ]);
    const card = screen
      .getByRole("heading", { name: "riley" })
      .closest("article")!;
    expect(
      within(card).getByRole("list", { name: "riley shared app limits" })
        .textContent,
    ).toBe("Games 0 / 40 min");
    expect(saved.bedtime).toEqual({
      enabled: true,
      start: "21:30",
      end: "06:45",
      days: [0, 1, 2, 3, 4, 5],
    });
    expect(saved.schedules[0]).toMatchObject({
      name: "Study",
      mode: "off",
      start: "15:30",
      days: [2, 3, 4, 5, 0],
      allow: ["khanacademy.org"],
      allowed_categories: ["news"],
    });
  });

  it("reports save errors, closes, and deletes profiles", async () => {
    await seedHousehold();
    await signIn();
    const user = await openDashboard();
    const alex = screen
      .getByRole("heading", { name: "Alex" })
      .closest("article")!;
    await user.click(
      within(alex as HTMLElement).getByRole("button", { name: "Edit rules" }),
    );
    let dialog = within(screen.getByRole("dialog"));
    expect(
      dialog.getByRole("heading", { name: "Edit client" }),
    ).toBeTruthy();
    await user.click(dialog.getByRole("button", { name: "Delete client" }));
    expect(dialog.getByRole("alert").textContent).toMatch(/Reassign or revoke/);
    await user.click(dialog.getByRole("button", { name: "Close editor" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    vi.mocked(window.confirm).mockReturnValueOnce(false);
    const sam = screen
      .getByRole("heading", { name: "Sam" })
      .closest("article")!;
    await user.click(
      within(sam as HTMLElement).getByRole("button", { name: "Edit rules" }),
    );
    dialog = within(screen.getByRole("dialog"));
    await user.click(dialog.getByRole("button", { name: "Delete client" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    await user.click(dialog.getByRole("button", { name: "Delete client" }));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Sam" })).toBeNull(),
    );
    expect((await state()).profiles.map((p) => p.name)).toEqual(["Alex"]);

    await user.click(
      within(alex as HTMLElement).getByRole("button", { name: "Edit rules" }),
    );
    dialog = within(screen.getByRole("dialog"));
    cookie = "";
    await user.click(dialog.getByRole("button", { name: "Save client" }));
    await waitFor(() =>
      expect(dialog.getByRole("alert").textContent).toMatch(/sign-in/i),
    );
  });
});

describe("devices", () => {
  it("shows a setup code for children's devices once the gateway checks in", async () => {
    await seedHousehold();
    await signIn();
    let user = await openDashboard();
    await tab(user, "Devices");
    expect(screen.getByText(/hasn’t checked in yet/)).toBeTruthy();
    cleanup();
    await api("v1/gateway/activity", { remote: { pin: "PIN" } }, GATEWAY);
    user = await openDashboard();
    await tab(user, "Devices");
    const view = within(screen.getByLabelText("Device setup code"));
    expect(
      await view.findByRole("img", {
        name: "QR code to set up a child's device",
      }),
    ).toBeTruthy();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    await user.click(view.getByRole("button", { name: "Copy setup code" }));
    const link: string = writeText.mock.calls[0][0];
    expect(
      JSON.parse(Buffer.from(link.split("#")[1], "base64url").toString()),
    ).toMatchObject({
      v: 1,
      port: 51820,
      pin: "PIN",
    });
    expect(view.getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("enrolls, renames, reassigns, pauses, locates and revokes", async () => {
    const phone = await seedHousehold();
    await api(
      "v1/gateway/activity",
      { active_devices: [phone.device_id] },
      GATEWAY,
    );
    await signIn();
    const user = await openDashboard();
    await tab(user, "Devices");
    await user.selectOptions(screen.getByLabelText("Client"), "2");
    await user.click(
      screen.getByRole("button", { name: "Create enrollment code" }),
    );
    const code = await screen.findByLabelText(/Enter this code/);
    expect((code as HTMLInputElement).value.length).toBeGreaterThan(20);
    expect((await state()).codes[0].profile_id).toBe(2);

    const row = screen
      .getByRole("textbox", { name: "Alex phone name" })
      .closest("tr")!;
    const r = within(row as HTMLElement);
    expect(row.textContent).toContain("just now");
    expect(row.textContent).toContain("None shared");
    const name = r.getByRole("textbox", { name: "Alex phone name" });
    await user.clear(name);
    await user.tab();
    expect((name as HTMLInputElement).value).toBe("Alex phone");
    await user.clear(name);
    await user.type(name, "Alex tablet{enter}");
    await waitFor(async () =>
      expect((await state()).devices[0].name).toBe("Alex tablet"),
    );

    await user.selectOptions(screen.getByLabelText("Alex tablet client"), "2");
    await waitFor(async () =>
      expect((await state()).devices[0].profile_id).toBe(2),
    );
    const row2 = within(
      screen
        .getByRole("textbox", { name: "Alex tablet name" })
        .closest("tr") as HTMLElement,
    );
    await user.click(row2.getByRole("button", { name: "Pause" }));
    await row2.findByRole("button", { name: "Resume" });
    await user.click(row2.getByRole("button", { name: "Set unmanaged" }));
    await row2.findByRole("button", { name: "Manage" });

    await user.click(row2.getByRole("button", { name: "Locate" }));
    await row2.findByText(/waiting for device/);
    await api(
      "v1/device/location",
      { latitude: 41.88, longitude: -87.63, accuracy: 18.4 },
      phone.token,
    );
    await tab(user, "Overview");
    await tab(user, "Devices");
    // The dashboard picks up the answer on its next poll.
    const row3 = within(
      screen
        .getByRole("textbox", { name: "Alex tablet name" })
        .closest("tr") as HTMLElement,
    );
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await user.click(row3.getByRole("button", { name: "Revoke" }));
    expect((await state()).devices[0].revoked).toBe(false);
    await user.click(row3.getByRole("button", { name: "Revoke" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", { name: "Alex tablet name" }),
      ).toBeNull(),
    );
    expect((await state()).devices[0].location?.accuracy).toBe(18.4);
  });

  it("explains that a home device needs the access point", async () => {
    await seedHousehold();
    await signIn();
    const user = await openDashboard();
    await tab(user, "Devices");
    expect(screen.queryByRole("button", { name: "Add home device" })).toBeNull();
    expect(screen.getByText(/Access point mode is off/)).toBeTruthy();
  });

  it("adds, labels and removes a home-network device", async () => {
    process.env.TEMPERANCE_GATEWAY_AP =
      "wlan0;192.168.50.1/24;Temperance;correct horse";
    await seedHousehold();
    await signIn();
    const user = await openDashboard();
    await tab(user, "Devices");
    const add = screen.getByRole("button", { name: "Add home device" });
    expect(screen.queryByLabelText("Assigned address")).toBeNull();
    expect(screen.queryByText(/correct horse/)).toBeNull();
    await user.type(screen.getByLabelText("Device name"), "Living room TV");
    await user.selectOptions(
      within(
        screen
          .getByRole("heading", { name: "Add a home-network device" })
          .closest("section")!,
      ).getByLabelText("Client"),
      "2",
    );
    await user.click(add);
    const name = await screen.findByRole("textbox", {
      name: "Living room TV name",
    });
    const guide = await screen.findByRole("dialog", {
      name: "Set up Living room TV",
    });
    expect(guide.textContent).toContain("192.168.50.2");
    expect(guide.textContent).toContain("Router: 192.168.50.1");
    expect(guide.textContent).toContain("correct horse");
    await user.click(within(guide).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    const tv = (await state()).devices.find((d) => d.kind === "home")!;
    expect(tv).toMatchObject({ ip: "192.168.50.2", profile_id: 2 });
    const row = within(name.closest("tr") as HTMLElement);
    expect(row.getByText("Home network")).toBeTruthy();
    expect(row.getByText("How to connect")).toBeTruthy();
    expect(row.getByText("Not available")).toBeTruthy();
    expect(row.queryByRole("button", { name: "Locate" })).toBeNull();
    await user.click(row.getByRole("button", { name: "Remove" }));
    expect(window.confirm).toHaveBeenLastCalledWith(
      "Stop managing Living room TV?",
    );
    await waitFor(async () =>
      expect(
        (await state()).devices.find((d) => d.kind === "home")?.revoked,
      ).toBe(true),
    );
  });

  it("shows device health reported by the app", async () => {
    const phone = await seedHousehold();
    await api(
      "v1/device/diagnostics",
      {
        issues: [
          {
            code: "vpn_permission",
            severity: "error",
            message: "VPN permission is turned off",
            action: "Open Temperance and allow the VPN connection.",
          },
        ],
      },
      phone.token,
    );
    await signIn();
    const user = await openDashboard();
    await tab(user, "Devices");
    const health = screen.getByRole("list", { name: "Alex phone health" });
    expect(health.textContent).toContain("VPN permission is turned off");
    expect(health.textContent).toContain("allow the VPN connection");
    expect(health.querySelector("li")!.className).toBe("error");
  });

  it("links to a shared location", async () => {
    const phone = await seedHousehold();
    await api("api/devices/locate", { ip: "10.77.0.2" }, ADMIN);
    await api(
      "v1/device/location",
      { latitude: 41.88, longitude: -87.63, accuracy: 18.4 },
      phone.token,
    );
    await signIn();
    const user = await openDashboard();
    await tab(user, "Devices");
    const link = screen.getByRole("link", { name: /±18 m/ });
    expect(link.getAttribute("href")).toContain("mlat=41.88&mlon=-87.63");
    expect(link.textContent).toContain("just now");
  });
});

describe("usage and history", () => {
  it("compares usage with the previous period and lists top categories", async () => {
    await seedHousehold();
    await signIn();
    const user = await openDashboard();
    await tab(user, "Usage");
    const alex = await screen.findByRole("article", {
      name: "Alex usage summary",
    });
    await waitFor(() => expect(alex.textContent).toContain("30 min"));
    expect(alex.textContent).toContain("▲ 50% vs previous 7 days");
    expect(alex.textContent).toMatch(/Video & streaming\s*30 min/);
    expect(
      screen.getByRole("article", { name: "Sam usage summary" }).textContent,
    ).toContain("no activity in the 7 days before");
    expect(screen.getByRole("table").textContent).toContain(
      "Video & streaming 30 min",
    );

    await user.selectOptions(screen.getByLabelText("Usage period"), "1");
    await waitFor(() =>
      expect(alex.textContent).toContain("no activity the day before"),
    );
    await user.selectOptions(screen.getByLabelText("Usage period"), "30");
    await waitFor(() => expect(alex.textContent).toContain("50 min"));
  });

  it("filters history, exports CSV, and turns a decision into a rule", async () => {
    await seedHousehold();
    await signIn();
    const user = await openDashboard();
    await tab(user, "History");
    await screen.findByText("games.example");
    expect(screen.getByText("school.example")).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("Decision"), "true");
    await waitFor(() =>
      expect(screen.queryByText("school.example")).toBeNull(),
    );
    await user.selectOptions(screen.getByLabelText("Client"), "1");
    const csv = screen.getByRole("link", { name: "Export CSV" });
    expect(csv.getAttribute("href")).toContain("format=csv");
    expect(csv.getAttribute("href")).toContain("profile_id=1");
    expect(csv.getAttribute("href")).toContain("blocked=true");

    const row = screen.getByText("games.example").closest("tr")!;
    await user.click(
      within(row as HTMLElement).getByRole("button", { name: "Allow" }),
    );
    await waitFor(async () =>
      expect((await state()).profiles[0].allow).toEqual(["games.example"]),
    );
    await user.click(
      within(row as HTMLElement).getByRole("button", { name: "Unmanaged" }),
    );
    await waitFor(async () => {
      const p = (await state()).profiles[0];
      expect(p.allow).toEqual([]);
      expect(p.unmanaged).toEqual(["games.example"]);
    });

    fireEvent.change(screen.getByLabelText("Date"), {
      target: { value: "2026-10-01" },
    });
    await screen.findByText("No recorded domain requests for these filters.");
  });
});

describe("requests and rewards", () => {
  it("answers pending requests from the overview", async () => {
    await seedHousehold();
    await signIn();
    const user = await openDashboard();
    const waiting = screen.getByRole("region", { name: "Waiting for you" });
    expect(waiting.textContent).toMatch(/asks for \d+ more minutes/);
    expect(waiting.textContent).toContain("“Finishing a project”");
    await user.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Waiting for you" }),
      ).toBeNull(),
    );
    expect((await state()).requests[0].status).toBe("denied");
  });

  it("sends and cancels rewards, answers requests, and clears notifications", async () => {
    await seedHousehold();
    await signIn();
    const user = await openDashboard();
    expect(
      screen.getByRole("button", { name: /^Requests/ }).querySelector(".dot"),
    ).toBeTruthy();
    await tab(user, "Requests");
    await user.selectOptions(screen.getByLabelText("Reward"), "skip_window");
    await user.click(screen.getByRole("button", { name: "Send reward" }));
    await screen.findByText("Choose a schedule to skip");
    await user.selectOptions(screen.getByLabelText("Schedule"), "homework");
    await user.click(screen.getByRole("button", { name: "Send reward" }));
    await screen.findByText(/Alex: skip Homework/);

    await user.selectOptions(screen.getByLabelText("Reward"), "late_bedtime");
    fireEvent.change(screen.getByLabelText("New bedtime"), {
      target: { value: "22:15" },
    });
    await user.click(screen.getByRole("button", { name: "Send reward" }));
    await screen.findByText(/late bedtime 22:15/);
    await user.click(
      screen.getAllByRole("button", { name: "Cancel reward" })[0],
    );
    await waitFor(() => expect(screen.queryByText(/skip Homework/)).toBeNull());
    expect((await state()).rewards[0]).not.toHaveProperty("minutes");

    expect(screen.getByText("Finishing a project")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Approve" }));
    await screen.findByText("Approved");
    expect((await state()).rewards.some((r) => r.minutes === 20)).toBe(true);
    expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();

    expect(screen.getAllByText(/● /).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Mark all read" }));
    await waitFor(() => expect(screen.queryAllByText(/● /)).toHaveLength(0));
  });

  it("declines requests", async () => {
    await seedHousehold();
    await signIn();
    const user = await openDashboard();
    await tab(user, "Requests");
    await user.click(screen.getByRole("button", { name: "Decline" }));
    await screen.findByText("Declined");
  });
});

describe("settings", () => {
  it("saves household settings, imports feeds and deletes history", async () => {
    await seedHousehold();
    await signIn();
    const user = await openDashboard();
    await tab(user, "Settings");
    await user.clear(screen.getByLabelText("History retention (days)"));
    await user.type(screen.getByLabelText("History retention (days)"), "14");
    await user.clear(screen.getByLabelText(/offline grace/));
    await user.type(screen.getByLabelText(/offline grace/), "2");
    await user.selectOptions(
      screen.getByLabelText("Home/default client"),
      "2",
    );
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(async () =>
      expect(await state()).toMatchObject({
        retention_days: 14,
        offline_grace_seconds: 7200,
        home_profile_id: 2,
      }),
    );

    await user.selectOptions(screen.getByLabelText("Category"), "ads");
    await user.type(
      screen.getByLabelText("Domains"),
      "ads.example\ntracker.example",
    );
    await user.click(screen.getByRole("button", { name: "Import feed" }));
    await waitFor(async () =>
      expect((await state()).extra_domains.ads).toEqual([
        "ads.example",
        "tracker.example",
      ]),
    );

    await user.click(screen.getByRole("button", { name: "Delete history" }));
    await waitFor(async () => expect((await state()).history).toHaveLength(0));
  });

  it("shows new releases and updates Docker installs from the dashboard", async () => {
    Object.assign(process.env, {
      TEMPERANCE_UPDATE_CHECK: "on",
      TEMPERANCE_INSTALL: "docker",
      TEMPERANCE_UPDATER_TOKEN: "updater-secret",
    });
    const updater = vi.fn();
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/"))
          return Response.json({
            tag_name: "v0.6.0",
            html_url:
              "https://github.com/MisterTea/temperance/releases/tag/v0.6.0",
            published_at: "2026-10-12T00:00:00Z",
          });
        if (url.startsWith("http://updater:8080/")) {
          updater(url, init);
          process.env.TEMPERANCE_BUILD_VERSION = "0.6.0";
          return new Response(null, { status: 200 });
        }
        return browserFetch(input, init);
      },
    );
    await seedHousehold();
    await signIn();
    const user = await openDashboard();
    expect(
      (await screen.findByText(/Temperance 0\.6\.0 is available/)).textContent,
    ).toBeTruthy();
    expect(screen.getByText(/Temperance 0\.5\.4 ·/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "See how to update" }));
    const section = within(
      screen
        .getByRole("heading", { name: "Software updates" })
        .closest("section")!,
    );
    expect(section.getByText(/Version 0\.6\.0 is available/)).toBeTruthy();
    expect(section.getByRole("link", { name: "Release notes" })).toBeTruthy();
    await user.click(section.getByRole("button", { name: "Update to 0.6.0" }));
    expect(window.confirm).toHaveBeenLastCalledWith(
      "Update Temperance to 0.6.0 now?",
    );
    expect(await section.findByText(/Updating to 0\.6\.0/)).toBeTruthy();
    expect(updater).toHaveBeenCalledOnce();
    await waitFor(
      () => expect(screen.getByText(/Temperance 0\.6\.0 ·/)).toBeTruthy(),
      { timeout: 8000 },
    );
    expect(section.queryByRole("button", { name: /Update to/ })).toBeNull();
    expect(section.getByText(/newest release is 0\.6\.0/)).toBeTruthy();
  });

  it("tells package installs which command updates them", async () => {
    Object.assign(process.env, {
      TEMPERANCE_UPDATE_CHECK: "on",
      TEMPERANCE_INSTALL: "linux",
    });
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).startsWith("https://api.github.com/")
          ? Response.json({
              tag_name: "v0.6.0",
              html_url:
                "https://github.com/MisterTea/temperance/releases/tag/v0.6.0",
              published_at: "2026-10-12T00:00:00Z",
            })
          : browserFetch(input, init),
    );
    await seedHousehold();
    await signIn();
    const user = await openDashboard();
    await tab(user, "Settings");
    const section = within(
      (
        await screen.findByRole("heading", { name: "Software updates" })
      ).closest("section")!,
    );
    expect(section.queryByRole("button", { name: /Update to/ })).toBeNull();
    expect(
      section.getByText(/sudo apt install \.\/temperance_0\.6\.0_/),
    ).toBeTruthy();
  });

  it("restarts the server and reconnects", async () => {
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    await seedHousehold();
    await signIn();
    const user = await openDashboard();
    await tab(user, "Settings");
    await user.click(screen.getByRole("button", { name: "Restart" }));
    expect(window.confirm).toHaveBeenLastCalledWith("Restart Temperance now?");
    expect(
      (await screen.findByRole("button", { name: "Restarting…" })).hasAttribute(
        "disabled",
      ),
    ).toBe(true);
    await waitFor(() => expect(exit).toHaveBeenCalledWith(75));
    expect(
      (
        await screen.findByRole(
          "button",
          { name: "Restart" },
          { timeout: 5000 },
        )
      ).hasAttribute("disabled"),
    ).toBe(false);
    exit.mockRestore();
  });

  it("restores a backup file", async () => {
    await seedHousehold();
    const backup = await api("api/export", undefined, ADMIN);
    await api("api/profiles", { name: "Temporary" }, ADMIN);
    await signIn();
    const user = await openDashboard();
    await tab(user, "Settings");
    const file = new File([JSON.stringify(backup)], "backup.json", {
      type: "application/json",
    });
    await user.upload(screen.getByLabelText("Restore backup"), file);
    await user.type(screen.getByLabelText(/Type RESTORE/), "RESTORE");
    // jsdom never marks a required file input as satisfied, so submit directly.
    fireEvent.submit(
      screen.getByRole("button", { name: "Restore backup" }).closest("form")!,
    );
    await waitFor(async () =>
      expect((await state()).profiles.map((p) => p.name)).toEqual([
        "Alex",
        "Sam",
      ]),
    );
    expect(
      screen
        .getByRole("link", { name: "Download backup" })
        .getAttribute("href"),
    ).toBe("/api/export");
  });

  it("configures remote access and shows the gateway's report", async () => {
    await seedHousehold();
    await signIn();
    const user = await openDashboard();
    await tab(user, "Settings");
    expect(
      screen.getByText(/Parent devices connect through the home gateway/),
    ).toBeTruthy();
    const section = screen
      .getByRole("heading", { name: "Remote access" })
      .closest("section")!;
    const view = within(section);
    expect(view.getByText(/has not connected yet/)).toBeTruthy();
    expect(view.getByRole("link", { name: "Router guide" })).toBeTruthy();
    await user.click(view.getByLabelText(/UPnP/));
    await user.type(
      view.getByLabelText(/^Dynu hostname/),
      "MyHome.ddnsfree.com",
    );
    await user.type(view.getByLabelText("Dynu username"), "family");
    await user.type(
      view.getByLabelText(/^Dynu IP update password/),
      "secret-1",
    );
    await user.click(view.getByRole("button", { name: "Save remote access" }));
    await waitFor(async () =>
      expect((await state()).network).toEqual({
        upnp: false,
        ddns: {
          provider: "dynu",
          hostname: "myhome.ddnsfree.com",
          username: "family",
          password: "secret-1",
        },
      }),
    );
    // The endpoint is still an IP address, so devices will not follow the name.
    await view.findByText(
      /Set TEMPERANCE_VPN_ENDPOINT to myhome.ddnsfree.com:51820/,
    );
    expect(
      view
        .getByLabelText(/^Dynu IP update password/)
        .getAttribute("placeholder"),
    ).toMatch(/Saved/);

    await api(
      "v1/gateway/activity",
      {
        network: {
          upnp: {
            state: "off",
            ip: null,
            message: "Automatic port forwarding is off.",
            at: Date.now() / 1000,
          },
          ddns: {
            state: "error",
            ip: null,
            message: "Dynu rejected the username or password.",
            at: Date.now() / 1000,
          },
        },
      },
      GATEWAY,
    );
    await user.click(view.getByRole("button", { name: "Save remote access" }));
    const status = await view.findByRole("list", {
      name: "Remote access status",
    });
    expect(status.textContent).toContain("Dynamic DNS: Dynu rejected");
    expect(within(status).getAllByRole("listitem")[1].className).toBe("error");
    expect((await state()).network?.ddns?.password).toBe("secret-1");

    await user.clear(view.getByLabelText(/^Dynu hostname/));
    await user.click(view.getByRole("button", { name: "Save remote access" }));
    await waitFor(async () =>
      expect((await state()).network).toEqual({ upnp: false }),
    );
  });

  it("pairs a parent phone with a QR code and removes it", async () => {
    process.env.TEMPERANCE_FORWARD_SECRET = "f".repeat(64);
    await seedHousehold();
    await api("v1/gateway/activity", { remote: { pin: "PIN" } }, GATEWAY);
    await signIn();
    const user = await openDashboard();
    await tab(user, "Settings");
    const view = within(
      screen
        .getByRole("heading", { name: "Parent devices" })
        .closest("section")!,
    );
    await user.click(
      view.getByRole("button", { name: "Pair a parent device" }),
    );
    const qr = await view.findByRole("img", { name: /QR code/ });
    expect(qr.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    expect(view.getByRole("timer").textContent).toMatch(/10:00 more/);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    await user.click(view.getByRole("button", { name: "Copy pairing link" }));
    const link: string = writeText.mock.calls[0][0];
    expect(link).toMatch(/^temperance:\/\/pair#/);
    expect(view.getByRole("button", { name: "Copied" })).toBeTruthy();

    const { code } = JSON.parse(
      atob(link.split("#")[1].replace(/-/g, "+").replace(/_/g, "/")),
    );
    const response = await handle(
      new Request(`${ORIGIN}/v1/gateway/parents/pair`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-temperance-forwarded": "f".repeat(64),
        },
        body: JSON.stringify({
          code,
          name: "Robin's Pixel",
          key: "k".repeat(43),
        }),
      }),
      "v1/gateway/parents/pair",
      repo,
    );
    expect(response.status).toBe(200);
    await view.findByText(/Robin's Pixel is paired/, {}, { timeout: 5000 });
    expect(view.queryByRole("img")).toBeNull();
    await user.click(view.getByRole("button", { name: "Revoke" }));
    await waitFor(async () =>
      expect((await state()).parents?.[0].revoked).toBe(true),
    );
    expect(view.queryByText("Robin's Pixel")).toBeNull();
  });

  it("opens through a paired phone without Sign out or self-removal", async () => {
    const FORWARD = "f".repeat(64);
    process.env.TEMPERANCE_FORWARD_SECRET = FORWARD;
    await setupOwner();
    await api("v1/gateway/activity", { remote: { pin: "PIN" } }, GATEWAY);
    const { link } = await api("api/parents/pairing", {}, ADMIN);
    const { code } = JSON.parse(
      Buffer.from(link.split("#")[1], "base64url").toString(),
    );
    const pair = (name: string, key: string) =>
      handle(
        new Request(`${ORIGIN}/v1/gateway/parents/pair`, {
          method: "POST",
          headers: { "x-temperance-forwarded": FORWARD },
          body: JSON.stringify({ code, name, key }),
        }),
        "v1/gateway/parents/pair",
        repo,
      ).then((r) => r.json());
    const { id } = await pair("Robin's Pixel", "k".repeat(43));
    vi.stubGlobal(
      "fetch",
      (input: RequestInfo | URL, init: RequestInit = {}) => {
        const headers = new Headers(init.headers);
        headers.set("x-temperance-forwarded", FORWARD);
        headers.set("x-temperance-parent", id);
        return browserFetch(input, { ...init, headers });
      },
    );
    const user = await openDashboard();
    await screen.findByText("AWAY FROM HOME · ROBIN'S PIXEL");
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    await tab(user, "Settings");
    const view = within(
      screen
        .getByRole("heading", { name: "Parent devices" })
        .closest("section")!,
    );
    expect(view.getByText("This phone")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Revoke" })).toBeNull();
  });

  it("creates a sign-in on the overview and lets an admin revoke it", async () => {
    await seedHousehold();
    await signIn();
    const user = await openDashboard();
    expect(screen.queryByRole("button", { name: "Clients" })).toBeNull();
    const alex = (
      await screen.findByRole("heading", { name: "Alex" })
    ).closest("article")!;
    await user.click(
      await within(alex).findByRole("button", { name: "Add sign-in" }),
    );
    const form = within(alex).getByRole("form", { name: "Sign-in for Alex" });
    await user.type(within(form).getByLabelText("Username"), "alex-client");
    await user.type(within(form).getByLabelText("Password"), "client-password");
    await user.click(within(form).getByRole("button", { name: "Add sign-in" }));
    const label = await screen.findByRole("heading", { name: "alex-client" });
    const stored = await state();
    const client = stored.profiles.find((p) => p.name === "alex-client");
    expect(client).toBeTruthy();
    expect(stored.users![0].profile_id).toBe(client!.id);
    const card = label.closest("article")!;
    await user.click(within(card).getByRole("button", { name: "Disable" }));
    await waitFor(() =>
      expect(within(card).getByText(/sign-in disabled/)).toBeTruthy(),
    );
    await user.click(
      within(card).getByRole("button", { name: "Delete sign-in" }),
    );
    await waitFor(() =>
      expect(
        within(card).queryByRole("button", { name: "Delete sign-in" }),
      ).toBeNull(),
    );
    expect(
      within(card).getByRole("button", { name: "Add sign-in" }),
    ).toBeTruthy();
  });
  it("admins set a new password for an existing client user", async () => {
    await seedHousehold();
    await api(
      "api/users",
      { username: "alex-client", password: "client-password", profile_id: 1 },
      ADMIN,
    );
    await signIn();
    const user = await openDashboard();
    const card = (
      await screen.findByRole("heading", { name: "alex-client" })
    ).closest("article")!;
    await user.click(
      within(card).getByRole("button", { name: "Set password" }),
    );
    const form = within(
      screen.getByRole("form", { name: "Set client password" }),
    );
    expect(
      form.getByRole("heading", { name: "Set password for alex-client" }),
    ).toBeTruthy();
    await user.type(form.getByLabelText("New password"), "new-client-pass");
    await user.type(form.getByLabelText("Confirm password"), "different-pass");
    await user.click(form.getByRole("button", { name: "Set password" }));
    expect(form.getByRole("alert").textContent).toMatch(/do not match/);
    await user.clear(form.getByLabelText("Confirm password"));
    await user.type(form.getByLabelText("Confirm password"), "new-client-pass");
    await user.click(form.getByRole("button", { name: "Set password" }));
    expect(
      await screen.findByText(/Password set for alex-client/),
    ).toBeTruthy();
    expect(
      screen.queryByRole("form", { name: "Set client password" }),
    ).toBeNull();
    const s = await state();
    expect(
      await accounts.authenticate(s, "alex-client", "new-client-pass"),
    ).toBeTruthy();
    expect(
      await accounts.authenticate(s, "alex-client", "client-password"),
    ).toBeFalsy();
  });
  it("client passwords cannot sign into the administrator website", async () => {
    await seedHousehold();
    await api(
      "api/users",
      { username: "alex-client", password: "client-password", profile_id: 1 },
      ADMIN,
    );
    cookie = "";
    const user = userEvent.setup();
    render(<Dashboard />);
    const form = await screen.findByRole("form", { name: "Sign in" });
    await user.type(
      within(form).getByLabelText("Admin password"),
      "client-password",
    );
    await user.click(within(form).getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/admin password/i),
    );
    expect(screen.queryByRole("heading", { name: "Client users" })).toBeNull();
  });
});
