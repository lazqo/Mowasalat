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

/**
 * Keys that would put a secret or an identifier in a log: the phone number a
 * driver signs up with, the code sent to it, and the tokens that stand for
 * either. A leaked trip token lets someone impersonate a bus; a leaked phone
 * number is the one piece of personal data the system holds at all.
 */
const SECRET_KEY =
  /^(phone|phone_number|phonenumber|msisdn|code|otp|otpcode|pin|token|triptoken|drivertoken|streamticket|ticket|password|secret|authorization)$/i;

export class SecretLeak extends Error {
  path: string;
  constructor(path: string) {
    super(`"${path}" is a secret or an identifier and must never be logged`);
    this.name = "SecretLeak";
    this.path = path;
  }
}

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

/** Throws if any secret-shaped key appears anywhere in the value. */
export function assertNoSecrets(value: unknown, path = "$"): void {
  if (value === null || typeof value !== "object") return;

  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecrets(v, `${path}[${i}]`));
    return;
  }

  for (const [key, v] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) throw new SecretLeak(`${path}.${key}`);
    assertNoSecrets(v, `${path}.${key}`);
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
    if (context) {
      assertNoCoordinates(context, "context");
      assertNoSecrets(context, "context");
    }
    sink(context ? `${message} ${JSON.stringify(context)}` : message);
  };
}
