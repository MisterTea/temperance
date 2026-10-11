import { expect, test, type Page } from "@playwright/test";
import {
  api,
  enrollDevice,
  ensureProfile,
  gateway,
  profileNamed,
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
  const name = "Avery " + info.project.name;
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
  await expectCleanLayout(page, "profile editor filled");
  await editor.getByRole("button", { name: "Save profile" }).click();
  await expect(editor).toBeHidden();

  const card = page.locator("article.profile", { hasText: name });
  await expect(card).toContainText("/ 90 allowance");
  await expect(card).toContainText("Bedtime 21:00–07:00");
  await expect(card).toContainText("1 schedule windows");

  await card.getByRole("button", { name: "Pause" }).click();
  await expect(card.locator(".badge")).toHaveText("paused");
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
    "household pause",
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
  await page.reload();
  await openTab(page, "Devices");
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
    page.getByRole("row", { name: /example-advertising-network/ }),
  ).toContainText("ads");
  await expectCleanLayout(page, "history with long domains");
  await page.getByLabel("Decision").selectOption("true");
  await expect(row).toBeHidden();
  await page.getByLabel("Decision").selectOption("all");
  await row.getByRole("button", { name: "deny" }).click();
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
  await expect(summary).toContainText("No activity in the previous 30 days");
  await expect(summary.getByRole("listitem")).toContainText("video");
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
  await expect(card).toContainText("approved");

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

test("settings manage co-parents, retention, and feeds", async ({
  page,
}, info) => {
  const clean = watchConsole(page);
  const coParent = "coparent-" + info.project.name;
  await page.goto("/");
  await openTab(page, "Settings");
  await expect(page.locator(".row-card", { hasText: "robin" })).toContainText(
    "owner",
  );
  const add = page.getByRole("form", { name: "Add parent" });
  await add.getByLabel("Co-parent username").fill(coParent);
  await add.getByLabel("Initial password").fill("co-parent-password");
  await add.getByRole("button", { name: "Add parent" }).click();
  const row = page.locator(".row-card", { hasText: coParent });
  await expect(row).toContainText("parent");
  await expectCleanLayout(page, "settings");

  page.once("dialog", (d) => d.accept());
  await row.getByRole("button", { name: "Remove" }).click();
  await expect(row).toBeHidden();

  await page.getByLabel("History retention (days)").fill("14");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.locator("footer")).toContainText("Policy version");
  await page.reload();
  await openTab(page, "Settings");
  await expect(page.getByLabel("History retention (days)")).toHaveValue("14");

  await page.getByLabel("Category").selectOption({ label: "Gaming" });
  await page.getByLabel("Domains").fill("chess.com\nlichess.org");
  await page.getByRole("button", { name: "Import feed" }).click();
  await expect(page.locator("p.error")).toHaveCount(0);
  clean();
});
