import { emptyState, type State } from "./model";
export interface Repository {
  read(): Promise<{ state: State; revision: number }>;
  commit(state: State, revision: number): Promise<boolean>;
}
// libSQL's documented HTTP pipeline protocol keeps the service independent of
// native SQLite binaries, filesystem persistence, and WebSocket shims.
class DatabaseError extends Error {
  constructor(
    code: string,
    public missingTable: boolean,
  ) {
    super("Database SQL error: " + code);
  }
}
export class SQLRepository implements Repository {
  private endpoint: string;
  constructor(
    url: string,
    private authToken?: string,
  ) {
    const parsed = new URL(url.replace(/^libsql:/, "https:"));
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      (parsed.protocol === "http:" &&
        !["localhost", "127.0.0.1"].includes(parsed.hostname))
    )
      throw new Error("Remote database endpoints require HTTPS");
    this.endpoint = parsed.origin + "/v2/pipeline";
  }
  private async execute(sql: string, args: (string | number)[] = []) {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.authToken
          ? { Authorization: "Bearer " + this.authToken }
          : {}),
      },
      body: JSON.stringify({
        requests: [
          {
            type: "execute",
            stmt: {
              sql,
              args: args.map((value) =>
                typeof value === "number"
                  ? { type: "integer", value: String(value) }
                  : { type: "text", value },
              ),
              want_rows: true,
            },
          },
          { type: "close" },
        ],
      }),
      cache: "no-store",
      // Never forward the database token to a redirect target. Workers do not
      // support redirect: "error", so redirects surface as non-2xx responses.
      redirect: "manual",
    });
    if (!response.ok) throw new Error("Database HTTP request failed");
    const value = await response.json();
    const result = value.results?.[0];
    if (result?.type === "error")
      throw new DatabaseError(
        result.error?.code ?? "unknown",
        /no such table/i.test(result.error?.message ?? ""),
      );
    if (result?.type !== "ok" || !result.response?.result)
      throw new Error("Invalid database response");
    return result.response.result as {
      cols: { name: string }[];
      rows: { type: string; value?: string }[][];
      affected_row_count: number;
    };
  }
  async prepare() {
    await this.execute(
      "CREATE TABLE IF NOT EXISTS temperance_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, body TEXT NOT NULL)",
    );
    await this.execute("INSERT OR IGNORE INTO temperance_state VALUES(1,1,?)", [
      JSON.stringify(emptyState()),
    ]);
  }
  async read() {
    let result;
    try {
      result = await this.execute(
        "SELECT revision,body FROM temperance_state WHERE id=1",
      );
    } catch (error) {
      if (error instanceof DatabaseError && error.missingTable) {
        await this.prepare();
        result = await this.execute(
          "SELECT revision,body FROM temperance_state WHERE id=1",
        );
      } else throw error;
    }
    return {
      revision: Number(result.rows[0][0].value),
      state: JSON.parse(result.rows[0][1].value!) as State,
    };
  }
  async commit(state: State, revision: number) {
    const result = await this.execute(
      "UPDATE temperance_state SET body=?,revision=revision+1 WHERE id=1 AND revision=?",
      [JSON.stringify(state), revision],
    );
    return Number(result.affected_row_count) === 1;
  }
}
const SCHEMA =
  "CREATE TABLE IF NOT EXISTS temperance_state (id INTEGER PRIMARY KEY CHECK(id=1), revision BIGINT NOT NULL, body TEXT NOT NULL)";
type SQLite = import("node:sqlite").DatabaseSync;
// Embedded SQLite file for single-host deployments (Docker, Raspberry Pi).
// Concurrent processes coordinate through the same revision compare-and-swap.
export class SQLiteRepository implements Repository {
  private db?: Promise<SQLite>;
  constructor(private path: string) {}
  private open() {
    this.db ??= Promise.all([
      import("node:sqlite"),
      import("node:fs"),
      import("node:path"),
    ]).then(([{ DatabaseSync }, fs, path]) => {
      if (this.path !== ":memory:")
        fs.mkdirSync(path.dirname(this.path), { recursive: true });
      const db = new DatabaseSync(this.path);
      db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
      db.exec(SCHEMA);
      db.prepare("INSERT OR IGNORE INTO temperance_state VALUES(1,1,?)").run(
        JSON.stringify(emptyState()),
      );
      return db;
    });
    return this.db;
  }
  async read() {
    const row = (await this.open())
      .prepare("SELECT revision,body FROM temperance_state WHERE id=1")
      .get() as { revision: number; body: string };
    return { revision: Number(row.revision), state: JSON.parse(row.body) };
  }
  async commit(state: State, revision: number) {
    const result = (await this.open())
      .prepare(
        "UPDATE temperance_state SET body=?,revision=revision+1 WHERE id=1 AND revision=?",
      )
      .run(JSON.stringify(state), revision);
    return Number(result.changes) === 1;
  }
  async close() {
    if (this.db) (await this.db).close();
    this.db = undefined;
  }
}
type Pool = import("pg").Pool;
const pools = new Map<string, Promise<Pool>>();
export class PostgresRepository implements Repository {
  constructor(private url: string) {}
  private pool() {
    let pool = pools.get(this.url);
    if (!pool) {
      pool = import("pg").then(async ({ default: pg }) => {
        const created = new pg.Pool({ connectionString: this.url, max: 5 });
        await created.query(SCHEMA);
        await created.query(
          "INSERT INTO temperance_state VALUES(1,1,$1) ON CONFLICT (id) DO NOTHING",
          [JSON.stringify(emptyState())],
        );
        return created;
      });
      pool.catch(() => pools.delete(this.url));
      pools.set(this.url, pool);
    }
    return pool;
  }
  async read() {
    const { rows } = await (
      await this.pool()
    ).query("SELECT revision,body FROM temperance_state WHERE id=1");
    return {
      revision: Number(rows[0].revision),
      state: JSON.parse(rows[0].body),
    };
  }
  async commit(state: State, revision: number) {
    const result = await (
      await this.pool()
    ).query(
      "UPDATE temperance_state SET body=$1,revision=revision+1 WHERE id=1 AND revision=$2",
      [JSON.stringify(state), revision],
    );
    return result.rowCount === 1;
  }
  async close() {
    const pool = pools.get(this.url);
    pools.delete(this.url);
    if (pool) await (await pool).end();
  }
}
export function backend(url: string) {
  if (/^postgres(ql)?:\/\//.test(url)) return "postgres";
  if (/^(sqlite|file):/.test(url) || /\.(db|sqlite3?)$/.test(url))
    return "sqlite";
  return "libsql";
}
export function repositoryFor(url: string, token?: string): Repository {
  switch (backend(url)) {
    case "postgres":
      return new PostgresRepository(url);
    case "sqlite":
      return new SQLiteRepository(url.replace(/^(sqlite|file):(\/\/)?/, ""));
    default:
      return new SQLRepository(url, token);
  }
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
let cached: { key: string; repo: Repository } | undefined;
export function repository() {
  const url = process.env.TEMPERANCE_DATABASE_URL;
  if (!url)
    throw new Error(
      "Configure TEMPERANCE_DATABASE_URL with persistent SQLite, PostgreSQL, or libSQL storage",
    );
  const key = url + "\n" + (process.env.TEMPERANCE_DATABASE_TOKEN ?? "");
  if (cached?.key !== key)
    cached = {
      key,
      repo: repositoryFor(url, process.env.TEMPERANCE_DATABASE_TOKEN),
    };
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
