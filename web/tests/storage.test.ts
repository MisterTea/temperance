import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  KyselyRepository,
  TestRepository,
  backend,
  dataDir,
  databaseUrl,
  mutate,
  repository,
  repositoryFor,
  type Repository,
} from "../src/lib/database";
import { emptyState } from "../src/lib/model";
import { saveProfile, deleteProfile } from "../src/lib/service";

const dir = mkdtempSync(join(tmpdir(), "temperance-storage-"));
const opened: KyselyRepository[] = [];
afterAll(async () => {
  await Promise.all(opened.map((r) => r.close()));
  rmSync(dir, { recursive: true, force: true });
});
function open(url: string) {
  const repo = repositoryFor(url);
  opened.push(repo);
  return repo;
}

const postgres = process.env.TEMPERANCE_TEST_POSTGRES_URL;
let fresh = 0;
const backends: [string, string | undefined, () => string][] = [
  ["sqlite", "yes", () => `sqlite:${join(dir, `state-${++fresh}.sqlite3`)}`],
  ["postgres", postgres, () => postgres!],
];

describe.each(backends)("%s storage contract", (name, enabled, url) => {
  it.skipIf(!enabled)("seeds an empty household on first read", async () => {
    const target = url();
    if (name === "postgres") {
      const { default: pg } = await import("pg");
      const client = new pg.Client(target);
      await client.connect();
      await client.query(
        "DROP TABLE IF EXISTS temperance_state, kysely_migration, kysely_migration_lock",
      );
      await client.end();
    }
    const { state, revision } = await open(target).read();
    expect(revision).toBe(1);
    expect(state).toEqual(emptyState());
  });

  it.skipIf(!enabled)(
    "rejects stale revisions (compare-and-swap)",
    async () => {
      const repo = open(url());
      const { state, revision } = await repo.read();
      expect(await repo.commit(state, revision)).toBe(true);
      expect(await repo.commit(state, revision)).toBe(false);
      expect((await repo.read()).revision).toBe(revision + 1);
    },
  );

  it.skipIf(!enabled)(
    "serializes concurrent mutations from independent connections",
    async () => {
      const target = url();
      const a = open(target),
        b = open(target);
      const before = (await a.read()).state.profiles.length;
      const saved = await Promise.all(
        ["A", "B", "C", "D", "E", "F"].map((suffix, n) =>
          mutate(
            n % 2 ? a : b,
            (s) =>
              saveProfile(s, { name: "Storage " + suffix }).profiles.at(-1)!.id,
          ),
        ),
      );
      const after = (await open(target).read()).state;
      expect(after.profiles).toHaveLength(before + 6);
      expect(new Set(after.profiles.map((p) => p.id)).size).toBe(
        after.profiles.length,
      );
      for (const id of saved) await mutate(a, (s) => deleteProfile(s, id));
      expect((await b.read()).state.profiles).toHaveLength(before);
    },
  );
});

describe("SQLite", () => {
  it("adopts a database created before migrations existed", async () => {
    const path = join(dir, "legacy.sqlite3");
    const legacy = new DatabaseSync(path);
    legacy.exec(
      "CREATE TABLE temperance_state (id INTEGER PRIMARY KEY CHECK(id=1), revision BIGINT NOT NULL, body TEXT NOT NULL)",
    );
    legacy
      .prepare("INSERT INTO temperance_state VALUES(1,7,?)")
      .run(JSON.stringify({ ...emptyState(), paused: true }));
    legacy.close();
    const { state, revision } = await open("sqlite:" + path).read();
    expect(revision).toBe(7);
    expect(state.paused).toBe(true);
  });
  it("creates the data directory", async () => {
    const path = join(dir, "nested", "deeper", "t.sqlite3");
    expect((await open("file:" + path).read()).revision).toBe(1);
  });
});

describe("configuration", () => {
  it("chooses the driver from the URL and rejects others", () => {
    expect(backend("postgres://u:p@db/temperance")).toBe("postgres");
    expect(backend("postgresql://db/temperance")).toBe("postgres");
    expect(backend("sqlite:///var/lib/temperance.db")).toBe("sqlite");
    expect(backend("file:data/temperance.sqlite3")).toBe("sqlite");
    expect(backend("/data/temperance.db")).toBe("sqlite");
    for (const other of ["libsql://family.turso.io", "https://db.example"])
      expect(() => backend(other)).toThrow(/sqlite:<path> or postgres/);
    expect(repositoryFor("postgres://db/t")).toBeInstanceOf(KyselyRepository);
  });
  it("defaults to SQLite in the data directory, never /tmp", () => {
    expect(databaseUrl({})).toBe(
      `sqlite:${process.cwd()}/data/temperance.sqlite3`,
    );
    expect(dataDir({ TEMPERANCE_DATA_DIR: "/var/lib/temperance" })).toBe(
      "/var/lib/temperance",
    );
    expect(databaseUrl({ TEMPERANCE_DATA_DIR: "/var/lib/temperance" })).toBe(
      "sqlite:/var/lib/temperance/temperance.sqlite3",
    );
    expect(databaseUrl({ TEMPERANCE_DATABASE_URL: "postgres://db/t" })).toBe(
      "postgres://db/t",
    );
  });
  it("caches the repository per URL", () => {
    const previous = process.env.TEMPERANCE_DATABASE_URL;
    process.env.TEMPERANCE_DATABASE_URL = "sqlite:" + join(dir, "env.db");
    const first = repository();
    expect(repository()).toBe(first);
    process.env.TEMPERANCE_DATABASE_URL = "sqlite:" + join(dir, "env2.db");
    expect(repository()).not.toBe(first);
    process.env.TEMPERANCE_DATABASE_URL = previous;
  });
  it("retries optimistic conflicts and reports exhaustion", async () => {
    const repo: Repository = new TestRepository();
    await expect(
      mutate({ read: repo.read.bind(repo), commit: async () => false }, (s) => {
        s.paused = !s.paused;
      }),
    ).rejects.toThrow(/Concurrent/);
  });
});
