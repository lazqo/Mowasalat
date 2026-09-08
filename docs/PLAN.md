# Mowasalat (مواصلات) — Product & Engineering Plan

**Status:** Draft v3 · **First country:** Jordan (pilot: Irbid) · **Second:** Syria · **Later:** other countries

> **Changes in v3.** The open decisions are resolved, using one test: *does this cause problems when we cross a border?* (§16). Trajectory storage is ruled out permanently, and a proper aggregate layer replaces it so expansion planning loses nothing (§6.3). Country packs now carry **policy as well as data**, so per-country differences never become code forks (§11).

> **Changes in v2.** Driver verification no longer assumes drivers hold shareable licence or permit documents (§5). Location privacy is now a designed architecture rather than a policy promise: raw GPS coordinates never leave either phone (§6).

---

## 1. The problem in one paragraph

In Jordan (and Syria) inter-town buses and service vans have no published schedule. A passenger stands on the roadside not knowing if a bus is coming in two minutes or forty. A driver leaving a town drives around looking for anyone who looks like they want a ride, then goes to the city bus complex (المجمع) where passengers gather for the return trip. On the way back the passenger knocks on the roof or says "على جنب" to be let off. Both sides waste time and fuel because neither knows where the other is.

**Mowasalat closes that gap with the smallest possible product:** the driver says which route he is on, the passenger says where she is going, and each sees the other on a map. No payment. No names. Arabic first. Simple enough for a child or a grandparent.

---

## 2. Product principles (these decide every argument later)

1. **Three taps or fewer** to the value. Passenger: open → pick destination → "I'm waiting". Driver: open → pick route → "Start".
2. **No personal data on screen, ever.** No names, no photos, no phone numbers between passenger and driver. Pseudonymous IDs that rotate per trip.
3. **Collect nothing you cannot justify losing.** Every field we store is a field that can leak or be demanded. The safest data is the data that was never sent (§6).
4. **Arabic is the source language**, not a translation. Labels use the everyday Jordanian/Levantine words people already say (المجمع, الخط, راكب, وين رايح؟).
5. **Works on a 60 JD Android phone on 3G.** Small payloads, offline-tolerant, low battery use.
6. **Country is configuration, not code.** Adding Syria means adding a country pack (map bounds, hubs, routes, dialect strings, phone prefix), not forking the app.
7. **Nothing destructive is one tap away.** Confirm every cancel/end. No free text fields except destination search. No settings maze.
8. **Useful on day one even with zero drivers online.** The passenger app doubles as a route directory ("buses to Al‑Mazar leave from the New Complex, usually every 20 min"), so the chicken-and-egg problem does not kill the pilot.

---

## 3. Vocabulary

| App term (code/API) | Arabic UI | Meaning |
|---|---|---|
| Route | الخط | A fixed origin → destination service, e.g. مجمع إربد الجديد ← المزار الشمالي. Drivers colloquially say "line"; the product name is **Route** but the Arabic UI says **الخط** because that is the word people use. |
| Hub | المجمع | The bus complex where routes start/end (Irbid New Complex, Old Complex / Sheikh Khalil, Amman North Complex, in Syria الكراج). |
| Trip | الرحلة | One driver actively driving one route right now. |
| Ride request | طلب / "أنا مستني" | A passenger saying "I am waiting here and going to X". |
| Vehicle | الباص / السرفيس | Coaster bus, minibus, or service van. Public info only (type, colour, plate optional). |
| Progress | — | How far along a route's line something is, in metres. The **only** position value the server ever handles (§6). |

---

## 4. Scope

### 4.1 MVP (Jordan pilot, Irbid)

**Passenger app (تطبيق الراكب)**
- Open → big question **"وين رايح؟"** with the nearest hub and the most common destinations as large tiles; search box for the rest.
- Result screen: a map + a list of buses currently on routes serving that destination, sorted by "will pass you in N minutes". If none are online: show the route's departure hub and typical frequency.
- One big button **"أنا مستني هون"** (I'm waiting here). Sends an anonymous request naming a route and a coarse position along it — never a coordinate (§6).
- Waiting screen: bus icon approaching on the map, ETA, big **"ركبت"** (I got on) and small "إلغاء" (cancel, with confirm). Request auto-expires after 20 min.
- No account, no login. No stable identifier is ever sent to the server.

**Driver app (تطبيق السائق)**
- Open → **"وين رايح؟"** → list of routes (recent first, then routes from the nearest hub).
- Tap route → map shows the route line → big **"ابدأ"** (Start).
- On-trip screen: map with the route, the driver's own position, and pins/clusters of waiting passengers ahead on the route ("٣ ركاب بعد ٢ كم"). Optional voice announcement so he does not have to look at the phone.
- Big **"خلصت"** (Finished) with confirm. Trip ends automatically when he reaches the destination hub or stops moving for 30 min.
- Sign-up is a phone OTP and nothing else. No documents are ever required (§5).

**Admin / ops (web, internal)**
- Country packs: hubs, routes (polylines), destinations, strings.
- Driver roster, vouching codes, block/unblock.
- Live map of trips and requests, basic counters.

### 4.2 Explicitly out of MVP
- Payments, fares, wallets.
- Seat booking / scheduling in advance.
- Chat or calling between passenger and driver.
- Ratings with identities (we may add anonymous thumbs up/down later).
- Intra-city routes with many stops (later; MVP is hub ↔ town routes).
- iOS is second priority (Jordan and Syria are overwhelmingly Android); build it, but pilot on Android.

---

## 5. Driver identity & verification (no documents required)

### 5.1 The concern, and why it is smaller than it looks

We should not assume a driver has a licence or route permit he can produce, photograph, and share. In practice, across both countries:

- The **route permit is usually held by the vehicle's owner**, not by the man driving it. Relief and substitute drivers are extremely common.
- Many drivers work someone else's bus on a daily arrangement and hold no paperwork of their own.
- In Syria, documentation is frequently lost, outdated, or impossible to reissue.
- Asking for a document photo at sign-up is the single biggest drop-off point in any driver onboarding flow, and it would make us the custodian of a national archive of ID documents — exactly the liability §2.3 tells us to avoid.

There is also a positioning argument. **We are not licensing anyone.** Verifying a licence would make us look like a regulator or an employer, which invites legal exposure we cannot carry and a job the LTRC (هيئة تنظيم النقل البري) already does. Our verification only has to answer one much narrower question: *will a real bus actually turn up?*

**And for the pilot itself the problem essentially disappears**, because 20–50 drivers on 5 routes are onboarded face to face at the Irbid complex by our own field person. Verification at that scale is a handshake. The tiered model below is what lets that survive contact with scale.

### 5.2 The tiered trust model

| Tier | How it is earned | What the driver gets |
|---|---|---|
| **0 · Phone** | Phone OTP. Nothing else. Immediate. | Full ability to start trips at once. Shown to passengers as a bus with no verification mark. |
| **1 · Vouched** | A hub coordinator, the drivers' committee (لجنة السائقين), or our field ops person confirms him in person and issues a one-time code. Alternatively, two already-trusted drivers on the same route vouch for him in-app. | Verified mark. Ranked above unverified buses. |
| **2 · Proven** | Automatic, no human involved: N completed trips whose movement matched the route geometry, across D distinct days. | Same as Tier 1, earned without anyone's time. |
| **3 · Documentary** | *Optional, never required.* The driver may type a plate number and/or permit number as text. Checked against LTRC records only if a data-sharing arrangement ever exists. | A second mark, if the market turns out to value it. |

Rules that make this work:

- **Tier 0 is never blocked.** A driver who declines everything else can still drive and still be found. If verification gates usage, the pilot dies at sign-up.
- **No document images are ever uploaded or stored.** Tier 3 is typed text only. If we later need images, that is a new decision with its own review, not a default.
- **Tier 2 is the load-bearing one.** A fake bus cannot fake it: repeatedly moving the length of a real route at plausible speeds, day after day, is exactly the behaviour we care about, and it is far better evidence than any document that a bus will show up.
- **Verification is displayed as trust, not as identity.** Passengers see a mark and a vehicle description, never a name, licence, or phone.

### 5.3 What verification is actually defending against

| Threat | Defence |
|---|---|
| Ghost buses that never arrive | Tier 2 behavioural trust; drivers with poor arrival records are ranked down and eventually suspended. |
| Someone impersonating a route to see where passengers wait | Passenger positions are coarse and route-relative (§6); a fake driver learns almost nothing, and cannot see beyond his own active route. |
| One person running many driver accounts | One account per phone number; new accounts start at Tier 0 with the tightest rate limits. |
| A genuinely dangerous driver | Out of scope, honestly. That is a policing and licensing matter. We provide an ops block list and cooperate with the regulator; we do not pretend to screen. |

---

## 6. Location privacy: the tracking architecture

Privacy here cannot be a promise in a policy document. At country scale, a live map of every bus and every waiting person is a movement database for a whole population, and the only durable protection is to **not build one**. The design below means we are not able to produce that database even if we wanted to.

### 6.1 The core mechanism: raw coordinates never leave either phone

Every device already has the route polylines cached locally, because the country pack ships them for offline use (§11). That single fact lets the entire system run in **one-dimensional route coordinates** instead of latitude and longitude.

**Driver side.** The phone reads its own GPS, snaps it to the polyline of the route the driver selected, and transmits two numbers: *progress along the route in metres*, and *speed*. No latitude or longitude is ever sent. If the driver is more than ~150 m off the route, the app transmits nothing at all — so a detour home, to a mechanic, or anywhere else is invisible by construction, not by policy.

**Passenger side.** "Which routes pass near me?" is computed **on the phone** against the cached polylines. The server is never asked "what is near this point", because that question would require sending the point. The ride request names a route, a coarse bucket of progress along it, and a destination. Again, no coordinate.

**Server side.** The backend therefore holds route-relative scalars and nothing else. It cannot plot a person or a bus on a map, because it has never been told where the map's origin is for them. Rendering happens on the clients, which map progress back onto the polyline they already have.

```
Driver phone                    Server                       Passenger phone
─────────────                   ──────                       ───────────────
GPS 32.5556,35.8497
  ↓ snap to route 7 locally
progress = 12,430 m   ──────▶  route 7 · 12,430 m · 41 km/h  ──────▶  draw bus at
speed    = 41 km/h              (60 s TTL, memory only)               polyline(12,430 m)

                                                             GPS 32.4901,35.9012
                                                               ↓ match routes locally
                       ◀──────  route 7 · ~19,250 m · to المزار  ◀──  send bucket only
```

A useful side effect: the payload is two numbers instead of a coordinate pair plus metadata, which is exactly what a 3G connection on a cheap phone wants (§2.5).

### 6.2 Storage: the trail is never written, not merely deleted

- Live state lives in **Redis with a 60-second TTL, on an instance with disk persistence switched off**. There is no snapshot or append-only file to seize or leak.
- **No trip trajectory table exists in the schema.** This is stronger than a retention policy — there is nothing to forget to purge, and no migration can accidentally start retaining it.
- Aggregates (requests and trips per route per hour) are **incremented in flight**, never derived from a stored trail.
- Trip and request rows hold a route, timestamps, and a status. They are deleted 24 hours after completion.
**This is now decided and is not revisited** (§16). The reason is expansion, not only ethics: a stored movement trail turns every new country into a legal negotiation and a political target, while costing storage that grows with every bus-second forever. It is also the only irreversible direction — we can add storage later if we are ever wrong, but we can never un-store data we already hold, and we can never un-break the promise. What we give up is per-individual replay and post-hoc forensic debugging. §6.3 explains why that costs expansion planning nothing.

### 6.3 Planning data without a trail

The obvious objection to §6.2 is that expansion needs data: entering a new city means knowing where demand is, which routes are underserved, and where people wait that no route serves. That objection is real, and it is answered without storing a single trail — because **planning needs aggregates, and aggregates never needed identity in the first place.**

Counters are incremented at the moment an event happens; the event itself is then discarded. Nothing is keyed to a person, device, token or session.

| Counter | Keyed by | What it answers |
|---|---|---|
| Demand | route, segment, hour | Where do people actually wait, and when? |
| **Unserved demand** | origin area, searched destination, hour | **Which route should we add next?** The single most valuable expansion signal, and it needs no identity at all. |
| Coverage gaps | area, hour | Where do searches return no route whatsoever? |
| Route health | route, hour | Trips started, trips completed, median headway. |
| Match quality | route, hour | Requests met by a bus vs requests that expired waiting. |

Three rules keep this from quietly becoming a trail:

1. **No counter may be keyed by any identifier of a person**, including a rotating token or a session.
2. **Minimum cell size.** A bucket with fewer than *k* events in its period is suppressed or merged upward. A counter must never be able to describe one person's single journey.
3. **Counters are append-only integers.** No raw event log sits behind them "just in case" — that log is exactly the trail we declined to keep.

For the debugging we genuinely lose, the answer is **opt-in diagnostics**: a driver hitting a problem taps "report a problem", which uploads the app's local buffer *for that trip only*, with explicit consent, deleted once the issue is resolved. Consent-gated and bounded, rather than a standing trail kept in case someone eventually needs it.

The result is that the privacy-maximal choice and the expansion-planning need are not actually in tension. Unserved-demand counters tell you which routes to open in city twelve better than trajectory replay would, because they measure the demand you are *failing* to serve rather than the trips you already serve.

### 6.4 Unlinkability: you cannot follow the same person across days

- **Passengers** send a rotating per-request token, not a device ID. Two requests by the same person on consecutive days are not linkable server-side.
- **Drivers** get a pseudonym that rotates every trip. The mapping from account to trip pseudonym exists only in memory for the life of the trip, so the realtime layer never handles an account ID at all.
- Consequence to accept: a passenger cannot "favourite" a driver she likes, and we cannot build reputation on a persistent driver identity visible to passengers. Trust is carried by the tier mark (§5.2), which the account holds privately.

### 6.5 Resolution that adapts to density (k-anonymity)

A pin showing "one person waiting" on an empty village road is a pin showing *a specific person*. So pin precision is not a constant:

- Where several requests are active nearby, positions are bucketed to ~250 m and clustered into a count.
- Where fewer than **k** requests are active nearby, the request snaps to the **nearest known waiting point** — a village entrance, a junction, a shop — rather than any distinct position. The driver sees "passengers at the junction", which is all he needs.
- The same rule applies to buses on rarely-served routes at quiet hours, where a single bus is effectively a single named driver.

### 6.6 Limiting who can see what

- A driver sees only requests **on his own active route, ahead of him, within a window** (about 15 km). There is no global view, for anyone, at any tier.
- A passenger sees only buses on routes serving her chosen destination.
- Read endpoints are rate-limited and bound to an active trip or an active request, so the national live picture cannot be enumerated by a script.
- Ops staff see aggregate counters and a coarse live map. Access to anything finer is role-gated and logged.

### 6.7 Controls the user actually holds

- Driver: tracking runs only between **ابدأ** and **خلصت**, under a foreground service with a permanent visible notification, plus a one-tap "go off air" that stops transmission instantly.
- Passenger: cancelling a request removes it immediately, everywhere.
- Neither app requests background location for the passenger role at all.
- A single onboarding card, in plain Arabic, states honestly what is and is not sent — "we do not know your name, and we do not receive your location, only how far along the line you are". Say it in one sentence and one picture, per §10.

### 6.8 What this does *not* protect against — stated plainly

- For up to 60 seconds, the server knows that an anonymous bus is somewhere along a route. That is inherent to the product; there is no version of this app without it.
- A compromised or seized **phone** defeats all of the above. Device security is not ours to solve.
- We do hold **driver phone numbers**, because we need to reach drivers. They are encrypted with keys in separate custody, access is logged, and they are never exposed to passengers or to the realtime layer.
- Under legal compulsion there is very little to hand over — by design. We should say so publicly and be able to demonstrate it. For a country-level product in this region, that posture is part of the product, not a footnote.

---

## 7. Architecture

```
┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
│  Passenger app   │   │   Driver app     │   │   Ops web admin  │
│  (Flutter)       │   │   (Flutter)      │   │   (React/Next)   │
│  snaps locally   │   │  snaps locally   │   │                  │
└────────┬─────────┘   └────────┬─────────┘   └────────┬─────────┘
         │  HTTPS + WebSocket   │                      │
         │  (route + progress,  │                      │
         │   never coordinates) │                      │
         └──────────┬───────────┴──────────────────────┘
                    ▼
        ┌─────────────────────────┐
        │  API  (TypeScript,      │
        │  NestJS or Fastify)     │
        │  - country resolver     │
        │  - matching engine (1D) │
        │  - realtime gateway     │
        └──┬──────────┬───────┬───┘
           │          │       │
   ┌───────▼───┐ ┌────▼────┐ ┌▼──────────────┐
   │ Postgres  │ │  Redis  │ │ Map services  │
   │ + PostGIS │ │ live    │ │ OSM tiles     │
   │ (routes,  │ │ progress│ │ (MapLibre),   │
   │ trips,    │ │ 60s TTL │ │ OSRM/Valhalla │
   │ requests) │ │ no disk │ │ (self-hosted) │
   └───────────┘ └─────────┘ └───────────────┘
```

**Key choices and why**
- **Flutter** for both apps from one monorepo with a shared `core` package: one team, first-class RTL, runs well on low-end Android, iOS for free later. The shared package also owns the on-device snapping logic, so both apps compute route progress identically.
- **Two separate apps**, not one app with a role switch. Simpler mental model for users, separate store listings, separate permission sets (driver needs foreground location during trips; passenger needs a one-shot fix).
- **TypeScript backend** (NestJS): fast to build, easy to hire for, good WebSocket story. Go is a fine alternative if the team prefers it.
- **PostgreSQL + PostGIS** for route geometry and admin-side editing; **Redis** for live progress values and pub/sub fan-out, persistence disabled.
- **OpenStreetMap + MapLibre + self-hosted OSRM** instead of Google Maps: no per-request cost at country scale, no availability risk in Syria, no third party receiving our users' map queries, and we control the data.
- **Firebase Cloud Messaging** for push (Android). Fall back to WebSocket while the app is open. Push payloads carry no location.
- **Country resolver**: every request carries a country code (from device locale + declared country). All data is partitioned by country.

---

## 8. Data model (first cut)

```
Country      id, code (JO, SY), name_ar, bounds, locale, phone_prefix, digits (eastern|western), enabled
City         id, country_id, name_ar, center
Hub          id, city_id, name_ar, location, aliases_ar[]           -- المجمع
Destination  id, country_id, name_ar, location, aliases_ar[]         -- town/village/landmark
WaitPoint    id, route_id, progress_m, name_ar                       -- junctions/village entrances, for §6.5
Route        id, country_id, origin_hub_id, destination_id, name_ar,
             polyline (LineString), served_destination_ids[], typical_headway_min, active
Vehicle      id, driver_id, type (coaster|minibus|service), colour, plate, show_plate (bool)
Driver       id, country_id, phone_enc, tier (0..3), status (active|blocked), created_at
Trip         id, route_id, driver_id, vehicle_id, started_at, ended_at, status
TripProgress (Redis, TTL 60s, no disk persistence)
             trip_pseudonym -> progress_m, speed_kph        -- NO lat/lng, NO driver_id
RideRequest  id, request_token (rotating), route_id, destination_id, progress_bucket_m,
             status (waiting|matched|boarded|cancelled|expired), created_at, expires_at, pseudonym
-- the only long-lived data, all of it counters (§6.3):
RouteStats   route_id, segment, hour_bucket, requests, trips, matched, expired
Unserved     country_id, origin_area, destination_id, hour_bucket, count
Coverage     country_id, area, hour_bucket, empty_searches
```

Note what is absent and must stay absent: no trajectory table, no coordinate column on `Trip` or `RideRequest`, no stable device identifier, and no `driver_id` anywhere in the realtime layer.

---

## 9. Matching: how a waiting passenger reaches the right driver

The whole engine works in one dimension, which is what makes §6.1 possible.

1. Passenger picks a destination → the **phone** filters its cached routes to those whose `served_destination_ids` contain it, and projects its own GPS onto each polyline locally to get `progress_m`.
2. The phone asks the server for active trips on those routes. The query names routes, not a location.
3. A trip is a **candidate** if its `progress_m` is *behind* the passenger's and within a configurable window (e.g. 15 km).
4. ETA = remaining distance along the polyline ÷ recent average speed (fallback: OSRM duration on the route geometry, computed once and cached per route).
5. On **"أنا مستني"** the request is stored with a bucketed progress value (§6.5) and published to every candidate trip's channel. Nearby requests collapse into one pin with a count.
6. Driver passing the request's position marks it **matched**; the passenger taps "ركبت" or the request expires. No explicit accept/decline step: keeping it "broadcast to all buses behind you" is simpler and matches how people actually board (first bus that comes).
7. Driver progress is sent every 5 s when moving, 30 s when stopped, and not at all when off-route. The API rebroadcasts to clients subscribed to that route.

---

## 10. Simplicity & accessibility rules (childproof / elderproof / edit‑proof)

- Font size minimum 18 sp, primary buttons 64 dp tall, full-width, high contrast, one primary action per screen.
- Arabic RTL layouts designed natively (not mirrored English). Eastern Arabic numerals (١٢٣) by default in Jordan and Syria, switchable per country.
- Icons always paired with a word. Colour never the only signal.
- No free-text input except destination search; search has large, forgiving matching (aliases, common misspellings, dialect names).
- Every destructive action (cancel, finish trip) needs a second tap on a confirm sheet. Nothing can be deleted by the user.
- Voice: optional text-to-speech announcements for drivers ("راكب بعد كيلومترين"). Optional voice search for passengers (later).
- Onboarding is three swipeable pictures, skippable; no tutorial text walls. One of the three is the privacy card from §6.7 — one sentence, one picture, no legal language.
- Test with real people: at least 5 elderly and 5 children in Irbid before pilot launch.

---

## 11. Multi-country strategy

A **country pack** is a versioned folder in the repo plus rows in the database:

```
countries/
  jo/  config.json, strings.ar-JO.json, hubs.geojson, routes.geojson
  sy/  config.json, strings.ar-SY.json, hubs.geojson, routes.geojson
```

**The pack carries policy, not just data.** This is the single most important structural decision for expansion: anything that differs between countries and lives in code becomes a fork the first time we cross a border. So `config.json` holds all of it.

```jsonc
{
  "code": "JO", "locale": "ar-JO", "digits": "eastern", "phone_prefix": "+962",
  "bounds": [...],
  "residency_region": "me-central-1",     // where this country's database lives
  "vouching_authorities": ["drivers_committee", "hub_supervisor", "field_ops"],
  "plate_visibility": "opt_in",           // some regulators may later require display
  "tier2_thresholds": { "trips": 12, "distinct_days": 5 },
  "k_anonymity_min": 4,                   // §6.5 density floor
  "retention_hours": 24,
  "otp_channels": ["sms", "manual_vouch"] // manual path where SMS is unreliable
}
```

A new country is then a data and policy exercise carried out by ops, not an engineering project. That is the test every future feature should be held to.

- Strings are per-dialect overrides on top of a shared Arabic base (Jordan says المجمع, Syria often says الكراج).
- Route data is imported from GeoJSON by the admin tool; ops can also draw/edit routes in the admin map.
- Packs are split by city so a phone downloads only what it needs. This is what makes offline route discovery and on-device snapping (§6.1) practical — Irbid is on the order of 50 routes, not a national file.
- **Syria-specific risks to check before starting:** app store and cloud availability under the current sanctions status, weaker mobile data, and possibly SMS OTP delivery. Design the OTP step to allow a manual ops verification path — which the Tier 1 vouching flow in §5.2 already provides.

---

## 12. Delivery phases

| Phase | Duration | What ships | Exit criteria |
|---|---|---|---|
| **0. Discovery** | 3 weeks | Field research in Irbid: ride 10+ routes with GPS logging, interview 15 drivers and 30 passengers at the New and Old Complex, meet the drivers' committee and check LTRC stance. Confirm what paperwork drivers actually hold (§5.1). Produce the first `jo` country pack with 5 routes. | Route GeoJSON for 5 routes; agreed pilot drivers (≥20); a written answer on driver documentation. |
| **0b. Name check** | in parallel | Trademark and app-store search for the product name across JO, SY and the wider region (§16.1). | A name we can register and list everywhere we intend to go. |
| **1. Foundations** | 4 weeks | Monorepo, CI, backend skeleton, country resolver, PostGIS schema, Redis live layer, on-device snapping library, admin route editor, self-hosted tiles + OSRM for Jordan. | Admin can import a route and see it on a map; snapping library passes accuracy tests against Phase 0 GPS logs; API passes integration tests. |
| **2. MVP apps** | 6–8 weeks | Passenger and driver Flutter apps with the flows in §4.1, push, matching engine, tiered sign-up, Arabic UI, accessibility rules. | Internal end-to-end test: a driver on a real route sees a test passenger request and the passenger sees the bus approaching — with no coordinate present in any server log. |
| **3. Irbid pilot** | 6 weeks | 20–50 drivers on 5 routes, open passenger beta via Play Store. Weekly iteration. | ≥40% of pilot drivers start ≥3 trips/week; ≥100 real requests/week; median wait time reported lower than baseline from Phase 0. |
| **4. Jordan scale** | ongoing | Add Amman, Zarqa, Mafraq, Karak… via country pack data only; ops onboarding playbook; iOS release. | New city added with zero code changes. |
| **5. Syria** | after Phase 4 stabilises | `sy` country pack, dialect strings, hubs, manual verification path, connectivity hardening. | Damascus or Aleppo pilot repeating Phase 3 metrics. |

Rough total to pilot launch: **~5 months** with the team below.

---

## 13. Team & effort

- 1 Flutter developer (both apps), 1 backend developer, 1 product designer (part-time, must be an Arabic-native RTL designer), 1 field/ops person in Irbid (route data, driver onboarding, support), plus the founder as product owner.
- Optional: 1 GIS/data person for the first two months to build country packs quickly.
- Budget a short external review of the §6 architecture before the pilot opens to the public. A privacy claim that turns out to be wrong is far more damaging than one never made.

---

## 14. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Drivers do not switch the app on | Driver app must cost them nothing (battery, data, attention) and pay back in passengers found. Recruit through the drivers' committee at the complex, not one by one. Show them the "N passengers waiting on your route right now" number before they even start. |
| Drivers cannot produce documents to sign up | Documents are never required. Tier 0 is phone-only and fully functional; trust is earned by vouching or by behaviour (§5.2). |
| Passengers do not trust being tracked | The honest answer is architectural: we do not receive their location (§6.1). Say it in one sentence on the onboarding card and be able to prove it. |
| Passengers open the app and see nothing | Route directory with hubs and typical frequency is there from day one; the "live" layer is a bonus. |
| Fake requests / fake buses | Phone-bound accounts; passenger rate limits; requests expire; driver can flag; behavioural trust tier makes ghost buses visible over time. |
| Someone scrapes the national live map | No global read endpoint exists; reads are bound to an active trip or request and rate-limited (§6.6). |
| A single waiting passenger is identifiable | Density-adaptive resolution snapping to known waiting points (§6.5). |
| A new country's data-protection regime blocks or delays launch | The architecture *is* the compliance story: no names, no coordinates, no trail, one database per country in-region. Entering a country becomes a filing exercise rather than a re-engineering project. |
| A government demands travel records | There is almost nothing to hand over, by design (§6.2). Say so publicly and be able to demonstrate it. Complying once, in any country, would end the product's premise in all of them. |
| Brand collision blocks a store listing in a new market | Settle the name before crossing the first border (§16.1); a rebrand after users exist is far more expensive. |
| A per-country difference gets hardcoded | Country packs carry policy, not just data (§11). Code review should reject any Jordan-specific constant that belongs in `config.json`. |
| Regulators object | Keep the app neutral (no fares, no dispatch, no exclusivity, no licensing claims). Meet LTRC early. Position as a public-information tool. |
| Map cost or availability | Self-hosted OSM stack from the start; no Google dependency, and no third party learns our users' map queries. |
| Battery drain on driver phones | Adaptive GPS interval, foreground service with a clear notification, stop tracking when trip ends. |
| Low-end devices / poor network | Two-number position payloads, delta updates, cached country pack, app size under 25 MB. |

---

## 15. Repository layout (proposed)

```
Mowasalat/
  apps/
    passenger/        Flutter app
    driver/           Flutter app
    admin/            Next.js ops web
  packages/
    core/             shared Flutter package: theme, RTL widgets, i18n, API client,
                      map widgets, route-snapping (§6.1)
  services/
    api/              NestJS backend
    maps/             docker-compose for tiles + OSRM (Jordan, Syria extracts)
  countries/
    jo/  sy/          country packs (config, strings, hubs, routes)
  docs/
    PLAN.md           this document
    ux/               flows and screen specs (Arabic)
  infra/              IaC, CI, deployment
```

---

## 16. Decisions, resolved for expansion

You asked for whichever answer does not cause problems as we expand. Applying that single test settles almost all of them, and it settles most of them the same way.

**The governing principle: if it differs by country, it is configuration, not a constant.** Nearly every open question above was really asking "what is the right answer for Jordan?", and the expansion-safe move is not to pick one answer but to move the question into the country pack (§11). What follows is therefore less a list of picks than one structural decision applied repeatedly.

| Question | Decision | Why this survives crossing a border |
|---|---|---|
| **Trajectory storage** | **None, permanently.** Aggregates only (§6.3), with consent-gated diagnostics for debugging. | Every new country adds a data-protection regime; Jordan's Personal Data Protection Law (No. 24 of 2023) is the first of several. Holding no movement trail collapses most of that compliance surface into a paragraph. It also removes the political target — in Syria especially, a record of who travelled where is a targeting tool, and the only durable answer to a demand for it is to be structurally unable to comply. And it is the one choice that is irreversible in only one direction: we can add storage later, never un-store. |
| **Planning analytics** | In-flight counters, including the unserved-demand signal (§6.3). | Gives expansion planning its primary input — *which route should we open next* — with no identity involved. The privacy choice costs the roadmap nothing. |
| **Data residency** | One **database per country**, not one schema per country. | A country that later imposes data-localisation rules can be lifted to a new region without a migration or an emergency schema split. Cheap now, very expensive retrofitted. |
| **Vouching authority** | Country-pack list, with an ops fallback always present. | Jordan has a drivers' committee at the complex. Another country may have nothing equivalent. Config, not code. |
| **Verification tiers** | Model in §5.2 confirmed; Tier 2 thresholds are per country. | Route lengths and trip frequencies differ enough that a fixed "12 trips over 5 days" would be wrong somewhere. |
| **Plate visibility** | Country-pack flag, defaulting to opt-in. | Some regulators may eventually require display; other jurisdictions treat a plate as personal data. Both are reachable without a release. |
| **Route label** (الخط / المسار) | Country-pack string. الخط for Jordan. | Dialect already varies — Syria says الكراج where Jordan says المجمع. This was never a global decision. |
| **Backend language** | TypeScript (NestJS). | Widest regional hiring pool, and nothing about it constrains us at this volume. Expansion is limited by route data and driver onboarding, never by the runtime. |

### 16.1 Still genuinely yours

1. **Pilot routes.** Which five out of the Irbid New Complex? Only local knowledge answers this, and it is the one input Phase 0 cannot start without.
2. **The name — worth settling before Syria, not after.** "Mowasalat" (مواصلات) is the ordinary Arabic word for transport. That makes it instantly understood, which is why it fits the simplicity goal, but it also makes it effectively impossible to own: generic terms are weak trademarks, and at least one large state transport operator in the Gulf already trades under this exact name (Qatar's Mowasalat / Karwa — worth a formal trademark search). This is not a pilot problem; it is precisely an expansion problem: app-store name collisions, search competition, and a possible forced rebrand once you cross borders, which costs far more after you have users than before. My recommendation is to keep مواصلات as the descriptive Arabic label in the interface, and choose a distinctive brand name you can actually own for the product itself.

## 17. Immediate next steps

1. Answer the two items in §16.1 — the five pilot routes, and whether to settle the brand name now.
2. Start Phase 0 field work in Irbid. Add one question to the driver interviews: *what paperwork do you personally hold, and would you share any of it?* That answer settles §5 with evidence rather than assumption.
3. In parallel, scaffold the monorepo (Phase 1) so the route editor is ready to receive the first GPS traces, and prototype the snapping library against those traces early — the whole privacy architecture rests on it working accurately on cheap hardware.
4. Write the Arabic screen-by-screen UX spec in `docs/ux/` using the flows in §4.1 and the rules in §10.
