# For the developer

The passenger app is now a **web page**, and it is finished: built, tested, and
driven through a real browser against a real backend. The remaining job is the
**driver** app, which is Flutter, and which a Flutter developer should be able
to finish in half a day.

## Why the passenger is web and the driver is not

The passenger opens the app, looks at it, and puts the phone away. That works
in a browser, and a page solves distribution outright — a link in a WhatsApp
group, no store, no APK, and a fix reaches everyone in thirty seconds.

The driver needs his phone to keep reporting while it is in his pocket, on a
mount, or with the screen off. A browser suspends a backgrounded tab, so the
bus would freeze on every passenger's screen the moment he took a call. That is
the one requirement a page cannot meet, and it is why the driver app stays
native.

## The job

Get the driver app onto an Android phone and confirm one thing: a passenger
opens the web page and taps `أنا مستني هون`, and within a couple of seconds the
driver's phone shows her.

That is the whole test. Everything else is setup.

## What already works

| | |
|---|---|
| Backend | Node, Postgres, Redis. 244 tests. Run with one command. |
| Contract | `/v1`, frozen and documented in [`docs/API.md`](API.md). No backend change is needed for these screens. |
| Passenger | [`apps/web-passenger`](../apps/web-passenger). ~18 kB, no runtime dependencies, no third-party requests. Unit, privacy and end-to-end tests, plus a browser smoke test that has actually been run. |
| Shared logic | `packages/corridor` (TypeScript) and `packages/core` (pure Dart, 103 tests, `dart analyze` clean). Corridor matching, API client, SSE, trip and request state machines. |
| Driver UI | `apps/driver`. Written, **never compiled**. |

## What is actually left

1. `flutter analyze` and `flutter test` on `apps/driver`. **Neither has ever
   run.** Expect real findings — most likely a `BuildContext` used across an
   `await`, unused imports, missing `const`. Fix them rather than silencing them.
2. `./tools/setup_apps.sh` generates the Android scaffolding and permissions.
   It has never been run either. Read it first.
3. Build, install, and walk the checks in [`docs/RUNBOOK.md`](RUNBOOK.md).
4. Deploy the passenger page and point it at the API — see
   [`apps/web-passenger/README.md`](../apps/web-passenger/README.md).

`apps/passenger` (the Flutter passenger app) is superseded by the web page. It
still builds against the same `packages/core` and is worth keeping until the
web version has survived a field test, but it is not the thing to ship.

## Start here

```bash
git clone <this repo> && cd Mowasalat
npm install
./tools/dev.sh          # Postgres, Redis, the pilot lines, the API — one command
```

It prints the address to build against. In another terminal:

```bash
npm test && npm run typecheck

API_BASE=http://<that address> npm run build:web
npm run serve:web       # open it on a laptop; see the README about https on phones
```

Then the driver app:

```bash
./tools/setup_apps.sh   # Android scaffolding, once

cd packages/core && dart pub get && dart analyze && dart test   # should stay green
cd ../../apps/driver && flutter pub get && flutter analyze && flutter test
```

Then [`docs/RUNBOOK.md`](RUNBOOK.md).

## Things that will look wrong but are not

- **No coordinate is ever sent to the server.** The phone (or the page) snaps
  its GPS to a cached corridor and transmits a remaining distance, a zone and a
  speed. If you find yourself adding `lat`/`lng` to a request, a test will stop
  you, and it is right to.
- **There is no map.** A tiled basemap means asking a third party for the tiles
  around wherever the user is standing, which is the disclosure this whole
  design exists to prevent. The line is drawn as itself instead.
- **A bus that leaves the corridor goes silent** rather than sending a coarser
  position. That silence is the design.
- **Nothing is queued when the network drops.** A lost reading is discarded, not
  retried. A backlog of positions would be a movement trail, which this system
  deliberately does not keep.
- **The driver cannot create or type a route.** Ops assigns lines. That is a
  product rule, not a missing screen.
- **`flutter_foreground_task` is not a dependency.** Geolocator's own foreground
  service does the job; a second plugin would be app size for nothing.
- **The API refuses browsers by default.** `WEB_ORIGINS` must name the deployed
  page, or every request fails in the browser with no server-side error.

## Where to push back

If `flutter analyze` finds something that looks like a real design problem
rather than lint noise, say so before working around it. The same goes for
anything in the runbook checks that fails in a way the runbook does not
anticipate.

## What "done" looks like

- `flutter analyze` clean on `apps/driver`.
- The driver app installed on a real phone, the passenger page open on another.
- The passenger taps `أنا مستني هون` and the driver sees a pin, with a number
  for how long it took.
- `grep -iE 'lat|lng|3[0-9]\.[0-9]{4}' server.log` comes back empty.
