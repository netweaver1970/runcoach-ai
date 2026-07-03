# Coach engine repro harness

Runs the **real** `src/services/coach.ts` in plain Node — no device, no LLM — so a "wrong plan" can be
reproduced and fixed deterministically instead of reasoning from screenshots.

## Run

```sh
node --import ./harness/register.mjs harness/run.ts                 # default scenario
node --import ./harness/register.mjs harness/run.ts path/to/other.json
```

Output: the cap context, `deterministicCoachPlan` (today's plan), and `getWeekPlan` (the 7-day structure)
for the scenario.

## How it works

Node 24 runs TypeScript, but the engine imports device modules and uses extensionless imports. The loader
(`harness/loader.mjs`) handles both:

- **resolve** — aliases the device modules to mocks (`expo-secure-store`, `expo-file-system` → seeded
  in-memory mocks; `@kingstinct/react-native-healthkit`, `expo-location`, `./healthkit`, `./weather` →
  light stubs) and appends `.ts` to relative imports.
- **load** — transpiles `.ts` with **sucrase** (strips types *and* type-only imports, which Node's native
  stripping can't).

`harness/run.ts` seeds the mocks from the scenario (`globalThis.__HARNESS_SEED`) **before** importing the
engine, so `coach.ts` reads the same settings + weekly-schedule the device would.

## Scenario file (`fixture/scenario.json`)

| field | meaning |
|---|---|
| `date` | today (YYYY-MM-DD); the last `recentTimeOnFeet` date |
| `recentTimeOnFeet` | last ~14 days of running **minutes** (`0` = no run) — drives the rolling cap |
| `capPct` | rolling +% volume cap (20 = +20%/wk) |
| `shrinkToFit` | hold quality on its day, shortened, over the cap |
| `planMode` | `leisure` or `race` |
| `readiness`, `strainReal`, `advisableLow/High`, `acwr`, `weather` | today's signals |
| `schedule` | the weekly-schedule knowledge file (as on the device) |
| `periodization` | `{on,buildWeeks,deloadWeeks,deloadDropPct,anchor}` (optional) |
| `secureStore` | raw `{key:value}` escape hatch for any other setting |
| `snapOverrides` | raw overrides merged onto the CoachSnapshot |

## Using a real device export

Drop values from the app's **Settings → Export** (settings + the `running-schedule` knowledge file) into a
scenario file, plus the last 14 days of run minutes. Keep real exports **out of git** (they contain
personal data) — save them as e.g. `harness/fixture/*.local.json`.

## Note

`sucrase` is currently satisfied as a transitive dependency. If a future `npm install` prunes it, add it
as a devDependency (`npm i -D sucrase`).
