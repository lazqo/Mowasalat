import type { Corridor, Direction, LatLng, Zone } from "./types.ts";
import { indexPath, nearestOnPath, type PathIndex } from "./geo.ts";

export type IndexedCorridor = {
  corridor: Corridor;
  paths: PathIndex[];
  /** For each path, the along-distance of each zone centre, ordered by zone seq. */
  zoneAlongM: number[][];
};

export function indexCorridor(corridor: Corridor): IndexedCorridor {
  if (corridor.referencePaths.length === 0) {
    throw new Error("a corridor needs at least one reference path");
  }
  const zones = [...corridor.zones].sort((a, b) => a.seq - b.seq);
  const paths = corridor.referencePaths.map(indexPath);
  const zoneAlongM = paths.map((idx) =>
    zones.map((z) => nearestOnPath(z.centre, idx).alongM),
  );
  return { corridor: { ...corridor, zones }, paths, zoneAlongM };
}

export type Placement = {
  inside: boolean;
  /** Which reference path the point sits closest to. */
  pathIndex: number;
  alongM: number;
  offsetM: number;
  zoneSeq: number;
};

/**
 * Places a coordinate against a corridor. Runs entirely on the device; the
 * result is what may be transmitted, and it contains no coordinate.
 *
 * `inside` is false when the point is further than the corridor's width from
 * every reference path. A driver outside the corridor transmits nothing at all,
 * so detours are invisible by construction (§6.1) — and a driver who is
 * repeatedly outside means the corridor is drawn too tight, not that the driver
 * misbehaved (§9.3).
 */
export function place(p: LatLng, ic: IndexedCorridor): Placement {
  let pathIndex = 0;
  let alongM = 0;
  let offsetM = Infinity;

  for (let i = 0; i < ic.paths.length; i++) {
    const fix = nearestOnPath(p, ic.paths[i]);
    if (fix.offsetM < offsetM) {
      offsetM = fix.offsetM;
      alongM = fix.alongM;
      pathIndex = i;
    }
  }

  return {
    inside: offsetM <= ic.corridor.widthM,
    pathIndex,
    alongM,
    offsetM,
    zoneSeq: zoneSeqAt(alongM, ic, pathIndex, p),
  };
}

/**
 * Resolves which ordered zone a position falls in. A point inside a zone's own
 * radius takes that zone; otherwise it takes the last zone it has passed.
 */
export function zoneSeqAt(
  alongM: number,
  ic: IndexedCorridor,
  pathIndex: number,
  p?: LatLng,
): number {
  const zones = ic.corridor.zones;
  if (zones.length === 0) return 0;

  if (p) {
    for (const z of zones) {
      if (withinRadius(p, z)) return z.seq;
    }
  }

  const alongs = ic.zoneAlongM[pathIndex];
  let seq = zones[0].seq;
  for (let i = 0; i < zones.length; i++) {
    if (alongs[i] <= alongM) seq = zones[i].seq;
  }
  return seq;
}

function withinRadius(p: LatLng, z: Zone): boolean {
  // Cheap planar check; radii here are hundreds of metres.
  const DEG = Math.PI / 180;
  const R = 6371008.8;
  const cosLat = Math.cos(z.centre.lat * DEG);
  const dx = (p.lng - z.centre.lng) * DEG * R * cosLat;
  const dy = (p.lat - z.centre.lat) * DEG * R;
  return Math.hypot(dx, dy) <= z.radiusM;
}

/**
 * Road distance still to cover to reach this direction's endpoint.
 *
 * This replaces "progress along the line". With a corridor, two drivers may
 * take different roads and so share no line to measure progress along — but
 * they share the distance still to cover, and that value is monotonic whichever
 * road is taken. Ordering and ETA then fall out as subtraction (§6.1).
 */
export function remainingM(placement: Placement, ic: IndexedCorridor, dir: Direction): number {
  const total = ic.paths[placement.pathIndex].totalM;
  return dir === 0 ? total - placement.alongM : placement.alongM;
}
