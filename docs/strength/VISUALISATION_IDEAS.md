# Strength visualisation ideas (2026-10-08)

Gap analysis against Bevel 3.2.0 (Fall Release, 30 Sep 2026) and other strength apps (Hevy, Fitbod, JEFIT, Strong, Strength Level, WHOOP).

## Sources

- Bevel release notes: https://releasebot.io/updates/bevel-health
- Bevel App Store listing: https://apps.apple.com/us/app/bevel-all-in-one-health-app/id6456176249
- Bevel feedback board:
  - https://feedback.bevel.health/feature-requests/p/detailed-muscle-group-analytics-in-activity-tab
  - https://feedback.bevel.health/feature-requests/p/show-muscular-load-with-cardio-load
- Hevy help:
  - https://help.hevyapp.com/hc/en-us/articles/35702030346903
  - https://help.hevyapp.com/hc/en-us/articles/35380117933207
- Fitbod: https://fitbod.me/blog/fitbod-insights-feature/
- Strength Level: https://strengthlevel.com/strength-standards/bench-press/lb
- WHOOP: https://barbend.com/whoop-strength-trainer-feature

## Ideas

Effort: S = small, M = medium.

| # | Idea | Data (already have?) | Precedent | Effort |
|---|---|---|---|---|
| 1 | Leg-load timeline. Daily run vs strength leg load, a leg-freshness line, and markers on quality days. | `muscleEvents` kinds, plus `fatigueAt` at past times (yes) | Bevel Muscular Load "across strength and cardio" | M |
| 2 | Muscular-load PMC per area (acute/chronic + ratio band), next to the cardio CTL/ATL chart | `groupLoad` daily array (yes) | Bevel Cardio + Muscular Load side by side | S–M |
| 3 | One training calendar for runs and strength. Dot colour = sport, size = load. Planned days hollow. Weekly streak. | Sessions, runs, routinesForDate, week plan (yes) | Bevel Training Calendar; Hevy calendar | M |
| 4 | Per-muscle chart (17 muscles, 10–20 hard-set band) plus a metric switch on the body map (sets over 7/30 days) | `muscleLoad`, BodyMap colour function (yes) | Bevel Muscle Chart/Map; Hevy | S |
| 5 | Strength-session breakdown. Mini body map, per-muscle bars, HR curve with set ticks, cardio vs muscular split, PRs. | `doneAt`, HR enrichment, `strengthStrainLoad`, `sessionPRs` (yes) | Bevel activity details; JEFIT BodyMap | M |
| 6 | PR timeline. Gold markers on the e1RM chart and a Records feed. | Derived from `sessionPRs` over history (yes) | Bevel PR types; Strong | S |
| 7 | Metric switch on the exercise chart: e1RM, heaviest, volume, sets, reps, longest hold | `exerciseHistory` (yes; hold time needs a new duration field) | Bevel exercise charts | S/M |
| 8 | Daily strain composition: cardio vs muscular vs passive | dayView muscular/cardio (yes) | WHOOP | S |
| 9 | Strength vs running-economy overlay: leg e1RM vs EC/EF, with lag scan | e1RM + EC/EF (yes; needs about 3 months of data) | None (Blagrove 2018 evidence) | M |
| 10 | Effort (RIR) distribution per week | `SetLog.rir`, sparse (yes) | Alpha Progression (secondary source) | S |
| 11 | Relative strength (× body weight) with Strength Level bands where standards exist | bodyKg (yes) | Strength Level | S |
| 12 | Customisable strength-stats layout with year-to-date and cumulative views | statsLayout.ts (yes) | Bevel pin/reorder, YTD | S |

**Suggested order:** quick wins 4 → 6 → 2, then the run + strength differentiators 1 → 3 → 5. Idea 9 waits until there are about 3 months of data.
