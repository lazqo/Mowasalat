/**
 * Checks a country pack against the corridor library, so malformed route data
 * fails here rather than on a driver's phone.
 *
 *   node packages/corridor/src/validate-pack.ts countries/jo
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { indexCorridor } from "./corridor.ts";
import { validateRoute } from "./validate.ts";
import type { Route } from "./types.ts";

const packDir = process.argv[2];
if (!packDir) {
  console.error("usage: validate-pack.ts <pack directory>");
  process.exit(2);
}

const config = JSON.parse(readFileSync(join(packDir, "config.json"), "utf8"));
const routeDir = join(packDir, "routes");
const files = readdirSync(routeDir).filter((f) => f.endsWith(".json"));

let failed = 0;
let provisional = 0;

for (const file of files) {
  const route: Route = JSON.parse(readFileSync(join(routeDir, file), "utf8"));
  const problems = validateRoute(route);
  if (route.provisional) provisional++;

  if (problems.length > 0) {
    failed++;
    console.error(`  ✗ ${route.nameAr ?? file}`);
    for (const p of problems) console.error(`      ${p.field}: ${p.message}`);
    continue;
  }

  const km = (indexCorridor(route.corridor).paths[0].totalM / 1000).toFixed(1);
  console.log(
    `  ${route.provisional ? "~" : "✓"} ${route.nameAr}  ${km} km, ` +
      `${route.corridor.zones.length} zones, ${route.servedDestinations.length} destinations, ` +
      `${route.waitPoints.length} wait points`,
  );
}

console.log(`\n${files.length} routes in ${config.code}, ${provisional} still provisional`);
if (failed > 0) {
  console.error(`${failed} invalid`);
  process.exit(1);
}
console.log("pack is structurally valid");
