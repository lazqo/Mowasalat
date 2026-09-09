/**
 * Applies the schema. Idempotent — every statement is `if not exists`, so
 * running it against an existing database is safe and is what a deploy does.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Sql } from "./sql.ts";

export async function migrate(sql: Sql): Promise<void> {
  const ddl = readFileSync(join(import.meta.dirname, "schema.sql"), "utf8");
  if (sql.exec) await sql.exec(ddl);
  else await sql.query(ddl);
}

/**
 * The tables that must never appear. Live movement belongs in memory with a
 * 60-second expiry (docs/PLAN.md §6.2), and a migration that quietly adds a
 * trip or ride-request table would turn this service into the movement database
 * we promised not to build. Checked by a test rather than trusted.
 */
export const FORBIDDEN_TABLES = ["trip", "trip_progress", "ride_request", "position", "location"];
