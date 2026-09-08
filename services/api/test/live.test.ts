import test from "node:test";
import assert from "node:assert/strict";
import { LiveState, REQUEST_TTL_MS, TRIP_TTL_MS } from "../src/live.ts";

function atClock() {
  let t = 1_700_000_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test("a bus that stops reporting disappears after the ttl", () => {
  const clock = atClock();
  const live = new LiveState(clock.now);

  live.startTrip("token", "bus1");
  live.updateTrip("token", { routeId: "r", dir: 0, remainingM: 8_000, zoneSeq: 1, speedKph: 40 });
  assert.equal(live.tripsOn("r", 0).length, 1);

  clock.advance(TRIP_TTL_MS - 1);
  assert.equal(live.tripsOn("r", 0).length, 1, "still live just before expiry");

  clock.advance(2);
  assert.equal(live.tripsOn("r", 0).length, 0, "gone, with no history left behind");
});

test("progress for an unknown or ended trip is refused", () => {
  const live = new LiveState();
  assert.equal(
    live.updateTrip("nope", { routeId: "r", dir: 0, remainingM: 1, zoneSeq: 0, speedKph: 1 }),
    null,
  );
});

test("ending a trip removes it immediately", () => {
  const live = new LiveState();
  live.startTrip("token", "bus1");
  live.updateTrip("token", { routeId: "r", dir: 0, remainingM: 8_000, zoneSeq: 1, speedKph: 40 });

  assert.equal(live.endTrip("token"), true);
  assert.equal(live.tripsOn("r", 0).length, 0);
  assert.equal(live.pseudonymFor("token"), undefined, "the token mapping is gone too");
  assert.equal(live.endTrip("token"), false);
});

test("trips are separated by direction", () => {
  const live = new LiveState();
  live.startTrip("a", "bus-a");
  live.updateTrip("a", { routeId: "r", dir: 0, remainingM: 8_000, zoneSeq: 1, speedKph: 40 });
  live.startTrip("b", "bus-b");
  live.updateTrip("b", { routeId: "r", dir: 1, remainingM: 8_000, zoneSeq: 1, speedKph: 40 });

  assert.equal(live.tripsOn("r", 0).length, 1);
  assert.equal(live.tripsOn("r", 1).length, 1);
});

test("a waiting request expires on its own", () => {
  const clock = atClock();
  const live = new LiveState(clock.now);
  live.addRequest({ pseudonym: "p1", routeId: "r", dir: 0, destinationId: "d", remainingM: 5_000, zoneSeq: 1 });

  assert.equal(live.requestsOn("r", 0).length, 1);
  clock.advance(REQUEST_TTL_MS + 1);
  assert.equal(live.requestsOn("r", 0).length, 0);
});

test("cancelling a request removes it at once", () => {
  const live = new LiveState();
  live.addRequest({ pseudonym: "p1", routeId: "r", dir: 0, destinationId: "d", remainingM: 5_000, zoneSeq: 1 });
  assert.equal(live.cancelRequest("p1"), true);
  assert.equal(live.requestsOn("r", 0).length, 0);
});
