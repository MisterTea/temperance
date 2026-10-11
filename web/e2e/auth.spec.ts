import { expect, test } from "@playwright/test";
import { OWNER, watchConsole } from "./helpers";
import { expectCleanLayout } from "./layout";

test.use({ storageState: { cookies: [], origins: [] } });

test("parents sign in with username and password and can sign out", async ({
  page,
}) => {
  const clean = watchConsole(page);
  await page.goto("/");
  const form = page.getByRole("form", { name: "Sign in" });
  await expect(form).toBeVisible();
  await expect(form.getByLabel("Setup token")).toHaveCount(0);
  await expectCleanLayout(page, "sign-in");

  await form.getByLabel("Username").fill(OWNER.username);
  await form.getByLabel("Password").fill("wrong password!");
  await form.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("p.error")).toHaveText(
    "Invalid username or password",
  );
  await expectCleanLayout(page, "sign-in error");

  await form.getByLabel("Username").fill(OWNER.username.toUpperCase());
  await form.getByLabel("Password").fill(OWNER.password);
  await form.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Overview" })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("form", { name: "Sign in" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("form", { name: "Sign in" })).toBeVisible();
  clean();
});

test("OAuth password grant returns bearer tokens for native clients", async ({
  request,
}) => {
  const response = await request.post("/v1/oauth/token", {
    form: { grant_type: "password", ...OWNER, client_id: "e2e" },
  });
  expect(response.status()).toBe(200);
  const tokens = await response.json();
  expect(tokens.token_type).toBe("Bearer");
  const state = await request.get("/api/state", {
    headers: { Authorization: "Bearer " + tokens.access_token },
  });
  expect(state.status()).toBe(200);
});
