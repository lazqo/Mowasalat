/**
 * Drives the built passenger page through a real browser, against a real API.
 *
 *   ./tools/dev.sh                                  # in one terminal
 *   API_BASE=http://localhost:3000 npm run build:web
 *   node tools/serve.mjs apps/web-passenger/dist    # in another
 *   node tools/drive-web.mjs
 *
 * The unit tests prove the arithmetic and the end-to-end test proves the
 * client and server agree. Neither opens a browser, so neither would notice
 * the page failing to render, a label drawn backwards, or a stylesheet quietly
 * fetched from a font CDN. This does.
 *
 * It is not part of `npm test`: it needs two servers and a browser. Run it
 * before shipping a change to the page.
 */

import { chromium } from "playwright";
import { indexCorridor, place, remainingM as remainingAlong, bucketRemaining } from "../packages/corridor/src/index.ts";

const API = process.env.API_BASE ?? "http://localhost:3000";
const PAGE = process.env.PAGE_URL ?? "http://localhost:5173";
const ADMIN = process.env.ADMIN_TOKEN;
const ROUTE = process.env.ROUTE ?? "jo-irbid-malka";
const AT = { latitude: 32.5556, longitude: 35.8497 }; // إربد, the hub end

if (!ADMIN) {
  console.error("set ADMIN_TOKEN (dev.sh writes it to .env.local)");
  process.exit(1);
}

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "  ok  " : "FAIL  "}${what}`);
  if (!ok) failures.push(what);
};

const post = (path, body, token) =>
  fetch(API + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

// --- a driver, actually running the line -------------------------------------

// A fresh number each run: codes are rate limited per number, as they should be.
const phone = "079" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0");

const challenge = await post("/v1/auth/otp/request", { phone });
if (!challenge.body.devCode) {
  console.error("no development OTP — run the API with NODE_ENV=development", challenge.body);
  process.exit(1);
}
const { body: session } = await post("/v1/auth/otp/verify", {
  challengeId: challenge.body.challengeId,
  code: challenge.body.devCode,
  phone,
});
await post(`/v1/admin/drivers/${session.driver.id}/routes`, { routeId: ROUTE }, ADMIN);

const { body: trip } = await post("/v1/trips", { routeId: ROUTE, dir: 0 }, session.driverToken);
check(Boolean(trip.tripToken), "a driver starts a trip");

// Where he has to be for her to see him: behind where she is standing, so the
// ground she is on is ground he has not covered yet. Derived from the line's
// own geometry rather than hardcoded, because the geometry changes whenever
// the roads are rebuilt and a stale constant would silently stop testing this.
const { remainingBucketM } = await fetch(`${API}/v1/country`).then((r) => r.json());
const { routes } = await fetch(`${API}/v1/routes`).then((r) => r.json());
const line = routes.find((r) => r.id === ROUTE);
const indexed = indexCorridor(line.corridor);
const hers = remainingAlong(place({ lat: AT.latitude, lng: AT.longitude }, indexed), indexed, 0);
const BEHIND_M = 4000;

const progress = await post(
  "/v1/trips/progress",
  {
    tripToken: trip.tripToken,
    routeId: ROUTE,
    dir: 0,
    remainingM: bucketRemaining(hers + BEHIND_M, remainingBucketM),
    zoneSeq: 0,
    speedKph: 40,
  },
  session.driverToken,
);
check(progress.status === 200, `and reports progress ${(BEHIND_M / 1000).toFixed(0)} km behind her`);

// --- the page ----------------------------------------------------------------

const browser = await chromium.launch({
  // Chromium may be installed outside Playwright's own cache.
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const context = await browser.newContext({
  permissions: ["geolocation"],
  geolocation: AT,
  locale: "ar-JO",
  viewport: { width: 390, height: 844 },
});
const page = await context.newPage();

const errors = [];
const external = [];
page.on("pageerror", (e) => errors.push(String(e.message)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("request", (r) => {
  const origin = new URL(r.url()).origin;
  if (origin !== new URL(PAGE).origin && origin !== new URL(API).origin) external.push(r.url());
});

await page.goto(PAGE, { waitUntil: "networkidle" });
await page.waitForSelector(".tile", { timeout: 10_000 });

const tiles = await page.$$eval(".tile", (ts) => ts.map((t) => t.textContent.trim()));
check(tiles.length > 0, `وين رايح؟ lists ${tiles.length} places: ${tiles.join("، ")}`);

await page.fill("#q", "ملكة");
await page.waitForTimeout(150);
const found = await page.$$eval(".tile", (ts) => ts.map((t) => t.textContent.trim()));
check(found.join() === "ملكا", "a misspelling still finds the village");

await page.click(".tile");
await page.waitForSelector(".buses li", { timeout: 10_000 });
await page.waitForTimeout(1000);

const buses = await page.$$eval(".buses li", (ls) => ls.map((l) => l.textContent.replace(/\s+/g, " ").trim()));
check(buses.length === 1, `one bus is offered: ${buses.join(" / ")}`);
check(/دقايق|وصل|واقف/.test(buses[0] ?? ""), "with an ETA a person can read");
check(Boolean(await page.$(".diagram svg")), "the line is drawn");
await page.screenshot({ path: "apps/web-passenger/screenshot-buses.png" });

await page.click('[data-act="wait"]');
await page.waitForSelector('[data-act="boarded"]', { timeout: 10_000 });
check(Boolean(await page.$('[data-act="cancel"]')), "أنا مستني هون leaves her able to cancel");
await page.screenshot({ path: "apps/web-passenger/screenshot-waiting.png" });

// The driver should now see a pin, and nothing that identifies her.
const pins = await readFirstEvent(`${API}/v1/stream/waiting?tripToken=${trip.tripToken}`);
check(pins.pins?.length >= 1, `the driver is told someone is waiting: ${JSON.stringify(pins.pins)}`);
check(
  (pins.pins ?? []).every((p) => Object.keys(p).sort().join() === "count,remainingM,zoneSeq"),
  "and is told nothing else about her",
);

await page.click('[data-act="boarded"]');
await page.waitForTimeout(300);

check(external.length === 0, external.length ? `NO external requests — saw ${external.join(", ")}` : "the page asked nobody else for anything");
check(errors.length === 0, errors.length ? `no page errors — saw ${errors.join(" | ")}` : "no errors in the console");

await browser.close();

console.log(failures.length ? `\n${failures.length} failed` : "\nall good");
process.exit(failures.length ? 1 : 0);

/** Reads one SSE frame, then lets the connection go. */
async function readFirstEvent(url) {
  const res = await fetch(url, { headers: { accept: "text/event-stream" }, signal: AbortSignal.timeout(5000) });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return {};
      buffer += decoder.decode(value, { stream: true });
      const line = buffer.split("\n").find((l) => l.startsWith("data: "));
      if (line) return JSON.parse(line.slice(6));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
