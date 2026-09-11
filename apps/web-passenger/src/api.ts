/**
 * The passenger half of the frozen /v1 contract (docs/API.md).
 *
 * Every body here is written out field by field rather than spread from an
 * object. That is deliberate: the server rejects a payload carrying a
 * coordinate, and the surest way never to send one is for there to be no code
 * path that could copy one in.
 */

import type { Direction, Route } from "../../../packages/corridor/src/types.ts";

export type CountryInfo = {
  code: string;
  locale: string;
  digits: string;
  phonePrefix: string;
  remainingBucketM: number;
  kAnonymityMin: number;
  strings?: Record<string, string>;
};

/** A bus as the server reports it: scalars, no coordinate, no identity. */
export type BusScalar = {
  pseudonym: string;
  remainingM: number;
  zoneSeq: number;
  speedKph?: number;
  gapM?: number;
  etaSeconds?: number | null;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly retryAfterSeconds?: number;

  constructor(status: number, message: string, code?: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Thrown when the phone is offline, so the screen can say so and keep waiting. */
export class OfflineError extends Error {
  constructor() {
    super("offline");
    this.name = "OfflineError";
  }
}

export class Api {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async country(): Promise<CountryInfo> {
    return this.get<CountryInfo>("/v1/country");
  }

  async routes(): Promise<Route[]> {
    const body = await this.get<{ routes: Route[] }>("/v1/routes");
    return body.routes;
  }

  /** Which buses are running, plus the ticket that lets her watch this one line. */
  async findBuses(args: {
    routeId: string;
    dir: Direction;
    remainingM: number;
    zoneSeq: number;
  }): Promise<{ buses: BusScalar[]; streamTicket: string }> {
    return this.post("/v1/buses", {
      routeId: args.routeId,
      dir: args.dir,
      remainingM: args.remainingM,
      zoneSeq: args.zoneSeq,
    });
  }

  /** أنا مستني هون. */
  async requestRide(args: {
    routeId: string;
    dir: Direction;
    destinationId: string;
    remainingM: number;
    zoneSeq: number;
  }): Promise<{ pseudonym: string }> {
    return this.post("/v1/requests", {
      routeId: args.routeId,
      dir: args.dir,
      destinationId: args.destinationId,
      remainingM: args.remainingM,
      zoneSeq: args.zoneSeq,
    });
  }

  async cancelRequest(pseudonym: string): Promise<{ cancelled: boolean }> {
    return this.post("/v1/requests/cancel", { pseudonym });
  }

  async boarded(args: {
    pseudonym: string;
    routeId: string;
    dir: Direction;
  }): Promise<{ ok: true }> {
    return this.post("/v1/requests/boarded", {
      pseudonym: args.pseudonym,
      routeId: args.routeId,
      dir: args.dir,
    });
  }

  /** The URL the browser's own EventSource opens. The ticket is the whole auth. */
  busStreamUrl(ticket: string): string {
    return `${this.baseUrl}/v1/stream/buses?ticket=${encodeURIComponent(ticket)}`;
  }

  private async get<T>(path: string): Promise<T> {
    return this.send<T>(path, { method: "GET" });
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.send<T>(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async send<T>(path: string, init: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, init);
    } catch {
      // A dropped connection is not an error worth a stack trace on a phone
      // on the Irbid road; it is a normal condition the screen handles.
      throw new OfflineError();
    }

    const text = await res.text();
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};

    if (!res.ok) {
      throw new ApiError(
        res.status,
        (body.error as string) ?? `request failed (${res.status})`,
        body.code as string | undefined,
        body.retryAfterSeconds as number | undefined,
      );
    }
    return body as T;
  }
}
