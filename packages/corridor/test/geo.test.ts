import test from "node:test";
import assert from "node:assert/strict";
import { haversineM, indexPath, nearestOnPath } from "../src/geo.ts";

const IRBID = { lat: 32.5556, lng: 35.8497 };

test("haversine matches a known one-degree-of-latitude span", () => {
  const north = { lat: IRBID.lat + 1, lng: IRBID.lng };
  // One degree of latitude is ~111.2 km everywhere.
  assert.ok(Math.abs(haversineM(IRBID, north) - 111_195) < 200);
});

test("haversine is zero for identical points and symmetric", () => {
  assert.equal(haversineM(IRBID, IRBID), 0);
  const b = { lat: 32.66, lng: 35.74 };
  assert.ok(Math.abs(haversineM(IRBID, b) - haversineM(b, IRBID)) < 1e-6);
});

test("cumulative distances along a path sum the segments", () => {
  const a = { lat: 32.5, lng: 35.8 };
  const b = { lat: 32.6, lng: 35.8 };
  const c = { lat: 32.7, lng: 35.8 };
  const idx = indexPath([a, b, c]);
  assert.equal(idx.cumulativeM[0], 0);
  assert.ok(Math.abs(idx.cumulativeM[1] - haversineM(a, b)) < 1e-6);
  assert.ok(Math.abs(idx.totalM - (haversineM(a, b) + haversineM(b, c))) < 1e-6);
});

test("a point on the path projects onto it with no offset", () => {
  const idx = indexPath([
    { lat: 32.5, lng: 35.8 },
    { lat: 32.7, lng: 35.8 },
  ]);
  const midpoint = { lat: 32.6, lng: 35.8 };
  const fix = nearestOnPath(midpoint, idx);
  assert.ok(fix.offsetM < 1, `offset was ${fix.offsetM}`);
  assert.ok(Math.abs(fix.alongM - idx.totalM / 2) < 5);
});

test("a point beside the path reports the perpendicular distance", () => {
  const idx = indexPath([
    { lat: 32.5, lng: 35.8 },
    { lat: 32.7, lng: 35.8 },
  ]);
  // ~0.01 degrees of longitude east, at this latitude roughly 937 m.
  const beside = { lat: 32.6, lng: 35.81 };
  const fix = nearestOnPath(beside, idx);
  assert.ok(fix.offsetM > 800 && fix.offsetM < 1100, `offset was ${fix.offsetM}`);
});

test("projection clamps to the ends rather than running past them", () => {
  const idx = indexPath([
    { lat: 32.5, lng: 35.8 },
    { lat: 32.7, lng: 35.8 },
  ]);
  const beforeStart = { lat: 32.4, lng: 35.8 };
  const afterEnd = { lat: 32.8, lng: 35.8 };
  assert.equal(nearestOnPath(beforeStart, idx).alongM, 0);
  assert.ok(Math.abs(nearestOnPath(afterEnd, idx).alongM - idx.totalM) < 1);
});
