import { sql, type Kysely } from "kysely";

// The whole household state is one JSON document guarded by a revision
// (compare-and-swap in mutate()). IF NOT EXISTS adopts pre-Kysely databases.
export async function up(db: Kysely<unknown>) {
  await db.schema
    .createTable("temperance_state")
    .ifNotExists()
    .addColumn("id", "integer", (c) => c.primaryKey().check(sql`id = 1`))
    .addColumn("revision", "bigint", (c) => c.notNull())
    .addColumn("body", "text", (c) => c.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>) {
  await db.schema.dropTable("temperance_state").execute();
}
