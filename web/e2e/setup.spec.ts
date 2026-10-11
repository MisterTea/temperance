import { expect, test } from "@playwright/test";
import { ADMIN_TOKEN } from "../playwright.config";
import { OWNER, watchConsole } from "./helpers";
import { expectCleanLayout } from "./layout";

test("first run creates the owner account with the setup token", async ({
  page,
}) => {
  const clean = watchConsole(page);
  await page.goto("/");
  const form = page.getByRole("form", { name: "Create owner account" });
  await expect(form).toBeVisible();
  await expectCleanLayout(page, "first-run setup");

  await form.getByLabel("Setup token").fill("not-the-token");
  await form.getByLabel("Username").fill(OWNER.username);
  await form.getByLabel("Password").fill(OWNER.password);
  await form.getByRole("button", { name: "Create account" }).click();
  await expect(page.locator("p.error")).toHaveText("Invalid setup token");

  await form.getByLabel("Setup token").fill(ADMIN_TOKEN);
  await form.getByRole("button", { name: "Create account" }).click();
  await expect(
    page.getByRole("heading", { name: "Your family's digital day." }),
  ).toBeVisible();
  await page.context().storageState({ path: "test-results/parent.json" });
  clean();
});
