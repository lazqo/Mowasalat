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
import { Onboarding } from "../../src/onboarding.ts";
import { DevelopmentOtpProvider } from "../../src/otp/provider.ts";
import { normalizePhone, rulesFor } from "../../src/phone.ts";
import { DEFAULT_LIMITS, type OtpLimits } from "../../src/otp/service.ts";
import { migrate } from "../../src/db/migrate.ts";
import { seedFromPack } from "../../src/db/seed.ts";
import type { Sql } from "../../src/db/sql.ts";

export const JO_POLICY = {
  vouchingAuthorities: ["drivers_committee", "hub_supervisor", "field_ops"],
  tier2Thresholds: { trips: 12, distinct_days: 5 },
};

export const JO_RULES = rulesFor({ phone_prefix: "+962", mobile_pattern: "^7\\d{8}$" });
export const SECRET = "test-server-secret";

export type TestDb = {
  sql: Sql;
  admin: Admin;
  onboarding: Onboarding;
  /** The development provider, so a test can read the code that was "sent". */
  otp: DevelopmentOtpProvider;
  /** A fresh Admin over the same database — what a restart actually leaves you. */
  restart(): Admin;
  /** Sign-up end to end: number, code, account. Returns the bearer token. */
  signIn(phone: string): Promise<{ driverToken: string; driverId: string }>;
  close(): Promise<void>;
};

const adapt = (pglite: PGlite): Sql => ({
  query: (text, params) => pglite.query(text, params) as never,
  // PGlite always uses the extended protocol, which is one statement per call,
  // so migrations go through exec.
  exec: async (text) => {
    await pglite.exec(text);
  },
});

/**
 * Building the schema and seeding the pilot lines takes about two seconds. The
 * suite wants a hundred isolated databases, so it is done once and the result
 * cloned, which is roughly five times faster per test and keeps every test fully
 * isolated.
 */
const templates = new Map<string, Promise<Blob>>();

function template(seeded: boolean): Promise<Blob> {
  const key = seeded ? "seeded" : "empty";
  let existing = templates.get(key);
  if (!existing) {
    existing = (async () => {
      const pglite = new PGlite();
      const sql = adapt(pglite);
      if (seeded) await seedFromPack(sql, "countries/jo");
      else await migrate(sql);
      const dump = await pglite.dumpDataDir("none");
      await pglite.close();
      return dump;
    })();
    templates.set(key, existing);
  }
  return existing;
}

export async function freshDb(
  options: { seed?: boolean; limits?: Partial<OtpLimits>; now?: () => number } = {},
): Promise<TestDb> {
  const pglite = new PGlite({ loadDataDir: await template(options.seed !== false) });
  const sql = adapt(pglite);

  const make = () => new Admin(sql, "JO", SECRET, JO_POLICY);
  const admin = make();
  const otp = new DevelopmentOtpProvider("test");
  const onboarding = new Onboarding({
    sql,
    admin,
    provider: otp,
    secret: SECRET,
    rules: JO_RULES,
    countryCode: "JO",
    now: options.now,
    limits: options.limits
      ? { ...DEFAULT_LIMITS, ...options.limits }
      : undefined,
  });

  async function signIn(phone: string) {
    const challenge = await onboarding.requestCode(phone);
    const code = otp.peek(normalizePhone(phone, JO_RULES))!;
    const session = await onboarding.verify(challenge.challengeId, code, phone);
    return { driverToken: session.driverToken, driverId: session.driver.id };
  }

  return { sql, admin, onboarding, otp, restart: make, signIn, close: () => pglite.close() };
}

export async function withDb(fn: (db: TestDb) => Promise<void>): Promise<void> {
  const db = await freshDb();
  try {
    await fn(db);
  } finally {
    await db.close();
  }
}

/**
 * A running API over a fresh database, with driver sign-in wired in. Returns a
 * signed-in driver's bearer token, because almost every driver endpoint needs
 * one.
 */
export async function freshApi(
  opts: {
    adminToken?: string;
    streamIntervalMs?: number;
    heartbeatMs?: number;
    webOrigins?: string;
  } = {},
) {
  const { createApi } = await import("../../src/http.ts");
  const db = await freshDb();
  const api = createApi(
    { code: "JO", remainingBucketM: 250, kAnonymityMin: 4 },
    {
      admin: db.admin,
      onboarding: db.onboarding,
      adminToken: opts.adminToken ?? "test-token-abcdefghijklmnop",
      streamIntervalMs: opts.streamIntervalMs,
      heartbeatMs: opts.heartbeatMs,
      webOrigins: opts.webOrigins,
      // What the real server serves. Without it a client reads an undefined
      // bucket band, which is a bug worth meeting in a test rather than in
      // Irbid.
      countryInfo: {
        code: "JO",
        locale: "ar-JO",
        digits: "eastern",
        phonePrefix: "+962",
        remainingBucketM: 250,
        kAnonymityMin: 4,
      },
    },
  );
  await new Promise<void>((r) => api.server.listen(0, r));
  const base = `http://127.0.0.1:${(api.server.address() as { port: number }).port}`;

  return {
    ...db,
    base,
    api,
    /** Signs a driver in and puts him on a line, the way ops would. */
    async driverOn(routeId: string, phone = "0790123456") {
      const session = await db.signIn(phone);
      await db.admin.assignRoute(session.driverId, routeId);
      return session;
    },
    async close() {
      // Idle keep-alive sockets from earlier requests would otherwise hold
      // server.close() open until they time out.
      api.server.closeAllConnections();
      await new Promise((r) => api.server.close(r));
      await db.close();
    },
  };
}
