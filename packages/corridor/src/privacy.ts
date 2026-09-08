import type { WaitPoint, Zone } from "./types.ts";

/**
 * Rounds a remaining-distance down to a coarse band before it leaves the
 * device. The band is the finest position the server ever holds.
 */
export function bucketRemaining(remaining: number, bucketM: number): number {
  if (bucketM <= 0) throw new Error("bucketM must be positive");
  return Math.floor(remaining / bucketM) * bucketM;
}

/**
 * Density-adaptive resolution (docs/PLAN.md §6.5).
 *
 * A pin showing one person waiting on an empty road is a pin showing a specific
 * person. Where fewer than `k` requests are active nearby, the position is
 * snapped to the nearest anchor instead — a recognised waiting point, or
 * failing that a zone centre — which is all the driver needs to know anyway.
 *
 * Anchors must not be empty. This is a privacy control, so the degenerate case
 * fails loudly rather than quietly publishing a fine-grained position: a route
 * always has at least an origin and a destination zone to fall back on, and a
 * caller passing nothing has a bug worth surfacing.
 */
export function resolvePublishedRemaining(
  remaining: number,
  nearbyActiveCount: number,
  k: number,
  anchorsRemainingM: number[],
  bucketM: number,
): number {
  if (nearbyActiveCount >= k) return bucketRemaining(remaining, bucketM);
  if (anchorsRemainingM.length === 0) {
    throw new Error(
      "cannot blur a sparse position: no waiting points or zones to snap to",
    );
  }
  return nearestValue(remaining, anchorsRemainingM);
}

function nearestValue(target: number, values: number[]): number {
  let best = values[0];
  for (const v of values) {
    if (Math.abs(v - target) < Math.abs(best - target)) best = v;
  }
  return best;
}

/**
 * The anchors a route offers for blurring: its recognised waiting points, and
 * its zone centres as the always-present fallback. `remainingOf` maps a
 * location to its remaining distance for the direction in question.
 */
export function blurAnchors(
  waitPoints: WaitPoint[],
  zones: Zone[],
  remainingOf: (p: { lat: number; lng: number }) => number,
): number[] {
  return [
    ...waitPoints.map((w) => remainingOf(w.location)),
    ...zones.map((z) => remainingOf(z.centre)),
  ];
}

/** Aggregate cells thinner than k are suppressed rather than reported (§6.3). */
export function suppressCell(count: number, k: number): boolean {
  return count < k;
}
