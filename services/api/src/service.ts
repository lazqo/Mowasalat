/**
 * The domain layer: everything the API does, with no HTTP in sight.
 *
 * Kept framework-independent on purpose. The transport in http.ts is a thin
 * shell, so wrapping these same services in Fastify or NestJS later is a
 * transport change and touches nothing here.
 */
import { randomUUID } from "node:crypto";
import { rankCandidates, type LiveTrip as MatchTrip, type PassengerFix } from "../../../packages/corridor/src/matching.ts";
import { Counters, hourBucket } from "./counters.ts";
import { createLogger } from "./guard.ts";
import { LiveState, type Clock } from "./live.ts";
import { assertBucketed, BadRequest, type Direction } from "./wire.ts";

export type CountryPolicy = {
  code: string;
  remainingBucketM: number;
  kAnonymityMin: number;
};

export type BusSighting = {
  pseudonym: string;
  remainingM: number;
  zoneSeq: number;
  gapM: number;
  etaSeconds: number | null;
};

export type WaitingPin = {
  /** How many requests this pin represents, never who they are. */
  count: number;
  remainingM: number;
  zoneSeq: number;
};

export class Service {
  private live: LiveState;
  private counters: Counters;
  private policy: CountryPolicy;
  private now: Clock;
  private log: ReturnType<typeof createLogger>;

  constructor(policy: CountryPolicy, now: Clock = () => Date.now(), sink?: (l: string) => void) {
    this.policy = policy;
    this.now = now;
    this.live = new LiveState(now);
    this.counters = new Counters();
    this.log = createLogger(sink);
  }

  // --- driver ------------------------------------------------------------

  /**
   * Starts a trip. Returns a secret token the driver's phone keeps, and a
   * public pseudonym that rotates with every trip, so a bus cannot be followed
   * from one day to the next (§6.4).
   */
  startTrip(routeId: string, dir: Direction): { tripToken: string; pseudonym: string } {
    const tripToken = randomUUID();
    const pseudonym = randomUUID().slice(0, 8);
    this.live.startTrip(tripToken, pseudonym);
    this.counters.increment("line_health", {
      routeId,
      dir,
      hourBucket: hourBucket(this.now()),
      outcome: "started",
    });
    this.log("trip started", { routeId, dir });
    return { tripToken, pseudonym };
  }

  updateProgress(
    tripToken: string,
    routeId: string,
    dir: Direction,
    remainingM: number,
    zoneSeq: number,
    speedKph: number,
  ): void {
    assertBucketed(remainingM, this.policy.remainingBucketM);
    const updated = this.live.updateTrip(tripToken, { routeId, dir, remainingM, zoneSeq, speedKph });
    if (!updated) throw new BadRequest("unknown or ended trip");
    this.counters.increment("demand", { routeId, dir, zoneSeq, hourBucket: hourBucket(this.now()) }, 0);
  }

  /**
   * Recorded when a driver's phone finds itself outside the corridor. This is
   * the signal that a corridor is drawn too tight, and it is why deviation is
   * treated as our modelling error rather than the driver's fault (§9.3).
   */
  reportOffCorridor(routeId: string, zoneSeq: number): void {
    this.counters.increment("corridor_fit", {
      routeId,
      zoneSeq,
      hourBucket: hourBucket(this.now()),
      outcome: "off_corridor",
    });
  }

  endTrip(tripToken: string, routeId?: string, dir?: Direction): void {
    if (!this.live.endTrip(tripToken)) throw new BadRequest("unknown or ended trip");
    if (routeId !== undefined && dir !== undefined) {
      this.counters.increment("line_health", {
        routeId,
        dir,
        hourBucket: hourBucket(this.now()),
        outcome: "completed",
      });
    }
  }

  /** What a driver sees: waiting passengers ahead of him, as counts, never identities. */
  waitingAhead(tripToken: string, windowM = 15_000): WaitingPin[] {
    const pseudonym = this.live.pseudonymFor(tripToken);
    if (!pseudonym) throw new BadRequest("unknown or ended trip");

    // A trip that has not reported progress yet has no position, so there is
    // nothing ahead of it to show.
    const mine = this.live.tripByPseudonym(pseudonym);
    if (!mine) return [];

    return this.pinsFor(mine.routeId, mine.dir, mine.remainingM, windowM);
  }

  pinsFor(routeId: string, dir: Direction, driverRemainingM: number, windowM: number): WaitingPin[] {
    const ahead = this.live
      .requestsOn(routeId, dir)
      .filter((r) => r.remainingM < driverRemainingM && driverRemainingM - r.remainingM <= windowM);

    const byCell = new Map<string, WaitingPin>();
    for (const r of ahead) {
      const key = `${r.zoneSeq}|${r.remainingM}`;
      const pin = byCell.get(key);
      if (pin) pin.count += 1;
      else byCell.set(key, { count: 1, remainingM: r.remainingM, zoneSeq: r.zoneSeq });
    }
    return [...byCell.values()].sort((a, b) => b.remainingM - a.remainingM);
  }

  // --- passenger ---------------------------------------------------------

  /** Buses that will pass this passenger, soonest first. */
  findBuses(routeId: string, dir: Direction, remainingM: number, zoneSeq: number): BusSighting[] {
    assertBucketed(remainingM, this.policy.remainingBucketM);

    const pax: PassengerFix = { routeId, dir, remainingM, zoneSeq };
    const trips: MatchTrip[] = this.live.tripsOn(routeId, dir).map((t) => ({
      pseudonym: t.pseudonym,
      routeId: t.routeId,
      dir: t.dir,
      remainingM: t.remainingM,
      zoneSeq: t.zoneSeq,
      speedKph: t.speedKph,
    }));

    const ranked = rankCandidates(trips, pax);
    if (ranked.length === 0) {
      this.counters.increment("coverage_gap", {
        routeId,
        dir,
        zoneSeq,
        hourBucket: hourBucket(this.now()),
        outcome: "empty",
      });
    }

    return ranked.map((c) => ({
      pseudonym: c.trip.pseudonym,
      remainingM: c.trip.remainingM,
      zoneSeq: c.trip.zoneSeq,
      gapM: c.gapM,
      etaSeconds: c.etaSeconds,
    }));
  }

  /** Records that nobody serves a destination someone searched for. The expansion signal (§6.3). */
  recordUnservedSearch(area: string, destinationId: string): void {
    this.counters.increment("unserved", {
      area,
      destinationId,
      hourBucket: hourBucket(this.now()),
    });
  }

  createRequest(
    routeId: string,
    dir: Direction,
    destinationId: string,
    remainingM: number,
    zoneSeq: number,
  ): { pseudonym: string } {
    assertBucketed(remainingM, this.policy.remainingBucketM);
    // A fresh pseudonym per request, not per device: two requests by the same
    // person on consecutive days are not linkable here (§6.4).
    const pseudonym = randomUUID().slice(0, 8);
    this.live.addRequest({ pseudonym, routeId, dir, destinationId, remainingM, zoneSeq });
    this.counters.increment("demand", { routeId, dir, zoneSeq, hourBucket: hourBucket(this.now()) });
    return { pseudonym };
  }

  cancelRequest(pseudonym: string): boolean {
    return this.live.cancelRequest(pseudonym);
  }

  boarded(pseudonym: string, routeId: string, dir: Direction): void {
    this.live.cancelRequest(pseudonym);
    this.counters.increment("match_quality", {
      routeId,
      dir,
      hourBucket: hourBucket(this.now()),
      outcome: "matched",
    });
  }

  // --- ops ---------------------------------------------------------------

  /** Aggregates, with thin cells suppressed. */
  report(): { cell: string; count: number }[] {
    return this.counters.report(this.policy.kAnonymityMin);
  }

  liveCounts(): { trips: number; requests: number } {
    return this.live.counts();
  }
}
