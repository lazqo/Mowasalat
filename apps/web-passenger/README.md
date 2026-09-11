# Passenger — web

The passenger app as a web page. No install, no store, no APK passed around a
WhatsApp group: a link, and whoever opens it can see the bus.

Roughly 18 kB of JavaScript, no runtime dependencies, no third-party requests
at all.

## Why this and not Flutter

The passenger has the lightest requirements in the system — she opens the app,
looks at it, and puts the phone away — and the heaviest distribution problem,
because there are thousands of her. A page solves the distribution problem
outright and costs nothing on the requirements.

The driver is the opposite case and is **not** covered here. He needs the phone
to keep reporting while it is in his pocket or the screen is off, and a browser
suspends a backgrounded tab. See [docs/PLAN.md](../../docs/PLAN.md) and the
driver app under [`apps/driver`](../driver).

## What it shares with the native client

The corridor geometry is [`packages/corridor`](../../packages/corridor)
imported directly as source — the same `place`, `remainingM` and
`bucketRemaining` the tooling and the backend use. The Arabic name matching and
the passenger flow are ports of `packages/core`, and both are tested against the
same recorded `/v1` responses in `packages/core/test/fixtures`, so the two
clients cannot drift into different ideas of the same journey.

## Running it

```bash
./tools/dev.sh                                   # backend, in one terminal

API_BASE=http://localhost:3000 npm run build:web # in another
npm run serve:web
```

`API_BASE` is baked into the page's meta tag *and* into its Content-Security-
Policy, so a built page can reach that API and nothing else. `?api=…` overrides
it at runtime for a field test without a rebuild.

**Browsers only give a page the device location over https, or on localhost.**
A phone opening `http://192.168.x.x:5173` will load the page and then fail to
locate. For a phone test use a tunnel or a real deployment.

## Deploying

`vercel.json` builds `apps/web-passenger/dist` as static files. Set `API_BASE`
in the project's environment. Two things worth being deliberate about:

- **The API does not belong on the same platform.** It holds open SSE streams
  for the length of a driver's trip and keeps live state in Redis, neither of
  which fits a request/response function runtime. Put it on an always-on host.
- **`countries/jo/config.json` declares `residency_region: me-central-1`,** and
  the database holds driver phone numbers. Host it where you said you would.

The API must be told which page may call it, or a browser will refuse every
request:

```
WEB_ORIGINS=https://your-page.example
```

Unset means no browser may call it, which is what every existing deployment
already does.

## Tests

```bash
npm test          # includes this app's unit, privacy and end-to-end tests
npm run typecheck # strict, and the app is checked without Node types in scope
```

`test/e2e.test.ts` runs the client against a real server and a real Postgres.

Nothing above opens a browser, so nothing above would notice the page failing
to render or a label drawn backwards. That is what `npm run drive:web` is for:
it drives the built page through Chromium against a running backend, and checks
the three things a unit test cannot — that the screens work, that the driver
sees a pin with nothing identifying in it, and that the page made no request to
anyone but its own API.

## Things that look wrong and are not

- **No map.** A tiled basemap means asking a third party for the tiles around
  wherever she is standing. The line is drawn as itself instead: villages in
  order, her position, the bus.
- **No coordinate is ever sent.** The page does the geometry and transmits a
  line, a direction, a bucketed remaining distance and a zone.
- **The bus list goes empty when a driver leaves the corridor.** That silence
  is the feature.
- **Only the network is cached.** Lines and villages are public infrastructure.
  Her position, her destination and her pseudonym never reach storage.
