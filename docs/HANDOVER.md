# For the developer

A Flutter developer should be able to finish this in **half a day**. Everything
that is not Flutter is built, tested and running.

## The job

Get two apps onto two Android phones and confirm one thing: a passenger taps
`أنا مستني هون` and, within a couple of seconds, the driver's phone shows her.

That is the whole test. Everything else is setup.

## What already works

| | |
|---|---|
| Backend | Node, Postgres, Redis. 198 tests. Run with one command. |
| Contract | `/v1`, frozen and documented in [`docs/API.md`](API.md). No backend change is needed for these screens. |
| App logic | `packages/core`, **pure Dart**. 103 tests, `dart analyze` clean. Corridor matching, API client, SSE, trip and request state machines all live here. |
| App UI | `apps/driver` and `apps/passenger`. Written, **never compiled**. |

## What is actually left

1. `flutter analyze` and `flutter test` on the two apps. **Neither has ever
   run.** Expect real findings — most likely a `BuildContext` used across an
   `await`, unused imports, missing `const`. Fix them rather than silencing them.
2. `./tools/setup_apps.sh` generates the Android scaffolding and permissions.
   It has never been run either. Read it first.
3. Build, install, and walk the thirteen checks in [`docs/RUNBOOK.md`](RUNBOOK.md).

## Start here

```bash
git clone <this repo> && cd Mowasalat
npm install
./tools/dev.sh          # Postgres, Redis, the pilot lines, the API — one command
```

It prints the address to build against. In another terminal:

```bash
./tools/setup_apps.sh   # Android scaffolding, once

cd packages/core && dart pub get && dart analyze && dart test   # should stay green
cd ../../apps/driver && flutter pub get && flutter analyze && flutter test
cd ../passenger && flutter pub get && flutter analyze && flutter test
```

Then [`docs/RUNBOOK.md`](RUNBOOK.md) from step 5.

## Things that will look wrong but are not

- **No coordinate is ever sent to the server.** The phone snaps its GPS to a
  cached corridor and transmits a remaining distance, a zone and a speed. If you
  find yourself adding `lat`/`lng` to a request, a test will stop you, and it is
  right to.
- **A bus that leaves the corridor goes silent** rather than sending a coarser
  position. That silence is the design.
- **Nothing is queued when the network drops.** A lost reading is discarded, not
  retried. A backlog of positions would be a movement trail, which this system
  deliberately does not keep.
- **The driver cannot create or type a route.** Ops assigns lines. That is a
  product rule, not a missing screen.
- **`flutter_foreground_task` is not a dependency.** Geolocator's own foreground
  service does the job; a second plugin would be app size for nothing.

## Where to push back

If `flutter analyze` finds something that looks like a real design problem
rather than lint noise, say so before working around it. The same goes for
anything in the thirteen checks that fails in a way the runbook does not
anticipate.

## What "done" looks like

- `flutter analyze` clean on both apps.
- Both apps installed on real phones.
- Check 8 in the runbook passes, with a number for how long it took.
- `grep -iE 'lat|lng|3[0-9]\.[0-9]{4}' server.log` comes back empty.
