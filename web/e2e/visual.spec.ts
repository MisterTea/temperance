import { expect } from "@playwright/test";
import {
  api,
  enrollDevice,
  ensureProfile,
  gateway,
  test,
  watchConsole,
} from "./helpers";
import { expectCleanLayout } from "./layout";

const TABS = [
  "Overview",
  "Devices",
  "Usage",
  "History",
  "Requests",
  "Settings",
];

test.beforeAll(async ({ request }) => {
  // Long names and many items stress wrapping, truncation, and table layout.
  const pid = await ensureProfile(
    request,
    "Maximilian-Alexandria the Very Long Named Child",
    {
      limit: 240,
      bedtime: { start: "20:30", end: "06:45", days: [0, 1, 2, 3, 4, 5, 6] },
      unmanaged: ["school.example.edu"],
    },
  );
  for (const n of [1, 2, 3])
    await ensureProfile(request, `Sibling ${n}`, { limit: n * 30 });
  const state = await api<{ devices: { name: string; id: string }[] }>(
    request,
    "/api/state",
  );
  let device = state.devices.find((d) => d.name.startsWith("Visual"));
  if (!device) {
    const enrolled = await enrollDevice(
      request,
      pid,
      "Visual test Chromebook with an unusually descriptive name",
      200,
    );
    device = { id: enrolled.device_id, name: "" };
  }
  const now = Math.floor(Date.now() / 1000);
  await api(
    request,
    "/v1/gateway/activity",
    {
      active_devices: [device.id],
      history: Array.from({ length: 12 }, (_, n) => ({
        id: `visual-${n}`,
        device_id: device!.id,
        at: now - n * 10,
        domain:
          n % 3
            ? `cdn${n}.static.longexamplecontentdeliverynetwork.net`
            : "khanacademy.org",
        blocked: n % 2 === 0,
        reason: n % 2 ? "allowed" : "limit category:video",
        category: "video",
      })),
    },
    gateway,
  );
});

for (const tab of TABS)
  test(`${tab} renders without overflow or overlap`, async ({ page }, info) => {
    const clean = watchConsole(page);
    await page.goto("/");
    await page.getByRole("button", { name: tab, exact: true }).click();
    await expect(page.locator("header h1")).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expectCleanLayout(page, tab);
    await info.attach(`${tab.toLowerCase()}.png`, {
      body: await page.screenshot({
        fullPage: true,
        path: info.outputPath(`${tab.toLowerCase()}.png`),
      }),
      contentType: "image/png",
    });
    clean();
  });

test("profile editor dialog fits the viewport", async ({ page }) => {
  const clean = watchConsole(page);
  await page.goto("/");
  await page
    .locator("article.profile", { hasText: "Maximilian" })
    .getByRole("button", { name: "Edit rules" })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "+ Add schedule" }).click();
  await dialog.getByLabel("Add a site budget").fill("youtube.com");
  await dialog.getByRole("button", { name: "Add site" }).click();
  await expectCleanLayout(page, "editor top");
  const box = await dialog.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box!.width).toBeLessThanOrEqual(viewport.width);
  await dialog
    .getByRole("button", { name: "Save profile" })
    .scrollIntoViewIfNeeded();
  await expectCleanLayout(page, "editor bottom");
  clean();
});
