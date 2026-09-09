# services/api

The backend. Its job is narrow: hold live scalars for sixty seconds, match
passengers to buses, and count aggregates — while never receiving, storing or
logging a coordinate.

```
npm run api                                          # public endpoints only
DATABASE_URL=… ADMIN_TOKEN=… PHONE_SALT=… npm run api   # with the ops admin at /admin
npm run seed                                         # load a country pack into Postgres
npm test                                             # 157 API tests
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
| `counters.ts` | Aggregates, with personal dimensions refused and thin cells suppressed |
| `service.ts` | The domain layer. No HTTP in sight |
| `db/schema.sql` | The durable half: network and roster. No trip or position table, deliberately |
| `db/network.ts` | Countries, hubs, destinations, lines and corridors |
| `db/roster.ts` | Drivers, vehicles, line assignments, verification state |
| `db/seed.ts` | Country pack into database |
| `phone.ts` | Turning what a driver types into one canonical number |
| `otp/provider.ts` | How a code reaches him: development, SMS, or a person |
| `otp/service.ts` | Issuing and checking codes, with the rate limits |
| `onboarding.ts` | Sign-up, driver tokens, and ops invitations |
| `live/store.ts` | The contract for live state, hub and tickets |
| `live/memory.ts` | In process: correct for one instance |
| `live/redis.ts` | Redis: for a pilot behind more than one |
| `live/coalesce.ts` | At most one push per interval |
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

## What a restart keeps, and what it must not

Postgres holds everything a restart must not lose: countries, hubs,
destinations, lines and their corridors, zones, wait points, drivers, vehicles,
driver-to-route assignments and verification state. A pilot that forgets which
lines its drivers run, or demotes everyone the drivers' committee vouched for,
is worse than useless.

Live movement is deliberately **not** in Postgres. There is no trip table, no
ride-request table and no position column anywhere in `schema.sql`, and that
absence is the point (§6.2): a stored movement trail is the one thing the plan
promises never to build. Trip progress, stream subscriptions and trip pseudonym
mappings stay in memory under the existing TTLs and are expected to vanish on
restart.

`restart.test.ts` proves both halves rather than asserting them in prose. A
"restart" there is a fresh `Admin` over the same database beside a brand new
`Service` whose live state started empty — which is exactly what the process
holds when it comes back:

| Proven | |
|---|---|
| Assignments survive | a driver's lines, and their removal |
| Lines survive | corridor width, zones, reference paths, wait points, imported geometry |
| Verification survives | tier, who vouched, proven trips and days, blocked status |
| Live movement does not | no bus, no request, and the old trip token is worthless |
| Nothing locatable is stored | no coordinate column on `driver`, `vehicle` or `driver_route`; coordinates exist only on infrastructure — a hub, a village, a zone centre, a waiting point |
| The schema stays clean | neither the live database nor `schema.sql` declares a trip, request or position table |
| Push still works | a driver on a line read back from the database streams to a subscriber |

The route model is persisted as decided (§9.1). A `route` row is the named line
a person recognises; the corridor lives in `route_corridor` and `route_zone`
because it is a geographic representation used on-device for matching, not a
path the driver must follow. `driver_route` lets a driver hold several lines,
and choosing exactly one line and one direction is a live decision the database
plays no part in.

Geometry is JSONB rather than PostGIS. Every spatial computation happens on the
phone by design, so the server runs no spatial queries and PostGIS would earn
nothing yet.

## Driver sign-in

Four screens and no paperwork: مرحبا → رقم الهاتف → رمز التحقق → شو الخط اللي
بتشتغل عليه؟ → الباص. No document, no licence photo, no permit, no email, no
password, no profile picture (§5.1).

**No SMS company is named anywhere in the product.** `OtpProvider` has one
method, and three implementations sit behind it: development (hands the code
back, and refuses to be constructed in production), SMS (through an injected
gateway, so swapping vendors is a line of wiring), and manual — which transmits
nothing at all, because in a market where SMS cannot be relied on, delivery is a
person. Which channels a country may use comes from its pack.

Because sign-up is a number and a code, this is the only door into a driver
account, so: codes expire in five minutes, work exactly once, allow five
attempts, are rate-limited per number and per caller, and are stored only as an
HMAC under a server secret — database access alone will not brute-force six
digits. The logger refuses to write a phone number, a code or a token at all.

Numbers are normalised before anything else. `0790123456`, `+962 79 012 3456`
and `٠٧٩٠١٢٣٤٥٦` are one driver; if they were not, he would end up with two
accounts and lose his lines.

Ops can create an **invitation** during face-to-face onboarding: a short code,
read aloud, that puts a driver straight onto the right lines already vouched to
tier 1. Single use, expiring, and stored hashed.

## Live state: Redis or in process

Postgres is durable configuration and roster. Redis is ephemeral operational
state, and the two never mix: no trip, request or position is ever written to
Postgres because Redis was inconvenient.

Set `REDIS_URL` and trip progress, ride requests, pub/sub, the trip pseudonym
mapping and stream tickets all move to Redis; leave it unset and they stay in
process, which is correct for a single instance. `live-store.test.ts` runs **one
behavioural suite against both**, so they are proven to agree rather than assumed
to — and it announces the Redis half as skipped rather than passing silently
when `REDIS_URL` is absent.

Two things the Redis implementation is careful about:

**Nothing may be durable.** Every key carries a TTL, checked by a test that
enumerates the keyspace, and `assertNoPersistence` refuses to start against a
Redis writing to disk. An RDB snapshot of this keyspace would be exactly the
movement trail the plan promises never to keep, so it is a guard rail rather
than a preference.

**Membership expires with its member.** A plain set of pseudonyms per line would
keep buses that stopped reporting an hour ago, because a set cannot expire
individual members. Membership is a sorted set scored by expiry, pruned on read,
and the index key expires too.

Verified against real Redis with two instances: a code issued on one and
verified on the other, a driver reporting to one while a passenger streams the
same bus from the other.

## Not built yet

- The SSE endpoints for the passenger and driver streams.
- Postgres. `live.ts` is in-memory; Redis replaces it behind the same contract.
- Real key custody for phone hashes. The salt comes from the environment, which
  is a deployment concern the plan puts in separate custody (§6.8).
- Exporting database edits back to a country pack, so ops changes can be
  committed to git (§11 wants both).
