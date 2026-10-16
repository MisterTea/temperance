import {
  Kysely,
  PostgresDialect,
  SqliteDialect,
  type Dialect,
  type SqliteDatabase,
} from "kysely";
import { Migrator } from "kysely/migration";
import { migrations, type Tables } from "./migrations";
import { emptyState, type State } from "./model";
export interface Repository {
  read(): Promise<{ state: State; revision: number }>;
  commit(state: State, revision: number): Promise<boolean>;
}
// NORMAL is crash-safe in WAL mode and skips a flush per commit; a power cut can lose the last commit.
const PRAGMAS =
  "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;";
// node:sqlite behind Kysely's SQLite driver interface; better-sqlite3 already matches it.
function sqliteDatabase(path: string): SqliteDatabase {
  let db: import("node:sqlite").DatabaseSync;
  try {
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    db = new DatabaseSync(path);
  } catch {
    const { createRequire } = process.getBuiltinModule("node:module");
    const BetterSqlite = createRequire(process.cwd() + "/")("better-sqlite3");
    const fallback: SqliteDatabase & { exec(sql: string): void } =
      new BetterSqlite(path);
    fallback.exec(PRAGMAS);
    return fallback;
  }
  db.exec(PRAGMAS);
  return {
    close: () => db.close(),
    prepare(sql) {
      const statement = db.prepare(sql);
      type Params = import("node:sqlite").SQLInputValue[];
      return {
        reader: statement.columns().length > 0,
        all: (params) => statement.all(...(params as Params)),
        run: (params) => statement.run(...(params as Params)),
        iterate: (params) => statement.iterate(...(params as Params)),
      };
    },
  };
}
/** One schema and one set of queries for SQLite (default) and PostgreSQL. */
export class KyselyRepository implements Repository {
  private db?: Promise<Kysely<Tables>>;
  constructor(private dialect: () => Promise<Dialect>) {}
  private open() {
    this.db ??= (async () => {
      const db = new Kysely<Tables>({ dialect: await this.dialect() });
      const { error } = await new Migrator({
        db,
        provider: { getMigrations: async () => migrations },
      }).migrateToLatest();
      if (error) throw error;
      await db
        .insertInto("temperance_state")
        .values({ id: 1, revision: 1, body: JSON.stringify(emptyState()) })
        .onConflict((oc) => oc.column("id").doNothing())
        .execute();
      return db;
    })();
    this.db.catch(() => (this.db = undefined));
    return this.db;
  }
  async read() {
    const row = await (
      await this.open()
    )
      .selectFrom("temperance_state")
      .select(["revision", "body"])
      .where("id", "=", 1)
      .executeTakeFirstOrThrow();
    return {
      revision: Number(row.revision),
      state: JSON.parse(row.body) as State,
    };
  }
  async commit(state: State, revision: number) {
    const result = await (
      await this.open()
    )
      .updateTable("temperance_state")
      .set((eb) => ({
        body: JSON.stringify(state),
        revision: eb("revision", "+", 1),
      }))
      .where("id", "=", 1)
      .where("revision", "=", revision)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }
  async close() {
    const db = this.db;
    this.db = undefined;
    if (db) await (await db).destroy();
  }
}
export function backend(url: string) {
  if (/^postgres(ql)?:\/\//.test(url)) return "postgres";
  if (/^(sqlite|file):/.test(url) || /\.(db|sqlite3?)$/.test(url))
    return "sqlite";
  throw new Error(
    "TEMPERANCE_DATABASE_URL must be sqlite:<path> or postgres://…",
  );
}
export function repositoryFor(url: string) {
  if (backend(url) === "postgres")
    return new KyselyRepository(async () => {
      const { default: pg } = await import("pg");
      return new PostgresDialect({
        pool: new pg.Pool({ connectionString: url, max: 5 }),
      });
    });
  const path = url.replace(/^(sqlite|file):(\/\/)?/, "");
  return new KyselyRepository(async () => {
    if (path !== ":memory:") {
      const fs = process.getBuiltinModule("node:fs");
      fs.mkdirSync(process.getBuiltinModule("node:path").dirname(path), {
        recursive: true,
      });
    }
    return new SqliteDialect({ database: sqliteDatabase(path) });
  });
}
// Only tests instantiate this adapter. Production never falls back to memory or /tmp.
export class TestRepository implements Repository {
  private value = emptyState();
  private revision = 1;
  async read() {
    return { state: structuredClone(this.value), revision: this.revision };
  }
  async commit(state: State, revision: number) {
    if (revision !== this.revision) return false;
    this.value = structuredClone(state);
    this.revision++;
    return true;
  }
}
/** Persistent data (database, gateway key): TEMPERANCE_DATA_DIR, else ./data next to the app. */
export function dataDir(env: Record<string, string | undefined> = process.env) {
  return env.TEMPERANCE_DATA_DIR || process.cwd() + "/data";
}
export function databaseUrl(
  env: Record<string, string | undefined> = process.env,
) {
  return (
    env.TEMPERANCE_DATABASE_URL || `sqlite:${dataDir(env)}/temperance.sqlite3`
  );
}
let cached: { url: string; repo: Repository } | undefined;
export function repository() {
  const url = databaseUrl();
  if (cached?.url !== url) cached = { url, repo: repositoryFor(url) };
  return cached.repo;
}
export async function mutate<T>(
  repo: Repository,
  operation: (state: State) => T | Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const { state, revision } = await repo.read();
    const previous = JSON.stringify(state);
    const result = await operation(state);
    if (
      JSON.stringify(state) === previous ||
      (await repo.commit(state, revision))
    )
      return result;
  }
  throw new Error("Concurrent update conflict; please retry");
}
