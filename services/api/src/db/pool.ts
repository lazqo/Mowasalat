import pg from "pg";
import type { Sql } from "./sql.ts";

/** A Postgres pool that satisfies the narrow `Sql` interface. */
export function createPool(connectionString: string): Sql & { end(): Promise<void> } {
  const pool = new pg.Pool({ connectionString, max: 10 });
  return {
    query: (text, params) => pool.query(text, params) as never,
    exec: async (text) => {
      await pool.query(text);
    },
    end: () => pool.end(),
  };
}
