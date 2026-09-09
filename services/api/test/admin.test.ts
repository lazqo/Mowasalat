import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Admin, AdminError, NotFound } from "../src/admin.ts";
import { InvalidRoute, Pack } from "../src/pack.ts";
import type { LatLng } from "../../../packages/corridor/src/types.ts";

const ROUTE = "jo-irbid-malka";

/** A throwaway copy of the real pack, so tests never touch countries/jo. */
function scratchPack(): { pack: Pack; admin: Admin; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pack-"));
  cpSync("countries/jo", dir, { recursive: true });
  const pack = new Pack(dir);
  return { pack, admin: new Admin(pack, "test-salt"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function withAdmin(fn: (admin: Admin, pack: Pack) => void): void {
  const { admin, pack, cleanup } = scratchPack();
  try {
    fn(admin, pack);
  } finally {
    cleanup();
  }
}

test("the five pilot lines are listed", () => {
  withAdmin((admin) => {
    const routes = admin.listRoutes();
    assert.equal(routes.length, 5);
    assert.ok(routes.some((r) => r.nameAr === "إربد – ملكا"));
    assert.ok(routes.every((r) => r.provisional), "all still awaiting Phase 0");
  });
});

test("an unknown line is reported, not invented", () => {
  withAdmin((admin) => {
    assert.throws(() => admin.getRoute("jo-nowhere"), NotFound);
  });
});

test("a corridor width can be widened and persists", () => {
  withAdmin((admin, pack) => {
    admin.setWidth(ROUTE, 1_200);
    assert.equal(new Pack(pack.dir).getRoute(ROUTE)!.corridor.widthM, 1_200);
  });
});

test("a width that would drop honest drivers offline is refused", () => {
  withAdmin((admin) => {
    // The failure the plan explicitly wants to avoid (§9.3).
    assert.throws(() => admin.setWidth(ROUTE, 50), InvalidRoute);
  });
});

test("an absurdly wide corridor is refused too", () => {
  withAdmin((admin) => {
    assert.throws(() => admin.setWidth(ROUTE, 20_000), InvalidRoute);
  });
});

test("a broken edit is never written to disk", () => {
  withAdmin((admin, pack) => {
    const before = pack.getRoute(ROUTE)!.corridor.widthM;
    assert.throws(() => admin.setWidth(ROUTE, 10), InvalidRoute);
    assert.equal(new Pack(pack.dir).getRoute(ROUTE)!.corridor.widthM, before);
  });
});

test("problems can be checked without saving", () => {
  withAdmin((admin) => {
    const route = admin.getRoute(ROUTE);
    const problems = admin.check({ ...route, corridor: { ...route.corridor, widthM: 10 } });
    assert.equal(problems.length, 1);
    assert.equal(problems[0].field, "corridor.widthM");
  });
});

test("adding an intermediate zone renumbers the line in order", () => {
  withAdmin((admin) => {
    const route = admin.getRoute(ROUTE);
    const [origin, destination] = route.corridor.zones;
    const middle = {
      nameAr: "قرية وسطى",
      kind: "intermediate" as const,
      centre: { lat: 32.61, lng: 35.797 },
      radiusM: 600,
    };

    const saved = admin.setZones(ROUTE, [origin, middle, destination]);
    assert.deepEqual(saved.corridor.zones.map((z) => z.seq), [0, 1, 2]);
    assert.equal(saved.corridor.zones[1].nameAr, "قرية وسطى");
    assert.equal(saved.corridor.zones[2].kind, "destination");
  });
});

test("served destinations follow their zone when zones are renumbered", () => {
  withAdmin((admin) => {
    const route = admin.getRoute(ROUTE);
    const [origin, destination] = route.corridor.zones;
    assert.equal(route.servedDestinations[0].zoneSeq, 1, "starts pointing at the destination");

    const middle = {
      nameAr: "قرية وسطى",
      kind: "intermediate" as const,
      centre: { lat: 32.61, lng: 35.797 },
      radiusM: 600,
    };
    const saved = admin.setZones(ROUTE, [origin, middle, destination]);

    // The destination moved from seq 1 to seq 2; the reference moved with it
    // rather than silently pointing at the new village.
    assert.equal(saved.servedDestinations[0].zoneSeq, 2);
  });
});

test("a served destination pointing at no zone is refused", () => {
  withAdmin((admin) => {
    assert.throws(
      () => admin.addServedDestination(ROUTE, { id: "jo-x", nameAr: "س", zoneSeq: 9 }),
      InvalidRoute,
    );
  });
});

test("the same destination cannot be added to a line twice", () => {
  withAdmin((admin) => {
    assert.throws(
      () => admin.addServedDestination(ROUTE, { id: "jo-malka", nameAr: "ملكا", zoneSeq: 1 }),
      AdminError,
    );
  });
});

test("wait points are added and removed", () => {
  withAdmin((admin) => {
    const added = admin.addWaitPoint(ROUTE, {
      nameAr: "الدوار",
      location: { lat: 32.61, lng: 35.797 },
      zoneSeq: 1,
    });
    assert.equal(added.waitPoints.length, 1);

    const after = admin.removeWaitPoint(ROUTE, added.waitPoints[0].id);
    assert.equal(after.waitPoints.length, 0);
  });
});

test("importing traces builds a corridor and clears provisional", () => {
  withAdmin((admin) => {
    // Two recorded drives of roughly the same road.
    const drive = (offset: number): LatLng[] =>
      Array.from({ length: 60 }, (_, i) => ({
        lat: 32.5556 + (32.669 - 32.5556) * (i / 59),
        lng: 35.8497 + (35.744 - 35.8497) * (i / 59) + offset,
      }));

    const before = admin.getRoute(ROUTE);
    assert.equal(before.provisional, true);

    const { route, widthM } = admin.importTraces(ROUTE, [drive(0), drive(0.002)]);
    assert.equal(route.provisional, false, "the line is now based on real driving");
    assert.ok(widthM >= 300);
    assert.ok(route.corridor.referencePaths[0].length >= 2);
  });
});

test("importing traces keeps intermediate zones the field team named", () => {
  withAdmin((admin) => {
    const route = admin.getRoute(ROUTE);
    const [origin, destination] = route.corridor.zones;
    admin.setZones(ROUTE, [
      origin,
      { nameAr: "قرية وسطى", kind: "intermediate", centre: { lat: 32.61, lng: 35.797 }, radiusM: 600 },
      destination,
    ]);

    const drive: LatLng[] = Array.from({ length: 60 }, (_, i) => ({
      lat: 32.5556 + (32.669 - 32.5556) * (i / 59),
      lng: 35.8497 + (35.744 - 35.8497) * (i / 59),
    }));

    const { route: imported } = admin.importTraces(ROUTE, [drive]);
    const names = imported.corridor.zones.map((z) => z.nameAr);
    assert.ok(names.includes("قرية وسطى"), `zones were ${names.join(", ")}`);
    assert.deepEqual(imported.corridor.zones.map((z) => z.seq), [0, 1, 2]);
  });
});

test("a width suggestion reports rather than applies", () => {
  withAdmin((admin) => {
    const before = admin.getRoute(ROUTE).corridor.widthM;
    const sideRoad: LatLng[] = Array.from({ length: 20 }, (_, i) => ({
      lat: 32.56 + 0.005 * i,
      lng: 35.845 - 0.004 * i,
    }));

    const suggestion = admin.suggestWidthFromTraces(ROUTE, [sideRoad]);
    assert.ok(suggestion.widthM > 0);
    assert.equal(admin.getRoute(ROUTE).corridor.widthM, before, "nothing was changed");
  });
});
