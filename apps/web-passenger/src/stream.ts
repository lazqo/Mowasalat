/**
 * Watching one line's buses.
 *
 * The browser already implements Server-Sent Events, including the reconnect
 * backoff the server asks for with `retry:`. What it does not do is recover
 * when the stream ticket expires: a 401 closes an EventSource for good. A
 * ticket lasts thirty minutes and a ride request twenty, so this is rare — but
 * "rare" on a road at night is someone watching a screen that quietly stopped
 * updating, so it is handled rather than assumed away.
 */

import type { BusScalar } from "./api.ts";

export type StreamState = "connecting" | "live" | "reconnecting";

export type BusStreamOptions = {
  /** Opens a stream for a ticket. Injected so tests need no browser. */
  open: (url: string) => EventSourceLike;
  /** Fetches a fresh ticket when the current one is refused. */
  reticket: () => Promise<string>;
  urlFor: (ticket: string) => string;
  onBuses: (buses: BusScalar[]) => void;
  onState: (state: StreamState) => void;
};

/** The part of EventSource used here, so a test can stand in for it. */
export type EventSourceLike = {
  readyState: number;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onopen: ((ev: unknown) => void) | null;
  close(): void;
};

const CLOSED = 2;

export class BusStream {
  private source: EventSourceLike | null = null;
  private stopped = false;
  private reticketing = false;

  private readonly options: BusStreamOptions;

  constructor(options: BusStreamOptions) {
    this.options = options;
  }

  start(ticket: string): void {
    this.stopped = false;
    this.connect(ticket);
  }

  stop(): void {
    this.stopped = true;
    this.source?.close();
    this.source = null;
  }

  private connect(ticket: string): void {
    if (this.stopped) return;
    this.options.onState("connecting");

    const source = this.options.open(this.options.urlFor(ticket));
    this.source = source;

    source.onopen = () => {
      if (!this.stopped) this.options.onState("live");
    };

    source.onmessage = (ev) => {
      if (this.stopped) return;
      this.options.onState("live");
      try {
        const payload = JSON.parse(ev.data) as { buses?: BusScalar[] };
        this.options.onBuses(payload.buses ?? []);
      } catch {
        // A malformed frame is not worth tearing the stream down for; the
        // next snapshot replaces it wholesale anyway.
      }
    };

    source.onerror = () => {
      if (this.stopped) return;
      this.options.onState("reconnecting");

      // readyState CLOSED means the browser has given up — a refused ticket,
      // not a dropped connection. Anything else it retries by itself.
      if (source.readyState === CLOSED) void this.renew();
    };
  }

  private async renew(): Promise<void> {
    if (this.reticketing || this.stopped) return;
    this.reticketing = true;
    try {
      const ticket = await this.options.reticket();
      this.source?.close();
      this.connect(ticket);
    } catch {
      // Offline. The screen already says so; the next user action retries.
    } finally {
      this.reticketing = false;
    }
  }
}
