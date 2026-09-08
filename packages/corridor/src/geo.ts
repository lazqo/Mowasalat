import type { LatLng } from "./types.ts";

/** IUGG mean Earth radius, metres. */
const R = 6371008.8;
const DEG = Math.PI / 180;

export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLng = (b.lng - a.lng) * DEG;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

type Local = { x: number; y: number };

/**
 * Equirectangular projection about `origin`. Over a corridor tens of kilometres
 * across at Jordanian latitudes the error is well under a metre, which is far
 * finer than any distance this system reports.
 */
function toLocal(p: LatLng, origin: LatLng): Local {
  const cosLat = Math.cos(origin.lat * DEG);
  return {
    x: (p.lng - origin.lng) * DEG * R * cosLat,
    y: (p.lat - origin.lat) * DEG * R,
  };
}

/** A reference path with cumulative distances precomputed. */
export type PathIndex = {
  points: LatLng[];
  local: Local[];
  /** cumulativeM[i] is the distance from the path start to points[i]. */
  cumulativeM: number[];
  totalM: number;
  origin: LatLng;
};

export function indexPath(points: LatLng[]): PathIndex {
  if (points.length < 2) throw new Error("a path needs at least two points");
  const origin = points[0];
  const local = points.map((p) => toLocal(p, origin));
  const cumulativeM = [0];
  for (let i = 1; i < points.length; i++) {
    cumulativeM.push(cumulativeM[i - 1] + haversineM(points[i - 1], points[i]));
  }
  return {
    points,
    local,
    cumulativeM,
    totalM: cumulativeM[cumulativeM.length - 1],
    origin,
  };
}

export type PathFix = {
  /** Distance from the path start to the projected point, in metres. */
  alongM: number;
  /** Perpendicular distance from the query point to the path, in metres. */
  offsetM: number;
};

/** Projects a point onto the nearest segment of a path. */
export function nearestOnPath(p: LatLng, idx: PathIndex): PathFix {
  const q = toLocal(p, idx.origin);
  let best: PathFix = { alongM: 0, offsetM: Infinity };

  for (let i = 0; i < idx.local.length - 1; i++) {
    const a = idx.local[i];
    const b = idx.local[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;

    // t is the clamped position along the segment, 0 at a and 1 at b.
    const t =
      len2 === 0 ? 0 : Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / len2));

    const px = a.x + t * dx;
    const py = a.y + t * dy;
    const offsetM = Math.hypot(q.x - px, q.y - py);

    if (offsetM < best.offsetM) {
      const segmentM = idx.cumulativeM[i + 1] - idx.cumulativeM[i];
      best = { alongM: idx.cumulativeM[i] + t * segmentM, offsetM };
    }
  }
  return best;
}
