/**
 * Loads a country pack and checks it against the corridor library, so malformed
 * route data fails here rather than on a driver's phone.
 *
 *   node packages/corridor/src/validate-pack.ts countries/jo
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { indexCorridor, place, remainingM } from "./corridor.ts";
import type { Route } from "./types.ts";

const packDir = process.argv[2];
if (!packDir) {
  console.error("usage: validate-pack.ts <pack directory>");
  process.exit(2);
}

const config = JSON.parse(readFileSync(join(packDir, "config.json"), "utf8"));
const routeDir = join(packDir, "routes");
const files = readdirSync(routeDir).filter((f) => f.endsWith(".json"));

const problems: string[] = [];
let provisional = 0;

for (const file of files) {
  const route: Route = JSON.parse(readFileSync(join(routeDir, file), "utf8"));
  const where = `${file} (${route.nameAr})`;

  if (!route.id || !route.nameAr) problems.push(`${where}: missing id or nameAr`);
  if (route.provisional) provisional++;

  try {
    const ic = indexCorridor(route.corridor);

    const zones = ic.corridor.zones;
    if (zones.length < 2) problems.push(`${where}: needs at least an origin and a destination zone`);
    if (zones[0]?.kind !== "origin_hub") problems.push(`${where}: first zone is not the origin hub`);
    if (zones[zones.length - 1]?.kind !== "destination")
      problems.push(`${where}: last zone is not the destination`);

    const seqs = zones.map((z) => z.seq);
    if (new Set(seqs).size !== seqs.length) problems.push(`${where}: duplicate zone seq`);

    for (const path of ic.paths) {
      if (path.totalM < 500) problems.push(`${where}: a reference path is only ${Math.round(path.totalM)} m`);
    }

    // The endpoints must actually place inside their own corridor, and
    // remaining distance must reach zero at the destination.
    const origin = zones[0].centre;
    const destination = zones[zones.length - 1].centre;
    if (!place(origin, ic).inside) problems.push(`${where}: origin sits outside its own corridor`);
    if (!place(destination, ic).inside) problems.push(`${where}: destination sits outside its own corridor`);

    const atDestination = remainingM(place(destination, ic), ic, 0);
    if (atDestination > 100) problems.push(`${where}: remaining at destination is ${Math.round(atDestination)} m, expected ~0`);

    if (route.corridor.widthM < 100) problems.push(`${where}: corridor width ${route.corridor.widthM} m is too tight`);

    const km = (ic.paths[0].totalM / 1000).toFixed(1);
    console.log(`  ${route.provisional ? "~" : "✓"} ${route.nameAr}  ${km} km, ${zones.length} zones, ${route.servedDestinations.length} destinations, ${route.waitPoints.length} wait points`);
  } catch (err) {
    problems.push(`${where}: ${(err as Error).message}`);
  }
}

console.log(`\n${files.length} routes in ${config.code}, ${provisional} still provisional`);
if (problems.length) {
  console.error("\nProblems:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("pack is structurally valid");
