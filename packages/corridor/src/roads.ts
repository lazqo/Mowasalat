/**
 * Building a corridor from the actual roads.
 *
 * Until now the pilot lines carried straight-line placeholder geometry waiting
 * on field work. A routing engine already knows where the road goes, so it can
 * do the first pass: origin and destination in, the real road out, including
 * the genuine alternatives drivers use.
 *
 * Three things about how this is used matter more than the code:
 *
 * 1. **It runs at ops time, never on a phone.** A corridor is built once, when
 *    a line is created or corrected, and stored in our own database. No
 *    passenger's phone and no driver's phone ever calls a map service, because
 *    doing so would tell that service where the person holding it is standing
 *    — the disclosure this whole design exists to prevent.
 *
 * 2. **It is not a survey.** It answers "where does the road go", not "which
 *    road do the drivers actually take", and the second question is the one
 *    Phase 0 is for. A generated corridor stays `provisional`.
 *
 * 3. **The licence has to permit storing the result.** Google's Directions API
 *    forbids caching or storing what it returns and forbids showing it on a
 *    non-Google map, which rules it out: storing the route *is* the feature.
 *    OSRM, Valhalla and GraphHopper over OpenStreetMap data permit it under
 *    ODbL, which requires attribution — see `OSM_ATTRIBUTION`.
 */

import { haversineM, indexPath, nearestOnPath } from "./geo.ts";
import { pathLengthM, simplifyPath } from "./trace.ts";
import type { Corridor, LatLng } from "./types.ts";

/** Required wherever a generated corridor is shown or redistributed (ODbL). */
export const OSM_ATTRIBUTION = "© OpenStreetMap contributors";

export type RoadRoute = {
  points: LatLng[];
  distanceM: number;
  durationS: number;
};

export type RoadRouter = {
  /** Every road worth considering between two points, best first. */
  route(from: LatLng, to: LatLng): Promise<RoadRoute[]>;
};

/**
 * Any OSRM-compatible server.
 *
 * The public demo server is fine for building the five pilot lines and is not
 * fine for anything ongoing: it has no availability promise and asks not to be
 * used in production. Self-hosting OSRM over a Jordan extract is a container
 * and a few hundred megabytes, and then this depends on nobody.
 */
export class OsrmRouter implements RoadRouter {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl = "https://router.project-osrm.org", fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
  }

  async route(from: LatLng, to: LatLng): Promise<RoadRoute[]> {
    // OSRM takes lng,lat — the opposite order to everything else here, which
    // is a reliable source of silently mirrored routes.
    const coords = `${from.lng},${from.lat};${to.lng},${to.lat}`;
    const url =
      `${this.baseUrl}/route/v1/driving/${coords}` +
      `?overview=full&geometries=geojson&alternatives=true&steps=false`;

    const res = await this.fetchImpl(url);
    if (!res.ok) throw new Error(`routing failed: ${res.status} ${res.statusText}`);

    const body = (await res.json()) as {
      code: string;
      message?: string;
      routes?: {
        distance: number;
        duration: number;
        geometry: { coordinates: [number, number][] };
      }[];
    };

    if (body.code !== "Ok" || !body.routes?.length) {
      throw new Error(`no road found: ${body.code}${body.message ? ` — ${body.message}` : ""}`);
    }

    return body.routes.map((r) => ({
      points: r.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })),
      distanceM: r.distance,
      durationS: r.duration,
    }));
  }
}

export type CorridorFromRoadsOptions = {
  /**
   * How far the stored line may sit from the road it describes. The default
   * turns a 900-point road into about 110 points and moves it by at most ten
   * metres, which is inside the error of the GPS that will be matched against
   * it — so a finer line would cost the phone work to buy nothing.
   */
  simplifyToleranceM?: number;
  /**
   * Corridor half-width. This covers GPS error and a bus pulling off the road,
   * not "a different road" — a genuinely different road belongs in
   * `referencePaths` as its own entry. See the note on `minAlternativeM`.
   */
  widthM?: number;
  /** An alternative this much longer than the best is a detour, not a choice. */
  maxAlternativeRatio?: number;
  /**
   * How far an alternative must diverge before it counts as a different road
   * rather than the same one with different jitter. Below this the corridor
   * width already covers it.
   */
  minAlternativeM?: number;
};

export type CorridorReport = {
  /** Road distance of the best route, which is what ETAs are computed from. */
  distanceM: number;
  /** What the engine thinks the drive takes, for sanity-checking a headway. */
  durationS: number;
  pointsBefore: number;
  pointsAfter: number;
  /** How far simplification moved the line from the road. */
  simplificationErrorM: number;
  /** One entry per alternative offered, whether it was kept, and why not. */
  alternatives: { distanceM: number; divergenceM: number; kept: boolean; reason?: string }[];
};

const DEFAULTS = {
  simplifyToleranceM: 10,
  widthM: 400,
  maxAlternativeRatio: 1.4,
  minAlternativeM: 800,
} as const;

/**
 * Turns routing output into a corridor.
 *
 * The important judgement here is what to do with a second road. Widening one
 * corridor until it covers both is the obvious move and the wrong one: the two
 * roads between إربد and ملكا diverge by about six kilometres, so a corridor
 * wide enough to hold both would be twelve kilometres across and would call a
 * bus three villages away "on the line". It would also swallow exactly the
 * private detours that going silent off-corridor is meant to keep private.
 *
 * Two reference paths, each a few hundred metres wide, describe the same
 * reality with none of that. `referencePaths` is a list for this reason.
 */
export function corridorFromRoads(
  routes: RoadRoute[],
  zones: Corridor["zones"],
  options: CorridorFromRoadsOptions = {},
): { corridor: Corridor; report: CorridorReport } {
  if (routes.length === 0) throw new Error("a corridor needs at least one road");

  const opts = { ...DEFAULTS, ...options };
  const [best, ...rest] = routes;

  const simplify = (r: RoadRoute) => simplifyPath(r.points, opts.simplifyToleranceM);
  const bestPath = simplify(best);
  const bestIndex = indexPath(bestPath);

  const referencePaths: LatLng[][] = [bestPath];
  const alternatives: CorridorReport["alternatives"] = [];

  for (const candidate of rest) {
    const divergenceM = maxOffsetM(candidate.points, bestIndex);
    const ratio = candidate.distanceM / best.distanceM;

    let reason: string | undefined;
    if (ratio > opts.maxAlternativeRatio) {
      reason = `${ratio.toFixed(2)}× the direct road`;
    } else if (divergenceM < opts.minAlternativeM) {
      reason = `only ${Math.round(divergenceM)} m from it — the corridor width already covers this`;
    }

    alternatives.push({
      distanceM: candidate.distanceM,
      divergenceM,
      kept: !reason,
      ...(reason ? { reason } : {}),
    });
    if (!reason) referencePaths.push(simplify(candidate));
  }

  return {
    corridor: { widthM: opts.widthM, referencePaths, zones },
    report: {
      distanceM: best.distanceM,
      durationS: best.durationS,
      pointsBefore: best.points.length,
      pointsAfter: bestPath.length,
      simplificationErrorM: maxOffsetM(best.points, bestIndex),
      alternatives,
    },
  };
}

/** The furthest any of these points sits from the given path. */
function maxOffsetM(points: LatLng[], index: ReturnType<typeof indexPath>): number {
  let max = 0;
  for (const p of points) {
    const offset = nearestOnPath(p, index).offsetM;
    if (offset > max) max = offset;
  }
  return max;
}

/**
 * How far the stored geometry is from the road, and whether that is survivable.
 *
 * Run against an existing corridor this answers the question that matters
 * before a pilot: would a driver on the real road be seen at all? A line whose
 * geometry is a straight-line guess can put most of the actual road outside
 * its own corridor, and a driver there transmits nothing — so the app looks
 * broken in a way no test would catch.
 */
export function checkCorridorAgainstRoad(
  corridor: Corridor,
  road: LatLng[],
): { maxOffsetM: number; outsideFraction: number; longestGapM: number } {
  const indexes = corridor.referencePaths.map(indexPath);

  let max = 0;
  let outside = 0;
  let gapM = 0;
  let longestGapM = 0;
  let previous: LatLng | undefined;

  for (const p of road) {
    const offset = Math.min(...indexes.map((i) => nearestOnPath(p, i).offsetM));
    if (offset > max) max = offset;

    const step = previous ? haversineM(previous, p) : 0;
    previous = p;

    if (offset > corridor.widthM) {
      outside++;
      gapM += step;
      if (gapM > longestGapM) longestGapM = gapM;
    } else {
      gapM = 0;
    }
  }

  return {
    maxOffsetM: max,
    outsideFraction: road.length ? outside / road.length : 0,
    longestGapM,
  };
}

export { pathLengthM };
