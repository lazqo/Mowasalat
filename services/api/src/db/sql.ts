/**
 * A deliberately narrow database interface.
 *
 * Everything below talks through this, so the same repository code runs against
 * a real Postgres pool in production and against whatever a test wants to hand
 * it. It is also the seam that keeps `pg` from spreading through the codebase.
 */
export type Row = Record<string, unknown>;

export interface Sql {
  query<T = Row>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /**
   * Runs a script of several statements. Drivers differ here: a pooled
   * Postgres client accepts multiple statements in one `query`, while clients
   * that always use the extended protocol need a separate call. Only migrations
   * need it.
   */
  exec?(text: string): Promise<void>;
}

/** Runs `fn` inside a transaction, rolling back if it throws. */
export async function transaction<T>(sql: Sql, fn: (tx: Sql) => Promise<T>): Promise<T> {
  await sql.query("begin");
  try {
    const result = await fn(sql);
    await sql.query("commit");
    return result;
  } catch (err) {
    await sql.query("rollback").catch(() => {});
    throw err;
  }
}
