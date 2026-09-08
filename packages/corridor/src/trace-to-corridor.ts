/**
 * Turns recorded drives into a route's corridor.
 *
 *   node packages/corridor/src/trace-to-corridor.ts \
 *     countries/jo/routes/irbid-malka.json traces/malka-*.json [--write]
 *
 * A trace file is either a JSON array of {lat,lng}, or a GeoJSON LineString.
 * Without --write the updated route is printed, so it can be reviewed first.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { corridorFromTraces, pathLengthM } from "./trace.ts";
import type { LatLng, Route } from "./types.ts";

function loadTrace(path: string): LatLng[] {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (Array.isArray(raw)) {
    return raw.map((p) => ({ lat: p.lat ?? p[1], lng: p.lng ?? p[0] }));
  }
  const coords = raw?.geometry?.coordinates ?? raw?.coordinates;
  if (Array.isArray(coords)) {
    return coords.map((c: [number, number]) => ({ lat: c[1], lng: c[0] }));
  }
  throw new Error(`${path}: expected an array of points or a GeoJSON LineString`);
}

const [routePath, ...rest] = process.argv.slice(2);
const write = rest.includes("--write");
const tracePaths = rest.filter((a) => a !== "--write");

if (!routePath || tracePaths.length === 0) {
  console.error("usage: trace-to-corridor.ts <route.json> <trace.json...> [--write]");
  process.exit(2);
}

const route: Route = JSON.parse(readFileSync(routePath, "utf8"));
const traces = tracePaths.map(loadTrace);

const { corridor, width } = corridorFromTraces(traces, {
  originNameAr: route.originNameAr,
  destinationNameAr: route.destinationNameAr,
});

// Zones the field team has already named are kept; only geometry is replaced.
const named = route.corridor.zones.filter((z) => z.kind === "intermediate");
corridor.zones = [corridor.zones[0], ...named, corridor.zones[1]].map((z, i) => ({ ...z, seq: i }));

const updated: Route = { ...route, corridor, provisional: false };

console.error(
  [
    `${route.nameAr}`,
    `  traces          ${traces.length}`,
    `  reference path  ${corridor.referencePaths[0].length} points, ${(pathLengthM(corridor.referencePaths[0]) / 1000).toFixed(1)} km`,
    `  width           ${width.widthM} m  (95th percentile offset ${Math.round(width.percentileM)} m, max ${Math.round(width.maxOffsetM)} m)`,
    `  zones           ${corridor.zones.length}`,
  ].join("\n"),
);

if (write) {
  writeFileSync(routePath, JSON.stringify(updated, null, 2) + "\n");
  console.error(`\nwrote ${routePath}`);
} else {
  console.log(JSON.stringify(updated, null, 2));
  console.error("\n(dry run — pass --write to update the route file)");
}
