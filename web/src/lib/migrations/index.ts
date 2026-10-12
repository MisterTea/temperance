import type { Migration } from "kysely/migration";
import * as state from "./001_state";

export interface Tables {
  temperance_state: {
    id: number;
    // PostgreSQL BIGINT arrives as a string.
    revision: number | string;
    body: string;
  };
}

// Imported statically so bundled servers carry their migrations.
export const migrations: Record<string, Migration> = {
  "001_state": state,
};
