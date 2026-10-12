import { expect } from "@playwright/test";
import { OWNER, test, watchConsole } from "./helpers";
import { expectCleanLayout } from "./layout";

test.use({ storageState: { cookies: [], origins: [] } });

test("administrator signs in with only a password and can sign out", async ({
  page,
}) => {
  const clean = watchConsole(page);
  await page.goto("/");
  const form = page.getByRole("form", { name: "Sign in" });
  await expect(form).toBeVisible();
  await expect(form.getByLabel("Setup token")).toHaveCount(0);
  await expectCleanLayout(page, "sign-in");

  await expect(form.getByLabel("Username")).toHaveCount(0);
  await form.getByLabel("Admin password").fill("wrong password!");
  await form.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("p.error")).toHaveText("Invalid admin password");
  await expectCleanLayout(page, "sign-in error");

  await form.getByLabel("Admin password").fill(OWNER.password);
  await form.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Overview" })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("form", { name: "Sign in" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("form", { name: "Sign in" })).toBeVisible();
  clean();
});

test("client IAM credentials identify the assigned profile without admin privileges", async ({
  request,
}) => {
  const { admin, ensureProfile, deviceKey } = await import("./helpers");
  const profileId = await ensureProfile(request, "IAM test profile");
  const username = "client-" + Date.now();
  const created = await request.post("/api/users", {
    headers: admin,
    data: { username, password: "client-test-password", profile_id: profileId },
  });
  expect(created.ok()).toBeTruthy();
  const response = await request.post("/v1/device/login", {
    data: {
      username,
      password: "client-test-password",
      name: "IAM test phone",
      public_key: deviceKey(),
    },
  });
  expect(response.status()).toBe(200);
  const device = await response.json();
  expect(device.policy.id).toBe(profileId);
  expect(
    (
      await request.get("/api/state", {
        headers: { Authorization: "Bearer " + device.token },
      })
    ).status(),
  ).toBe(401);
  expect(
    (
      await request.get("/v1/device/state", {
        headers: { Authorization: "Bearer " + device.token },
      })
    ).status(),
  ).toBe(200);
  expect(
    (
      await request.post("/v1/oauth/token", {
        data: { grant_type: "password" },
      })
    ).status(),
  ).toBe(404);
});
