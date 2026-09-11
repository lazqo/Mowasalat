import test from "node:test";
import assert from "node:assert/strict";
import { blurAnchors, bucketRemaining, resolvePublishedRemaining, suppressCell } from "../src/privacy.ts";
import type { WaitPoint, Zone } from "../src/types.ts";

test("remaining distance is rounded down to the band", () => {
  assert.equal(bucketRemaining(5_123, 250), 5_000);
  assert.equal(bucketRemaining(5_250, 250), 5_250);
  assert.equal(bucketRemaining(0, 250), 0);
});

test("an unusable band is rejected rather than silently applied", () => {
  assert.throws(() => bucketRemaining(100, 0));

  // NaN fails every comparison, so a `<= 0` check alone would let an
  // unconfigured band through and quietly produce NaN — an unbucketed position
  // heading for the wire. A privacy control has to fail loudly when it has not
  // been configured.
  assert.throws(() => bucketRemaining(100, Number.NaN), /finite/);
  assert.throws(() => bucketRemaining(100, Number.POSITIVE_INFINITY), /finite/);
  assert.throws(() => bucketRemaining(100, undefined as unknown as number), /finite/);
  assert.throws(() => bucketRemaining(Number.NaN, 250), /finite/);
});

test("with enough people nearby the position is merely bucketed", () => {
  const published = resolvePublishedRemaining(5_123, 6, 4, [4_000, 5_500], 250);
  assert.equal(published, 5_000);
});

test("a lone waiting passenger is snapped to a recognised waiting point", () => {
  // One person on an empty road: publishing her band would identify her, so
  // she is reported at the nearest junction instead (docs/PLAN.md §6.5).
  const published = resolvePublishedRemaining(5_123, 1, 4, [4_000, 5_500], 250);
  assert.equal(published, 5_500);
});

test("she falls back to a zone centre when no waiting point is nearer", () => {
  // Zone centres are always available, so a sparse position always has
  // somewhere coarse to land.
  const published = resolvePublishedRemaining(9_000, 1, 4, [4_000, 5_500, 12_000], 250);
  assert.equal(published, 12_000);
});

test("blurring with nothing to snap to fails loudly rather than publishing", () => {
  // Failing closed matters here: silently publishing a 250 m band for a lone
  // passenger is exactly the outcome the control exists to prevent.
  assert.throws(
    () => resolvePublishedRemaining(5_123, 1, 4, [], 250),
    /no waiting points or zones/,
  );
});

test("anchors combine waiting points with zone centres", () => {
  const waitPoints: WaitPoint[] = [
    { id: "w1", nameAr: "الدوار", location: { lat: 32.6, lng: 35.8 }, zoneSeq: 1 },
  ];
  const zones: Zone[] = [
    { seq: 0, nameAr: "إربد", kind: "origin_hub", centre: { lat: 32.5, lng: 35.8 }, radiusM: 800 },
    { seq: 1, nameAr: "ملكا", kind: "destination", centre: { lat: 32.7, lng: 35.8 }, radiusM: 800 },
  ];
  const anchors = blurAnchors(waitPoints, zones, (p) => p.lat * 1000);
  assert.equal(anchors.length, 3);
});

test("thin aggregate cells are suppressed", () => {
  assert.equal(suppressCell(3, 4), true);
  assert.equal(suppressCell(4, 4), false);
});
