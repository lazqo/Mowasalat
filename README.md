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
| `countries/jo/` | Jordan country pack: policy, and the five pilot lines ([README](countries/jo/README.md)) |
| `docs/PLAN.md` | Product and engineering plan |

Still to come: the two Flutter apps, the NestJS API, the ops admin with its
corridor editor, and the self-hosted map stack.

## Getting started

Node 22.6 or newer. No dependencies and no build step — TypeScript runs directly
through Node's type stripping.

```
npm test                  # corridor library, 33 tests
npm run validate:packs    # structural check on the Jordan pack
```
