import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  OsrmRouter,
  checkCorridorAgainstRoad,
  corridorFromRoads,
  OSM_ATTRIBUTION,
} from "../src/roads.ts";
import { pathLengthM } from "../src/trace.ts";
import type { Corridor, LatLng, Zone } from "../src/types.ts";

/** A real OSRM answer for إربد → ملكا, recorded so these need no network. */
const recorded = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/osrm-irbid-malka.json"), "utf8"),
);

const IRBID: LatLng = { lat: 32.5556, lng: 35.8497 };
const MALKA: LatLng = { lat: 32.669, lng: 35.744 };

const ZONES: Zone[] = [
  { seq: 0, nameAr: "إربد", kind: "origin_hub", centre: IRBID, radiusM: 800 },
  { seq: 1, nameAr: "ملكا", kind: "destination", centre: MALKA, radiusM: 800 },
];

function stubFetch(body: unknown, ok = true): typeof fetch {
  return (async () =>
    ({
      ok,
      status: ok ? 200 : 500,
      statusText: ok ? "OK" : "Server Error",
      json: async () => body,
    }) as Response) as unknown as typeof fetch;
}

// --- talking to the router ---------------------------------------------------

test("coordinates go out in the order OSRM expects, not ours", async () => {
  // OSRM takes lng,lat. Getting this backwards routes across the Mediterranean
  // and returns something plausible-looking, so it is worth pinning down.
  let asked = "";
  const router = new OsrmRouter("https://osrm.test", (async (url: string) => {
    asked = String(url);
    return { ok: true, status: 200, statusText: "OK", json: async () => recorded } as Response;
  }) as unknown as typeof fetch);

  await router.route(IRBID, MALKA);

  assert.match(asked, /\/route\/v1\/driving\/35\.8497,32\.5556;35\.744,32\.669/);
  assert.match(asked, /alternatives=true/);
  assert.match(asked, /geometries=geojson/);
});

test("a recorded answer becomes paths in our own coordinate order", async () => {
  const router = new OsrmRouter("https://osrm.test", stubFetch(recorded));
  const [best] = await router.route(IRBID, MALKA);

  assert.ok(best.distanceM > 20_000 && best.distanceM < 22_000, "about 21 km");
  assert.ok(best.points.length > 100);
  // Jordan, not the middle of the sea: latitudes near 32, longitudes near 35.
  for (const p of best.points) {
    assert.ok(p.lat > 32 && p.lat < 33, `lat ${p.lat}`);
    assert.ok(p.lng > 35 && p.lng < 36, `lng ${p.lng}`);
  }
});

test("a routing failure is raised, not turned into an empty corridor", async () => {
  const router = new OsrmRouter("https://osrm.test", stubFetch({ code: "NoRoute", message: "no route" }));
  await assert.rejects(() => router.route(IRBID, MALKA), /no road found/);

  const broken = new OsrmRouter("https://osrm.test", stubFetch({}, false));
  await assert.rejects(() => broken.route(IRBID, MALKA), /routing failed/);
});

// --- turning roads into a corridor -------------------------------------------

test("the stored line follows the road closely enough for the GPS matched against it", async () => {
  const router = new OsrmRouter("https://osrm.test", stubFetch(recorded));
  const roads = await router.route(IRBID, MALKA);
  const { corridor, report } = corridorFromRoads(roads, ZONES);

  assert.ok(report.pointsAfter < report.pointsBefore / 3, "worth simplifying at all");
  assert.ok(report.simplificationErrorM <= 12, `moved the line by ${report.simplificationErrorM} m`);

  // Distance is what every ETA is computed from, so it must survive.
  const stored = pathLengthM(corridor.referencePaths[0]);
  const error = Math.abs(stored - report.distanceM) / report.distanceM;
  assert.ok(error < 0.02, `distance drifted ${(error * 100).toFixed(1)}%`);
});

test("a genuinely different road is kept as a second path, not swallowed by width", async () => {
  const router = new OsrmRouter("https://osrm.test", stubFetch(recorded));
  const { corridor, report } = corridorFromRoads(await router.route(IRBID, MALKA), ZONES);

  assert.equal(corridor.referencePaths.length, 2);
  assert.equal(report.alternatives[0].kept, true);
  assert.ok(report.alternatives[0].divergenceM > 1000);

  // The point of the second path: widening one corridor to cover both roads
  // would take a corridor kilometres across, which would call a bus in another
  // village "on the line" and would publish exactly the detours that going
  // silent off-corridor exists to keep private.
  assert.ok(
    corridor.widthM < report.alternatives[0].divergenceM / 4,
    "the width must stay far below the distance between the two roads",
  );
});

test("a near-identical alternative is dropped rather than stored twice", () => {
  const road = recorded.routes[0].geometry.coordinates.map(([lng, lat]: number[]) => ({ lat, lng }));
  const nudged = road.map((p: LatLng) => ({ lat: p.lat + 0.0005, lng: p.lng })); // ~55 m

  const { corridor, report } = corridorFromRoads(
    [
      { points: road, distanceM: 21_000, durationS: 1860 },
      { points: nudged, distanceM: 21_050, durationS: 1870 },
    ],
    ZONES,
  );

  assert.equal(corridor.referencePaths.length, 1);
  assert.equal(report.alternatives[0].kept, false);
  assert.match(report.alternatives[0].reason ?? "", /width already covers/);
});

test("a wildly longer alternative is a detour, not a choice", () => {
  const road = recorded.routes[0].geometry.coordinates.map(([lng, lat]: number[]) => ({ lat, lng }));
  const detour = road.map((p: LatLng) => ({ lat: p.lat + 0.05, lng: p.lng + 0.05 }));

  const { report } = corridorFromRoads(
    [
      { points: road, distanceM: 21_000, durationS: 1860 },
      { points: detour, distanceM: 60_000, durationS: 5400 },
    ],
    ZONES,
  );

  assert.equal(report.alternatives[0].kept, false);
  assert.match(report.alternatives[0].reason ?? "", /× the direct road/);
});

test("no roads at all is an error, not an empty corridor", () => {
  assert.throws(() => corridorFromRoads([], ZONES), /at least one road/);
});

// --- checking geometry that already exists -----------------------------------

test("a straight-line guess is measured against the road and found wanting", async () => {
  const router = new OsrmRouter("https://osrm.test", stubFetch(recorded));
  const roads = await router.route(IRBID, MALKA);

  // What the pack held before this existed: origin, destination, two points
  // interpolated between them, and a 750 m corridor.
  const guess: Corridor = {
    widthM: 750,
    referencePaths: [[IRBID, { lat: 32.593022, lng: 35.814819 }, { lat: 32.630444, lng: 35.779938 }, MALKA]],
    zones: ZONES,
  };

  const before = checkCorridorAgainstRoad(guess, roads[0].points);
  assert.ok(before.outsideFraction > 0.5, "most of the real road falls outside the guess");
  assert.ok(before.longestGapM > 5000, "and a bus would be invisible for kilometres of it");

  const { corridor } = corridorFromRoads(roads, ZONES);
  const after = checkCorridorAgainstRoad(corridor, roads[0].points);
  assert.equal(after.outsideFraction, 0, "the generated corridor covers the road it came from");
});

test("attribution is carried, because the data is ODbL", () => {
  // Storing what a router returns is the whole feature here, and it is only
  // allowed because the data is OpenStreetMap's. Attribution is the condition.
  assert.match(OSM_ATTRIBUTION, /OpenStreetMap/);
});
