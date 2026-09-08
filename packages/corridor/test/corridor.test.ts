import test from "node:test";
import assert from "node:assert/strict";
import { indexCorridor, place, remainingM } from "../src/corridor.ts";
import type { Corridor } from "../src/types.ts";

const START = { lat: 32.5, lng: 35.8 };
const END = { lat: 32.7, lng: 35.8 };

const corridor: Corridor = {
  widthM: 750,
  referencePaths: [[START, END]],
  zones: [
    { seq: 0, nameAr: "البداية", kind: "origin_hub", centre: START, radiusM: 800 },
    { seq: 1, nameAr: "الوسط", kind: "intermediate", centre: { lat: 32.6, lng: 35.8 }, radiusM: 500 },
    { seq: 2, nameAr: "النهاية", kind: "destination", centre: END, radiusM: 800 },
  ],
};

test("a point on the road is inside the corridor", () => {
  const ic = indexCorridor(corridor);
  const p = place({ lat: 32.62, lng: 35.8 }, ic);
  assert.equal(p.inside, true);
  assert.ok(p.offsetM < 5);
});

test("a point beyond the corridor width is outside", () => {
  const ic = indexCorridor(corridor);
  // ~1.9 km east of the road, well past the 750 m width.
  const p = place({ lat: 32.6, lng: 35.82 }, ic);
  assert.equal(p.inside, false);
});

test("a driver on a parallel side road stays inside a generous corridor", () => {
  const ic = indexCorridor(corridor);
  // ~470 m off the reference path — the case a 150 m tolerance would have
  // wrongly dropped (docs/PLAN.md §9.3).
  const p = place({ lat: 32.6, lng: 35.805 }, ic);
  assert.equal(p.inside, true);
});

test("remaining distance falls to zero at the destination and is monotonic", () => {
  const ic = indexCorridor(corridor);
  const atStart = remainingM(place(START, ic), ic, 0);
  const atMid = remainingM(place({ lat: 32.6, lng: 35.8 }, ic), ic, 0);
  const atEnd = remainingM(place(END, ic), ic, 0);

  assert.ok(atStart > atMid && atMid > atEnd);
  assert.ok(atEnd < 1, `remaining at destination was ${atEnd}`);
  assert.ok(Math.abs(atStart - ic.paths[0].totalM) < 1);
});

test("the reverse direction mirrors the forward one", () => {
  const ic = indexCorridor(corridor);
  const p = place({ lat: 32.65, lng: 35.8 }, ic);
  const forward = remainingM(p, ic, 0);
  const reverse = remainingM(p, ic, 1);
  assert.ok(Math.abs(forward + reverse - ic.paths[0].totalM) < 1);
});

test("two drivers on different roads still agree on distance still to cover", () => {
  // The property the whole design rests on: with alternative roads there is no
  // shared line to measure progress along, but both roads end at the same
  // place, so remaining distance stays comparable (docs/PLAN.md §6.1).
  const withAlternative: Corridor = {
    ...corridor,
    referencePaths: [
      [START, END],
      [START, { lat: 32.6, lng: 35.79 }, END], // a longer detour road
    ],
  };
  const ic = indexCorridor(withAlternative);

  const onMain = place({ lat: 32.69, lng: 35.8 }, ic);
  const onAlternative = place({ lat: 32.69, lng: 35.7905 }, ic);

  assert.notEqual(onMain.pathIndex, onAlternative.pathIndex);
  const a = remainingM(onMain, ic, 0);
  const b = remainingM(onAlternative, ic, 0);
  // Both are near the destination, so both report a small remaining distance.
  assert.ok(a < 1500 && b < 1500, `got ${a} and ${b}`);
});

test("zones resolve in order along the line", () => {
  const ic = indexCorridor(corridor);
  assert.equal(place(START, ic).zoneSeq, 0);
  assert.equal(place({ lat: 32.6, lng: 35.8 }, ic).zoneSeq, 1);
  assert.equal(place(END, ic).zoneSeq, 2);
});

test("a point between zones takes the last zone it has passed", () => {
  const ic = indexCorridor(corridor);
  // Past the midpoint zone's radius but short of the destination.
  assert.equal(place({ lat: 32.65, lng: 35.8 }, ic).zoneSeq, 1);
});

test("a corridor with no reference path is rejected", () => {
  assert.throws(() => indexCorridor({ ...corridor, referencePaths: [] }));
});
