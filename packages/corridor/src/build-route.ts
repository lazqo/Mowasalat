/**
 * Rebuilds a route file's corridor from the actual roads.
 *
 *   node packages/corridor/src/build-route.ts countries/jo/routes/irbid-malka.json
 *   node packages/corridor/src/build-route.ts countries/jo/routes/*.json --write
 *
 * Without `--write` it reports what it would change and touches nothing.
 *
 * This is an ops tool. It runs on a laptop when a line is created or
 * corrected, and the result is stored in the pack. No phone ever calls a
 * routing service — see the note at the top of roads.ts.
 *
 * It does not mark a line surveyed. A routing engine knows where the road
 * goes; it does not know which road the drivers take, where they actually
 * stop, or what passengers call the place. Those stay Phase 0 questions and
 * the line stays `provisional` until a person answers them.
 */

import { readFileSync, writeFileSync } from "node:fs";
import {
  OsrmRouter,
  checkCorridorAgainstRoad,
  corridorFromRoads,
  pathLengthM,
  OSM_ATTRIBUTION,
} from "./roads.ts";
import type { Corridor, LatLng } from "./types.ts";

type RouteFile = {
  id: string;
  nameAr: string;
  corridor: Corridor;
  _phase0?: Record<string, unknown>;
  [key: string]: unknown;
};

const args = process.argv.slice(2);
const write = args.includes("--write");
const files = args.filter((a) => !a.startsWith("--"));

if (files.length === 0) {
  console.error("usage: build-route.ts <route.json…> [--write]");
  process.exit(1);
}

const router = new OsrmRouter(process.env.OSRM_URL);
let changed = 0;

for (const file of files) {
  const route = JSON.parse(readFileSync(file, "utf8")) as RouteFile;
  const zones = [...route.corridor.zones].sort((a, b) => a.seq - b.seq);

  const from = zones.at(0)?.centre;
  const to = zones.at(-1)?.centre;
  if (!from || !to) {
    console.error(`${route.id}: needs a first and last zone to route between`);
    continue;
  }

  console.log(`\n${route.nameAr}  (${route.id})`);

  let roads;
  try {
    roads = await router.route(from, to);
  } catch (err) {
    console.error(`  could not route: ${(err as Error).message}`);
    continue;
  }

  // What the stored geometry claims today, measured against the real road.
  const before = checkCorridorAgainstRoad(route.corridor, roads[0].points);
  const oldLengthM = pathLengthM(route.corridor.referencePaths[0] ?? []);

  const { corridor, report } = corridorFromRoads(roads, zones);
  const after = checkCorridorAgainstRoad(corridor, roads[0].points);

  console.log(`  road          ${(report.distanceM / 1000).toFixed(1)} km, about ${Math.round(report.durationS / 60)} min`);
  console.log(`  stored now    ${(oldLengthM / 1000).toFixed(1)} km`);
  if (oldLengthM > 0) {
    const error = ((report.distanceM - oldLengthM) / report.distanceM) * 100;
    console.log(`                ETAs are currently ${error > 0 ? "short" : "long"} by ${Math.abs(error).toFixed(0)}%`);
  }
  console.log(
    `  coverage      ${pct(before.outsideFraction)} of the road is outside the stored corridor` +
      ` → ${pct(after.outsideFraction)}`,
  );
  if (before.longestGapM > 0) {
    console.log(`                longest stretch where a bus would go silent: ${Math.round(before.longestGapM)} m`);
  }
  console.log(`  geometry      ${report.pointsBefore} points → ${report.pointsAfter}, off by at most ${Math.round(report.simplificationErrorM)} m`);

  for (const alt of report.alternatives) {
    console.log(
      `  alternative   ${(alt.distanceM / 1000).toFixed(1)} km, diverging ${Math.round(alt.divergenceM)} m — ` +
        (alt.kept ? "kept as a second road" : `dropped: ${alt.reason}`),
    );
  }

  if (!write) continue;

  route.corridor = { ...corridor, zones: route.corridor.zones };
  route._phase0 = {
    ...route._phase0,
    note:
      "Road geometry generated from OpenStreetMap. Still provisional: a router knows where the " +
      "road goes, not which road the drivers take. Phase 0 confirms that — see docs/PLAN.md §12.1.",
    // Deliberately not flipped to true: this is not a survey.
    roadsSurveyed: false,
    roadsFrom: `osrm (${OSM_ATTRIBUTION})`,
    roadsGeneratedAt: new Date().toISOString().slice(0, 10),
  };

  writeFileSync(file, JSON.stringify(route, null, 2) + "\n");
  changed++;
  console.log("  written");
}

if (!write && files.length > 0) console.log("\nnothing written — pass --write to apply");
else if (changed) console.log(`\n${changed} route${changed === 1 ? "" : "s"} updated`);

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

// Keeps the type import honest for a file that otherwise only reads JSON.
export type { LatLng };
