import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

const url = process.env.TEMPERANCE_DATABASE_URL ?? "";
if (/^postgres(ql)?:\/\//.test(url)) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query(
    "DROP TABLE IF EXISTS temperance_state, kysely_migration, kysely_migration_lock",
  );
  await client.end();
} else if (url.startsWith("sqlite:")) {
  const path = url.replace(/^sqlite:(\/\/)?/, "");
  mkdirSync(dirname(path), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(path + suffix, { force: true });
} else {
  throw new Error("E2E runs require a sqlite: or postgres:// database URL");
}
