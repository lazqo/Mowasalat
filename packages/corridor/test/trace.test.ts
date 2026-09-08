import test from "node:test";
import assert from "node:assert/strict";
import { indexPath, nearestOnPath } from "../src/geo.ts";
import {
  corridorFromTraces,
  pathLengthM,
  simplifyPath,
  suggestCorridorWidthM,
  thin,
} from "../src/trace.ts";
import type { LatLng } from "../src/types.ts";

/** A straight drive north, sampled densely, with a little GPS noise. */
function straightTrace(n: number, jitterM = 0): LatLng[] {
  const out: LatLng[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    // ~0.00001 degrees is about 1.1 m of latitude.
    const jitter = jitterM === 0 ? 0 : (((i * 7919) % 11) / 11 - 0.5) * jitterM * 0.00001;
    out.push({ lat: 32.5 + 0.2 * t, lng: 35.8 + jitter });
  }
  return out;
}

test("a straight line simplifies to its endpoints", () => {
  const simplified = simplifyPath(straightTrace(200), 30);
  assert.equal(simplified.length, 2);
});

test("simplifying keeps a real bend", () => {
  const bent: LatLng[] = [
    { lat: 32.5, lng: 35.8 },
    { lat: 32.55, lng: 35.85 },
    { lat: 32.6, lng: 35.8 },
  ];
  assert.equal(simplifyPath(bent, 30).length, 3);
});

test("simplifying preserves the endpoints and shortens the path", () => {
  const trace = straightTrace(500, 20);
  const simplified = simplifyPath(trace, 30);
  assert.deepEqual(simplified[0], trace[0]);
  assert.deepEqual(simplified[simplified.length - 1], trace[trace.length - 1]);
  assert.ok(simplified.length < trace.length / 10, `kept ${simplified.length} of ${trace.length}`);
});

test("simplifying does not move the road", () => {
  const trace = straightTrace(300, 15);
  const simplified = simplifyPath(trace, 30);
  const idx = indexPath(simplified);
  for (const p of trace) {
    assert.ok(nearestOnPath(p, idx).offsetM <= 30 + 1e-6);
  }
});

test("thinning removes stationary jitter", () => {
  const parked: LatLng[] = Array.from({ length: 50 }, (_, i) => ({
    lat: 32.5 + i * 1e-6,
    lng: 35.8,
  }));
  assert.ok(thin(parked, 25).length <= 2);
});

test("a short trace is returned unchanged", () => {
  const two = [{ lat: 32.5, lng: 35.8 }, { lat: 32.6, lng: 35.8 }];
  assert.deepEqual(simplifyPath(two, 30), two);
});

test("width is suggested from how far drivers actually stray", () => {
  const reference = [{ lat: 32.5, lng: 35.8 }, { lat: 32.7, lng: 35.8 }];
  // A parallel road roughly 470 m to the east.
  const sideRoad: LatLng[] = Array.from({ length: 20 }, (_, i) => ({
    lat: 32.5 + 0.01 * i,
    lng: 35.805,
  }));

  const s = suggestCorridorWidthM(reference, [sideRoad]);
  assert.ok(s.widthM >= 600, `suggested ${s.widthM}`);
  assert.ok(s.widthM <= 800, `suggested ${s.widthM}`);
  assert.equal(s.samples, 20);
});

test("one stray driver does not inflate the corridor", () => {
  const reference = [{ lat: 32.5, lng: 35.8 }, { lat: 32.7, lng: 35.8 }];
  const onRoad: LatLng[] = Array.from({ length: 99 }, (_, i) => ({
    lat: 32.5 + 0.002 * i,
    lng: 35.8,
  }));
  const wayOff: LatLng[] = [{ lat: 32.6, lng: 35.95 }]; // ~14 km away

  const s = suggestCorridorWidthM(reference, [onRoad, wayOff]);
  assert.ok(s.maxOffsetM > 10_000, "the outlier was seen");
  assert.ok(s.widthM < 1_000, `but did not set the width: ${s.widthM}`);
});

test("width never falls below the floor", () => {
  const reference = [{ lat: 32.5, lng: 35.8 }, { lat: 32.7, lng: 35.8 }];
  const s = suggestCorridorWidthM(reference, [reference]);
  assert.equal(s.widthM, 300);
});

test("a corridor is built from recorded drives", () => {
  const traces = [straightTrace(300, 10), straightTrace(300, 40)];
  const { corridor, width } = corridorFromTraces(traces, {
    originNameAr: "إربد",
    destinationNameAr: "ملكا",
  });

  assert.equal(corridor.referencePaths.length, 1);
  assert.ok(corridor.referencePaths[0].length >= 2);
  assert.equal(corridor.zones.length, 2);
  assert.equal(corridor.zones[0].kind, "origin_hub");
  assert.equal(corridor.zones[1].kind, "destination");
  assert.ok(corridor.widthM >= 300);
  assert.ok(width.samples > 0);
  assert.ok(pathLengthM(corridor.referencePaths[0]) > 20_000);
});

test("building from no usable trace fails clearly", () => {
  assert.throws(() => corridorFromTraces([[{ lat: 32.5, lng: 35.8 }]], {
    originNameAr: "إربد",
    destinationNameAr: "ملكا",
  }), /at least one trace/);
});
