import { expect, test, type Page } from "@playwright/test";
import { ADMIN_TOKEN } from "../playwright.config";
import { OWNER, api, watchConsole } from "./helpers";
import { expectCleanLayout } from "./layout";

const SIZES = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "phone", width: 412, height: 915 },
];

/** The wizard is only reachable once, so audit each step at every viewport here. */
async function auditEverySize(page: Page, label: string) {
  for (const size of SIZES) {
    await page.setViewportSize(size);
    await expectCleanLayout(page, `${label} (${size.name})`);
  }
  await page.setViewportSize(SIZES[0]);
}

test("a fresh install walks the parent through the admin account and first rules", async ({
  page,
  request,
}) => {
  const clean = watchConsole(page);
  await page.setViewportSize(SIZES[0]);
  await page.goto("/");
  const progress = page.getByRole("list", { name: "Setup progress" });
  await expect(progress.locator('[aria-current="step"]')).toContainText(
    "Welcome",
  );
  await auditEverySize(page, "setup welcome");
  await page.getByRole("button", { name: "Get started" }).click();

  const account = page.getByRole("form", {
    name: "Create the administrator account",
  });
  await expect(progress.locator('[aria-current="step"]')).toContainText(
    "Admin account",
  );
  await account.getByLabel("Setup token").fill("not-the-token");
  await account.getByLabel("Username").fill(OWNER.username);
  await account.getByLabel(/^Password/).fill(OWNER.password);
  await account.getByLabel("Confirm password").fill("a-different-pass");
  await account.getByRole("button", { name: "Create account" }).click();
  await expect(page.locator("p.error")).toHaveText(
    "The passwords do not match",
  );
  await account.getByLabel("Confirm password").fill(OWNER.password);
  await account.getByRole("button", { name: "Create account" }).click();
  await expect(page.locator("p.error")).toHaveText("Invalid setup token");
  await auditEverySize(page, "setup account with error");

  await account.getByLabel("Setup token").fill(ADMIN_TOKEN);
  await account.getByRole("button", { name: "Create account" }).click();

  const rules = page.getByRole("form", {
    name: "Starting rules for your first family member",
  });
  await expect(rules).toBeVisible();
  await expect(progress.locator('[aria-current="step"]')).toContainText(
    "Family rules",
  );
  await rules.getByLabel("Their name").fill("Jordan");
  await rules.getByLabel(/^Teen/).check();
  await expect(rules.getByLabel(/Daily screen-time limit/)).toHaveValue("180");
  await rules.getByLabel("Social media").check();
  await rules.getByLabel("Minutes per day for all games together").fill("60");
  await rules
    .getByLabel("Games in the group")
    .fill("roblox.com\nminecraft.net\nfortnite.com");
  await auditEverySize(page, "setup rules");
  await rules.getByRole("button", { name: "Save rules" }).click();

  await expect(
    page.getByRole("heading", { name: "Jordan’s rules are ready." }),
  ).toBeVisible();
  await auditEverySize(page, "setup finished");
  const state = await api<{
    profiles: {
      name: string;
      filter_level: string;
      categories: string[];
      app_limits: { name: string; domains: string[]; minutes: number }[];
    }[];
    needs_onboarding: boolean;
  }>(request, "/api/state");
  expect(state.profiles[0]).toMatchObject({
    name: "Jordan",
    filter_level: "teen",
    categories: ["social"],
    app_limits: [
      {
        name: "Games",
        minutes: 60,
        domains: ["roblox.com", "minecraft.net", "fortnite.com"],
      },
    ],
  });

  await page.getByRole("button", { name: "Add a device" }).click();
  await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible();
  const jordan = page.locator("article.profile", { hasText: "Jordan" });
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await expect(
    jordan.getByRole("list", { name: "Jordan shared app limits" }),
  ).toHaveText("Games 0 / 60 min");
  await expectCleanLayout(page, "overview after setup");
  await page.context().storageState({ path: "test-results/parent.json" });

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Your family's digital day." }),
  ).toBeVisible();
  clean();
});
