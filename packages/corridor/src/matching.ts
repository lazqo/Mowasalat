import type { LiveTrip, PassengerFix } from "./types.ts";

export type Candidate = {
  trip: LiveTrip;
  /** How far the bus still has to travel before reaching the passenger. */
  gapM: number;
  etaSeconds: number | null;
};

export type MatchOptions = {
  /** Ignore buses further back than this. */
  windowM: number;
  /** Below this speed an ETA is not meaningful; the bus is stopped. */
  minSpeedKph: number;
};

export const DEFAULT_MATCH_OPTIONS: MatchOptions = { windowM: 15_000, minSpeedKph: 3 };

/**
 * A bus will pass a passenger when it still has further to go than she does:
 * the ground she is standing on is ground it has not yet covered.
 */
export function willPass(trip: LiveTrip, pax: PassengerFix): boolean {
  return (
    trip.routeId === pax.routeId && trip.dir === pax.dir && trip.remainingM > pax.remainingM
  );
}

export function gapM(trip: LiveTrip, pax: PassengerFix): number {
  return trip.remainingM - pax.remainingM;
}

export function etaSeconds(gap: number, speedKph: number, minSpeedKph: number): number | null {
  if (speedKph < minSpeedKph) return null;
  return (gap / (speedKph * 1000)) * 3600;
}

/** Buses that will pass this passenger, soonest first. */
export function rankCandidates(
  trips: LiveTrip[],
  pax: PassengerFix,
  opts: MatchOptions = DEFAULT_MATCH_OPTIONS,
): Candidate[] {
  return trips
    .filter((t) => willPass(t, pax) && gapM(t, pax) <= opts.windowM)
    .map((trip) => {
      const gap = gapM(trip, pax);
      return { trip, gapM: gap, etaSeconds: etaSeconds(gap, trip.speedKph, opts.minSpeedKph) };
    })
    .sort((a, b) => a.gapM - b.gapM);
}
