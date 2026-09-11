import { test } from "node:test";
import assert from "node:assert/strict";
import { BusStream, type EventSourceLike } from "../src/stream.ts";

/** A stand-in for EventSource, so the behaviour can be tested without a browser. */
class FakeSource implements EventSourceLike {
  readyState = 0;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  closed = false;

  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  /** The browser retrying by itself: an error while it still intends to reconnect. */
  drop(): void {
    this.readyState = 0;
    this.onerror?.(new Error("dropped"));
  }

  /** The browser giving up: a refused ticket, not a flaky connection. */
  refuse(): void {
    this.readyState = 2;
    this.onerror?.(new Error("401"));
  }
}

function harness(tickets: string[] = ["t-2"]) {
  const opened: FakeSource[] = [];
  const states: string[] = [];
  const seen: unknown[][] = [];
  let issued = 0;

  const stream = new BusStream({
    open: (url) => {
      const s = new FakeSource(url);
      opened.push(s);
      return s;
    },
    urlFor: (ticket) => `https://api.test/v1/stream/buses?ticket=${ticket}`,
    reticket: async () => {
      const next = tickets[issued++];
      if (!next) throw new Error("offline");
      return next;
    },
    onBuses: (buses) => seen.push(buses),
    onState: (s) => states.push(s),
  });

  return { stream, opened, states, seen };
}

test("a snapshot reaches the screen", () => {
  const { stream, opened, seen, states } = harness();
  stream.start("t-1");

  opened[0].onopen?.(null);
  opened[0].onmessage?.({ data: JSON.stringify({ buses: [{ pseudonym: "a", remainingM: 900, zoneSeq: 0 }] }) });

  assert.equal(seen.length, 1);
  assert.equal((seen[0] as { pseudonym: string }[])[0].pseudonym, "a");
  assert.deepEqual(states, ["connecting", "live", "live"]);
  stream.stop();
});

test("a malformed frame does not tear the stream down", () => {
  const { stream, opened, seen } = harness();
  stream.start("t-1");

  opened[0].onmessage?.({ data: "{not json" });
  opened[0].onmessage?.({ data: JSON.stringify({ buses: [] }) });

  assert.equal(seen.length, 1, "the bad frame was dropped, the good one was not");
  assert.equal(opened.length, 1, "and nothing reconnected over it");
  stream.stop();
});

test("a dropped connection is left to the browser", () => {
  const { stream, opened, states } = harness();
  stream.start("t-1");
  opened[0].drop();

  assert.equal(opened.length, 1, "no second stream: the browser is already retrying");
  assert.equal(states.at(-1), "reconnecting");
  stream.stop();
});

test("a refused ticket is replaced rather than left dead", async () => {
  const { stream, opened } = harness(["t-2"]);
  stream.start("t-1");

  opened[0].refuse();
  await new Promise((r) => setImmediate(r));

  assert.equal(opened.length, 2, "a fresh ticket opened a new stream");
  assert.match(opened[1].url, /ticket=t-2$/);
  assert.ok(opened[0].closed);
  stream.stop();
});

test("being offline when the ticket is refused is not a crash", async () => {
  const { stream, opened, states } = harness([]); // reticket() throws
  stream.start("t-1");

  opened[0].refuse();
  await new Promise((r) => setImmediate(r));

  assert.equal(opened.length, 1);
  assert.equal(states.at(-1), "reconnecting", "the screen still says so");
  stream.stop();
});

test("stopping means stopping", async () => {
  const { stream, opened, seen } = harness();
  stream.start("t-1");
  stream.stop();

  opened[0].onmessage?.({ data: JSON.stringify({ buses: [{ pseudonym: "a", remainingM: 1, zoneSeq: 0 }] }) });
  opened[0].refuse();
  await new Promise((r) => setImmediate(r));

  assert.equal(seen.length, 0);
  assert.equal(opened.length, 1);
  assert.ok(opened[0].closed);
});
