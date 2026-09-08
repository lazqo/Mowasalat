import test from "node:test";
import assert from "node:assert/strict";
import { CoordinateLeak } from "../src/guard.ts";
import { Service, type CountryPolicy } from "../src/service.ts";
import { BadRequest } from "../src/wire.ts";

const JO: CountryPolicy = { code: "JO", remainingBucketM: 250, kAnonymityMin: 4 };
const ROUTE = "jo-irbid-malka";

function clock() {
  let t = 1_700_000_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test("a passenger sees a bus that will pass her, with an eta", () => {
  const svc = new Service(JO);
  const { tripToken } = svc.startTrip(ROUTE, 0);
  svc.updateProgress(tripToken, ROUTE, 0, 8_000, 2, 40);

  const buses = svc.findBuses(ROUTE, 0, 5_000, 1);
  assert.equal(buses.length, 1);
  assert.equal(buses[0].gapM, 3_000);
  assert.ok(Math.abs(buses[0].etaSeconds! - 270) < 1);
});

test("a bus that has already gone past her is not offered", () => {
  const svc = new Service(JO);
  const { tripToken } = svc.startTrip(ROUTE, 0);
  svc.updateProgress(tripToken, ROUTE, 0, 3_000, 1, 40);
  assert.equal(svc.findBuses(ROUTE, 0, 5_000, 1).length, 0);
});

test("a driver sees waiting passengers ahead of him, as counts", () => {
  const svc = new Service(JO);
  const { tripToken } = svc.startTrip(ROUTE, 0);
  svc.updateProgress(tripToken, ROUTE, 0, 10_000, 2, 40);

  svc.createRequest(ROUTE, 0, "jo-malka", 6_000, 1);
  svc.createRequest(ROUTE, 0, "jo-malka", 6_000, 1);
  svc.createRequest(ROUTE, 0, "jo-malka", 2_000, 1);
  svc.createRequest(ROUTE, 0, "jo-malka", 12_000, 3); // behind him

  const pins = svc.waitingAhead(tripToken);
  assert.equal(pins.length, 2, "two distinct places ahead");
  assert.equal(pins[0].remainingM, 6_000);
  assert.equal(pins[0].count, 2, "two people at the same place become one pin with a count");
  assert.ok(!("pseudonym" in pins[0]), "a pin carries no identity");
});

test("a trip that has not reported progress has nothing ahead of it", () => {
  const svc = new Service(JO);
  const { tripToken } = svc.startTrip(ROUTE, 0);
  assert.deepEqual(svc.waitingAhead(tripToken), []);
});

test("progress and ending are refused for an unknown trip", () => {
  const svc = new Service(JO);
  assert.throws(() => svc.updateProgress("nope", ROUTE, 0, 1_000, 1, 40), BadRequest);
  assert.throws(() => svc.endTrip("nope"), BadRequest);
  assert.throws(() => svc.waitingAhead("nope"), BadRequest);
});

test("a position finer than the country's band is refused everywhere", () => {
  const svc = new Service(JO);
  const { tripToken } = svc.startTrip(ROUTE, 0);
  assert.throws(() => svc.updateProgress(tripToken, ROUTE, 0, 8_123, 2, 40), BadRequest);
  assert.throws(() => svc.findBuses(ROUTE, 0, 5_123, 1), BadRequest);
  assert.throws(() => svc.createRequest(ROUTE, 0, "jo-malka", 5_123, 1), BadRequest);
});

test("each trip gets a fresh pseudonym, so a bus cannot be followed across days", () => {
  const svc = new Service(JO);
  const monday = svc.startTrip(ROUTE, 0);
  svc.endTrip(monday.tripToken);
  const tuesday = svc.startTrip(ROUTE, 0);
  assert.notEqual(monday.pseudonym, tuesday.pseudonym);
});

test("each request gets its own pseudonym, so two requests are not linkable", () => {
  const svc = new Service(JO);
  const first = svc.createRequest(ROUTE, 0, "jo-malka", 5_000, 1);
  const second = svc.createRequest(ROUTE, 0, "jo-malka", 5_000, 1);
  assert.notEqual(first.pseudonym, second.pseudonym);
});

test("a trip leaves nothing behind once it ends", () => {
  const svc = new Service(JO);
  const { tripToken } = svc.startTrip(ROUTE, 0);
  svc.updateProgress(tripToken, ROUTE, 0, 8_000, 2, 40);
  assert.equal(svc.liveCounts().trips, 1);

  svc.endTrip(tripToken, ROUTE, 0);
  assert.equal(svc.liveCounts().trips, 0);
  assert.equal(svc.findBuses(ROUTE, 0, 5_000, 1).length, 0);
});

test("a bus that goes silent drops out on its own", () => {
  const c = clock();
  const svc = new Service(JO, c.now);
  const { tripToken } = svc.startTrip(ROUTE, 0);
  svc.updateProgress(tripToken, ROUTE, 0, 8_000, 2, 40);

  c.advance(61_000);
  assert.equal(svc.findBuses(ROUTE, 0, 5_000, 1).length, 0);
});

test("aggregates suppress thin cells", () => {
  const svc = new Service(JO);
  svc.recordUnservedSearch("irbid-north", "jo-somewhere");
  assert.equal(svc.report().length, 0, "one search is not reportable");

  for (let i = 0; i < 5; i++) svc.recordUnservedSearch("irbid-north", "jo-somewhere");
  const report = svc.report();
  assert.ok(report.some((r) => r.cell.includes("jo-somewhere")));
});

test("nothing the service logs during a whole trip carries a coordinate", () => {
  // The system-level property, checked end to end rather than per module: this
  // is the Phase 2 exit criterion in docs/PLAN.md §12.
  const lines: string[] = [];
  const svc = new Service(JO, () => 1_700_000_000_000, (l) => lines.push(l));

  const { tripToken } = svc.startTrip(ROUTE, 0);
  svc.updateProgress(tripToken, ROUTE, 0, 8_000, 2, 40);
  svc.createRequest(ROUTE, 0, "jo-malka", 5_000, 1);
  svc.findBuses(ROUTE, 0, 5_000, 1);
  svc.waitingAhead(tripToken);
  svc.reportOffCorridor(ROUTE, 2);
  svc.endTrip(tripToken, ROUTE, 0);

  assert.ok(lines.length > 0, "the service did log something");
  for (const line of lines) {
    assert.doesNotMatch(line, /\blat\b|\blng\b|latitude|longitude|32\.\d{4}|35\.\d{4}/i, line);
  }
});

test("a caller who tries to log a coordinate is stopped", () => {
  const svc = new Service(JO, () => 1_700_000_000_000, () => {});
  // Reaching into the logger the way a careless debug line would.
  const log = (svc as unknown as { log: (m: string, c?: Record<string, unknown>) => void }).log;
  assert.throws(() => log("debug", { lat: 32.5556, lng: 35.8497 }), CoordinateLeak);
});
