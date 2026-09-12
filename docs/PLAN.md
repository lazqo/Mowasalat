# Mowasalat (working name) — Product & Engineering Plan

**Status:** Draft v4 · **Pilot:** Irbid ↔ Bani Kinana, Jordan · **Then:** rest of Jordan, then Syria

> **Changes in v4.** The pilot network is fixed: five named lines between Irbid and Bani Kinana (§4.3). Routes are now **transport service identities**, not street-by-street geometry — a rigid polyline is replaced by a **Route Corridor** that tolerates drivers taking whichever road they normally take (§9). This forced one genuine change to the privacy mechanism: position is now reported as *remaining distance to the destination* rather than *progress along a line*, which is monotonic no matter which road is used (§6.1). Drivers are assigned to their lines by ops and pick line + direction at trip start (§5.4). Intermediate destinations are first-class (§9.4). "Mowasalat" is a working name only (§16.1).

> **Changes in v3.** Open decisions resolved against one test: does this cause problems when we cross a border? Trajectory storage ruled out permanently, with an aggregate layer in its place (§6.3). Country packs carry policy as well as data (§11).

> **Changes in v2.** Driver verification no longer assumes drivers hold shareable licence or permit documents (§5). Location privacy became a designed architecture rather than a policy promise (§6).

---

## 1. The problem in one paragraph

In Jordan (and Syria) inter-town buses and service vans have no published schedule. A passenger stands on the roadside not knowing if a bus is coming in two minutes or forty. A driver leaving a town drives around looking for anyone who looks like they want a ride, then goes to the city bus complex (المجمع) where passengers gather for the return trip. On the way back the passenger knocks on the roof or says "على جنب" to be let off. Both sides waste time and fuel because neither knows where the other is.

**The app closes that gap with the smallest possible product:** the driver says which line he is running, the passenger says where she is going, and each sees the other on a map. No payment. No names. Arabic first. Simple enough for a child or a grandparent.

---

## 2. Product principles (these decide every argument later)

1. **Three taps or fewer** to the value. Passenger: open → pick destination → "I'm waiting". Driver: open → pick line and direction → "Start".
2. **No personal data on screen, ever.** No names, no photos, no phone numbers between passenger and driver. Pseudonymous IDs that rotate per trip.
3. **Collect nothing you cannot justify losing.** Every field we store is a field that can leak or be demanded. The safest data is the data that was never sent (§6).
4. **Model the transport system as it actually works**, not as a tidy schema would prefer. Drivers run *lines*, know their own roads, and vary them. The software adapts to that, not the reverse (§9).
5. **Arabic is the source language**, not a translation. Labels use the everyday Jordanian/Levantine words people already say (المجمع, الخط, راكب, وين رايح؟).
6. **Works on a 60 JD Android phone on 3G.** Small payloads, offline-tolerant, low battery use.
7. **Country is configuration, not code.** Adding Syria means adding a country pack, not forking the app.
8. **Nothing destructive is one tap away.** Confirm every cancel/end. No free text fields except destination search. No settings maze.
9. **Useful on day one even with zero drivers online.** The passenger app doubles as a line directory, so the chicken-and-egg problem does not kill the pilot.

---

## 3. Vocabulary

| App term (code/API) | Arabic UI | Meaning |
|---|---|---|
| Route | الخط | **A transport service identity**, e.g. `إربد – ملكا`. An origin, a destination, and two directions. Not a street-by-street path. |
| Direction | الاتجاه | Which way the service is running: `إربد → ملكا` or `ملكا → إربد`. |
| Route Corridor | — | Internal only. The geographic area a line's traffic actually uses, tolerant of road variation (§9.2). Never shown to users. |
| Hub | المجمع / الموقف | Where a line's vehicles gather and depart in the city. In Syria often الكراج. |
| Zone | — | Internal only. An ordered area along a corridor — the origin hub, each intermediate village, the destination. Gives robust ordering when roads vary. |
| Trip | الرحلة | One driver running one line in one direction right now. |
| Ride request | طلب / "أنا مستني" | A passenger saying "I am waiting here and going to X". |
| Waiting point | — | A recognised place people actually stand — a junction, a village entrance, a shop. Used for coarse positioning (§6.5). |
| Remaining | — | Road distance still to cover to reach the direction's endpoint. The **only** position value the server ever handles (§6.1). |

---

## 4. Scope

### 4.1 MVP

**Passenger app (تطبيق الراكب)**
- Open → **"وين رايح؟"** with the nearest hub and common destinations as large tiles; search for the rest. Destinations include **intermediate villages**, not only line endpoints (§9.4).
- Result screen: a map plus the buses currently running lines that serve that destination, sorted by "will pass you in N minutes". If none are running: the line's departure hub and typical frequency.
- One big button **"أنا مستني هون"**. The request names a line, a direction, a destination and a coarse position — never a coordinate (§6.1).
- Waiting screen: bus approaching, ETA, big **"ركبت"** and a small "إلغاء" with confirm. Auto-expires after 20 min.
- No account, no login. No stable identifier is ever sent to the server.

**Driver app (تطبيق السائق)**
- Open → the lines **he is assigned to** (§5.4), usually one or two. No search, no free text, no creating routes.
- Tap a line → tap the direction → big **"ابدأ"**.
- On-trip screen: the corridor, his own position, and waiting passengers ahead of him ("٣ ركاب بعد ٢ كم"). Optional voice announcement so he does not look at the phone.
- Big **"خلصت"** with confirm. Ends automatically on arrival at the destination zone, or after 30 min stopped.
- Sign-up is a phone OTP and nothing else. No documents are ever required (§5).

**Admin / ops (web, internal)**
- Country packs: hubs, lines, corridors, zones, destinations, waiting points, strings.
- Driver roster, line assignment, vouching codes, block/unblock.
- Live view of trips and requests, aggregate counters.

### 4.2 Explicitly out of MVP
- Payments, fares, wallets.
- Seat booking or scheduling in advance.
- Chat or calling between passenger and driver.
- Ratings tied to identities.
- Drivers creating or editing lines. Ops owns the network so it stays clean.
- Dense intra-city routes with many stops.
- iOS as a pilot platform. Build it, pilot on Android.

### 4.3 The pilot network: Irbid ↔ Bani Kinana

Rather than attempting all of Irbid, the pilot covers one district's worth of lines out of Irbid into Bani Kinana (لواء بني كنانة):

| # | Line | Origin | Destination |
|---|---|---|---|
| 1 | `إربد – ملكا` | Irbid | Malka |
| 2 | `إربد – سما الروسان` | Irbid | Sama al-Rousan |
| 3 | `إربد – كفرسوم` | Irbid | Kufr Soum |
| 4 | `إربد – حبراص` | Irbid | Habras |
| 5 | `إربد – أم قيس` | Irbid | Umm Qais |

Each is bidirectional. Each carries its own intermediate destinations, to be established in Phase 0.

**Why this choice is stronger than five scattered lines.** These five share an origin city and, for the first stretch out of Irbid, largely share road. That means their corridors **overlap near the city**, so a passenger standing in that shared stretch can be served by any of up to five lines rather than one. Liquidity in the early weeks is the single biggest risk to a pilot like this, and overlapping corridors are the cheapest way to buy it. The lines also serve one district, so drivers know each other and the drivers' committee can vouch across all five (§5.2).

**One line to watch in the numbers.** Umm Qais (Gadara) is a tourist site as well as a village, so its demand pattern will differ from the other four — different hours, some non-local passengers, possibly different language needs. Worth tracking separately rather than letting it skew the pilot's aggregate metrics.

---

## 5. Driver identity & verification (no documents required)

### 5.1 The concern, and why it is smaller than it looks

We should not assume a driver has a licence or route permit he can produce, photograph and share. In practice, across both countries:

- The **route permit is usually held by the vehicle's owner**, not by the man driving it. Relief and substitute drivers are extremely common.
- Many drivers work someone else's bus on a daily arrangement and hold no paperwork of their own.
- In Syria, documentation is frequently lost, outdated, or impossible to reissue.
- Asking for a document photo at sign-up is the biggest drop-off point in any driver onboarding flow, and it would make us the custodian of a national archive of ID documents — exactly the liability §2.3 tells us to avoid.

There is also a positioning argument. **We are not licensing anyone.** Verifying a licence would make us look like a regulator or an employer, which invites legal exposure we cannot carry and a job the LTRC (هيئة تنظيم النقل البري) already does. Our verification only has to answer one much narrower question: *will a real bus actually turn up?*

**And for the pilot the problem essentially disappears**, because the drivers on five lines in one district are onboarded face to face by our own field person. Verification at that scale is a handshake. The tiers below are what let that survive scale.

### 5.2 The tiered trust model

| Tier | How it is earned | What the driver gets |
|---|---|---|
| **0 · Phone** | Phone OTP. Nothing else. Immediate. | Full ability to run trips at once. Shown to passengers as a bus with no verification mark. |
| **1 · Vouched** | A hub coordinator, the drivers' committee (لجنة السائقين), or our field ops person confirms him in person and issues a one-time code. Alternatively, two already-trusted drivers on the same line vouch for him in-app. | Verified mark. Ranked above unverified buses. |
| **2 · Proven** | Automatic, no human involved: N completed trips whose movement stayed within the line's corridor, across D distinct days. | Same as Tier 1, earned without anyone's time. |
| **3 · Documentary** | *Optional, never required.* The driver may type a plate or permit number as text. Checked against LTRC records only if a data-sharing arrangement ever exists. | A second mark, if the market turns out to value it. |

Rules that make this work:

- **Tier 0 is never blocked.** A driver who declines everything else can still drive and still be found. If verification gates usage, the pilot dies at sign-up.
- **No document images are ever uploaded or stored.** Tier 3 is typed text only.
- **Tier 2 is the load-bearing one.** A fake bus cannot fake it: repeatedly covering a real corridor at plausible speeds, day after day, is far better evidence that a bus will show up than any document.
- **Verification is displayed as trust, not identity.** Passengers see a mark and a vehicle description, never a name, licence or phone.

### 5.3 What verification is actually defending against

| Threat | Defence |
|---|---|
| Ghost buses that never arrive | Tier 2 behavioural trust; drivers with poor arrival records rank down and are eventually suspended. |
| Someone impersonating a line to see where passengers wait | Passenger positions are coarse and corridor-relative (§6); a fake driver learns little, and sees only his own active line. |
| One person running many driver accounts | One account per phone number; new accounts start at Tier 0 with the tightest rate limits. |
| A genuinely dangerous driver | Out of scope, honestly. That is a policing and licensing matter. We provide an ops block list and cooperate with the regulator; we do not pretend to screen. |

### 5.4 Line assignment

Drivers are attached to the lines they actually run, during onboarding, by ops:

```
Driver #—
  routes: [ إربد – ملكا, إربد – سما الروسان ]
```

A driver may hold several. At the start of a shift the app asks only what he already knows:

```
وين رايح؟
  → ملكا
  → سما الروسان
ثم:  ابدأ  →  الاتجاه: إربد ← ملكا
```

That selection sets the trip's line and direction. **Drivers never type a destination or create a line.** Ops owns the network, which keeps it clean, keeps corridors meaningful, and stops the map filling with one-off routes that no passenger will ever search for. The cost is an ops step whenever a driver picks up a new line; at pilot scale that is a message to the field person, and at national scale it is a queue in the admin tool.

---

## 6. Location privacy: the tracking architecture

Privacy here cannot be a promise in a policy document. At country scale, a live map of every bus and every waiting person is a movement database for a whole population, and the only durable protection is to **not build one**. The design below means we are not able to produce that database even if we wanted to.

### 6.1 The core mechanism: raw coordinates never leave either phone

Every device caches its city's lines and corridors, because the country pack ships them for offline use (§11). That lets the whole system run on **scalars measured against the line**, never latitude and longitude.

The measure is **remaining road distance to the direction's endpoint**. This replaces "progress along a fixed polyline", which the corridor model (§9) makes unworkable: if two drivers take different roads to Malka, they have no common line to measure progress along — but they have exactly the same distance still to cover. **Remaining distance is monotonic whichever road is taken**, which is precisely the property the corridor needs.

**Driver side.** The phone checks it is inside the line's corridor, looks up its remaining distance from the cached distance table, and transmits: line, direction, remaining metres (bucketed), zone index, speed. No latitude or longitude is ever sent. Outside the corridor it transmits nothing at all — so a detour home or to a mechanic is invisible by construction, not by policy.

**Passenger side.** "Which lines pass near me?" is computed **on the phone** against the cached corridors. The server is never asked "what is near this point", because that question would require sending the point.

**Server side.** The backend holds line-relative scalars and nothing else. It cannot plot a person or a bus on a map, because it has never been told where the map's origin is for them. Rendering happens on the clients.

```
Driver phone                     Server                        Passenger phone
─────────────                    ──────                        ───────────────
GPS 32.6104,35.7712
  ↓ inside corridor? yes
  ↓ look up remaining distance
line   = إربد–ملكا      ──────▶  line إربد–ملكا · dir 1        ──────▶  draw bus at
dir    = 1 (→ملكا)               remaining 8,400 m · 41 km/h            8,400 m out
remaining = 8,400 m              zone 3 of 6                            on the corridor
speed  = 41 km/h                 (60 s TTL, memory only)

                                                              GPS 32.5890,35.8221
                                                                ↓ match corridors locally
                        ◀──────  line إربد–ملكا · dir 1        ◀──────  send scalars only
                                 remaining ~5,100 m · zone 2
                                 dest: حبراص
```

Ordering falls out of it: **the driver will pass the passenger when the driver's remaining distance is greater than hers.** ETA is the difference divided by his recent speed. Both are subtractions on two numbers neither of which is a location.

**The corridor makes this better, not worse, for privacy.** A polyline projection pinned someone to a line to within metres. A corridor plus a bucketed remaining distance is inherently coarser, and the zone index is coarser still. We gave up precision we never wanted to hold.

### 6.2 Storage: the trail is never written, not merely deleted

- Live state lives in **Redis with a 60-second TTL, on an instance with disk persistence switched off**. There is no snapshot or append-only file to seize or leak.
- **No trip trajectory table exists in the schema.** This is stronger than a retention policy — there is nothing to forget to purge, and no migration can accidentally start retaining it.
- Aggregates are **incremented in flight**, never derived from a stored trail.
- Trip and request rows hold a line, timestamps and a status. They are deleted 24 hours after completion.

**This is decided and is not revisited** (§16). The reason is expansion, not only ethics: a stored movement trail turns every new country into a legal negotiation and a political target, while costing storage that grows with every bus-second forever. It is also the only irreversible direction — we can add storage later if we are ever wrong, but we can never un-store data we already hold, and we can never un-break the promise. What we give up is per-individual replay and post-hoc forensic debugging. §6.3 explains why that costs expansion planning nothing.

### 6.3 Planning data without a trail

The obvious objection is that expansion needs data: entering a new area means knowing where demand is, which lines are underserved, and where people wait that no line serves. That objection is real, and it is answered without storing a single trail — because **planning needs aggregates, and aggregates never needed identity in the first place.**

Counters are incremented at the moment an event happens; the event itself is then discarded. Nothing is keyed to a person, device, token or session.

| Counter | Keyed by | What it answers |
|---|---|---|
| Demand | line, zone, hour | Where do people actually wait, and when? |
| **Unserved demand** | origin area, searched destination, hour | **Which line should we add next?** The single most valuable expansion signal, and it needs no identity at all. |
| Coverage gaps | area, hour | Where do searches return no line whatsoever? |
| Line health | line, direction, hour | Trips started, trips completed, median headway. |
| Match quality | line, hour | Requests met by a bus vs requests that expired waiting. |
| Corridor fit | line, zone, hour | How often drivers fall outside the corridor — tells ops a corridor is drawn too tight (§9.3). |

Three rules keep this from quietly becoming a trail:

1. **No counter may be keyed by any identifier of a person**, including a rotating token or a session.
2. **Minimum cell size.** A bucket with fewer than *k* events in its period is suppressed or merged upward. A counter must never describe one person's single journey.
3. **Counters are append-only integers.** No raw event log sits behind them "just in case" — that log is exactly the trail we declined to keep.

For the debugging we genuinely lose, the answer is **opt-in diagnostics**: a driver hitting a problem taps "report a problem", which uploads the app's local buffer *for that trip only*, with explicit consent, deleted once resolved. Consent-gated and bounded, rather than a standing trail kept in case someone eventually needs it.

The privacy-maximal choice and the expansion-planning need are therefore not in tension. Unserved-demand counters tell you which lines to open next better than trajectory replay would, because they measure the demand you are *failing* to serve rather than the trips you already serve.

### 6.4 Unlinkability: you cannot follow the same person across days

- **Passengers** send a rotating per-request token, not a device ID. Two requests by the same person on consecutive days are not linkable server-side.
- **Drivers** get a pseudonym that rotates every trip. The mapping from account to trip pseudonym exists only in memory for the life of the trip, so the realtime layer never handles an account ID.
- Consequence to accept: a passenger cannot "favourite" a driver she likes, and reputation cannot be built on an identity passengers can see. Trust is carried by the tier mark (§5.2), which the account holds privately.

### 6.5 Resolution that adapts to density (k-anonymity)

A pin showing "one person waiting" on an empty village road is a pin showing *a specific person*. So precision is not a constant:

- Where several requests are active nearby, positions bucket to a coarse remaining-distance band and cluster into a count.
- Where fewer than **k** requests are active nearby, the request snaps to the **nearest recognised waiting point** — a village entrance, a junction, a shop. The driver sees "passengers at the junction", which is all he needs. Phase 0 collects these points precisely so this degradation has somewhere sensible to land.
- The same rule applies to buses on quiet lines at quiet hours, where a single bus is effectively a single named driver.

### 6.6 Limiting who can see what

- A driver sees only requests **on his own active line and direction, ahead of him, within a window**. There is no global view, for anyone, at any tier.
- A passenger sees only buses on lines serving her chosen destination.
- Read endpoints are rate-limited and bound to an active trip or request, so the national picture cannot be enumerated by a script.
- Ops staff see aggregate counters and a coarse live view. Anything finer is role-gated and logged.

### 6.7 Controls the user actually holds

- Driver: tracking runs only between **ابدأ** and **خلصت**, under a foreground service with a permanent visible notification, plus a one-tap "go off air" that stops transmission instantly.
- Passenger: cancelling a request removes it immediately, everywhere.
- Neither app requests background location for the passenger role at all.
- One onboarding card, in plain Arabic, states honestly what is and is not sent — "we do not know your name, and we do not receive your location, only how far you still are from where the bus is going". One sentence, one picture, per §10.

### 6.8 What this does *not* protect against — stated plainly

- For up to 60 seconds, the server knows that an anonymous bus is some distance from the end of a line. That is inherent to the product.
- A compromised or seized **phone** defeats all of the above. Device security is not ours to solve.
- We do hold **driver phone numbers**, because we need to reach drivers. They are encrypted with keys in separate custody, access is logged, and they are never exposed to passengers or to the realtime layer.
- Under legal compulsion there is very little to hand over — by design. We should say so publicly and be able to demonstrate it.

---

## 7. Architecture

```
┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
│  Passenger app   │   │   Driver app     │   │   Ops web admin  │
│  (Flutter)       │   │   (Flutter)      │   │   (React/Next)   │
│  corridor match  │   │  corridor match  │   │  corridor editor │
│  on device       │   │  on device       │   │                  │
└────────┬─────────┘   └────────┬─────────┘   └────────┬─────────┘
         │  HTTPS + WebSocket   │                      │
         │  (line, direction,   │                      │
         │   remaining, zone —  │                      │
         │   never coordinates) │                      │
         └──────────┬───────────┴──────────────────────┘
                    ▼
        ┌─────────────────────────┐
        │  API  (TypeScript,      │
        │  NestJS or Fastify)     │
        │  - country resolver     │
        │  - matching (scalars)   │
        │  - realtime gateway     │
        └──┬──────────┬───────┬───┘
           │          │       │
   ┌───────▼───┐ ┌────▼────┐ ┌▼──────────────┐
   │ Postgres  │ │  Redis  │ │ Map services  │
   │ + PostGIS │ │ live    │ │ OSM tiles     │
   │ (lines,   │ │ scalars │ │ (MapLibre),   │
   │ corridors,│ │ 60s TTL │ │ OSRM/Valhalla │
   │ trips)    │ │ no disk │ │ (self-hosted) │
   └───────────┘ └─────────┘ └───────────────┘
```

**Key choices and why**
- **Flutter** for both apps from one monorepo with a shared `core` package. One team, first-class RTL, runs well on low-end Android, iOS later at little cost. The shared package owns corridor matching and the remaining-distance lookup, so both apps compute identically.
- **Two separate apps**, not one with a role switch. Simpler mental model, separate store listings, separate permissions.
- **TypeScript backend** (NestJS). Fast to build, easy to hire for regionally, good WebSocket story.
- **PostgreSQL + PostGIS** for corridor and zone geometry and the ops editor; **Redis** for live scalars and pub/sub, persistence disabled.
- **OpenStreetMap + MapLibre + self-hosted OSRM.** No per-request cost at country scale, no availability risk in Syria, no third party receiving our users' map queries. OSRM is also what generates each corridor's remaining-distance table offline, in the admin tool — never at request time.
- **Firebase Cloud Messaging** for push. Payloads carry no location.

---

## 8. Data model

```
Country      id, code (JO, SY), name_ar, bounds, locale, phone_prefix, digits, enabled
City         id, country_id, name_ar, center
Hub          id, city_id, name_ar, location, aliases_ar[]        -- المجمع / الموقف
Destination  id, country_id, name_ar, location, aliases_ar[]     -- town, village, landmark

Route        id, country_id, name_ar ("إربد – ملكا"),
             origin_hub_id, destination_id, bidirectional, typical_headway_min, active
RouteCorridor route_id, reference_paths (MultiLineString),   -- roads drivers actually use
             corridor_polygon (Polygon), width_m,
             distance_table (samples: point -> remaining_m, per direction)
RouteZone    id, route_id, seq, name_ar, area (Polygon),
             kind (origin_hub | intermediate | destination)
RouteDestination route_id, destination_id, zone_id,
             kind (terminus | intermediate)                     -- §9.4
WaitPoint    id, route_id, zone_id, name_ar, area               -- for §6.5
DriverRoute  driver_id, route_id                                -- assignment, many-to-many

Vehicle      id, driver_id, type (coaster|minibus|service), colour, plate, show_plate
Driver       id, country_id, phone_enc, tier (0..3), status, created_at
Trip         id, route_id, direction, driver_id, vehicle_id, started_at, ended_at, status

TripProgress (Redis, TTL 60s, no disk persistence)
             trip_pseudonym -> remaining_m, zone_seq, speed_kph
             -- NO lat/lng, NO driver_id
RideRequest  id, request_token (rotating), route_id, direction, destination_id,
             remaining_bucket_m, zone_seq, status, expires_at, pseudonym

-- the only long-lived data, all of it counters (§6.3):
RouteStats   route_id, direction, zone_seq, hour_bucket, requests, trips, matched, expired
Unserved     country_id, origin_area, destination_id, hour_bucket, count
Coverage     country_id, area, hour_bucket, empty_searches
CorridorFit  route_id, zone_seq, hour_bucket, off_corridor_events
```

What must stay absent: no trajectory table, no coordinate column on a trip or a request, no stable device identifier, and no `driver_id` anywhere in the realtime layer.

---

## 9. Routes, corridors and matching

### 9.1 A route is a service, not a street

Drivers already know how to get from Irbid to Malka, and the road they take varies with traffic, roadworks, and habit. Modelling a line as one exact path and dropping a driver who deviates 150 m would produce a system that is wrong most of the time and blames the driver for it. So the model separates two things that a naive design conflates:

- **Route** — the service identity a human recognises: `إربد – ملكا`, an origin, a destination, two directions. This is what drivers select, what passengers search, and what ops curates.
- **Route Corridor** — an internal geographic representation, used on-device for matching, ordering and ETA. Never shown to anyone.

### 9.2 What a corridor contains

| Part | What it is | What it is for |
|---|---|---|
| Reference paths | One or more LineStrings — the roads drivers actually use, including known alternatives | Generating the distance table; drawing the line on a map |
| Corridor polygon | A buffer around all of them, width set per line (wide in open country, tighter in town) | Answering "is this bus/passenger on this line at all" |
| Ordered zones | Origin hub → each intermediate village → destination, each an area with a sequence number | Robust ordering that survives any road choice |
| Distance table | Sampled remaining road distance to each endpoint, precomputed offline by OSRM | The scalar in §6.1, without a routing engine on the phone |
| Waiting points | Recognised places people stand | Coarse positioning when density is low (§6.5) |

The table is small — sampling every ~100 m over a 20 km line is a couple of thousand entries per direction — so shipping it in the country pack costs almost nothing and keeps everything offline-capable.

### 9.2a Corridors are generated from the roads, then corrected in the field

A routing engine already knows where the road goes, so it does the first pass:
origin and destination in, the real road out, including the genuine
alternatives. `npm run build:routes -- countries/<cc>/routes/*.json --write`
does this for a whole pack.

Three constraints shape how this is used.

**It is an ops-time tool, never a runtime one.** A corridor is generated once,
on a laptop, when a line is created or corrected, and stored in our own
database. No phone ever calls a routing or tile service, because doing so
would tell that service where the person holding it is standing — precisely
the disclosure §6 exists to prevent.

**The licence has to permit storing the result.** This rules out the
commercial routing APIs: Google's terms forbid caching or storing what
Directions returns and forbid drawing it on a non-Google map, and storing the
route *is* the feature here. OSRM, Valhalla and GraphHopper over OpenStreetMap
permit it under the ODbL, whose condition is attribution — carried in the pack
and on the passenger page.

**A router is not a survey.** It answers "where does the road go", not "which
road do the drivers take", where they actually stop, or what passengers call
the place. A generated line stays `provisional` and §12.1 still applies; what
changes is that Phase 0 starts from the real road instead of a straight line.

That difference is not cosmetic. The five pilot lines were carrying
straight-line placeholder geometry, and measured against the actual roads,
between 46% and 85% of each road fell outside its own corridor — on إربد – أم
قيس, a bus would have been invisible for 19.8 km of a 28.8 km trip, and every
ETA was 17–34% short. None of that would have shown up in a test; it would
have shown up as the app not working, in Irbid, in front of drivers.

**A second road is a second reference path, not a wider corridor.** The two
roads between إربد and ملكا diverge by about six kilometres. One corridor wide
enough to hold both would be twelve kilometres across — it would call a bus
three villages away "on the line", make remaining-distance useless as an ETA,
and capture exactly the private detours that going silent off-corridor
(§6.1) exists to keep private. Two paths, each a few hundred metres wide,
describe the same reality with none of that. This is why `referencePaths` is a
list.

### 9.3 Corridor width is a tuning knob, not a constant

Width is per line, set by ops, and starts generous. **A driver falling outside the corridor is treated as evidence the corridor is drawn wrong, not that the driver misbehaved.** The `CorridorFit` counter (§6.3) reports how often that happens per line and zone, so ops widens corridors from real data during the pilot rather than guessing up front. The driver app says "you seem to have left the line" rather than silently going dark.

### 9.4 Intermediate destinations

A named line does not mean travelling end to end. If `إربد – ملكا` passes or serves villages along the way, each is attached to the line as an intermediate destination in a specific zone.

So a passenger can search a village, be offered the main Irbid–Malka line, and be matched with a driver running it — without the driver doing anything different. Conversely a passenger heading only part-way is matched normally, because ordering is by remaining distance, and her destination simply has a larger remaining value than the terminus.

### 9.5 The matching sequence

1. Passenger picks a destination. Her **phone** filters cached lines to those serving it, and checks which of their corridors contain her.
2. Her phone looks up her own remaining distance and zone from each candidate line's distance table.
3. The phone asks the server for active trips on those lines and directions. **The query names lines, not a location.**
4. A trip is a candidate if the driver's `remaining_m` is **greater** than the passenger's — he still has to cover the ground she is standing on — and the gap is within a window.
5. ETA is that gap divided by his recent average speed.
6. On **"أنا مستني"** the request is stored with a bucketed remaining value and zone, and published to every candidate trip. Nearby requests collapse into one pin with a count.
7. No accept/decline step. Broadcasting to every bus behind her matches how people actually board: the first bus that comes.
8. Drivers send scalars every 5 s when moving, 30 s when stopped, never when outside the corridor.

**Known limitation, worth stating.** Ordering by remaining distance assumes the driver's road will pass the passenger. Where a corridor genuinely forks and rejoins, a driver on one branch will not pass someone on the other. The zone sequence catches the common cases; for a true fork, the corridor should be modelled with branch-labelled zones so a passenger on branch A is not offered a bus on branch B. Phase 0 should note any line where this actually occurs — on five roughly linear lines out of Irbid it may not arise at all.

---

## 10. Simplicity & accessibility rules (childproof / elderproof / edit‑proof)

- Font size minimum 18 sp, primary buttons 64 dp tall, full-width, high contrast, one primary action per screen.
- Arabic RTL layouts designed natively (not mirrored English). Eastern Arabic numerals (١٢٣) by default, switchable per country.
- Icons always paired with a word. Colour never the only signal.
- No free-text input except destination search; search matches aliases, dialect names and common misspellings — and must accept the names people actually use for these villages, which Phase 0 collects.
- Every destructive action needs a second tap on a confirm sheet. Nothing can be deleted by the user.
- Voice: optional text-to-speech for drivers ("راكب بعد كيلومترين"). Optional voice search for passengers later.
- Onboarding is three swipeable pictures, skippable. One of the three is the privacy card from §6.7.
- Test with real people: at least 5 elderly and 5 children before pilot launch.

---

## 11. Multi-country strategy

A **country pack** is a versioned folder in the repo plus rows in the database:

```
countries/
  jo/  config.json, strings.ar-JO.json, hubs.geojson, routes.geojson, corridors.geojson
  sy/  config.json, strings.ar-SY.json, hubs.geojson, routes.geojson, corridors.geojson
```

**The pack carries policy, not just data.** This is the single most important structural decision for expansion: anything that differs between countries and lives in code becomes a fork the first time we cross a border.

```jsonc
{
  "code": "JO", "locale": "ar-JO", "digits": "eastern", "phone_prefix": "+962",
  "bounds": [...],
  "residency_region": "me-central-1",       // where this country's database lives
  "vouching_authorities": ["drivers_committee", "hub_supervisor", "field_ops"],
  "plate_visibility": "opt_in",             // a regulator may later require display
  "tier2_thresholds": { "trips": 12, "distinct_days": 5 },
  "default_corridor_width_m": 750,          // per-line overrides allowed (§9.3)
  "k_anonymity_min": 4,
  "retention_hours": 24,
  "otp_channels": ["sms", "manual_vouch"]   // manual path where SMS is unreliable
}
```

- Strings are per-dialect overrides on a shared Arabic base (Jordan says المجمع, Syria often says الكراج).
- Packs split by city so a phone downloads only what it needs — which is what makes offline corridor matching practical.
- A new country is a data and policy exercise carried out by ops, not an engineering project. That is the test every future feature should be held to.
- **Syria checks before starting:** app store and cloud availability under the current sanctions status, weaker mobile data, SMS OTP delivery. The manual vouching path (§5.2) already covers the last of these.

---

## 12. Delivery phases

| Phase | Duration | What ships | Exit criteria |
|---|---|---|---|
| **0. Discovery** | 3 weeks | Field research on the five Bani Kinana lines (§12.1). | The five lines modelled well enough to run — **not** perfect geometry (§12.2). |
| **0b. Name check** | in parallel | Domain, trademark, Play/App Store and existing transport-company searches (§16.1). | A name we can register and list everywhere we intend to go. |
| **1. Foundations** | 4 weeks | Monorepo, CI, backend skeleton, country resolver, PostGIS schema, Redis live layer, corridor + distance-table library, admin corridor editor, self-hosted tiles and OSRM for Jordan. | Ops can draw a corridor and generate its distance table; the library places Phase 0 GPS traces on the right line and zone. |
| **2. MVP apps** | 6–8 weeks | Both Flutter apps, push, matching, tiered sign-up, line assignment, Arabic UI, accessibility rules. | End-to-end on a real line: a driver sees a test request and the passenger sees the bus approaching, with no coordinate in any server log. |
| **3. Pilot** | 6 weeks | 20–50 drivers across the five lines, open passenger beta on Play Store, weekly iteration. | ≥40% of pilot drivers run ≥3 trips/week; ≥100 real requests/week; median wait time below the Phase 0 baseline; corridor-fit counters stable. |
| **4. Jordan scale** | ongoing | More districts, then more cities, via pack data only. Ops onboarding playbook. iOS. | A new district added with zero code changes. |
| **5. Syria** | after Phase 4 stabilises | Syria pack, dialect strings, hubs, manual verification path, connectivity hardening. | A Damascus or Aleppo pilot repeating Phase 3 metrics. |

Rough total to pilot launch: **~5 months**.

### 12.1 What Phase 0 must establish, per line

- Which hub or موقف in Irbid the line actually departs from.
- Origin and destination zones.
- **Which** of the generated roads drivers commonly use, and any alternative the router did not find. The geometry now starts from the real road network (§9.2a), so this is confirmation rather than tracing — but it is still the question a router cannot answer.
- Intermediate villages and areas the line serves.
- Recognised passenger waiting points.
- Approximate journey time and frequency, by time of day.
- **How drivers and passengers actually refer to the line**, including local and colloquial names, which become the search aliases.

### 12.2 Phase 0 is not held hostage to geometry

The goal is to model how the transport system actually works, not to produce survey-grade route data. A corridor drawn generously from a handful of GPS traces and a conversation is enough to launch; §9.3's corridor-fit counters then tighten or widen it from real driving during the pilot. Waiting for perfect geometry would delay the only thing that actually validates the product — whether drivers switch it on and passengers get picked up.

---

## 13. Team & effort

- 1 Flutter developer (both apps), 1 backend developer, 1 part-time product designer (Arabic-native, RTL-experienced), 1 field/ops person for Irbid and Bani Kinana, plus the founder as product owner.
- Optional: 1 GIS/data person for the first two months to build corridors and country packs quickly.
- Budget a short external review of the §6 architecture before the pilot opens publicly. A privacy claim that turns out to be wrong is far more damaging than one never made.

---

## 14. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Drivers do not switch the app on | It must cost them nothing in battery, data or attention, and pay back in passengers found. Recruit through the drivers' committee, not one by one. Show "N passengers waiting on your line right now" before they start. |
| Drivers cannot produce documents to sign up | Documents are never required. Tier 0 is phone-only and fully functional (§5.2). |
| Corridors drawn too tight drop drivers offline | Width is per line and starts generous; corridor-fit counters surface bad corridors from real driving (§9.3). Deviation is treated as our modelling error, not driver misbehaviour. |
| A forked corridor mismatches passengers to buses | Branch-labelled zones where a real fork exists; Phase 0 flags the lines where it occurs (§9.5). |
| Passengers do not trust being tracked | The answer is architectural: we do not receive their location (§6.1). One sentence on the onboarding card, and we can prove it. |
| Passengers open the app and see nothing | Line directory with hubs and typical frequency from day one; live is a bonus. Overlapping corridors near Irbid raise early liquidity (§4.3). |
| Fake requests / fake buses | Phone-bound accounts, rate limits, expiring requests, driver flagging, behavioural trust tier. |
| Someone scrapes the national live map | No global read endpoint; reads bound to an active trip or request, rate-limited (§6.6). |
| A single waiting passenger is identifiable | Density-adaptive resolution snapping to recognised waiting points (§6.5). |
| A new country's data-protection regime blocks launch | The architecture is the compliance story: no names, no coordinates, no trail, one database per country in-region. |
| A government demands travel records | Almost nothing to hand over, by design (§6.2). Complying once, anywhere, would end the premise everywhere. |
| Brand collision blocks a store listing | Settle the name before crossing the first border (§16.1). |
| A per-country difference gets hardcoded | Packs carry policy, not just data (§11). Review should reject any Jordan-specific constant belonging in config. |
| Regulators object | Stay neutral: no fares, no dispatch, no exclusivity, no licensing claims. Meet LTRC early. |
| Map cost or availability | Self-hosted OSM stack from the start. |
| Battery drain | Adaptive GPS interval, foreground service, tracking stops with the trip. |
| Low-end devices / poor network | Scalar payloads, delta updates, cached packs, app under 25 MB. |

---

## 15. Repository layout (proposed)

```
Mowasalat/
  apps/
    passenger/        Flutter app
    driver/           Flutter app
    admin/            Next.js ops web, incl. corridor editor
  packages/
    core/             shared Flutter package: theme, RTL widgets, i18n, API client,
                      map widgets, corridor matching + distance lookup (§6.1, §9)
  services/
    api/              NestJS backend
    maps/             docker-compose for tiles + OSRM (Jordan, Syria extracts)
  countries/
    jo/  sy/          country packs (config, strings, hubs, routes, corridors)
  docs/
    PLAN.md           this document
    ux/               flows and screen specs (Arabic)
  infra/              IaC, CI, deployment
```

---

## 16. Decisions, resolved

**The governing principle: if it differs by country, it is configuration, not a constant.** Most open questions were really asking "what is right for Jordan?"; the expansion-safe move is to put the question in the country pack (§11) rather than pick a global answer.

| Question | Decision |
|---|---|
| **Pilot area** | Irbid ↔ Bani Kinana, five named lines (§4.3), rather than all of Irbid. |
| **Route model** | Route = service identity; geometry lives in a tolerant Route Corridor (§9). Drivers are never required to follow a stored path. |
| **Position measure** | Remaining road distance to the direction's endpoint, not progress along a polyline — monotonic whichever road is taken (§6.1). |
| **Line assignment** | Ops assigns drivers to lines; drivers pick line + direction at trip start and never create routes (§5.4). |
| **Intermediate destinations** | First-class, attached to lines with a zone (§9.4). |
| **Trajectory storage** | None, permanently. Aggregates only, with consent-gated diagnostics (§6.2–6.3). |
| **Data residency** | One database per country, not one schema per country. |
| **Vouching authority** | Country-pack list, ops fallback always present. |
| **Verification tiers** | §5.2 confirmed; Tier 2 thresholds per country. |
| **Plate visibility** | Country-pack flag, default opt-in. |
| **Route label** | Country-pack string. الخط for Jordan. |
| **Backend language** | TypeScript (NestJS). |
| **Brand** | "Mowasalat" is a **working name only** (§16.1). |

### 16.1 Brand

مواصلات stays as ordinary descriptive Arabic throughout the interface, because users understand it instantly — `مواصلات إربد`, `وين رايح؟`, `أنا مستني هون`. It is **not** the permanent product or company name.

A distinctive, ownable brand is chosen **before public launch, and certainly before Syria**. Generic terms are weak trademarks, and at least one large state transport operator in the Gulf already trades under this exact name (Qatar's Mowasalat / Karwa). Before selecting a name, run: domain availability, trademark searches in Jordan, Syria and the wider region, Google Play and App Store name checks, and a search for existing transport companies using it. Phase 0b runs this in parallel so it never blocks field work.

The repository and internal references keep the working name until then.

---

## 17. Immediate next steps

1. Begin Phase 0 field work on the five Bani Kinana lines against the checklist in §12.1. Add one question to the driver interviews: *what paperwork do you personally hold, and would you share any of it?* That settles §5 with evidence rather than assumption.
2. Start the Phase 0b name searches in parallel.
3. Scaffold the monorepo, and prototype the corridor library against the first GPS traces early. The privacy architecture rests on it placing a phone on the right line and zone reliably, on cheap hardware.
4. Write the Arabic screen-by-screen UX spec in `docs/ux/`, covering the driver's line-and-direction start flow (§5.4) and the passenger's intermediate-destination search (§9.4).
