/**
 * What makes a route valid.
 *
 * Shared by the pack CLI and the ops admin, so a corridor the admin accepts is
 * exactly a corridor the apps can use. Ops owns the network (docs/PLAN.md
 * §5.4), and this is what keeps it clean: a route that fails here is never
 * written.
 */
import { indexCorridor, place, remainingM } from "./corridor.ts";
import type { Route } from "./types.ts";

export type Problem = { field: string; message: string };

export function validateRoute(route: Route): Problem[] {
  const problems: Problem[] = [];
  const add = (field: string, message: string) => problems.push({ field, message });

  if (!route.id) add("id", "missing");
  if (!route.nameAr) add("nameAr", "missing");
  if (!route.originNameAr) add("originNameAr", "missing");
  if (!route.destinationNameAr) add("destinationNameAr", "missing");
  if (!route.corridor) {
    add("corridor", "missing");
    return problems;
  }

  if (route.corridor.widthM < 100) {
    add("corridor.widthM", `${route.corridor.widthM} m is too tight; drivers would drop offline`);
  }
  if (route.corridor.widthM > 5_000) {
    add("corridor.widthM", `${route.corridor.widthM} m is so wide the line stops meaning anything`);
  }

  let ic;
  try {
    ic = indexCorridor(route.corridor);
  } catch (err) {
    add("corridor.referencePaths", (err as Error).message);
    return problems;
  }

  const zones = ic.corridor.zones;
  if (zones.length < 2) add("corridor.zones", "needs at least an origin and a destination");
  if (zones.length > 0 && zones[0].kind !== "origin_hub") {
    add("corridor.zones[0]", "the first zone must be the origin hub");
  }
  if (zones.length > 1 && zones[zones.length - 1].kind !== "destination") {
    add(`corridor.zones[${zones.length - 1}]`, "the last zone must be the destination");
  }
  if (new Set(zones.map((z) => z.seq)).size !== zones.length) {
    add("corridor.zones", "zone seq values must be unique");
  }
  for (const z of zones) {
    if (!z.nameAr) add(`corridor.zones[${z.seq}].nameAr`, "missing");
    if (z.radiusM <= 0) add(`corridor.zones[${z.seq}].radiusM`, "must be positive");
  }

  for (let i = 0; i < ic.paths.length; i++) {
    if (ic.paths[i].totalM < 500) {
      add(`corridor.referencePaths[${i}]`, `only ${Math.round(ic.paths[i].totalM)} m long`);
    }
  }

  if (zones.length >= 2) {
    const origin = zones[0].centre;
    const destination = zones[zones.length - 1].centre;

    if (!place(origin, ic).inside) {
      add("corridor.zones[0].centre", "the origin sits outside its own corridor");
    }
    if (!place(destination, ic).inside) {
      add("corridor.zones", "the destination sits outside its own corridor");
    }

    const atDestination = remainingM(place(destination, ic), ic, 0);
    if (atDestination > 100) {
      add(
        "corridor",
        `remaining distance at the destination is ${Math.round(atDestination)} m, expected about zero — the reference path probably does not end there`,
      );
    }
  }

  for (const d of route.servedDestinations ?? []) {
    if (!zones.some((z) => z.seq === d.zoneSeq)) {
      add(`servedDestinations.${d.id}`, `refers to zone ${d.zoneSeq}, which does not exist`);
    }
  }
  for (const w of route.waitPoints ?? []) {
    if (!zones.some((z) => z.seq === w.zoneSeq)) {
      add(`waitPoints.${w.id}`, `refers to zone ${w.zoneSeq}, which does not exist`);
    }
  }

  return problems;
}
