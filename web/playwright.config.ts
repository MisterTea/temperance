import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 3100);
export const ADMIN_TOKEN = "e2e-admin-".padEnd(48, "a");
export const GATEWAY_TOKEN = "e2e-gateway-".padEnd(48, "g");
export const baseURL = `http://127.0.0.1:${port}`;
// The standalone server changes directory, so SQLite paths must be absolute.
const database =
  process.env.E2E_DATABASE_URL ??
  "sqlite:" + resolve(__dirname, "test-results/e2e.sqlite3");

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL, trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: {
    command: "node e2e/reset-db.mjs && node scripts/start.cjs",
    url: baseURL + "/healthz",
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: String(port),
      TEMPERANCE_DATABASE_URL: database,
      TEMPERANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      TEMPERANCE_GATEWAY_TOKEN: GATEWAY_TOKEN,
      TEMPERANCE_PUBLIC_URL: baseURL,
      TEMPERANCE_VPN_ENDPOINT: "192.0.2.10:51820",
      TEMPERANCE_VPN_PUBLIC_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
      TEMPERANCE_TIMEZONE: "America/Chicago",
    },
  },
  projects: [
    { name: "setup", testMatch: /setup\.spec\.ts/ },
    {
      name: "desktop",
      dependencies: ["setup"],
      testIgnore: /setup\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        storageState: "test-results/parent.json",
      },
    },
    {
      name: "tablet",
      dependencies: ["setup"],
      testMatch: /visual\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 820, height: 1180 },
        storageState: "test-results/parent.json",
      },
    },
    {
      name: "mobile",
      dependencies: ["setup"],
      testIgnore: /(setup|layout)\.spec\.ts/,
      use: {
        ...devices["Pixel 7"],
        storageState: "test-results/parent.json",
      },
    },
  ],
});
