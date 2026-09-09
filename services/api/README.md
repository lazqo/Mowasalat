# services/api

The backend. Its job is narrow: hold live scalars for sixty seconds, match
passengers to buses, and count aggregates — while never receiving, storing or
logging a coordinate.

```
npm run api                              # public endpoints only
ADMIN_TOKEN=… PHONE_SALT=… npm run api   # with the ops admin at /admin
npm test                                 # 107 API tests
```

No dependencies and no build step; TypeScript runs through Node's type
stripping, as in `packages/corridor`.

## The property this service exists to protect

[docs/PLAN.md §6.1](../../docs/PLAN.md) promises that no coordinate reaches the
server. The corridor library guarantees the client *can* compute a position
without sending one. It guarantees nothing about what this server accepts or
writes down — a debug log, an error handler or a crash reporter reintroduces a
coordinate very easily, and that is the leak nobody notices until an audit.

So the property is enforced in three places and tested:

| Where | What it does |
|---|---|
| `wire.ts` | Strict allow-list schemas. Unknown keys are rejected, so a client that starts sending `lat` gets an error rather than a silently stored value. A coordinate key is reported as a leak, not a typo. |
| `guard.ts` | The only logger. Every payload is scanned before it can be written, so a careless `log(req.body)` fails loudly in tests. |
| `wire.assertBucketed` | Refuses a position finer than the country's band. Blurring happens on the device, but a modified client could skip it — this makes the policy enforceable against a client we do not control. |

`service.test.ts` runs a whole trip and asserts nothing logged carries a
coordinate; `http.test.ts` asserts the same of what goes out over the wire.

### The rule is about people, not geography

The ops endpoints handle route geometry freely — the editor cannot draw a
corridor it is not allowed to see. That is not an exception to the rule. A bus
line's corridor is public infrastructure; a coordinate on the passenger and
driver endpoints is a *person's* position. The split is deliberate, and the
guard sits on the endpoints where a person could be located.

## Shape

| Module | Responsibility |
|---|---|
| `wire.ts` | The wire contract and its validation |
| `guard.ts` | Coordinate detection and the safe logger |
| `live.ts` | Expiring in-memory state — the Redis stand-in, same contract |
| `counters.ts` | Aggregates, with personal dimensions refused and thin cells suppressed |
| `service.ts` | The domain layer. No HTTP in sight |
| `stream.ts` | The push hub, coalescing, and stream tickets |
| `pack.ts` | Reading and writing country packs, validated and atomic |
| `admin.ts` | Ops: line and corridor editing, and the driver roster |
| `editor.html` | The corridor editor served at `/admin` |
| `http.ts` | Thin transport, public and ops routes |

## Two notes on the choices

**The domain layer is framework-independent.** The plan names NestJS, and that
still holds for the transport; `http.ts` is deliberately thin so wrapping these
same services in NestJS or Fastify touches nothing else. Keeping the domain free
of a framework is also what lets `npm test` run with no install.

**Push is Server-Sent Events, not WebSockets.** The stream is one-way, which is
all a bus position needs; SSE rides plain HTTP so it survives the proxies and
captive portals a cheap phone meets, and the browser reconnects it without any
code from us. The client-to-server direction is ordinary POSTs.

## Push

```
GET /stream/buses?ticket=…       passengers: bus positions on one line
GET /stream/waiting?tripToken=…  drivers: waiting pins ahead on their own trip
```

**Streams are bound, not open.** The plan requires reads to be bound to an
active trip or request so the national picture cannot be enumerated by a script
(§6.6). A driver's stream is bound to his trip token. A passenger has no token
before she has asked for anything, so the binding comes from the lookup she
already makes: `POST /buses` hands back a `streamTicket` good for that line and
direction only, and nothing else.

**A stream sends bus scalars, not answers.** No gap, no ETA — the subscriber's
phone already holds the corridor, so it computes both itself. That also means a
streaming passenger never has to send her position at all.

**Bursts collapse.** Buses report every five seconds, so a busy line would push
several times a second to every passenger. Notifications are coalesced to at
most one push per interval, with a trailing push so nothing is lost. A tested
case fires ten updates inside one window and asserts fewer than ten pushes.

Publishers say only "something on this line changed"; each subscriber then
receives the current snapshot. At this scale that is simpler than diffing and it
is self-healing — a missed notification is corrected by the next one.
Subscriptions are released on disconnect, which is tested rather than assumed.

## The ops admin

Served at `/admin`, behind a bearer token. It exists so the field team can turn
Phase 0 notes into a pack without hand-editing JSON.

**It fails closed.** Without `ADMIN_TOKEN` and `PHONE_SALT` the ops endpoints do
not serve at all — an unconfigured deployment exposes nothing rather than
exposing the driver roster to anyone who asks. Tokens are compared in constant
time.

**A line that fails validation is never written.** There is no force flag. Ops
owns the network (§5.4), and `validateRoute` in the corridor package is the one
definition of valid, shared with the pack CLI. Writes are atomic, by rename, so
a half-written route file can never reach a phone.

**Corridor width is informed, not guessed.** Upload recorded drives and the
editor reports what they imply — the 95th-percentile offset, the furthest
stray — and an operator decides. Building a corridor from drives clears the
provisional flag.

**The roster never stores a phone number.** Lookup is by salted hash, display is
the masked tail, and a test asserts the number appears nowhere in what comes
back over the wire. The roster is also the one place in the system holding
anything personal, so it stays out of the realtime layer entirely: a test
asserts no driver id appears in what a passenger can see.

Two known limitations in the editor page, both fine for an internal tool and
both worth fixing before it is used widely:

- MapLibre loads from a CDN, so the editor needs the open internet. Vendoring it
  matters for Syria, where the plan already avoids third-party dependencies.
- The default basemap is public OpenStreetMap tiles, whose usage policy is not
  meant for this. Set `MAP_TILES` to the self-hosted stack once it exists.

The editor page has not been rendered or clicked through — there is no browser
in the environment it was written in. Its endpoints are tested; its interface is
not.

## Not built yet

- The SSE endpoints for the passenger and driver streams.
- Postgres. `live.ts` is in-memory; Redis replaces it behind the same contract.
- OTP. The roster holds tiers and vouching, but nothing sends or checks a code.
- Persistence for the roster. It is in memory, like live state; Postgres replaces it.
- Real key custody for phone hashes. The salt comes from the environment, which
  is a deployment concern the plan puts in separate custody (§6.8).
