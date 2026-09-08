# @mowasalat/corridor

The corridor and matching library. It is the load-bearing piece of the privacy
architecture in [docs/PLAN.md §6.1](../../docs/PLAN.md): everything here runs on
the device, and its output is what may be transmitted — line, direction,
remaining distance, zone. No coordinate ever leaves.

Written in TypeScript and run directly by Node's type stripping, so it has no
dependencies and no build step:

```
npm test                  # 33 tests
npm run validate:packs    # check countries/jo against the library
```

It is also the reference implementation for the Dart port in the Flutter `core`
package. Behaviour should be compared against these tests, not re-derived.

## What it does

| Module | Responsibility |
|---|---|
| `geo.ts` | Haversine distance, path indexing, point-to-path projection |
| `corridor.ts` | Corridor containment, zone resolution, remaining distance |
| `matching.ts` | Which buses will pass a passenger, ordered, with ETA |
| `privacy.ts` | Distance bucketing, density-adaptive blurring, cell suppression |
| `validate-pack.ts` | Structural checks on a country pack |

## Two decisions worth knowing about

**Containment is tested against the reference paths, not a buffer polygon.**
"Within `widthM` of some reference path" is exactly what a buffer polygon would
encode, and it needs no polygon library on the phone. The polygon in the plan is
therefore only ever a drawing aid for the ops editor.

**There is no precomputed distance table.** The plan called for one so the phone
would not need a routing engine. Projecting onto the cached path gives the same
answer — distance along a path that follows roads *is* road distance — and it is
exact rather than sampled. A table only becomes necessary if we later take true
OSRM road distances that diverge from along-path distance, which the corridor
model does not currently require.

## The property everything rests on

With alternative roads there is no shared line to measure progress along, but
both roads end in the same place, so **remaining distance is monotonic whichever
road is taken**. Ordering is then a comparison and ETA is a subtraction:

```
bus will pass her   ⟺   bus.remainingM > passenger.remainingM
eta                 =   (bus.remainingM - passenger.remainingM) / speed
```

`corridor.test.ts` covers this directly, including the two-drivers-on-different-
roads case.
