/**
 * Turning GPS traces into a corridor.
 *
 * Phase 0 comes back with recorded drives, not GeoJSON. This derives a
 * reference path and, more usefully, a corridor width measured from how much
 * real drivers actually vary — which is what §9.3 of the plan asks for, rather
 * than a width guessed up front.
 */
import { haversineM, indexPath, nearestOnPath, type PathIndex } from "./geo.ts";
import type { Corridor, LatLng, Zone } from "./types.ts";

/** Perpendicular distance from p to the segment a→b, in metres. */
function perpendicularM(p: LatLng, a: LatLng, b: LatLng): number {
  const idx = indexPath([a, b]);
  return nearestOnPath(p, idx).offsetM;
}

/**
 * Ramer–Douglas–Peucker. A raw trace is thousands of points at 1 Hz; a corridor
 * needs tens. Simplifying keeps the shape and drops the noise, which also keeps
 * the country pack small enough to ship to a cheap phone.
 */
export function simplifyPath(points: LatLng[], toleranceM: number): LatLng[] {
  if (points.length <= 2) return [...points];

  let worst = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularM(points[i], points[0], points[points.length - 1]);
    if (d > worst) {
      worst = d;
      index = i;
    }
  }

  if (worst <= toleranceM) return [points[0], points[points.length - 1]];

  const left = simplifyPath(points.slice(0, index + 1), toleranceM);
  const right = simplifyPath(points.slice(index), toleranceM);
  return [...left.slice(0, -1), ...right];
}

/** Drops points closer together than `minM`, which removes stationary jitter. */
export function thin(points: LatLng[], minM: number): LatLng[] {
  if (points.length === 0) return [];
  const out = [points[0]];
  for (const p of points.slice(1)) {
    if (haversineM(out[out.length - 1], p) >= minM) out.push(p);
  }
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

export function pathLengthM(points: LatLng[]): number {
  return indexPath(points).totalM;
}

export type WidthSuggestion = {
  widthM: number;
  percentileM: number;
  maxOffsetM: number;
  samples: number;
};

/**
 * Suggests a corridor width from how far the observed drives stray from the
 * reference path.
 *
 * Uses a high percentile rather than the maximum so one lost driver or one
 * burst of bad GPS does not inflate the corridor, then adds a margin and a
 * floor. Erring wide is the right direction: a corridor that is too tight drops
 * honest drivers offline, which is the failure the plan explicitly wants to
 * avoid.
 */
export function suggestCorridorWidthM(
  reference: LatLng[],
  traces: LatLng[][],
  opts: { percentile?: number; marginM?: number; floorM?: number } = {},
): WidthSuggestion {
  const percentile = opts.percentile ?? 0.95;
  const marginM = opts.marginM ?? 150;
  const floorM = opts.floorM ?? 300;

  const idx: PathIndex = indexPath(reference);
  const offsets: number[] = [];
  for (const trace of traces) {
    for (const p of trace) offsets.push(nearestOnPath(p, idx).offsetM);
  }

  if (offsets.length === 0) {
    return { widthM: floorM, percentileM: 0, maxOffsetM: 0, samples: 0 };
  }

  offsets.sort((a, b) => a - b);
  const at = offsets[Math.min(offsets.length - 1, Math.floor(percentile * offsets.length))];
  const maxOffsetM = offsets[offsets.length - 1];
  const widthM = Math.max(floorM, Math.ceil((at + marginM) / 50) * 50);

  return { widthM, percentileM: at, maxOffsetM, samples: offsets.length };
}

export type CorridorFromTracesOptions = {
  simplifyToleranceM?: number;
  thinM?: number;
  originNameAr: string;
  destinationNameAr: string;
  zoneRadiusM?: number;
};

/**
 * Builds a corridor from one or more recorded drives of the same line.
 *
 * The longest trace becomes the reference path; the rest set the width. Zones
 * start as just the two endpoints — intermediate villages are added by ops once
 * Phase 0 has identified them, since only a person can say which settlement a
 * bend in the road belongs to.
 */
export function corridorFromTraces(
  traces: LatLng[][],
  opts: CorridorFromTracesOptions,
): { corridor: Corridor; width: WidthSuggestion } {
  const usable = traces.filter((t) => t.length >= 2);
  if (usable.length === 0) throw new Error("need at least one trace with two or more points");

  const cleaned = usable.map((t) => thin(t, opts.thinM ?? 25));
  const longest = cleaned.reduce((a, b) => (pathLengthM(b) > pathLengthM(a) ? b : a));
  const reference = simplifyPath(longest, opts.simplifyToleranceM ?? 30);

  const others = cleaned.filter((t) => t !== longest);
  const width = suggestCorridorWidthM(reference, others.length > 0 ? others : [longest]);

  const radiusM = opts.zoneRadiusM ?? 800;
  const zones: Zone[] = [
    { seq: 0, nameAr: opts.originNameAr, kind: "origin_hub", centre: reference[0], radiusM },
    {
      seq: 1,
      nameAr: opts.destinationNameAr,
      kind: "destination",
      centre: reference[reference.length - 1],
      radiusM,
    },
  ];

  return {
    corridor: { widthM: width.widthM, referencePaths: [reference], zones },
    width,
  };
}
