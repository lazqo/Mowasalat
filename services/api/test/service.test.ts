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

test("a passenger sees a bus that will pass her, with an eta", async () => {
  const svc = new Service(JO);
  const { tripToken } = await svc.startTrip(ROUTE, 0);
  await svc.updateProgress(tripToken, ROUTE, 0, 8_000, 2, 40);

  const buses = await svc.findBuses(ROUTE, 0, 5_000, 1);
  assert.equal(buses.length, 1);
  assert.equal(buses[0].gapM, 3_000);
  assert.ok(Math.abs(buses[0].etaSeconds! - 270) < 1);
});

test("a bus that has already gone past her is not offered", async () => {
  const svc = new Service(JO);
  const { tripToken } = await svc.startTrip(ROUTE, 0);
  await svc.updateProgress(tripToken, ROUTE, 0, 3_000, 1, 40);
  assert.equal((await svc.findBuses(ROUTE, 0, 5_000, 1)).length, 0);
});

test("a driver sees waiting passengers ahead of him, as counts", async () => {
  const svc = new Service(JO);
  const { tripToken } = await svc.startTrip(ROUTE, 0);
  await svc.updateProgress(tripToken, ROUTE, 0, 10_000, 2, 40);

  await svc.createRequest(ROUTE, 0, "jo-malka", 6_000, 1);
  await svc.createRequest(ROUTE, 0, "jo-malka", 6_000, 1);
  await svc.createRequest(ROUTE, 0, "jo-malka", 2_000, 1);
  await svc.createRequest(ROUTE, 0, "jo-malka", 12_000, 3); // behind him

  const pins = await svc.waitingAhead(tripToken);
  assert.equal(pins.length, 2, "two distinct places ahead");
  assert.equal(pins[0].remainingM, 6_000);
  assert.equal(pins[0].count, 2, "two people at the same place become one pin with a count");
  assert.ok(!("pseudonym" in pins[0]), "a pin carries no identity");
});

test("a trip that has not reported progress has nothing ahead of it", async () => {
  const svc = new Service(JO);
  const { tripToken } = await svc.startTrip(ROUTE, 0);
  assert.deepEqual(await svc.waitingAhead(tripToken), []);
});

test("progress and ending are refused for an unknown trip", async () => {
  const svc = new Service(JO);
  await assert.rejects(() => svc.updateProgress("nope", ROUTE, 0, 1_000, 1, 40), BadRequest);
  await assert.rejects(() => svc.endTrip("nope"), BadRequest);
  await assert.rejects(() => svc.waitingAhead("nope"), BadRequest);
});

test("a position finer than the country's band is refused everywhere", async () => {
  const svc = new Service(JO);
  const { tripToken } = await svc.startTrip(ROUTE, 0);
  await assert.rejects(() => svc.updateProgress(tripToken, ROUTE, 0, 8_123, 2, 40), BadRequest);
  await assert.rejects(() => svc.findBuses(ROUTE, 0, 5_123, 1), BadRequest);
  await assert.rejects(() => svc.createRequest(ROUTE, 0, "jo-malka", 5_123, 1), BadRequest);
});

test("each trip gets a fresh pseudonym, so a bus cannot be followed across days", async () => {
  const svc = new Service(JO);
  const monday = await svc.startTrip(ROUTE, 0);
  await svc.endTrip(monday.tripToken);
  const tuesday = await svc.startTrip(ROUTE, 0);
  assert.notEqual(monday.pseudonym, tuesday.pseudonym);
});

test("each request gets its own pseudonym, so two requests are not linkable", async () => {
  const svc = new Service(JO);
  const first = await svc.createRequest(ROUTE, 0, "jo-malka", 5_000, 1);
  const second = await svc.createRequest(ROUTE, 0, "jo-malka", 5_000, 1);
  assert.notEqual(first.pseudonym, second.pseudonym);
});

test("a trip leaves nothing behind once it ends", async () => {
  const svc = new Service(JO);
  const { tripToken } = await svc.startTrip(ROUTE, 0);
  await svc.updateProgress(tripToken, ROUTE, 0, 8_000, 2, 40);
  assert.equal((await svc.liveCounts()).trips, 1);

  await svc.endTrip(tripToken, ROUTE, 0);
  assert.equal((await svc.liveCounts()).trips, 0);
  assert.equal((await svc.findBuses(ROUTE, 0, 5_000, 1)).length, 0);
});

test("a bus that goes silent drops out on its own", async () => {
  const c = clock();
  const svc = new Service(JO, c.now);
  const { tripToken } = await svc.startTrip(ROUTE, 0);
  await svc.updateProgress(tripToken, ROUTE, 0, 8_000, 2, 40);

  c.advance(61_000);
  assert.equal((await svc.findBuses(ROUTE, 0, 5_000, 1)).length, 0);
});

test("aggregates suppress thin cells", async () => {
  const svc = new Service(JO);
  svc.recordUnservedSearch("irbid-north", "jo-somewhere");
  assert.equal(svc.report().length, 0, "one search is not reportable");

  for (let i = 0; i < 5; i++) svc.recordUnservedSearch("irbid-north", "jo-somewhere");
  const report = svc.report();
  assert.ok(report.some((r) => r.cell.includes("jo-somewhere")));
});

test("nothing the service logs during a whole trip carries a coordinate", async () => {
  // The system-level property, checked end to end rather than per module: this
  // is the Phase 2 exit criterion in docs/PLAN.md §12.
  const lines: string[] = [];
  const svc = new Service(JO, () => 1_700_000_000_000, (l) => lines.push(l));

  const { tripToken } = await svc.startTrip(ROUTE, 0);
  await svc.updateProgress(tripToken, ROUTE, 0, 8_000, 2, 40);
  await svc.createRequest(ROUTE, 0, "jo-malka", 5_000, 1);
  await svc.findBuses(ROUTE, 0, 5_000, 1);
  await svc.waitingAhead(tripToken);
  svc.reportOffCorridor(ROUTE, 2);
  await svc.endTrip(tripToken, ROUTE, 0);

  assert.ok(lines.length > 0, "the service did log something");
  for (const line of lines) {
    assert.doesNotMatch(line, /\blat\b|\blng\b|latitude|longitude|32\.\d{4}|35\.\d{4}/i, line);
  }
});

test("a caller who tries to log a coordinate is stopped", async () => {
  const svc = new Service(JO, () => 1_700_000_000_000, () => {});
  // Reaching into the logger the way a careless debug line would.
  const log = (svc as unknown as { log: (m: string, c?: Record<string, unknown>) => void }).log;
  assert.throws(() => log("debug", { lat: 32.5556, lng: 35.8497 }), CoordinateLeak);
});
