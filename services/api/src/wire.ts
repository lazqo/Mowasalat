/**
 * The wire contract. These are the only shapes the server accepts.
 *
 * Note what is absent: there is no field here that can carry a latitude or a
 * longitude. Positions arrive as a line, a direction, a remaining distance and
 * a zone — all computed on the device (docs/PLAN.md §6.1).
 */
import { CoordinateLeak } from "./guard.ts";

export type Direction = 0 | 1;

export type StartTripBody = { routeId: string; dir: Direction };
export type TripProgressBody = {
  tripToken: string;
  routeId: string;
  dir: Direction;
  remainingM: number;
  zoneSeq: number;
  speedKph: number;
};
export type EndTripBody = { tripToken: string };
export type FindBusesBody = { routeId: string; dir: Direction; remainingM: number; zoneSeq: number };
export type RideRequestBody = {
  routeId: string;
  dir: Direction;
  destinationId: string;
  remainingM: number;
  zoneSeq: number;
};

export class BadRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequest";
  }
}

type Field = { kind: "string" | "int" | "number" | "direction"; min?: number; max?: number };
type Schema = Record<string, Field>;

/**
 * Strict allow-list validation. Unknown keys are rejected rather than ignored,
 * which is what makes the absence of coordinate fields structural: a client
 * that starts sending `lat` gets an error, not a silently stored value.
 */
function parse<T>(body: unknown, schema: Schema): T {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new BadRequest("body must be an object");
  }
  const input = body as Record<string, unknown>;

  for (const key of Object.keys(input)) {
    if (!(key in schema)) {
      // Surface a coordinate specifically: it is the one unknown field whose
      // arrival means something has gone wrong rather than merely stale.
      if (/^(lat|lng|lon|latitude|longitude|coords?|gps|position|location)$/i.test(key)) {
        throw new CoordinateLeak(`body.${key}`);
      }
      throw new BadRequest(`unexpected field "${key}"`);
    }
  }

  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(schema)) {
    const v = input[key];
    if (v === undefined) throw new BadRequest(`missing field "${key}"`);

    if (spec.kind === "string") {
      if (typeof v !== "string" || v.length === 0 || v.length > 128) {
        throw new BadRequest(`"${key}" must be a non-empty string`);
      }
    } else if (spec.kind === "direction") {
      if (v !== 0 && v !== 1) throw new BadRequest(`"${key}" must be 0 or 1`);
    } else {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new BadRequest(`"${key}" must be a finite number`);
      }
      if (spec.kind === "int" && !Number.isInteger(v)) {
        throw new BadRequest(`"${key}" must be an integer`);
      }
      if (spec.min !== undefined && v < spec.min) throw new BadRequest(`"${key}" below minimum`);
      if (spec.max !== undefined && v > spec.max) throw new BadRequest(`"${key}" above maximum`);
    }
    out[key] = v;
  }
  return out as T;
}

const MAX_REMAINING_M = 500_000;

export const parseStartTrip = (b: unknown) =>
  parse<StartTripBody>(b, { routeId: { kind: "string" }, dir: { kind: "direction" } });

export const parseTripProgress = (b: unknown) =>
  parse<TripProgressBody>(b, {
    tripToken: { kind: "string" },
    routeId: { kind: "string" },
    dir: { kind: "direction" },
    remainingM: { kind: "number", min: 0, max: MAX_REMAINING_M },
    zoneSeq: { kind: "int", min: 0, max: 1000 },
    speedKph: { kind: "number", min: 0, max: 200 },
  });

export const parseEndTrip = (b: unknown) =>
  parse<EndTripBody>(b, { tripToken: { kind: "string" } });

export const parseFindBuses = (b: unknown) =>
  parse<FindBusesBody>(b, {
    routeId: { kind: "string" },
    dir: { kind: "direction" },
    remainingM: { kind: "number", min: 0, max: MAX_REMAINING_M },
    zoneSeq: { kind: "int", min: 0, max: 1000 },
  });

export const parseRideRequest = (b: unknown) =>
  parse<RideRequestBody>(b, {
    routeId: { kind: "string" },
    dir: { kind: "direction" },
    destinationId: { kind: "string" },
    remainingM: { kind: "number", min: 0, max: MAX_REMAINING_M },
    zoneSeq: { kind: "int", min: 0, max: 1000 },
  });

/**
 * Refuses a position finer than country policy allows.
 *
 * Blurring happens on the device, but a modified client could simply not do it.
 * Checking the value is a multiple of the country's band makes the policy
 * enforceable against a client we do not control — the server declines to hold
 * a more precise position than it said it would.
 */
export function assertBucketed(remainingM: number, bucketM: number): void {
  if (bucketM <= 0) throw new Error("bucketM must be positive");
  if (Math.abs(remainingM % bucketM) > 1e-6) {
    throw new BadRequest(
      `position is more precise than policy allows: expected a multiple of ${bucketM} m`,
    );
  }
}
