import { expect, it } from "vitest";
import {
  betaChecks,
  stableChecks,
  validateEvidence,
} from "../../scripts/check-release.mjs";

it("requires exact version, source, owners and recorded passing evidence", () => {
  const evidence = {
    schema: 1,
    version: "v0.7.0-beta.1",
    source_digest: "tested-source",
    checks: Object.fromEntries(
      betaChecks.map((id) => [
        id,
        {
          status: "passed",
          owner: "assigned reviewer",
          evidence: "https://example.net/test-record",
          verified_at: "2026-10-15T12:00:00Z",
        },
      ]),
    ),
  };
  Object.assign(evidence.checks.signed_distribution, { run_id: 123456 });
  expect(
    validateEvidence(evidence, "beta", evidence.version, "tested-source"),
  ).toEqual([]);
  expect(
    validateEvidence(evidence, "stable", evidence.version, "tested-source"),
  ).toHaveLength(stableChecks.length - betaChecks.length);
  expect(
    validateEvidence(evidence, "beta", "v0.7.0-beta.2", "changed-source"),
  ).toHaveLength(2);
  evidence.checks.ios_device.status = "pending";
  expect(
    validateEvidence(evidence, "beta", evidence.version, "tested-source"),
  ).toEqual([expect.stringContaining("ios_device")]);
});
