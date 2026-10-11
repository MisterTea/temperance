import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  PostgresRepository,
  SQLiteRepository,
  SQLRepository,
  TestRepository,
  backend,
  mutate,
  repository,
  repositoryFor,
  type Repository,
} from "../src/lib/database";
import { saveProfile, deleteProfile } from "../src/lib/service";

const dir = mkdtempSync(join(tmpdir(), "temperance-storage-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const libsql = process.env.TEMPERANCE_TEST_DATABASE_URL;
const postgres = process.env.TEMPERANCE_TEST_POSTGRES_URL;
const backends: [string, string | undefined, () => Repository][] = [
  ["memory", "yes", () => new TestRepository()],
  ["sqlite", "yes", () => new SQLiteRepository(join(dir, "state.sqlite3"))],
  ["postgres", postgres, () => new PostgresRepository(postgres!)],
  ["libsql", libsql, () => new SQLRepository(libsql!)],
];

describe.each(backends)("%s storage", (name, enabled, open) => {
  it.skipIf(!enabled)(
    "persists across independent repository instances and serializes concurrent changes",
    async () => {
      const shared = name === "memory" ? open() : undefined;
      const a = shared ?? open(),
        b = shared ?? open();
      const before = (await a.read()).state.profiles.length;
      const saved = await Promise.all(
        ["A", "B", "C", "D"].map((suffix, n) =>
          mutate(
            n % 2 ? a : b,
            (s) =>
              saveProfile(s, { name: "Storage " + suffix }).profiles.at(-1)!.id,
          ),
        ),
      );
      const after = (await (shared ?? open()).read()).state;
      expect(after.profiles).toHaveLength(before + 4);
      expect(new Set(after.profiles.map((p) => p.id)).size).toBe(
        after.profiles.length,
      );
      for (const id of saved) await mutate(a, (s) => deleteProfile(s, id));
      expect((await b.read()).state.profiles).toHaveLength(before);
    },
  );
  it.skipIf(!enabled)("rejects stale revisions", async () => {
    const repo = open();
    const { state, revision } = await repo.read();
    expect(await repo.commit(state, revision)).toBe(true);
    expect(await repo.commit(state, revision)).toBe(false);
  });
});

describe("backend selection", () => {
  it("chooses the driver from the database URL", () => {
    expect(backend("postgres://u:p@db/temperance")).toBe("postgres");
    expect(backend("postgresql://db/temperance")).toBe("postgres");
    expect(backend("sqlite:///var/lib/temperance.db")).toBe("sqlite");
    expect(backend("file:data/temperance.sqlite3")).toBe("sqlite");
    expect(backend("/data/temperance.db")).toBe("sqlite");
    expect(backend("libsql://family.turso.io")).toBe("libsql");
    expect(backend("https://family.turso.io")).toBe("libsql");
    expect(repositoryFor("postgres://db/t")).toBeInstanceOf(PostgresRepository);
    expect(repositoryFor("sqlite:" + join(dir, "x.db"))).toBeInstanceOf(
      SQLiteRepository,
    );
    expect(repositoryFor("https://db.example")).toBeInstanceOf(SQLRepository);
  });
  it("requires configuration and HTTPS for remote libSQL", () => {
    const previous = process.env.TEMPERANCE_DATABASE_URL;
    delete process.env.TEMPERANCE_DATABASE_URL;
    expect(() => repository()).toThrow(/Configure/);
    process.env.TEMPERANCE_DATABASE_URL = "sqlite:" + join(dir, "env.db");
    expect(repository()).toBe(repository());
    process.env.TEMPERANCE_DATABASE_URL = previous;
    expect(() => new SQLRepository("http://db.example")).toThrow(/HTTPS/);
  });
  it("retries optimistic conflicts and reports exhaustion", async () => {
    const repo = new TestRepository();
    await expect(
      mutate({ read: repo.read.bind(repo), commit: async () => false }, (s) => {
        s.paused = !s.paused;
      }),
    ).rejects.toThrow(/Concurrent/);
  });
});
