import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { repositoryFor, mutate } from "../src/lib/database";
import recovery from "../scripts/recovery.cjs";
import { backupNow } from "../src/lib/maintenance";
import { recoveryJob } from "../src/lib/recovery";

const passphrase = "separately stored recovery passphrase";
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "temperance-recovery-test-"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
it("runs scheduled/pre-update backups outside the gateway process and records failures safely", async () => {
  const repo = await household();
  try {
    vi.stubEnv("TEMPERANCE_DATA_DIR", directory);
    vi.stubEnv(
      "TEMPERANCE_DATABASE_URL",
      `sqlite:${join(directory, "temperance.sqlite3")}`,
    );
    vi.stubEnv("TEMPERANCE_BACKUP_PASSPHRASE", passphrase);
    const file = await backupNow(repo);
    expect(file).toContain("recovery-");
    expect((await repo.read()).state.maintenance?.backup_at).toBeGreaterThan(0);
    const archive = await recoveryJob("export");
    expect(
      (await recovery.unseal(archive, passphrase)).keys["parent.key"],
    ).toBe(await readFile(join(directory, "parent.key"), "utf8"));
    vi.stubEnv("TEMPERANCE_BACKUP_PASSPHRASE", "short");
    await expect(backupNow(repo)).rejects.toThrow(/Recovery backup failed/);
    expect((await repo.read()).state.maintenance?.backup_error).not.toContain(
      directory,
    );
  } finally {
    await repo.close();
  }
});
async function household() {
  const repo = repositoryFor(`sqlite:${join(directory, "temperance.sqlite3")}`);
  await mutate(repo, (s) => {
    s.paused = true;
    s.network = {
      upnp: false,
      ddns: {
        provider: "dynu",
        hostname: "private.example.net",
        username: "PRIVATE",
        password: "PRIVATE",
      },
    };
  });
  await writeFile(
    join(directory, "gateway.key"),
    Buffer.alloc(32, 7).toString("base64") + "\n",
  );
  await writeFile(
    join(directory, "parent.key"),
    generateKeyPairSync("ed25519")
      .privateKey.export({ format: "der", type: "pkcs8" })
      .toString("base64url"),
  );
  return repo;
}
it("encrypts and authenticates snapshots and rejects unknown formats", async () => {
  const archive = await recovery.seal({ secret: "PRIVATE" }, passphrase);
  expect(archive).not.toContain("PRIVATE");
  expect(await recovery.unseal(archive, passphrase)).toEqual({
    secret: "PRIVATE",
  });
  await expect(
    recovery.unseal(archive, "wrong passphrase is long enough"),
  ).rejects.toThrow(/authentication failed/);
  const damaged = JSON.parse(archive);
  damaged.tag = Buffer.alloc(16).toString("base64");
  await expect(
    recovery.unseal(JSON.stringify(damaged), passphrase),
  ).rejects.toThrow(/authentication failed/);
  await expect(recovery.seal({}, "short")).rejects.toThrow(/passphrase/);
  await expect(recovery.unseal('{"schema":99}', passphrase)).rejects.toThrow(
    /format/,
  );
});
it("restores a live SQLite snapshot and both gateway identities on a replacement host", async () => {
  const repo = await household();
  try {
    const env = {
      TEMPERANCE_DATA_DIR: directory,
      TEMPERANCE_BACKUP_PASSPHRASE: passphrase,
      TEMPERANCE_ADMIN_PASSWORD: "PRIVATE-$pecial",
      TEMPERANCE_VPN_ENDPOINT: "private.example.net:51820",
    };
    const archive = await recovery.createArchive(env);
    expect(archive).not.toContain("PRIVATE");
    const restored = join(directory, "replacement");
    await recovery.restoreArchive(archive, passphrase, restored);
    const replacement = repositoryFor(
      `sqlite:${join(restored, "temperance.sqlite3")}`,
    );
    try {
      expect((await replacement.read()).state).toEqual(
        (await repo.read()).state,
      );
    } finally {
      await replacement.close();
    }
    for (const name of ["gateway.key", "parent.key"])
      expect(await readFile(join(restored, name), "utf8")).toBe(
        await readFile(join(directory, name), "utf8"),
      );
    const config = await readFile(join(restored, "recovery.env"), "utf8");
    expect(config).not.toContain(passphrase);
    expect(config).toContain("PRIVATE-$$pecial");
    expect((await stat(join(restored, "gateway.key"))).mode & 0o777).toBe(
      0o600,
    );
    await expect(
      recovery.restoreArchive(archive, passphrase, restored),
    ).rejects.toThrow();
    expect(await readdir(restored)).toContain("temperance.sqlite3");
  } finally {
    await repo.close();
  }
});
it("bounds retained archives, refuses PostgreSQL and leaves targets untouched on failed recovery", async () => {
  const repo = await household();
  try {
    const env = {
      TEMPERANCE_DATA_DIR: directory,
      TEMPERANCE_BACKUP_PASSPHRASE: passphrase,
    };
    for (let i = 0; i < 8; i++) await recovery.saveArchive(env);
    expect(await readdir(join(directory, "backups"))).toHaveLength(7);
    await expect(
      recovery.createArchive({
        ...env,
        TEMPERANCE_DATABASE_URL: "postgres://private",
      }),
    ).rejects.toThrow(/SQLite only/);
    const malformed = await recovery.seal(
      {
        database: Buffer.from("not sqlite").toString("base64"),
        config: {},
        keys: {},
      },
      passphrase,
    );
    const destination = join(directory, "bad");
    await expect(
      recovery.restoreArchive(malformed, passphrase, destination),
    ).rejects.toThrow(/database/);
    await expect(stat(destination)).rejects.toThrow();
  } finally {
    await repo.close();
  }
});
