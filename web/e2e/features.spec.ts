import { expect, type Page } from "@playwright/test";
import {
  api,
  enrollDevice,
  ensureProfile,
  forwarded,
  gateway,
  profileNamed,
  test,
  watchConsole,
} from "./helpers";
import { expectCleanLayout } from "./layout";

async function openTab(page: Page, name: string) {
  await page.getByRole("button", { name, exact: true }).click();
  await expect(page.locator("header h1")).toContainText(
    name === "Overview" ? "digital day" : name,
  );
}

test.describe.configure({ mode: "serial" });

test("parent creates and edits a profile with limits, bedtime, and schedules", async ({
  page,
  request,
}, info) => {
  const clean = watchConsole(page);
  const name =
    "Avery " + info.project.name + (info.retry ? ` ${info.retry}` : "");
  await page.goto("/");
  await page.getByRole("button", { name: "+ Add profile" }).click();
  const editor = page.getByRole("dialog");
  await expect(
    editor.getByRole("heading", { name: "Add family profile" }),
  ).toBeVisible();
  await expectCleanLayout(page, "new profile editor");
  await editor.getByLabel("Name", { exact: true }).fill(name);
  await editor.getByLabel("Daily network-minute limit").fill("90");
  await editor.getByLabel("Sat limit").fill("150");
  await editor.getByLabel("Starts").fill("21:00");
  await editor.getByLabel("Ends").fill("07:00");
  await editor.getByRole("button", { name: "+ Add schedule" }).click();
  await editor.getByLabel("Blocked domains").fill("example.org");
  await editor.getByRole("button", { name: "+ Add app group" }).click();
  const group = editor.getByRole("group", { name: "App group 1" });
  await group.getByLabel("Group name").fill("Games with a long shared name");
  await group.getByLabel("Shared minutes per day").fill("40");
  await group
    .getByLabel("Apps and sites in this group")
    .fill("roblox.com\nminecraft.net");
  await expectCleanLayout(page, "profile editor filled");
  await editor.getByRole("button", { name: "Save profile" }).click();
  await expect(editor).toBeHidden();

  const card = page.locator("article.profile", { hasText: name });
  await expect(card).toContainText("of 90 min used");
  await expect(card).toContainText("Bedtime 9:00 PM–7:00 AM");
  await expect(card).toContainText("1 schedule ·");
  await expect(
    card.getByRole("list", { name: `${name} shared app limits` }),
  ).toHaveText("Games with a long shared name 0 / 40 min");
  await expectCleanLayout(page, "profile card with shared app limit");
  await expect(
    card.getByRole("list", { name: `${name} shared app limits` }),
  ).toHaveText("Games with a long shared name 0 / 40 min");
  await expectCleanLayout(page, "profile card with shared app limit");

  await card.getByRole("button", { name: "Pause" }).click();
  await expect(card.locator(".badge")).toHaveText("Paused");
  await card.getByRole("button", { name: "Resume" }).click();
  await expect(card.locator(".badge")).toHaveText("Rules active");

  await card.getByRole("button", { name: "Edit rules" }).click();
  await expect(
    editor.getByRole("heading", { name: "Edit family rules" }),
  ).toBeVisible();
  await expect(editor.getByLabel("Blocked domains")).toHaveValue("example.org");
  await editor.getByRole("button", { name: "Close editor" }).click();
  await expect(editor).toBeHidden();

  const saved = await profileNamed(request, name);
  expect(saved).toBeTruthy();
  await expectCleanLayout(page, "overview with profile");

  const doomed = "Retired " + info.project.name;
  await ensureProfile(request, doomed);
  await page.reload();
  await page
    .locator("article.profile", { hasText: doomed })
    .getByRole("button", { name: "Edit rules" })
    .click();
  page.once("dialog", (d) => d.accept());
  await editor.getByRole("button", { name: "Delete profile" }).click();
  await expect(editor).toBeHidden();
  await expect(
    page.locator("article.profile", { hasText: doomed }),
  ).toHaveCount(0);
  expect(await profileNamed(request, doomed)).toBeUndefined();
  clean();
});

test("household pause applies to every profile", async ({ page }) => {
  const clean = watchConsole(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Pause family" }).click();
  await expect(
    page.getByRole("button", { name: "Resume family" }),
  ).toBeVisible();
  await expect(page.locator("article.profile .badge").first()).toHaveText(
    "Household pause",
  );
  await page.getByRole("button", { name: "Resume family" }).click();
  await expect(
    page.getByRole("button", { name: "Pause family" }),
  ).toBeVisible();
  clean();
});

test("devices enroll, are reassigned, paused, and revoked", async ({
  page,
  request,
}, info) => {
  const clean = watchConsole(page);
  const seed = info.project.name.length * 3;
  const kid = await ensureProfile(request, "Kid " + info.project.name, {
    limit: 60,
  });
  await ensureProfile(request, "Teen " + info.project.name);
  await page.goto("/");
  await openTab(page, "Devices");
  await page
    .getByLabel("Family profile")
    .selectOption({ label: "Kid " + info.project.name });
  await page.getByRole("button", { name: "Create enrollment code" }).click();
  await expect(
    page.getByLabel("Enter this code in the Temperance app"),
  ).toHaveValue(/^[a-f0-9]{64}$/);

  const phone = `Phone ${info.project.name}`;
  const device = await enrollDevice(request, kid, phone, seed);
  await page.reload();
  await expect(page.getByRole("status")).toContainText(
    "gateway has not connected yet",
  );
  await expectCleanLayout(page, "overview with gateway warning");
  await openTab(page, "Devices");
  const deviceRow = (name: string) =>
    page.getByRole("row").filter({ has: page.getByLabel(`${name} name`) });
  await expect(deviceRow(phone)).toBeVisible();
  await expectCleanLayout(page, "devices table");

  const renamed = `Tablet ${info.project.name}`;
  await deviceRow(phone).getByLabel(`${phone} name`).fill(renamed);
  await deviceRow(phone).getByLabel(`${phone} name`).press("Enter");
  const row = deviceRow(renamed);
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Locate" }).click();
  await expect(row).toContainText("waiting for device");
  await api(
    request,
    "/v1/device/location",
    { latitude: 41.8781, longitude: -87.6298, accuracy: 35 },
    { Authorization: "Bearer " + device.token },
  );
  await api(
    request,
    "/v1/device/diagnostics",
    {
      issues: [
        {
          code: "gateway_unreachable",
          severity: "warning",
          message: "The VPN cannot reach your family's gateway",
          action:
            "This network may block VPNs or need a sign-in page; try “Sign in to Wi-Fi”.",
        },
      ],
    },
    { Authorization: "Bearer " + device.token },
  );
  await page.reload();
  await openTab(page, "Devices");
  await expect(
    row.getByRole("list", { name: `${renamed} health` }),
  ).toContainText("cannot reach your family's gateway");
  await expect(row.getByRole("link", { name: /±35 m/ })).toHaveAttribute(
    "href",
    /openstreetmap\.org\/\?mlat=41\.8781&mlon=-87\.6298/,
  );
  await expectCleanLayout(page, "devices with location");
  const renamedPhone = renamed;

  await row
    .getByLabel(`${renamedPhone} profile`)
    .selectOption({ label: "Teen " + info.project.name });
  await expect(row.getByLabel(`${renamedPhone} profile`)).toHaveValue(
    String((await profileNamed(request, "Teen " + info.project.name))!.id),
  );
  await row.getByRole("button", { name: "Pause" }).click();
  await expect(row.getByRole("button", { name: "Resume" })).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await row.getByRole("button", { name: "Revoke" }).click();
  await expect(row).toBeHidden();

  const tv = `TV ${info.project.name}`;
  await page.getByLabel("Device name").fill(tv);
  await page
    .getByLabel("Home-network IPv4 address")
    .fill(`192.168.77.${seed + 10}`);
  await page
    .getByLabel("Home device profile")
    .selectOption({ label: "Kid " + info.project.name });
  await page.getByRole("button", { name: "Add home device" }).click();
  const tvRow = deviceRow(tv);
  await expect(tvRow).toContainText("Home network");
  await expect(tvRow.getByRole("button", { name: "Locate" })).toHaveCount(0);
  await expectCleanLayout(page, "devices with a home-network device");
  const state = await api<{ devices: { ip: string; kind: string }[] }>(
    request,
    "/api/state",
  );
  expect(
    state.devices.find((d) => d.ip === `192.168.77.${seed + 10}`)?.kind,
  ).toBe("home");
  page.once("dialog", (d) => d.accept());
  await tvRow.getByRole("button", { name: "Remove" }).click();
  await expect(tvRow).toBeHidden();
  clean();
});

test("history shows gateway decisions and one-click rules; usage summarizes minutes", async ({
  page,
  request,
}, info) => {
  const clean = watchConsole(page);
  const profile = "History " + info.project.name;
  const pid = await ensureProfile(request, profile, { limit: 120 });
  const device = await enrollDevice(
    request,
    pid,
    "Laptop " + info.project.name,
    info.project.name.length * 5 + 1,
  );
  const now = Math.floor(Date.now() / 1000);
  await api(
    request,
    "/v1/gateway/activity",
    {
      active_devices: [device.device_id],
      activity: [
        {
          device_id: device.device_id,
          minute: Math.floor(now / 60) - 1,
          buckets: ["total", "category:video"],
        },
      ],
      history: [
        {
          id: "h1-" + info.project.name,
          device_id: device.device_id,
          at: now - 30,
          domain: "youtube.com",
          blocked: false,
          reason: "allowed",
          category: "video",
        },
        {
          id: "h2-" + info.project.name,
          device_id: device.device_id,
          at: now - 20,
          domain:
            "a-really-long-subdomain-name.tracking.example-advertising-network.com",
          blocked: true,
          reason: "ads",
          category: "ads",
        },
      ],
    },
    gateway,
  );
  await page.goto("/");
  await openTab(page, "History");
  await page.getByLabel("Profile").selectOption({ label: profile });
  const row = page
    .getByRole("row", { name: /youtube\.com/ })
    .filter({ hasText: profile });
  await expect(row).toBeVisible();
  await expect(
    page
      .getByRole("row", { name: /example-advertising-network/ })
      .filter({ hasText: profile }),
  ).toContainText("Blocked · Ads & trackers");
  await expectCleanLayout(page, "history with long domains");
  await page.getByLabel("Decision").selectOption("true");
  await expect(row).toBeHidden();
  await page.getByLabel("Decision").selectOption("all");
  await row.getByRole("button", { name: "Deny" }).click();
  await expect
    .poll(async () => {
      const state = await api<{ profiles: { name: string; deny: string[] }[] }>(
        request,
        "/api/state",
      );
      return state.profiles.find((p) => p.name === profile)?.deny;
    })
    .toContain("youtube.com");
  const csv = page.getByRole("link", { name: "Export CSV" });
  await expect(csv).toHaveAttribute("href", /format=csv/);

  await openTab(page, "Usage");
  await page.getByLabel("Usage period").selectOption("30");
  await expect(page.getByRole("columnheader", { name: profile })).toBeVisible();
  await expect(page.locator("tbody")).toContainText("2 min");
  const summary = page.getByRole("article", {
    name: `${profile} usage summary`,
  });
  await expect(summary).toContainText("2 min");
  await expect(summary).toContainText("no activity in the 30 days before");
  await expect(summary.getByRole("listitem")).toContainText(
    "Video & streaming",
  );
  await expectCleanLayout(page, "usage table");
  clean();
});

test("children request time and parents approve, reward, and cancel", async ({
  page,
  request,
}, info) => {
  const clean = watchConsole(page);
  const profile = "Requests " + info.project.name;
  const pid = await ensureProfile(request, profile, { limit: 30 });
  const device = await enrollDevice(
    request,
    pid,
    "Tablet " + info.project.name,
    info.project.name.length * 11 + 2,
  );
  await api(
    request,
    "/v1/device/requests",
    {
      minutes: 20,
      message: "Finishing my science project " + info.project.name,
    },
    { Authorization: "Bearer " + device.token },
  );
  await page.goto("/");
  await expect(page.locator("button.nav .dot")).toBeVisible();
  await openTab(page, "Requests");
  const card = page.locator(".row-card", {
    hasText: "Finishing my science project " + info.project.name,
  });
  await expectCleanLayout(page, "requests");
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(card).toContainText("Approved");

  const rewards = page.locator("section", { hasText: "Today’s rewards" });
  await expect(rewards).toContainText(`${profile}: 20 extra minutes`);
  await page.getByLabel("Profile").selectOption({ label: profile });
  await page.getByLabel("Extra minutes").fill("10");
  await page.getByRole("button", { name: "Send reward" }).click();
  await expect(rewards).toContainText(`${profile}: 10 extra minutes`);
  const tenMinutes = rewards.locator(".row-card", {
    hasText: `${profile}: 10 extra minutes`,
  });
  await tenMinutes.getByRole("button", { name: "Cancel reward" }).click();
  await expect(tenMinutes).toBeHidden();

  const deviceState = await api<{ status: { remaining_minutes: number } }>(
    request,
    "/v1/device/state",
    undefined,
    { Authorization: "Bearer " + device.token },
  );
  expect(deviceState.status.remaining_minutes).toBe(50);
  await page.getByRole("button", { name: "Mark all read" }).click();
  clean();
});

test("clients and settings manage client users, retention, and feeds", async ({
  page,
}, info) => {
  const clean = watchConsole(page);
  const coParent = "coparent-" + info.project.name;
  await page.goto("/");
  await openTab(page, "Clients");
  const add = page.getByRole("form", { name: "Add client user" });
  await add.getByLabel("Username").fill(coParent);
  await add.getByLabel("Password").fill("client-test-password");
  await add.getByRole("button", { name: "Create user" }).click();
  const row = page.locator(".row-card", { hasText: coParent });
  await expect(row).toContainText("Enabled");
  await expectCleanLayout(page, "clients");

  await row.getByRole("button", { name: "Set password" }).click();
  const reset = page.getByRole("form", { name: "Set client password" });
  await reset.getByLabel("New password").fill("client-new-password");
  await reset.getByLabel("Confirm password").fill("client-new-password");
  await reset.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Password set for " + coParent,
  );

  page.once("dialog", (d) => d.accept());
  await row.getByRole("button", { name: "Delete user" }).click();
  await expect(row).toBeHidden();

  await openTab(page, "Settings");
  await page.getByLabel("History retention (days)").fill("14");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.locator("footer")).toContainText("Policy version");
  await page.reload();
  await openTab(page, "Settings");
  await expect(page.getByLabel("History retention (days)")).toHaveValue("14");

  const remote = page.locator("section", {
    has: page.getByRole("heading", { name: "Remote access" }),
  });
  await remote.getByLabel(/^Dynu hostname/).fill("myhome.ddnsfree.com");
  await remote.getByLabel("Dynu username").fill("family");
  await remote.getByLabel(/^Dynu IP update password/).fill("ip-secret");
  await remote.getByRole("button", { name: "Save remote access" }).click();
  await expect(remote.getByLabel(/^Dynu IP update password/)).toHaveAttribute(
    "placeholder",
    /Saved/,
  );
  await expect(remote.getByRole("status")).toContainText(
    "TEMPERANCE_VPN_ENDPOINT",
  );
  await expectCleanLayout(page, "settings-remote-access");
  await remote.getByLabel(/^Dynu hostname/).fill("");
  await remote.getByRole("button", { name: "Save remote access" }).click();
  await expect(remote.getByRole("status")).toHaveCount(0);

  await page.getByLabel("Category").selectOption({ label: "Gaming" });
  await page.getByLabel("Domains").fill("chess.com\nlichess.org");
  await page.getByRole("button", { name: "Import feed" }).click();
  await expect(page.locator("p.error")).toHaveCount(0);
  clean();
});

test("parents pair a phone and reach the dashboard through the gateway", async ({
  page,
  browser,
  request,
}, info) => {
  const clean = watchConsole(page);
  await api(
    request,
    "/v1/gateway/activity",
    { remote: { pin: "E2E-PIN" } },
    gateway,
  );
  await page.goto("/");
  await openTab(page, "Settings");
  const section = page.locator("section", {
    has: page.getByRole("heading", { name: "Parent devices" }),
  });
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string) =>
          void ((window as unknown as { copied: string }).copied = text),
      },
    });
  });
  await section.getByRole("button", { name: "Pair a parent device" }).click();
  await expect(section.getByRole("img", { name: /QR code/ })).toBeVisible();
  await expect(section.getByRole("timer")).toContainText("Works once");
  await expectCleanLayout(page, "settings-parent-pairing");
  await section.getByRole("button", { name: "Copy pairing link" }).click();
  const link = await page.evaluate(
    () => (window as unknown as { copied: string }).copied,
  );
  const { code } = JSON.parse(
    Buffer.from(link.split("#")[1], "base64url").toString(),
  );
  const name = "Robin's phone " + info.project.name;
  const { id } = await api<{ id: string }>(
    request,
    "/v1/gateway/parents/pair",
    { code, name, key: ("e2e" + info.project.name).padEnd(43, "k") },
    forwarded(),
  );
  await expect(section.getByRole("status")).toContainText(`${name} is paired`);

  const phone = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: forwarded(id),
  });
  const away = await phone.newPage();
  await away.goto("/");
  await expect(
    away.getByText(`AWAY FROM HOME · ${name.toUpperCase()}`),
  ).toBeVisible();
  await expect(away.getByRole("button", { name: "Sign out" })).toHaveCount(0);

  page.once("dialog", (d) => d.accept());
  await section
    .locator(".row-card", { hasText: name })
    .getByRole("button", { name: "Revoke" })
    .click();
  await expect(section.locator(".row-card", { hasText: name })).toBeHidden();
  await away.reload();
  await expect(away.getByRole("button", { name: "Sign in" })).toBeVisible();
  await phone.close();
  clean();
});
