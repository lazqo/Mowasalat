/**
 * A real Postgres for every test.
 *
 * PGlite is the Postgres engine compiled to WebAssembly, so these tests run the
 * same SQL the deployed database will, with no server to install and nothing
 * shared between tests. The identical schema and queries were also exercised
 * against a real Postgres 16 server while this was written.
 */
import { PGlite } from "@electric-sql/pglite";
import { Admin } from "../../src/admin.ts";
import { migrate } from "../../src/db/migrate.ts";
import { seedFromPack } from "../../src/db/seed.ts";
import type { Sql } from "../../src/db/sql.ts";

export const JO_POLICY = {
  vouchingAuthorities: ["drivers_committee", "hub_supervisor", "field_ops"],
  tier2Thresholds: { trips: 12, distinct_days: 5 },
};

export type TestDb = {
  sql: Sql;
  admin: Admin;
  /** A fresh Admin over the same database — what a restart actually leaves you. */
  restart(): Admin;
  close(): Promise<void>;
};

export async function freshDb(options: { seed?: boolean } = {}): Promise<TestDb> {
  const pglite = new PGlite();
  const sql: Sql = {
    query: (text, params) => pglite.query(text, params) as never,
    // PGlite always uses the extended protocol, which is one statement per
    // call, so migrations go through exec.
    exec: async (text) => {
      await pglite.exec(text);
    },
  };

  if (options.seed === false) await migrate(sql);
  else await seedFromPack(sql, "countries/jo");

  const make = () => new Admin(sql, "JO", "test-salt", JO_POLICY);
  return { sql, admin: make(), restart: make, close: () => pglite.close() };
}

export async function withDb(fn: (db: TestDb) => Promise<void>): Promise<void> {
  const db = await freshDb();
  try {
    await fn(db);
  } finally {
    await db.close();
  }
}
