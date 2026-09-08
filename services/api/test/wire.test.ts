import test from "node:test";
import assert from "node:assert/strict";
import { CoordinateLeak } from "../src/guard.ts";
import {
  assertBucketed,
  BadRequest,
  parseRideRequest,
  parseStartTrip,
  parseTripProgress,
} from "../src/wire.ts";

test("a well-formed trip start parses", () => {
  assert.deepEqual(parseStartTrip({ routeId: "jo-irbid-malka", dir: 1 }), {
    routeId: "jo-irbid-malka",
    dir: 1,
  });
});

test("a body carrying a coordinate is rejected as a leak, not a typo", () => {
  assert.throws(
    () => parseStartTrip({ routeId: "jo-irbid-malka", dir: 0, lat: 32.5, lng: 35.8 }),
    CoordinateLeak,
  );
});

test("unknown fields are rejected rather than ignored", () => {
  assert.throws(() => parseStartTrip({ routeId: "r", dir: 0, extra: 1 }), BadRequest);
});

test("missing fields are rejected", () => {
  assert.throws(() => parseStartTrip({ routeId: "r" }), BadRequest);
});

test("direction must be 0 or 1", () => {
  assert.throws(() => parseStartTrip({ routeId: "r", dir: 2 }), BadRequest);
});

test("out-of-range and non-finite numbers are rejected", () => {
  const base = {
    tripToken: "t",
    routeId: "jo-irbid-malka",
    dir: 0 as const,
    remainingM: 1_000,
    zoneSeq: 1,
    speedKph: 40,
  };
  assert.throws(() => parseTripProgress({ ...base, speedKph: -1 }), BadRequest);
  assert.throws(() => parseTripProgress({ ...base, speedKph: 500 }), BadRequest);
  assert.throws(() => parseTripProgress({ ...base, remainingM: Number.NaN }), BadRequest);
  assert.throws(() => parseTripProgress({ ...base, zoneSeq: 1.5 }), BadRequest);
});

test("a ride request parses", () => {
  const body = {
    routeId: "jo-irbid-malka",
    dir: 0 as const,
    destinationId: "jo-malka",
    remainingM: 5_000,
    zoneSeq: 1,
  };
  assert.deepEqual(parseRideRequest(body), body);
});

test("a position finer than policy is refused", () => {
  // Blurring happens on the device, but a modified client could skip it. The
  // server declines to hold a position more precise than it said it would.
  assert.doesNotThrow(() => assertBucketed(5_000, 250));
  assert.throws(() => assertBucketed(5_123, 250), BadRequest);
});
