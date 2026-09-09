# Mowasalat · مواصلات

> **Mowasalat is a working name.** مواصلات stays as descriptive Arabic in the
> interface; the product gets a distinctive, ownable brand before public launch.

A privacy-first, Arabic-first public transport app for countries where buses
have no published schedule. The driver says which line he is running, the
passenger says where she is going, and each sees the other on a map. No
payments, no names, and no coordinate ever reaches the server.

- **Pilot:** five lines, Irbid ↔ Bani Kinana, Jordan. **Then:** rest of Jordan, then Syria.
- **Apps:** Passenger and Driver, plus an internal ops admin.

Start with the plan: [docs/PLAN.md](docs/PLAN.md).

## Repository

| Path | What |
|---|---|
| `packages/corridor/` | Corridor, matching and privacy library — the reference implementation ([README](packages/corridor/README.md)) |
| `services/api/` | Backend: live state, matching, aggregates, the ops admin and corridor editor, and the enforcement that keeps coordinates off the server ([README](services/api/README.md)) |
| `countries/jo/` | Jordan country pack: policy, and the five pilot lines ([README](countries/jo/README.md)) |
| `docs/PLAN.md` | Product and engineering plan |

Still to come: the two Flutter apps, Postgres and Redis, OTP, and the
self-hosted map stack.

Live updates are pushed over Server-Sent Events: `GET /stream/buses` for
passengers, `GET /stream/waiting` for drivers. Both are bound — a driver's
stream to his trip, a passenger's to a ticket issued by the lookup she just
made — so the network cannot be enumerated by a script.

## Getting started

Node 22.6 or newer. No dependencies and no build step — TypeScript runs directly
through Node's type stripping.

```
npm test                  # 151 tests across the corridor library and the API
npm run api               # start the API on :3000
ADMIN_TOKEN=… PHONE_SALT=… npm run api   # also serves the ops admin at /admin
npm run validate:packs    # structural check on the Jordan pack
npm run trace -- <route.json> <trace.json...>   # build a corridor from GPS traces
```

## The one property worth knowing about

No coordinate ever reaches the server. Positions travel as a line, a direction,
a remaining distance and a zone, all computed on the device. That is enforced
rather than intended — strict schemas reject coordinate fields, the logger
refuses to write one, and the server declines positions finer than the country's
policy band. See [services/api/README.md](services/api/README.md).
