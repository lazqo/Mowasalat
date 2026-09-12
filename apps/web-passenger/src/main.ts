/**
 * The passenger app, as a web page.
 *
 * Four screens and one decision per screen: where are you going, which bus is
 * coming, I am waiting here, I got on. No account, no login, nothing stored
 * about her, and no coordinate leaving the phone.
 */

import { indexCorridor, place, remainingM as remainingAlong } from "../../../packages/corridor/src/index.ts";
import type { Direction, LatLng, Route } from "../../../packages/corridor/src/types.ts";
import { Api, OfflineError, type BusScalar, type CountryInfo } from "./api.ts";
import { PassengerController, etaText, type BusSighting, type DestinationOption, type RideOption } from "./passenger.ts";
import { BusStream, type EventSourceLike, type StreamState } from "./stream.ts";
import { renderDiagram, type DiagramZone } from "./diagram.ts";
import { Ar, humaniseDistance } from "./strings.ts";

type Screen =
  | { name: "loading" }
  | { name: "failed"; message: string }
  | { name: "whereTo"; query: string }
  | { name: "locating"; destination: DestinationOption }
  | { name: "located"; destination: DestinationOption; ride: RideOption | null }
  | { name: "waiting"; destination: DestinationOption; ride: RideOption }
  | { name: "done"; heading: string; note?: string };

const root = document.getElementById("app")!;

let api: Api;
let country: CountryInfo;
let network: Route[] = [];
let controller: PassengerController;

let screen: Screen = { name: "loading" };
let sightings: BusSighting[] = [];
let streamState: StreamState = "connecting";
let offline = false;
let stream: BusStream | null = null;
let ticker: number | undefined;

// --- start ------------------------------------------------------------------

/**
 * Where the API lives. A meta tag by default so the deployed page needs no
 * rebuild to be repointed, and `?api=` so a field tester can aim a phone at a
 * laptop on the same wifi without one either.
 */
function apiBase(): string {
  const override = new URLSearchParams(location.search).get("api");
  if (override) return override;
  const meta = document.querySelector('meta[name="api-base"]')?.getAttribute("content");
  return meta && meta !== "__API_BASE__" ? meta : location.origin;
}

/**
 * The network is public infrastructure: the lines, the villages, the roads.
 * Caching it means the app opens and can still tell her where the buses leave
 * from with no signal at all. Nothing about *her* is cached, because nothing
 * about her exists.
 */
const CACHE_KEY = "mowasalat.network.v1";

function readCache(): { country: CountryInfo; routes: Route[] } | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeCache(value: { country: CountryInfo; routes: Route[] }): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(value));
  } catch {
    // A full or disabled store is not a reason to fail; it only costs a fetch.
  }
}

async function boot(): Promise<void> {
  api = new Api(apiBase());

  const cached = readCache();
  if (cached) {
    start(cached.country, cached.routes);
    void refreshNetwork();
    return;
  }

  try {
    const [c, r] = await Promise.all([api.country(), api.routes()]);
    writeCache({ country: c, routes: r });
    start(c, r);
  } catch (err) {
    screen = {
      name: "failed",
      message: err instanceof OfflineError ? Ar.offline : Ar.loadFailed,
    };
    render();
  }
}

/** Picks up a changed corridor quietly, for the next journey rather than this one. */
async function refreshNetwork(): Promise<void> {
  try {
    const [c, r] = await Promise.all([api.country(), api.routes()]);
    writeCache({ country: c, routes: r });
  } catch {
    // Offline, or the API moved. The cached network still works.
  }
}

function start(c: CountryInfo, routes: Route[]): void {
  country = c;
  network = routes;
  controller = new PassengerController(api, network, country.remainingBucketM);
  screen = { name: "whereTo", query: "" };
  render();
}

// --- the journey ------------------------------------------------------------

async function chooseDestination(destination: DestinationOption): Promise<void> {
  screen = { name: "locating", destination };
  render();

  let position: LatLng;
  try {
    position = await locate();
  } catch {
    screen = { name: "failed", message: Ar.locationRefused };
    render();
    return;
  }

  const rides = controller.ridesFor(destination.id, position);
  const ride = rides[0] ?? null;
  screen = { name: "located", destination, ride };
  sightings = [];
  render();

  if (ride) await watch(ride);
}

/**
 * One position fix, on the page, discarded once it has been turned into a
 * distance. `enableHighAccuracy` is off: the answer is bucketed to hundreds of
 * metres before anything is sent, so the extra precision would cost battery to
 * buy nothing.
 */
function locate(): Promise<LatLng> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("no geolocation"));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      reject,
      { enableHighAccuracy: false, timeout: 15_000, maximumAge: 30_000 },
    );
  });
}

async function watch(ride: RideOption): Promise<void> {
  stream?.stop();
  try {
    const first = await controller.busesFor(ride);
    sightings = first.buses;
    offline = false;
    render();

    stream = new BusStream({
      open: (url) => new EventSource(url) as unknown as EventSourceLike,
      urlFor: (ticket) => api.busStreamUrl(ticket),
      reticket: async () => (await controller.busesFor(ride)).streamTicket,
      onBuses: (buses: BusScalar[]) => {
        sightings = controller.sightingsFrom(buses, ride);
        render();
      },
      onState: (s) => {
        streamState = s;
        render();
      },
    });
    stream.start(first.streamTicket);
  } catch (err) {
    offline = err instanceof OfflineError;
    render();
  }
}

async function waitHere(): Promise<void> {
  if (screen.name !== "located" || !screen.ride) return;
  const { destination, ride } = screen;
  try {
    await controller.requestRide(ride);
  } catch (err) {
    offline = err instanceof OfflineError;
    render();
    return;
  }

  screen = { name: "waiting", destination, ride };
  offline = false;
  // The request dies by itself after twenty minutes; the countdown says so
  // rather than letting her stand there trusting a promise that has lapsed.
  ticker = window.setInterval(() => {
    if (controller.refresh() === "expired") {
      finish(Ar.requestExpired);
    } else {
      render();
    }
  }, 1000);
  render();
}

async function boarded(): Promise<void> {
  await controller.boarded();
  finish(Ar.boardedThanks);
}

async function cancel(): Promise<void> {
  if (!confirm(Ar.confirmCancel)) return;
  await controller.cancel();
  finish(Ar.cancelled);
}

function finish(heading: string): void {
  window.clearInterval(ticker);
  ticker = undefined;
  stream?.stop();
  stream = null;
  sightings = [];
  screen = { name: "done", heading };
  render();
}

function restart(): void {
  window.clearInterval(ticker);
  ticker = undefined;
  stream?.stop();
  stream = null;
  sightings = [];
  controller.reset();
  screen = { name: "whereTo", query: "" };
  render();
}

// --- drawing ----------------------------------------------------------------

function render(): void {
  root.innerHTML = view();
  bind();
}

function view(): string {
  switch (screen.name) {
    case "loading":
      return `<p class="note">${Ar.loading}</p>`;

    case "failed":
      return `
        <h1>${esc(screen.message)}</h1>
        <button class="primary" data-act="restart">${Ar.retry}</button>`;

    case "whereTo":
      return `
        <h1>${Ar.whereTo}</h1>
        <input id="q" type="search" inputmode="search" placeholder="${Ar.search}"
               value="${esc(screen.query)}" autocomplete="off">
        <div id="results">${destinationList(screen.query)}</div>
        <p class="credit">${Ar.mapCredit}</p>`;

    case "locating":
      return `
        <h1>${esc(screen.destination.nameAr)}</h1>
        <p class="note">${Ar.findingYou}</p>
        <p class="note small">${Ar.needLocation}</p>`;

    case "located":
      return screen.ride
        ? `
          <button class="back" data-act="restart">→</button>
          <h1>${esc(screen.destination.nameAr)}</h1>
          ${routeLine(screen.ride)}
          ${busesView(screen.ride)}
          <button class="primary" data-act="wait">${Ar.imWaiting}</button>`
        : `
          <button class="back" data-act="restart">→</button>
          <h1>${esc(screen.destination.nameAr)}</h1>
          <p class="note">${Ar.noLineHere}</p>`;

    case "waiting": {
      const minutes = Math.ceil(controller.timeLeftMs / 60000);
      return `
        <h1>${Ar.waitingForBus}</h1>
        <p class="note">${Ar.driverSeesYou}</p>
        ${routeLine(screen.ride)}
        ${busesView(screen.ride)}
        <p class="note small">${Ar.minutesLeft(minutes)}</p>
        <button class="primary" data-act="boarded">${Ar.iBoarded}</button>
        <button class="quiet" data-act="cancel">${Ar.cancel}</button>`;
    }

    case "done":
      return `
        <h1>${esc(screen.heading)}</h1>
        <button class="primary" data-act="restart">${Ar.again}</button>`;
  }
}

function destinationList(query: string): string {
  const options = controller.destinations(query);
  if (options.length === 0) return `<p class="note">${Ar.noPlace}</p>`;
  return `<div class="tiles">${options
    .map((o) => `<button class="tile" data-dest="${esc(o.id)}">${esc(o.nameAr)}</button>`)
    .join("")}</div>`;
}

function routeLine(ride: RideOption): string {
  const provisional = ride.route.provisional
    ? `<span class="badge">${Ar.provisional}</span>`
    : "";
  return `<p class="line">${esc(ride.route.nameAr)} ${provisional}</p>`;
}

function busesView(ride: RideOption): string {
  const status = offline
    ? `<p class="note small">${Ar.offline}</p>`
    : streamState === "reconnecting"
      ? `<p class="note small">${Ar.reconnecting}</p>`
      : "";

  if (sightings.length === 0) {
    // Useful even with nothing running: where the buses leave from.
    return `
      ${status}
      <p class="note">${Ar.noBusNow}</p>
      <p class="note small">${Ar.departsFrom} ${esc(originFor(ride))}</p>`;
  }

  const list = sightings
    .map(
      (s) => `
      <li>
        <span class="eta">${esc(etaText(s))}</span>
        <span class="gap">${esc(humaniseDistance(s.gapM))}</span>
      </li>`,
    )
    .join("");

  return `
    ${status}
    <div class="diagram">${diagramFor(ride)}</div>
    <ul class="buses">${list}</ul>`;
}

/** The endpoint she is travelling away from, which is where the buses start. */
function originFor(ride: RideOption): string {
  return ride.dir === 0 ? ride.route.originNameAr : ride.route.destinationNameAr;
}

function diagramFor(ride: RideOption): string {
  const ic = indexCorridor(ride.route.corridor);
  const zones: DiagramZone[] = ride.route.corridor.zones.map((z) => ({
    nameAr: z.nameAr,
    remainingM: remainingAlong(place(z.centre, ic), ic, ride.dir as Direction),
  }));

  return renderDiagram({
    zones,
    youRemainingM: ride.remainingM,
    buses: sightings.map((s) => ({
      pseudonym: s.pseudonym,
      remainingM: ride.remainingM + s.gapM,
      stopped: s.etaSeconds === null,
    })),
  });
}

function bind(): void {
  const q = root.querySelector<HTMLInputElement>("#q");
  const results = root.querySelector<HTMLElement>("#results");
  if (q && results) {
    q.oninput = () => {
      if (screen.name !== "whereTo") return;
      // Only the list is replaced. A full redraw would rebuild the field she
      // is typing into and take the keyboard down with it.
      screen = { name: "whereTo", query: q.value };
      results.innerHTML = destinationList(q.value);
    };
  }

  root.onclick = (ev) => {
    const target = (ev.target as HTMLElement).closest<HTMLElement>("[data-act],[data-dest]");
    if (!target) return;

    const dest = target.dataset.dest;
    if (dest) {
      const option = controller.destinations().find((o) => o.id === dest);
      if (option) void chooseDestination(option);
      return;
    }

    switch (target.dataset.act) {
      case "wait":
        void waitHere();
        break;
      case "boarded":
        void boarded();
        break;
      case "cancel":
        void cancel();
        break;
      case "restart":
        restart();
        break;
    }
  };
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

void boot();
