import test from "node:test";
import assert from "node:assert/strict";
import { assertNoCoordinates, CoordinateLeak, createLogger } from "../src/guard.ts";

test("a plain scalar payload passes", () => {
  assertNoCoordinates({ routeId: "jo-irbid-malka", dir: 0, remainingM: 5_000, zoneSeq: 1 });
});

test("a latitude anywhere in the object is caught", () => {
  assert.throws(() => assertNoCoordinates({ lat: 32.5556 }), CoordinateLeak);
  assert.throws(() => assertNoCoordinates({ trip: { gps: { lng: 35.8 } } }), CoordinateLeak);
  assert.throws(() => assertNoCoordinates({ pins: [{ ok: 1 }, { location: {} }] }), CoordinateLeak);
});

test("the error names where the leak was", () => {
  try {
    assertNoCoordinates({ trip: { position: 1 } });
    assert.fail("should have thrown");
  } catch (err) {
    assert.equal((err as CoordinateLeak).path, "$.trip.position");
  }
});

test("the logger refuses to write a coordinate", () => {
  const lines: string[] = [];
  const log = createLogger((l) => lines.push(l));

  log("trip started", { routeId: "jo-irbid-malka", dir: 0 });
  assert.equal(lines.length, 1);

  // The failure mode this exists to prevent: someone logs the raw fix.
  assert.throws(() => log("debug", { latitude: 32.5, longitude: 35.8 }), CoordinateLeak);
  assert.equal(lines.length, 1, "nothing was written");
});
