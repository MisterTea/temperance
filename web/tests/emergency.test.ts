import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { emergencyVerifier } from "../src/lib/emergency";
import { verifyPassword } from "../src/lib/accounts";
import { TestRepository } from "../src/lib/database";
import { handle } from "../src/lib/http";
const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../core/temperance-core/tests/fixtures/emergency.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
afterEach(() => vi.unstubAllEnvs());
test("offline verifiers match the Rust fixture and cannot authenticate as a login hash", async () => {
  vi.stubEnv("TEMPERANCE_ADMIN_PASSWORD", fixture.password);
  vi.stubEnv("TEMPERANCE_GATEWAY_TOKEN", "g".repeat(48));
  expect(
    await verifyPassword(
      "Temperance emergency VPN unlock v1\0" + fixture.password,
      fixture.verifier,
    ),
  ).toBe(true);
  const first = await emergencyVerifier("device-one");
  expect(await emergencyVerifier("device-one")).toBe(first);
  expect(await emergencyVerifier("device-two")).not.toBe(first);
  expect(await verifyPassword(fixture.password, first)).toBe(false);
  expect(
    await verifyPassword(
      "Temperance emergency VPN unlock v1\0" + fixture.password,
      first,
    ),
  ).toBe(true);
  vi.stubEnv("TEMPERANCE_ADMIN_PASSWORD", "new-household-password");
  const rotated = await emergencyVerifier("device-one");
  expect(rotated).not.toBe(first);
  expect(
    await verifyPassword(
      "Temperance emergency VPN unlock v1\0" + fixture.password,
      rotated,
    ),
  ).toBe(false);
});
test("an unauthenticated or revoked device cannot fetch emergency credentials", async () => {
  vi.stubEnv("TEMPERANCE_ADMIN_PASSWORD", fixture.password);
  vi.stubEnv("TEMPERANCE_GATEWAY_TOKEN", "g".repeat(48));
  const response = await handle(
    new Request("http://localhost/v1/device/state"),
    "v1/device/state",
    new TestRepository(),
  );
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain("pbkdf2");
});
