# Jordan country pack

Carries policy as well as data, so that per-country differences never become
code forks — see [docs/PLAN.md §11](../../docs/PLAN.md).

- `config.json` — locale, residency, verification thresholds, corridor width,
  anonymity floor, OTP channels, core Arabic strings.
- `routes/*.json` — the five pilot lines, Irbid ↔ Bani Kinana.

## Every route here is provisional

**The geometry is placeholder, not survey data.** Each line is currently a
straight-line guess between Irbid and the village, carrying `"provisional": true`
and a `_phase0` checklist of what is still missing. Nothing here has been
verified in the field.

Phase 0 replaces it, per §12.1 of the plan:

| Field to fill | Currently |
|---|---|
| Departure hub / موقف in Irbid | not identified |
| Roads actually used, incl. alternatives | straight line |
| Intermediate villages served | none recorded |
| Recognised waiting points | none recorded |
| Local and colloquial names (search aliases) | none recorded |
| Headway and journey time by hour | not observed |

This is deliberate. The plan is explicit that Phase 0 is not held hostage to
survey-grade geometry (§12.2): a generously drawn corridor is enough to launch,
and the corridor-fit counters tighten it from real driving. Having the pipeline
run end to end on placeholder data means the field work only has to supply
numbers, not unblock engineering.

Run `npm run validate:packs` after editing.

## Road geometry

The corridors are generated from OpenStreetMap via OSRM, then corrected in the
field. To rebuild them:

```bash
npm run build:routes -- countries/jo/routes/*.json          # report only
npm run build:routes -- countries/jo/routes/*.json --write  # apply
```

Set `OSRM_URL` to point at your own server. The public demo server is fine for
building these five lines and is not fine for anything ongoing — it makes no
availability promise and asks not to be used in production. Self-hosting OSRM
over a Jordan extract is a container and a few hundred megabytes.

The tool reports, per line, how far the stored geometry sits from the real road
and how long a stretch a bus would be invisible for. Run it after any change to
a line's endpoints.

It does **not** mark a line surveyed. A router knows where the road goes; it
does not know which road the drivers take, where they actually stop, or what
passengers call the place. Those remain Phase 0 questions and the lines stay
`provisional` until a person answers them.

### Attribution

Road geometry here is derived from OpenStreetMap and is used under the
[ODbL](https://opendatacommons.org/licenses/odbl/), which requires attribution:
**© OpenStreetMap contributors**. The passenger page carries this, and a test
fails if it is ever dropped.

This is also why a commercial routing API is not used. Google's Directions
terms forbid caching or storing what it returns and forbid drawing it on a
non-Google map — and storing the route is the whole point.
