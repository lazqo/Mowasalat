/**
 * Enforcement of the property in docs/PLAN.md §6.1: no coordinate ever reaches
 * the server.
 *
 * The corridor library guarantees the client *can* compute a position without
 * sending one. It guarantees nothing about what this server accepts or writes
 * down. A debug log, an error handler or a crash reporter can quietly
 * reintroduce a coordinate, and that is exactly the leak nobody notices until
 * someone audits it. So the property is enforced here, and tested.
 */

/**
 * Keys that would carry a position. Matched on the key, not the value: a bare
 * number like 32.5556 is indistinguishable from any other number, so value
 * heuristics would be noise. The structural defence is the strict schema in
 * wire.ts, which rejects unknown keys outright; this is the second line, for
 * anything constructed internally and handed to a log.
 */
const COORDINATE_KEY =
  /^(lat|lng|lon|latitude|longitude|coord|coords|coordinate|coordinates|gps|geo|point|position|location|centre|center|waypoint|trace)$/i;

export class CoordinateLeak extends Error {
  path: string;
  constructor(path: string) {
    super(`coordinate-shaped field "${path}" must never reach the server or its logs`);
    this.name = "CoordinateLeak";
    this.path = path;
  }
}

/** Throws if any coordinate-shaped key appears anywhere in the value. */
export function assertNoCoordinates(value: unknown, path = "$"): void {
  if (value === null || typeof value !== "object") return;

  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoCoordinates(v, `${path}[${i}]`));
    return;
  }

  for (const [key, v] of Object.entries(value)) {
    if (COORDINATE_KEY.test(key)) throw new CoordinateLeak(`${path}.${key}`);
    assertNoCoordinates(v, `${path}.${key}`);
  }
}

export type LogSink = (line: string) => void;

/**
 * The only logger the service uses. Every payload passes the coordinate check
 * before it can be written, so adding a careless `log(req.body)` fails loudly
 * in tests rather than silently building the movement database we promised not
 * to build.
 */
export function createLogger(sink: LogSink = console.log) {
  return function log(message: string, context?: Record<string, unknown>): void {
    if (context) assertNoCoordinates(context, "context");
    sink(context ? `${message} ${JSON.stringify(context)}` : message);
  };
}
