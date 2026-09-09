# apps/driver — تطبيق السائق

One journey, end to end:

```
sign in → choose an assigned line → choose direction → ابدأ
      → GPS becomes progress locally → transmit → see who is waiting → إنهاء الرحلة
```

Nothing else is built, on purpose. No earnings, no ratings, no chat, no
statistics, no route creation. Those would distract from proving the loop.

## Not verified

**Flutter and Android are not installed in the environment this was written in,
so none of this has been analysed, built, or run.** It is implemented, not
verified. Before any pilot build is distributed, someone with Flutter must run:

```
cd packages/core && dart analyze && dart test      # already passing here
cd apps/driver   && flutter pub get
                    flutter analyze
                    flutter test
                    flutter build apk --debug --dart-define=API_BASE=http://…
```

Then the real-device flow: a driver OTPs in, his Postgres-backed lines load, he
picks إربد – ملكا and a direction, starts, real GPS becomes progress, Redis
receives only scalars, a request made from another client appears live, he ends
the trip, and everything stops.

## Where the logic actually lives

Almost nothing decides anything in this package. It is a shell over
[`packages/core`](../../packages/core), which is **pure Dart** — no Flutter
dependency — precisely so the parts that matter could be analysed and tested
without a device. Those 75 tests do pass.

| Here | What it is |
|---|---|
| `main.dart` | Which screen to show, and wiring the pieces together |
| `src/sign_in_screen.dart` | رقم الهاتف → رمز التحقق |
| `src/home_screen.dart` | وين رايح؟ — his assigned lines, then direction |
| `src/trip_screen.dart` | The driving screen, and the recovery prompt |
| `src/location_service.dart` | GPS stream and the Android foreground service |
| `src/platform.dart` | HTTP, SSE, and the two values kept on the device |
| `src/strings.dart` | Every word the driver reads |

## Choices worth knowing

**The coordinate stops at the corridor matcher.** `LocationService` hands a
position to `TripController.onPosition`, which turns it into a remaining
distance, a zone and a speed. There is no code path from a fix to a log, an
analytics call, a crash report, or a queue.

**Nothing is queued when the network drops.** A reading that fails to send is
discarded, not retried later. A backlog of positions waiting to upload would be
exactly the trajectory the plan promises never to keep.

**Off the corridor, the app says nothing.** Not a smaller update — nothing. And
the tolerance comes from the route data, so Phase 0 can widen it from real Irbid
traces without an app release.

**Ending is two taps**, because a misplaced thumb should not take a bus off the
map mid-route. Auto-ending is deliberately not implemented for the first pilot:
wrongly ending a legitimate trip is worse than a driver tapping a button.

**Recovery asks rather than guesses.** If Android kills the app mid-trip, the
driver is offered استمرار الرحلة or إنهاء الرحلة. Silently resuming would put a
bus on the map he thinks he parked; silently dropping would take one off the map
he is still driving. It never creates a second trip.

**Few dependencies.** http, shared_preferences, geolocator, and the foreground
task plugin. Each one is app size and battery on a phone that has little of
either.
