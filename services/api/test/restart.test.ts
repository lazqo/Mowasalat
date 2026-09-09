/**
 * What a restart must and must not keep.
 *
 * A "restart" here is a fresh Admin over the same database, which is exactly
 * what the process holds after it comes back up, alongside a brand new Service
 * whose live state started empty.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withDb } from "./helpers/db.ts";
import { FORBIDDEN_TABLES } from "../src/db/migrate.ts";
import { Service, type CountryPolicy } from "../src/service.ts";
import type { LatLng } from "../../../packages/corridor/src/types.ts";

const JO: CountryPolicy = { code: "JO", remainingBucketM: 250, kAnonymityMin: 4 };
const ROUTE = "jo-irbid-malka";
const OTHER = "jo-irbid-sama-alrousan";

test("driver-to-route assignments survive a restart", async () => {
  await withDb(async (db) => {
    const driver = await db.admin.createDriver("+962790000001");
    await db.admin.assignRoute(driver.id, ROUTE);
    await db.admin.assignRoute(driver.id, OTHER);

    const afterRestart = db.restart();
    const reloaded = await afterRestart.getDriver(driver.id);

    assert.deepEqual(reloaded.routeIds.sort(), [ROUTE, OTHER].sort());
    const routes = await afterRestart.routesForDriver(driver.id);
    assert.equal(routes.length, 2, "he can still be offered both his lines");
    assert.ok(routes.some((r) => r.nameAr === "إربد – ملكا"));
  });
});

test("unassigning a line survives a restart too", async () => {
  await withDb(async (db) => {
    const driver = await db.admin.createDriver("+962790000002");
    await db.admin.assignRoute(driver.id, ROUTE);
    await db.admin.assignRoute(driver.id, OTHER);
    await db.admin.unassignRoute(driver.id, OTHER);

    const reloaded = await db.restart().getDriver(driver.id);
    assert.deepEqual(reloaded.routeIds, [ROUTE]);
  });
});

test("a driver assigned to several lines still picks exactly one to drive", async () => {
  await withDb(async (db) => {
    const driver = await db.admin.createDriver("+962790000003");
    await db.admin.assignRoute(driver.id, ROUTE);
    await db.admin.assignRoute(driver.id, OTHER);

    const afterRestart = db.restart();
    const offered = await afterRestart.routesForDriver(driver.id);
    assert.equal(offered.length, 2, "both lines are offered");

    // A trip is one line and one direction, which is a live decision the
    // database plays no part in (§5.4).
    const service = new Service(JO);
    const started = await service.startTrip(offered[0].id, 0);
    await service.updateProgress(started.tripToken, offered[0].id, 0, 8_000, 1, 40);

    assert.equal((await service.busesOn(offered[0].id, 0)).length, 1);
    assert.equal((await service.busesOn(offered[1].id, 0)).length, 0, "the other line carries no trip");
    assert.equal((await service.busesOn(offered[0].id, 1)).length, 0, "nor the other direction");
  });
});

test("route and corridor definitions survive a restart", async () => {
  await withDb(async (db) => {
    await db.admin.setWidth(ROUTE, 1_150);
    const before = await db.admin.getRoute(ROUTE);
    const [origin, destination] = before.corridor.zones;
    await db.admin.setZones(ROUTE, [
      origin,
      { nameAr: "قرية وسطى", kind: "intermediate", centre: { lat: 32.61, lng: 35.797 }, radiusM: 600 },
      destination,
    ]);
    await db.admin.addWaitPoint(ROUTE, {
      nameAr: "الدوار",
      location: { lat: 32.62, lng: 35.79 },
      zoneSeq: 1,
    });

    const after = await db.restart().getRoute(ROUTE);

    assert.equal(after.nameAr, "إربد – ملكا", "the line keeps its identity");
    assert.equal(after.corridor.widthM, 1_150);
    assert.deepEqual(after.corridor.zones.map((z) => z.seq), [0, 1, 2]);
    assert.equal(after.corridor.zones[1].nameAr, "قرية وسطى");
    assert.equal(after.corridor.zones[2].kind, "destination");
    assert.equal(after.waitPoints.length, 1);
    assert.equal(after.waitPoints[0].nameAr, "الدوار");
    assert.deepEqual(
      after.corridor.referencePaths,
      before.corridor.referencePaths,
      "the geometry came back unchanged",
    );
  });
});

test("a corridor built from recorded drives survives a restart", async () => {
  await withDb(async (db) => {
    const drive: LatLng[] = Array.from({ length: 50 }, (_, i) => ({
      lat: 32.5556 + (32.669 - 32.5556) * (i / 49),
      lng: 35.8497 + (35.744 - 35.8497) * (i / 49),
    }));
    const { widthM } = await db.admin.importTraces(ROUTE, [drive]);

    const after = await db.restart().getRoute(ROUTE);
    assert.equal(after.provisional, false, "it is no longer placeholder geometry");
    assert.equal(after.corridor.widthM, widthM);
    assert.ok(after.corridor.referencePaths[0].length >= 2);
  });
});

test("verification tier and who vouched survive a restart", async () => {
  await withDb(async (db) => {
    const vouched = await db.admin.createDriver("+962790000004");
    await db.admin.vouch(vouched.id, "drivers_committee");

    const proven = await db.admin.createDriver("+962790000005");
    await db.admin.recordProvenTrips(proven.id, 12, 5);

    const blocked = await db.admin.createDriver("+962790000006");
    await db.admin.setStatus(blocked.id, "blocked");

    const afterRestart = db.restart();

    const v = await afterRestart.getDriver(vouched.id);
    assert.equal(v.tier, 1);
    assert.equal(v.vouchedBy, "drivers_committee");

    const p = await afterRestart.getDriver(proven.id);
    assert.equal(p.tier, 2, "trust earned by driving is not forgotten");
    assert.equal(p.provenTrips, 12);
    assert.equal(p.provenDays, 5);

    const b = await afterRestart.getDriver(blocked.id);
    assert.equal(b.status, "blocked");
    assert.deepEqual(await afterRestart.routesForDriver(blocked.id), []);
  });
});

test("a driver is still found by his number after a restart, which is still not stored", async () => {
  await withDb(async (db) => {
    const created = await db.admin.createDriver("+962790000007");
    const afterRestart = db.restart();

    assert.equal((await afterRestart.findByPhone("+962790000007"))?.id, created.id);

    const { rows } = await db.sql.query<{ phone_hash: string; phone_masked: string }>(
      "select phone_hash, phone_masked from driver where id = $1",
      [created.id],
    );
    assert.match(rows[0].phone_hash, /^[0-9a-f]{64}$/);
    assert.equal(rows[0].phone_masked, "••• 007");
    assert.doesNotMatch(JSON.stringify(rows[0]), /790000007/, "the number is nowhere in the row");
  });
});

test("live bus positions do NOT survive a restart", async () => {
  await withDb(async (db) => {
    const driver = await db.admin.createDriver("+962790000008");
    await db.admin.assignRoute(driver.id, ROUTE);

    const before = new Service(JO);
    const started = await before.startTrip(ROUTE, 0);
    await before.updateProgress(started.tripToken, ROUTE, 0, 8_000, 2, 40);
    assert.equal((await before.busesOn(ROUTE, 0)).length, 1);

    // The process comes back: durable state is reloaded, live state starts empty.
    const afterRestart = db.restart();
    const after = new Service(JO);

    assert.equal((await after.busesOn(ROUTE, 0)).length, 0, "no bus was resurrected");
    assert.equal((await after.liveCounts()).trips, 0);
    assert.equal((await after.liveCounts()).requests, 0);
    assert.deepEqual(await after.findBuses(ROUTE, 0, 5_000, 1), []);
    assert.equal(await after.pinsForTrip(started.tripToken), null, "the old trip token is worthless");

    // But the roster it belonged to is intact.
    assert.deepEqual((await afterRestart.getDriver(driver.id)).routeIds, [ROUTE]);
  });
});

test("waiting ride requests do not survive a restart either", async () => {
  await withDb(async () => {
    const before = new Service(JO);
    await before.createRequest(ROUTE, 0, "jo-malka", 5_000, 1);
    assert.equal((await before.liveCounts()).requests, 1);

    const after = new Service(JO);
    assert.equal((await after.liveCounts()).requests, 0);
  });
});

test("the schema has no table for trips, requests or positions", async () => {
  await withDb(async (db) => {
    const { rows } = await db.sql.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const tables = rows.map((r) => r.table_name);

    for (const forbidden of FORBIDDEN_TABLES) {
      assert.ok(
        !tables.includes(forbidden),
        `"${forbidden}" exists; live movement must never be persisted (§6.2)`,
      );
    }
    assert.ok(tables.includes("route"), "sanity: the durable tables are there");
    assert.ok(tables.includes("driver_route"));
  });
});

test("no persisted column anywhere holds a latitude or longitude for a person", async () => {
  await withDb(async (db) => {
    const { rows } = await db.sql.query<{ table_name: string; column_name: string }>(
      // Anchored on segment boundaries: a substring match would flag
      // vehicle.plate for containing "lat".
      `select table_name, column_name from information_schema.columns
        where table_schema = 'public'
          and column_name ~* '(^|_)(lat|latitude|lng|lon|longitude|coords?|position|location)(_|$)'`,
    );

    // Coordinates are allowed on infrastructure — a hub, a village, a zone
    // centre, a waiting point are public geography. They are never allowed on
    // anything describing a person or a journey.
    const infrastructure = new Set(["hub", "destination", "city", "route_zone", "wait_point"]);
    for (const r of rows) {
      assert.ok(
        infrastructure.has(r.table_name),
        `${r.table_name}.${r.column_name} looks like a coordinate on a non-infrastructure table`,
      );
    }

    const personal = ["driver", "vehicle", "driver_route"];
    const { rows: personalCols } = await db.sql.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'public' and table_name = any($1)`,
      [personal],
    );
    for (const c of personalCols) {
      assert.doesNotMatch(
        c.column_name,
        /(^|_)(lat|latitude|lng|lon|longitude|coords?|position|location)(_|$)/i,
        `${c.table_name}.${c.column_name} would locate a driver`,
      );
    }
  });
});

test("the schema file itself declares no trip or request table", async () => {
  // Belt and braces: catches a table added to the DDL but not yet migrated.
  const ddl = readFileSync(
    join(import.meta.dirname, "..", "src", "db", "schema.sql"),
    "utf8",
  ).toLowerCase();

  for (const forbidden of FORBIDDEN_TABLES) {
    assert.doesNotMatch(
      ddl,
      new RegExp(`create table (if not exists )?${forbidden}\\b`),
      `schema.sql creates "${forbidden}"`,
    );
  }
});
