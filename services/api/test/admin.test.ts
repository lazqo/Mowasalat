import test from "node:test";
import assert from "node:assert/strict";
import { Admin, AdminError, InvalidRoute, NotFound } from "../src/admin.ts";
import { withDb } from "./helpers/db.ts";
import type { LatLng } from "../../../packages/corridor/src/types.ts";

const ROUTE = "jo-irbid-malka";

/** A throwaway database seeded from the real pack. */
function withAdmin(fn: (admin: Admin, restart: () => Admin) => Promise<void>): Promise<void> {
  return withDb((db) => fn(db.admin, db.restart));
}

test("the five pilot lines are listed", async () => {
  await withAdmin(async (admin) => {
    const routes = await admin.listRoutes();
    assert.equal(routes.length, 5);
    assert.ok(routes.some((r) => r.nameAr === "إربد – ملكا"));
    assert.ok(routes.every((r) => r.provisional), "all still awaiting Phase 0");
  });
});

test("an unknown line is reported, not invented", async () => {
  await withAdmin(async (admin) => {
    await assert.rejects(() => admin.getRoute("jo-nowhere"), NotFound);
  });
});

test("a widened corridor is readable again from the database", async () => {
  await withAdmin(async (admin, restart) => {
    await admin.setWidth(ROUTE, 1_200);
    assert.equal((await restart().getRoute(ROUTE)).corridor.widthM, 1_200);
  });
});

test("a width that would drop honest drivers offline is refused", async () => {
  await withAdmin(async (admin) => {
    // The failure the plan explicitly wants to avoid (§9.3).
    await assert.rejects(() => admin.setWidth(ROUTE, 50), InvalidRoute);
  });
});

test("an absurdly wide corridor is refused too", async () => {
  await withAdmin(async (admin) => {
    await assert.rejects(() => admin.setWidth(ROUTE, 20_000), InvalidRoute);
  });
});

test("a broken edit is never written", async () => {
  await withAdmin(async (admin, restart) => {
    const before = (await admin.getRoute(ROUTE)).corridor.widthM;
    await assert.rejects(() => admin.setWidth(ROUTE, 10), InvalidRoute);
    assert.equal((await restart().getRoute(ROUTE)).corridor.widthM, before);
  });
});

test("problems can be checked without saving", async () => {
  await withAdmin(async (admin) => {
    const route = await admin.getRoute(ROUTE);
    const problems = admin.check({ ...route, corridor: { ...route.corridor, widthM: 10 } });
    assert.equal(problems.length, 1);
    assert.equal(problems[0].field, "corridor.widthM");
  });
});

test("adding an intermediate zone renumbers the line in order", async () => {
  await withAdmin(async (admin) => {
    const route = await admin.getRoute(ROUTE);
    const [origin, destination] = route.corridor.zones;
    const middle = {
      nameAr: "قرية وسطى",
      kind: "intermediate" as const,
      centre: { lat: 32.61, lng: 35.797 },
      radiusM: 600,
    };

    const saved = await admin.setZones(ROUTE, [origin, middle, destination]);
    assert.deepEqual(saved.corridor.zones.map((z) => z.seq), [0, 1, 2]);
    assert.equal(saved.corridor.zones[1].nameAr, "قرية وسطى");
    assert.equal(saved.corridor.zones[2].kind, "destination");
  });
});

test("served destinations follow their zone when zones are renumbered", async () => {
  await withAdmin(async (admin, restart) => {
    const route = await admin.getRoute(ROUTE);
    const [origin, destination] = route.corridor.zones;
    assert.equal(route.servedDestinations[0].zoneSeq, 1, "starts pointing at the destination");

    await admin.setZones(ROUTE, [
      origin,
      { nameAr: "قرية وسطى", kind: "intermediate", centre: { lat: 32.61, lng: 35.797 }, radiusM: 600 },
      destination,
    ]);

    // The destination moved from seq 1 to seq 2; the reference moved with it
    // rather than silently pointing at the new village.
    const after = await restart().getRoute(ROUTE);
    assert.equal(after.servedDestinations[0].zoneSeq, 2);
  });
});

test("a served destination pointing at no zone is refused", async () => {
  await withAdmin(async (admin) => {
    await assert.rejects(
      () => admin.addServedDestination(ROUTE, { id: "jo-x", nameAr: "س", zoneSeq: 9 }),
      InvalidRoute,
    );
  });
});

test("the same destination cannot be added to a line twice", async () => {
  await withAdmin(async (admin) => {
    await assert.rejects(
      () => admin.addServedDestination(ROUTE, { id: "jo-malka", nameAr: "ملكا", zoneSeq: 1 }),
      AdminError,
    );
  });
});

test("wait points are added and removed", async () => {
  await withAdmin(async (admin, restart) => {
    const added = await admin.addWaitPoint(ROUTE, {
      nameAr: "الدوار",
      location: { lat: 32.61, lng: 35.797 },
      zoneSeq: 1,
    });
    assert.equal(added.waitPoints.length, 1);
    assert.equal((await restart().getRoute(ROUTE)).waitPoints.length, 1);

    await admin.removeWaitPoint(ROUTE, added.waitPoints[0].id);
    assert.equal((await restart().getRoute(ROUTE)).waitPoints.length, 0);
  });
});

test("importing traces builds a corridor and clears provisional", async () => {
  await withAdmin(async (admin) => {
    const drive = (offset: number): LatLng[] =>
      Array.from({ length: 60 }, (_, i) => ({
        lat: 32.5556 + (32.669 - 32.5556) * (i / 59),
        lng: 35.8497 + (35.744 - 35.8497) * (i / 59) + offset,
      }));

    assert.equal((await admin.getRoute(ROUTE)).provisional, true);

    const { route, widthM } = await admin.importTraces(ROUTE, [drive(0), drive(0.002)]);
    assert.equal(route.provisional, false, "the line is now based on real driving");
    assert.ok(widthM >= 300);
    assert.ok(route.corridor.referencePaths[0].length >= 2);
  });
});

test("importing traces keeps intermediate zones the field team named", async () => {
  await withAdmin(async (admin) => {
    const route = await admin.getRoute(ROUTE);
    const [origin, destination] = route.corridor.zones;
    await admin.setZones(ROUTE, [
      origin,
      { nameAr: "قرية وسطى", kind: "intermediate", centre: { lat: 32.61, lng: 35.797 }, radiusM: 600 },
      destination,
    ]);

    const drive: LatLng[] = Array.from({ length: 60 }, (_, i) => ({
      lat: 32.5556 + (32.669 - 32.5556) * (i / 59),
      lng: 35.8497 + (35.744 - 35.8497) * (i / 59),
    }));

    const { route: imported } = await admin.importTraces(ROUTE, [drive]);
    const names = imported.corridor.zones.map((z) => z.nameAr);
    assert.ok(names.includes("قرية وسطى"), `zones were ${names.join(", ")}`);
    assert.deepEqual(imported.corridor.zones.map((z) => z.seq), [0, 1, 2]);
  });
});

test("a width suggestion reports rather than applies", async () => {
  await withAdmin(async (admin) => {
    const before = (await admin.getRoute(ROUTE)).corridor.widthM;
    const sideRoad: LatLng[] = Array.from({ length: 20 }, (_, i) => ({
      lat: 32.56 + 0.005 * i,
      lng: 35.845 - 0.004 * i,
    }));

    const suggestion = await admin.suggestWidthFromTraces(ROUTE, [sideRoad]);
    assert.ok(suggestion.widthM > 0);
    assert.equal((await admin.getRoute(ROUTE)).corridor.widthM, before, "nothing was changed");
  });
});
