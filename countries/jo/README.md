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
