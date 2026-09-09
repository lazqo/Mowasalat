# packages/core

The logic behind both apps: corridor matching, the `/v1` client, the realtime
stream, and the trip state machine.

**Pure Dart, with no Flutter dependency.** That is the point: everything that
decides anything lives here, so it can be analysed and tested without a device,
and the apps stay a thin shell that only draws.

```
dart pub get
dart analyze     # clean
dart test        # 75 tests
```

## Tested against real responses

`test/fixtures/` holds JSON captured from a **running `/v1` backend** — driver
profile with real Irbid–Malka geometry, an OTP challenge, trip credentials, a
live stream snapshot, and four error shapes. Invented response shapes would only
prove the parser agrees with itself.

## What is covered

| Area | |
|---|---|
| Corridor matching | inside/outside, remaining distance, monotonicity, both directions, zone order, real Irbid geometry |
| Tolerance | comes from route data, not a constant — the old fixed 150 m rule is gone |
| Speed | smoothing, implausible-sample rejection, reset between trips |
| Reporting | 5 s moving, 30 s stopped, silence off-corridor, bucketing |
| Trip state | start, persist, refuse a second trip, teardown, sign-out |
| Recovery | offered not resumed, no duplicate trip, stale trips dropped, unassigned lines dropped |
| Network loss | a lost reading is discarded, never queued for later upload |
| Streaming | frame parsing, split chunks, duplicate suppression, reconnect, replay after reconnect, teardown |
| Parsing | every fixture, including errors and non-JSON bodies |
| Privacy | the guard below |

## The privacy guard

`privacy_test.dart` reads `transport.dart` and fails if a field named `lat`,
`lng`, `latitude`, `longitude`, `coordinates`, `position`, `location` or `gps`
appears in a realtime payload. It also asserts the inverse — that country-pack
geography *does* carry coordinates — so the guard cannot be satisfied by
removing geography from the app.

The distinction is the whole point: a bus line's corridor is public
infrastructure; a person's live position is not.

Verified by breaking it on purpose — adding a `latitude` field to
`ProgressReport` fails three tests with a readable reason.

## One bug worth recording

The first version of `LiveStream` parsed frames with an `async*` generator.
Cancelling a subscription to a generator blocked on a source that never closes
does not complete, so **`close()` hung** — which in the app would mean ending a
trip hangs instead of tearing everything down. It now feeds an incremental
`SseParser` from a plain listener, and closing is immediate.
