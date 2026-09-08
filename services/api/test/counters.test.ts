import test from "node:test";
import assert from "node:assert/strict";
import { Counters, hourBucket, PersonalDimension } from "../src/counters.ts";

const HOUR = hourBucket(1_700_000_000_000);

test("counting a person is refused at the point of writing", () => {
  const c = new Counters();
  // The rule from the plan, enforced rather than intended: a counter may not be
  // keyed by anything that identifies someone, a rotating token included.
  assert.throws(
    () => c.increment("demand", { hourBucket: HOUR, pseudonym: "p1" } as never),
    PersonalDimension,
  );
  assert.throws(
    () => c.increment("demand", { hourBucket: HOUR, deviceId: "d" } as never),
    PersonalDimension,
  );
});

test("a thin cell is suppressed rather than reported", () => {
  const c = new Counters();
  const dims = { routeId: "r", dir: 0 as const, zoneSeq: 1, hourBucket: HOUR };
  c.increment("demand", dims);
  c.increment("demand", dims);
  c.increment("demand", dims);

  assert.equal(c.read("demand", dims, 4), null, "3 events, k=4, so nothing is returned");
  c.increment("demand", dims);
  assert.equal(c.read("demand", dims, 4), 4);
});

test("thin cells are absent from the report, not merely marked", () => {
  const c = new Counters();
  const thin = { routeId: "quiet", hourBucket: HOUR };
  const busy = { routeId: "busy", hourBucket: HOUR };
  c.increment("demand", thin);
  for (let i = 0; i < 10; i++) c.increment("demand", busy);

  const report = c.report(4);
  assert.equal(report.length, 1);
  assert.match(report[0].cell, /busy/);
  assert.equal(report[0].count, 10);
});

test("cells are distinguished by their dimensions", () => {
  const c = new Counters();
  for (let i = 0; i < 5; i++) {
    c.increment("demand", { routeId: "r", zoneSeq: 1, hourBucket: HOUR });
    c.increment("demand", { routeId: "r", zoneSeq: 2, hourBucket: HOUR });
  }
  assert.equal(c.read("demand", { routeId: "r", zoneSeq: 1, hourBucket: HOUR }, 4), 5);
  assert.equal(c.read("demand", { routeId: "r", zoneSeq: 2, hourBucket: HOUR }, 4), 5);
});

test("the unserved-demand signal records a destination nobody serves", () => {
  const c = new Counters();
  for (let i = 0; i < 6; i++) {
    c.increment("unserved", { area: "irbid-north", destinationId: "jo-somewhere", hourBucket: HOUR });
  }
  assert.equal(
    c.read("unserved", { area: "irbid-north", destinationId: "jo-somewhere", hourBucket: HOUR }, 4),
    6,
  );
});
