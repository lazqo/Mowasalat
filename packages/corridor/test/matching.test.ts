import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MATCH_OPTIONS, etaSeconds, rankCandidates, willPass } from "../src/matching.ts";
import type { LiveTrip, PassengerFix } from "../src/types.ts";

const pax: PassengerFix = { routeId: "jo-irbid-malka", dir: 0, remainingM: 5_000, zoneSeq: 1 };

function trip(over: Partial<LiveTrip>): LiveTrip {
  return {
    pseudonym: "t1",
    routeId: "jo-irbid-malka",
    dir: 0,
    remainingM: 8_000,
    zoneSeq: 1,
    speedKph: 40,
    ...over,
  };
}

test("a bus with further to go will pass the passenger", () => {
  assert.equal(willPass(trip({ remainingM: 8_000 }), pax), true);
});

test("a bus that has already passed her is excluded", () => {
  assert.equal(willPass(trip({ remainingM: 3_000 }), pax), false);
});

test("a bus level with her is excluded rather than counted as arriving", () => {
  assert.equal(willPass(trip({ remainingM: 5_000 }), pax), false);
});

test("a bus running the other direction is excluded", () => {
  assert.equal(willPass(trip({ dir: 1 }), pax), false);
});

test("a bus on another line is excluded", () => {
  assert.equal(willPass(trip({ routeId: "jo-irbid-umm-qais" }), pax), false);
});

test("eta is the gap over the speed", () => {
  // 3 km at 40 km/h is 270 seconds.
  assert.ok(Math.abs(etaSeconds(3_000, 40, 3)! - 270) < 0.5);
});

test("a stopped bus reports no eta rather than an absurd one", () => {
  assert.equal(etaSeconds(3_000, 0, 3), null);
});

test("candidates come back soonest first", () => {
  const trips = [
    trip({ pseudonym: "far", remainingM: 14_000 }),
    trip({ pseudonym: "near", remainingM: 6_000 }),
    trip({ pseudonym: "mid", remainingM: 9_000 }),
  ];
  const ranked = rankCandidates(trips, pax);
  assert.deepEqual(
    ranked.map((c) => c.trip.pseudonym),
    ["near", "mid", "far"],
  );
  assert.equal(ranked[0].gapM, 1_000);
});

test("buses beyond the window are dropped", () => {
  const trips = [trip({ pseudonym: "beyond", remainingM: 5_000 + DEFAULT_MATCH_OPTIONS.windowM + 1 })];
  assert.equal(rankCandidates(trips, pax).length, 0);
});

test("no candidates yields an empty list rather than an error", () => {
  assert.deepEqual(rankCandidates([], pax), []);
});
