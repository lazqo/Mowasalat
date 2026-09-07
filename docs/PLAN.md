# Mowasalat (مواصلات) — Product & Engineering Plan

**Status:** Draft v1 · **First country:** Jordan (pilot: Irbid) · **Second:** Syria · **Later:** other countries

---

## 1. The problem in one paragraph

In Jordan (and Syria) inter-town buses and service vans have no published schedule. A passenger stands on the roadside not knowing if a bus is coming in two minutes or forty. A driver leaving a town drives around looking for anyone who looks like they want a ride, then goes to the city bus complex (المجمع) where passengers gather for the return trip. On the way back the passenger knocks on the roof or says "على جنب" to be let off. Both sides waste time and fuel because neither knows where the other is.

**Mowasalat closes that gap with the smallest possible product:** the driver says which route he is on, the passenger says where she is going, and each sees the other on a map. No payment. No names. Arabic first. Simple enough for a child or a grandparent.

---

## 2. Product principles (these decide every argument later)

1. **Three taps or fewer** to the value. Passenger: open → pick destination → "I'm waiting". Driver: open → pick route → "Start".
2. **No personal data on screen, ever.** No names, no photos, no phone numbers between passenger and driver. Pseudonymous IDs that rotate per trip.
3. **Arabic is the source language**, not a translation. Labels use the everyday Jordanian/Levantine words people already say (المجمع, الخط, راكب, وين رايح؟). English and others come later.
4. **Works on a 60 JD Android phone on 3G.** Small payloads, offline-tolerant, low battery use.
5. **Country is configuration, not code.** Adding Syria means adding a country pack (map bounds, hubs, routes, dialect strings, phone prefix), not forking the app.
6. **Nothing destructive is one tap away.** Confirm every cancel/end. No free text fields except destination search. No settings maze.
7. **Useful on day one even with zero drivers online.** The passenger app doubles as a route directory ("buses to Al‑Mazar leave from the New Complex, usually every 20 min"), so the chicken-and-egg problem does not kill the pilot.

---

## 3. Vocabulary

| App term (code/API) | Arabic UI | Meaning |
|---|---|---|
| Route | الخط | A fixed origin → destination service, e.g. مجمع إربد الجديد ← المزار الشمالي. Drivers colloquially say "line"; the product name is **Route** but the Arabic UI says **الخط** because that is the word people use. |
| Hub | المجمع | The bus complex where routes start/end (Irbid New Complex, Old Complex / Sheikh Khalil, Amman North Complex, in Syria الكراج). |
| Trip | الرحلة | One driver actively driving one route right now. |
| Ride request | طلب / "أنا مستني" | A passenger saying "I am waiting here and going to X". |
| Vehicle | الباص / السرفيس | Coaster bus, minibus, or service van. Public info only (type, colour, plate optional). |

---

## 4. Scope

### 4.1 MVP (Jordan pilot, Irbid)

**Passenger app (تطبيق الراكب)**
- Open → big question **"وين رايح؟"** with the nearest hub and the most common destinations as large tiles; search box for the rest.
- Result screen: a map + a list of buses currently on routes serving that destination, sorted by "will pass you in N minutes". If none are online: show the route's departure hub and typical frequency.
- One big button **"أنا مستني هون"** (I'm waiting here). Sends an anonymous request with approximate location and destination.
- Waiting screen: bus icon approaching on the map, ETA, big **"ركبت"** (I got on) and small "إلغاء" (cancel, with confirm). Request auto-expires after 20 min.
- No account, no login. Device-bound anonymous identity.

**Driver app (تطبيق السائق)**
- Open → **"وين رايح؟"** → list of routes (recent first, then routes from the nearest hub).
- Tap route → map shows the route line → big **"ابدأ"** (Start).
- On-trip screen: map with the route, the driver's own position, and pins/clusters of waiting passengers ahead on the route ("٣ ركاب بعد ٢ كم"). Optional voice announcement so he does not have to look at the phone.
- Big **"خلصت"** (Finished) with confirm. Trip ends automatically when he reaches the destination hub or stops moving for 30 min.
- Driver signs up once with phone OTP (needed for accountability and to stop fake buses). Phone is never shown to anyone. Optional public fields: vehicle type, colour, plate.

**Admin / ops (web, internal)**
- Country packs: hubs, routes (polylines), destinations, strings.
- Driver verification list, block/unblock.
- Live map of trips and requests, basic counters.

### 4.2 Explicitly out of MVP
- Payments, fares, wallets.
- Seat booking / scheduling in advance.
- Chat or calling between passenger and driver.
- Ratings with identities (we may add anonymous thumbs up/down later).
- Intra-city routes with many stops (later; MVP is hub ↔ town routes).
- iOS is second priority (Jordan and Syria are overwhelmingly Android); build it, but pilot on Android.

---

## 5. Privacy design (the part that makes this viable at country scale)

| Concern | Decision |
|---|---|
| Passenger identity | No sign-up. A random device ID is the account. Nothing else is collected. |
| Driver identity | Phone OTP + optional permit number, stored encrypted, visible only to ops. Never shown to passengers. |
| What the driver sees | "راكب ينتظر" pins with a rotating per-trip pseudonym and destination. Location snapped to the road, rounded to ~50 m. |
| What the passenger sees | The bus position, ETA, vehicle type/colour, and plate only if the driver opted in. |
| Location retention | Live positions live in memory (Redis) with a 60 s TTL. Requests and trips are deleted 24 h after completion; only anonymous aggregates (counts per route per hour) are kept for planning. |
| Data residency | Host in-region (AWS me-central-1 / me-south-1, or Hetzner) with a per-country database schema so a country's data can be moved or deleted as a unit. |
| Abuse | Rate-limit requests per device, requests expire, drivers can flag a ghost request, repeat offenders are shadow-throttled. No public reporting of individuals. |

---

## 6. Architecture

```
┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
│  Passenger app   │   │   Driver app     │   │   Ops web admin  │
│  (Flutter)       │   │   (Flutter)      │   │   (React/Next)   │
└────────┬─────────┘   └────────┬─────────┘   └────────┬─────────┘
         │  HTTPS + WebSocket   │                      │
         └──────────┬───────────┴──────────────────────┘
                    ▼
        ┌─────────────────────────┐
        │  API  (TypeScript,      │
        │  NestJS or Fastify)     │
        │  - country resolver     │
        │  - matching engine      │
        │  - realtime gateway     │
        └──┬──────────┬───────┬───┘
           │          │       │
   ┌───────▼───┐ ┌────▼────┐ ┌▼──────────────┐
   │ Postgres  │ │  Redis  │ │ Map services  │
   │ + PostGIS │ │ live    │ │ OSM tiles     │
   │ (routes,  │ │ positions│ │ (MapLibre),   │
   │ trips,    │ │ pub/sub │ │ OSRM/Valhalla │
   │ requests) │ │ geo idx │ │ (self-hosted) │
   └───────────┘ └─────────┘ └───────────────┘
```

**Key choices and why**
- **Flutter** for both apps from one monorepo with a shared `core` package: one team, first-class RTL, runs well on low-end Android, iOS for free later.
- **Two separate apps**, not one app with a role switch. Simpler mental model for users, separate store listings, separate permission sets (driver needs background location; passenger does not).
- **TypeScript backend** (NestJS): fast to build, easy to hire for, good WebSocket story. Go is a fine alternative if the team prefers it.
- **PostgreSQL + PostGIS** for routes and geometry; **Redis** for live bus positions (GEO commands) and pub/sub to fan out updates.
- **OpenStreetMap + MapLibre + self-hosted OSRM** instead of Google Maps: no per-request cost at country scale, no availability risk in Syria, and we control the data. OSM coverage of Jordan and Syria roads is good enough for hub ↔ town routes.
- **Firebase Cloud Messaging** for push (Android). Fall back to WebSocket while the app is open.
- **Country resolver**: every request carries a country code (from device locale + GPS bounds). All data is partitioned by country.

---

## 7. Data model (first cut)

```
Country      id, code (JO, SY), name_ar, bounds, locale, phone_prefix, digits (eastern|western), enabled
City         id, country_id, name_ar, center
Hub          id, city_id, name_ar, location, aliases_ar[]           -- المجمع
Destination  id, country_id, name_ar, location, aliases_ar[]         -- town/village/landmark
Route        id, country_id, origin_hub_id, destination_id, name_ar,
             polyline (LineString), served_destination_ids[], typical_headway_min, active
Vehicle      id, driver_id, type (coaster|minibus|service), colour, plate, show_plate (bool)
Driver       id, country_id, phone_hash, permit_no_enc, status (pending|active|blocked), created_at
Trip         id, route_id, driver_id, vehicle_id, started_at, ended_at, status
DriverPos    (Redis GEO, TTL 60s) trip_id -> lat, lng, heading, speed, route_progress_m
Device       id (random), country_id, created_at                      -- the passenger "account"
RideRequest  id, device_id, route_id?, destination_id, approx_location, route_progress_m,
             status (waiting|matched|boarded|cancelled|expired), created_at, expires_at, pseudonym
RouteStats   route_id, hour_bucket, requests, trips                    -- the only long-lived data
```

---

## 8. Matching: how a waiting passenger reaches the right driver

1. Passenger picks a destination → API returns all **routes whose `served_destination_ids` contain it**, ordered by distance from the passenger to the route polyline.
2. Passenger's position is **projected onto each route polyline** → `route_progress_m` (how far along the route she stands).
3. Active trips on those routes are read from Redis. A trip is a **candidate** if its `route_progress_m` is *behind* the passenger's (the bus has not passed yet) and within a configurable window (e.g. 15 km).
4. ETA = remaining distance along the polyline ÷ recent average speed (fallback: OSRM duration).
5. On **"أنا مستني"** the request is stored and published to every candidate trip's channel. Driver apps show it as a pin; multiple requests within ~300 m collapse into one pin with a count.
6. Driver passing the request's position marks it **matched**; the passenger taps "ركبت" or the request expires. No explicit accept/decline step: keeping it "broadcast to all buses behind you" is simpler and matches how people actually board (first bus that comes).
7. Driver location is sent every 5 s when moving, 30 s when stopped; the API rebroadcasts to passengers subscribed to that route.

---

## 9. Simplicity & accessibility rules (childproof / elderproof / edit‑proof)

- Font size minimum 18 sp, primary buttons 64 dp tall, full-width, high contrast, one primary action per screen.
- Arabic RTL layouts designed natively (not mirrored English). Eastern Arabic numerals (١٢٣) by default in Jordan and Syria, switchable per country.
- Icons always paired with a word. Colour never the only signal.
- No free-text input except destination search; search has large, forgiving matching (aliases, common misspellings, dialect names).
- Every destructive action (cancel, finish trip) needs a second tap on a confirm sheet. Nothing can be deleted by the user.
- Voice: optional text-to-speech announcements for drivers ("راكب بعد كيلومترين"). Optional voice search for passengers (later).
- Onboarding is three swipeable pictures, skippable; no tutorial text walls.
- Test with real people: at least 5 elderly and 5 children in Irbid before pilot launch.

---

## 10. Multi-country strategy

A **country pack** is a versioned folder in the repo plus rows in the database:

```
countries/
  jo/  config.json (bounds, locale ar-JO, digits eastern, phone +962), strings.ar-JO.json, hubs.geojson, routes.geojson
  sy/  config.json (bounds, locale ar-SY, digits eastern, phone +963), strings.ar-SY.json, hubs.geojson, routes.geojson
```

- Strings are per-dialect overrides on top of a shared Arabic base (Jordan says المجمع, Syria often says الكراج).
- Route data is imported from GeoJSON by the admin tool; ops can also draw/edit routes in the admin map.
- The apps download only their country's pack and cache it, so the route directory works offline.
- **Syria-specific risks to check before starting:** app store and cloud availability under the current sanctions status, weaker mobile data, and possibly SMS OTP delivery. Design the OTP step to allow a manual ops verification path.

---

## 11. Delivery phases

| Phase | Duration | What ships | Exit criteria |
|---|---|---|---|
| **0. Discovery** | 3 weeks | Field research in Irbid: ride 10+ routes with GPS logging, interview 15 drivers and 30 passengers at the New and Old Complex, meet the drivers' committee and check LTRC (هيئة تنظيم النقل البري) stance. Produce the first `jo` country pack with 5 routes. | Route GeoJSON for 5 routes; agreed pilot drivers (≥20). |
| **1. Foundations** | 4 weeks | Monorepo, CI, backend skeleton, country resolver, PostGIS schema, Redis live layer, admin route editor, self-hosted tiles + OSRM for Jordan. | Admin can import a route and see it on a map; API passes integration tests. |
| **2. MVP apps** | 6–8 weeks | Passenger and driver Flutter apps with the flows in §4.1, push, matching engine, Arabic UI, accessibility rules. | Internal end-to-end test: a driver on a real route sees a test passenger request and the passenger sees the bus approaching. |
| **3. Irbid pilot** | 6 weeks | 20–50 drivers on 5 routes, open passenger beta via Play Store. Weekly iteration. | ≥40% of pilot drivers start ≥3 trips/week; ≥100 real requests/week; median wait time reported lower than baseline from Phase 0. |
| **4. Jordan scale** | ongoing | Add Amman, Zarqa, Mafraq, Karak… via country pack data only; ops onboarding playbook; iOS release. | New city added with zero code changes. |
| **5. Syria** | after Phase 4 stabilises | `sy` country pack, dialect strings, hubs, manual verification path, connectivity hardening. | Damascus or Aleppo pilot repeating Phase 3 metrics. |

Rough total to pilot launch: **~5 months** with the team below.

---

## 12. Team & effort

- 1 Flutter developer (both apps), 1 backend developer, 1 product designer (part-time, must be an Arabic-native RTL designer), 1 field/ops person in Irbid (route data, driver onboarding, support), plus the founder as product owner.
- Optional: 1 GIS/data person for the first two months to build country packs quickly.

---

## 13. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Drivers do not switch the app on | Driver app must cost them nothing (battery, data, attention) and pay back in passengers found. Recruit through the drivers' committee at the complex, not one by one. Show them the "N passengers waiting on your route right now" number before they even start. |
| Passengers open the app and see nothing | Route directory with hubs and typical frequency is there from day one; the "live" layer is a bonus. |
| Fake requests / fake buses | Driver phone OTP; passenger rate limits; requests expire; driver can flag. |
| Regulators object | Keep the app neutral (no fares, no dispatch, no exclusivity). Meet LTRC early. Position as a public-information tool. |
| Map cost or availability | Self-hosted OSM stack from the start; no Google dependency. |
| Battery drain on driver phones | Adaptive GPS interval, foreground service with a clear notification, stop tracking when trip ends. |
| Low-end devices / poor network | Minimal payloads, delta updates, cached country pack, app size under 25 MB. |

---

## 14. Repository layout (proposed)

```
Mowasalat/
  apps/
    passenger/        Flutter app
    driver/           Flutter app
    admin/            Next.js ops web
  packages/
    core/             shared Flutter package: theme, RTL widgets, i18n, API client, map widgets
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

## 15. Decisions needed from you before Phase 1

1. **Name and branding:** "Mowasalat" (مواصلات) — keep it? It is generic and clear, which fits the simplicity goal.
2. **Driver verification:** phone OTP only, or also require the LTRC permit number? (Recommendation: OTP only for the pilot; permit later if regulators want it.)
3. **Plate visibility:** show plate to passengers by default (helps identify the bus) or opt-in only? (Recommendation: opt-in, per your privacy stance; show vehicle colour and type by default.)
4. **Arabic label for Route:** الخط (what people say) vs المسار (formal). (Recommendation: الخط.)
5. **Pilot routes:** which 5 routes out of the Irbid New Complex do we start with? Your local knowledge decides this.
6. **Backend language:** TypeScript (recommended) or Go?

---

## 16. Immediate next steps

1. Confirm the decisions in §15.
2. Start Phase 0 field work in Irbid; in parallel, scaffold the monorepo (Phase 1) so the route editor is ready to receive the first GPS traces.
3. Write the Arabic screen-by-screen UX spec in `docs/ux/` using the flows in §4.1 and the rules in §9.
