/** A WGS84 coordinate. Never sent to the server (see docs/PLAN.md §6.1). */
export type LatLng = { lat: number; lng: number };

/** 0 = origin → destination. 1 = destination → origin. */
export type Direction = 0 | 1;

export type ZoneKind = "origin_hub" | "intermediate" | "destination";

/**
 * An ordered area along a corridor. Modelled as a centre and a radius rather
 * than a polygon: Phase 0 collects village centres and junctions as points, and
 * a circle is authorable from that with no polygon tooling. Ordering comes from
 * `seq`, not from geometry.
 */
export type Zone = {
  seq: number;
  nameAr: string;
  kind: ZoneKind;
  centre: LatLng;
  radiusM: number;
};

/** A place people actually stand. Used to blur position when density is low (§6.5). */
export type WaitPoint = {
  id: string;
  nameAr: string;
  location: LatLng;
  zoneSeq: number;
};

/**
 * The internal geography of a line. Never shown to users.
 *
 * `referencePaths` holds the roads drivers actually use, including known
 * alternatives — each is a full path from origin to destination. Containment is
 * tested against these directly rather than against a precomputed buffer
 * polygon: the test "within widthM of some reference path" is exactly what a
 * buffer would encode, and needs no polygon library on the phone.
 */
export type Corridor = {
  widthM: number;
  referencePaths: LatLng[][];
  zones: Zone[];
};

export type Route = {
  id: string;
  nameAr: string;
  originNameAr: string;
  destinationNameAr: string;
  bidirectional: boolean;
  /** True until Phase 0 field data replaces the placeholder geometry. */
  provisional: boolean;
  corridor: Corridor;
  servedDestinations: { id: string; nameAr: string; zoneSeq: number }[];
  waitPoints: WaitPoint[];
};

/** What a driver's phone broadcasts. Note the absence of any coordinate. */
export type LiveTrip = {
  pseudonym: string;
  routeId: string;
  dir: Direction;
  remainingM: number;
  zoneSeq: number;
  speedKph: number;
};

/** What a passenger's phone broadcasts. Again, no coordinate. */
export type PassengerFix = {
  routeId: string;
  dir: Direction;
  remainingM: number;
  zoneSeq: number;
};
