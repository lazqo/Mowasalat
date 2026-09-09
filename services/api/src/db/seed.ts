/**
 * Seeds a database from a country pack.
 *
 * The pack in git is the reviewable, versioned definition of a country; the
 * database is the runtime truth ops edits day to day (docs/PLAN.md §11). This
 * moves the first into the second, and is safe to re-run: everything upserts.
 *
 *   node services/api/src/db/seed.ts countries/jo
 */
import { Pack } from "../pack.ts";
import { migrate } from "./migrate.ts";
import { NetworkStore } from "./network.ts";
import type { Sql } from "./sql.ts";

export async function seedFromPack(sql: Sql, packDir: string): Promise<{ routes: number; destinations: number }> {
  const pack = new Pack(packDir);
  const config = pack.config as Record<string, unknown>;
  const code = config.code as string;

  await migrate(sql);
  const network = new NetworkStore(sql, code);

  await network.upsertCountry({
    code,
    nameAr: (config.nameAr as string) ?? code,
    locale: config.locale as string,
    digits: config.digits as string,
    phonePrefix: config.phone_prefix as string,
    bounds: config.bounds,
    // Policy travels with the country rather than living in code.
    policy: {
      residency_region: config.residency_region,
      vouching_authorities: config.vouching_authorities,
      plate_visibility: config.plate_visibility,
      tier2_thresholds: config.tier2_thresholds,
      default_corridor_width_m: config.default_corridor_width_m,
      k_anonymity_min: config.k_anonymity_min,
      remaining_bucket_m: config.remaining_bucket_m,
      retention_hours: config.retention_hours,
      otp_channels: config.otp_channels,
      strings: config.strings,
    },
  });

  const routes = pack.listRoutes();
  let destinations = 0;

  for (const route of routes) {
    // Destinations are upserted first so the line can reference them. Their
    // coordinates stay null until Phase 0 supplies them.
    for (const d of route.servedDestinations) {
      await network.upsertDestination({ id: d.id, countryCode: code, nameAr: d.nameAr });
      destinations++;
    }
    await network.saveRoute(route);
  }

  return { routes: routes.length, destinations };
}

if (process.argv[1]?.endsWith("seed.ts")) {
  const packDir = process.argv[2] ?? "countries/jo";
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(2);
  }
  const { createPool } = await import("./pool.ts");
  const pool = createPool(url);
  try {
    const result = await seedFromPack(pool, packDir);
    console.log(`seeded ${result.routes} lines and ${result.destinations} destinations from ${packDir}`);
  } finally {
    await pool.end();
  }
}
