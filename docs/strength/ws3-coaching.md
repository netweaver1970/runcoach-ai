# WS3: Planning, progressive overload, load model, feedback

Research only. No app code was changed. Every rule below is **deterministic**, so it works keyless. The LLM can explain a rule but never has to make one. Citations point to the numbered **Sources** at the end. `[H]` marks a coaching heuristic that no study backs directly; it is chosen to fit Geert's conservative profile.

Access note: pmc.ncbi.nlm.nih.gov, pubmed.ncbi.nlm.nih.gov and link.springer.com returned a captcha, cookie wall or login redirect to the fetcher. I therefore read the abstracts through the **Europe PMC REST API** (the same PubMed record) and cite the PubMed URL. Two papers were seen only through search-engine summaries and are labelled as such: Eddens 2018 [14] and Taddei 2020 [11].

---

## 1. TL;DR

| Question | Answer |
|---|---|
| Does strength help a runner? | **Yes for economy**, with a small-to-moderate effect: running economy (RE) improves 2–8% [3], or about −3.9% O₂ cost on average [2]. Heavy (≥80% 1RM) and combined heavy + plyometric work also improve time-trial performance [5]. Submaximal (40–79% 1RM) and isometric work did **not** improve RE [4]. |
| Injury prevention? | Strong in general sport: RR 0.32–0.34 [7][8]. **Weaker in runners**: the pooled runner RCTs are not significant [9]. In one observational study, a self-selected high-compliance subgroup had 85% fewer injuries, but the overall effect was not significant (p = 0.31) [10]; supervised programmes did better in a post-hoc analysis, "possibly due to increased compliance" [9]. **Adherence is the most plausible lever** (healthy-adherer bias possible), which argues for easy, short sessions. |
| Body composition (central weight)? | Resistance training alone: −1.46% body fat and less visceral fat (SMD −0.49) in healthy adults [35]. In runner trials, body mass and composition barely changed [3]. It won't make him bulky, and it won't lean him out without diet. |
| Dose | **2×/week, 6–12+ weeks** to build (2–3×/wk in trials [1][3]; ACSM 2026: every major muscle group ≥2×/wk, 2–3 sets, ≥80% 1RM for strength [20]). **1×/week maintains** strength for up to 32 weeks if intensity is kept [19]. |
| Scheduling | **Hard days hard**: lift on quality-run days, **after** the run, ideally ≥3–6 h later [12][15][16]. No lower-body lifting within 24 h before a key run [17][18]. ≥48 h between lower-body sessions `[H]`. |
| Overload model | **Autoregulated double progression**: a rep range plus an RIR target, and load goes up when the top of the range is hit at the target RIR [21][23][24]. Not linear, not DUP. |
| Load model | Foster session-RPE × minutes [28]. Map with **k ≈ 0.41 TRIMP per AU** (self-calibrating). HR-TRIMP under-counts a 45-min lifting session by **≈2–3.5×** (spike, §6). Merge through the **existing `TrimpRepair` path**. |
| Feedback | sRPE about 30 min after the session [28], plus optional per-set RIR (3 buttons), plus next-morning soreness (0–3). A deterministic table (§7) sets the next session and can downgrade tomorrow's quality run. |

---

## 2. Evidence: why a runner should lift

| Study | Design | Key result | Use in app |
|---|---|---|---|
| Balsalobre-Fernández 2016 [1] | MA, 5 studies, 93 highly trained runners | Large RE benefit (SMD −1.42). Programmes used 2–4 lower-body lifts, ≤200 jumps and 5–10 short sprints, **2–3×/wk for 8–12 wk** | Dose template |
| Denadai 2017 [2] | MA, 16 studies | RE −3.93%. Explosive (−4.83%) ≈ heavy (−3.65%). Isometric not significant. **Longer programmes gave larger gains** | Long-term, habit-first design |
| Blagrove 2018 [3] | SR | RE +2–8% over 6–20 wk. Heavy: 2–6 sets × 3–10 reps at >70% 1RM. Plyo: 30–228 contacts per session. Free weights beat machines. Best when strength sits **on separate days or as separate sessions** from running. VO₂max and body composition unchanged | Rep/contact ranges, exercise choice |
| Llanos-Lagos 2024a [4] | 3-level MA, RE by speed | Heavy (≥80% 1RM): small RE gain (ES −0.27) at 8.6–17.9 km/h. Combined: moderate (ES −0.43). **Plyometric helped RE at ≤12 km/h** (ES −0.31). Submaximal and isometric: no RE gain | Heavy is the core. Plyo suits recreational speeds |
| Llanos-Lagos 2024b [5] | MA, performance | Time-trial performance: high-load ES −0.47, **combined ES −1.04**. Plyo alone not significant | Target = heavy + a little plyo |
| Rønnestad & Mujika 2014 [6] | Review | Heavy or explosive work improves RE and time to exhaustion. Proposed mechanisms: tendon stiffness, delayed recruitment of type II fibres | Rationale text for the coach |
| Lauersen 2014 / 2018 [7][8] | MA, all sports | Strength training RR 0.315 [7] / 0.338 [8]. **A 10% rise in strength volume cut injury risk by more than 4 percentage points** [8]. Stretching had no effect [7] | Injury rationale |
| Wu 2024 [9] | MA, 9 runner RCTs, n=1904 | Pooled: **no significant** reduction in running-related injuries (RRI). **Supervised** programmes (post hoc): significant reduction, "possibly due to increased compliance" | Adherence features, not "more exercises" |
| Desai 2023 [10] | 433 recreational runners, 18 wk, 2×/wk; **observational comparative** | Whole group NS (23.0% vs 27.1%, p = 0.31). **Self-selected high-compliance subgroup HR 0.15** (85% fewer injuries) | Adherence tracking and nudges |
| Taddei 2020 [11] | RCT, 118 runners, foot-core training | Controls were 2.42× more likely to get an RRI over 12 months *(search summary; abstract not read directly)* | Short foot/calf block in presets |
| Wewege 2022 [35] | MA, 58 RCTs | Body fat −1.46 %-pts, fat mass −0.55 kg, visceral fat SMD −0.49 | Body-composition goal (Biology mode) |

**Honest read for Geert:** the RE and performance case is solid. The runner-specific injury case is "only if you actually do it", which makes the **UX and adherence the intervention**. The body-composition gain is real but modest.

---

## 3. Concurrent training: interference and ordering

| Finding | Source | Rule it drives |
|---|---|---|
| Concurrent training does **not** blunt max strength (SMD −0.06) or hypertrophy (−0.01). It **does** blunt explosive strength (−0.28), mainly when both are done **in the same session**. ≥3 h apart shows no significant attenuation | Schumann 2022 [12] | Prefer AM run / PM lift. Same-session lifting is allowed but second best |
| Interference grows with the **frequency and duration** of endurance work. Running interferes more than cycling | Wilson 2012 [13] | Accept a small strength penalty. Goals are RE and resilience, not max hypertrophy |
| 0 h recovery between modes gave the worst strength gains, 6 h was intermediate, 24 h was best | Robineau 2016 [15] | Separate by ≥6 h if possible `[H: ≥3 h floor per 12]` |
| **Strength → run** (6 h apart) impaired **next-day** RE and time to exhaustion more than **run → strength** | Doma & Deakin 2013 [16] | **Run first, lift second** |
| One lifting bout leaves fatigue for **hours to days** (neural, kinematic, soreness, glycogen) | Doma 2017 [17] | No lower-body lifting the day before a key run |
| Muscle damage from strength work impairs RE mainly at **high intensity (~90% VO₂max)**. The repeated-bout effect blunts this after the first exposure | Assumpção 2013 [18] | Soreness gates tomorrow's **quality**, not easy runs. Include an intro phase |
| Strength-then-endurance ordering gave ~7% larger squat 1RM gains | Eddens 2018 [14] *(search summary)* | Doesn't apply: the runner's priority is run quality, so run first |

---

## 4. Scheduling rules versus the running plan (deterministic)

The inputs are already in `coach.ts`: `SessionKind` (`intervals | tempo | long | easy | recovery`), the build/deload `cyclePhase`, readiness/recovery, `athleteStatus`, `heatStrainFactor`, and season-plan phases.

| # | Rule | Evidence |
|---|---|---|
| S1 | **Frequency by phase:** Base/Build = 2×/wk. Peak = 1–2×/wk at the **same load** with fewer sets. Taper = 0–1 light session. Deload week = 2×/wk at half the sets (§5.3) | [1][3][19][20] |
| S2 | **Hard days hard:** the first choice for lower-body/heavy strength is a day with `intervals` or `tempo`, slotted **after** the run, ideally ≥6 h later (≥3 h minimum). If the run and lift are back-to-back, the run goes first | [12][15][16] |
| S3 | **Protect key runs:** no lower-body heavy or plyo work on the day before an `intervals`, `tempo` or `long` day | [17][18] |
| S4 | **No lifting on long-run day.** An optional ≤15-min core/upper/mobility block is allowed | `[H]` glycogen and fatigue [17] |
| S5 | ≥48 h between two lower-body sessions. Upper/core may be adjacent | `[H]` common practice |
| S6 | If the week has only one quality day, session 2 goes on an easy day that also satisfies S3 and S5. On an easy-only week, use easy days ≥48 h apart | `[H]` |
| S7 | **Readiness gate:** on a red recovery/readiness day, the session becomes the **maintenance version**: 1 set per exercise, same load, RIR ≥3. It is never cancelled outright, because adherence matters [9][10] | [19] |
| S8 | `athleteStatus` = sick → no strength. Injured → "physio-prescribed only" (the existing string). Holiday → optional bodyweight preset | Existing coach logic |
| S9 | **Heat swap (heat-sensitive):** when `heatStrainFactor` ≥ ~1.25 on an **easy** run day, offer "swap to indoor strength today; run tomorrow". Never swap a quality session automatically | `[H]` fits the heat model |
| S10 | **Replace the current "gym = hard commitment" rule.** Today `/gym|strength|weights/` blocks quality on that day **and** the day after (`coach.ts` ~l.789, l.1101). That is the opposite of S2. A planned strength session should become a first-class item placed by S1–S6, and the text-commitment path should stay only for unplanned gym classes | Code finding |
| S11 | Strength minutes **never** count toward the running progression cap. The ToF cap is already runs-only; keep it that way | Code (ToF cap) |

**Example week** (5 run days, the app's default maximum):

| Mon | Tue | Wed | Thu | Fri | Sat | Sun |
|---|---|---|---|---|---|---|
| Easy | **Intervals AM + Strength A PM** (lower heavy + plyo) | Easy | **Tempo AM + Strength B PM** (lower moderate, calf/foot, core) | Rest | Easy / rest | **Long** |

Check: Thu PM to Sun long is about 60 h (S3 ✓). Tue to Thu is about 48 h (S5 ✓). If Geert's Thursday dance commitment is active, move Strength B to Wednesday PM with upper/core plus light calf work.

---

## 5. Progressive overload model

### 5.1 Options compared

| Model | How it works | For a busy runner | Evidence |
|---|---|---|---|
| **Linear** (+x kg every session) | Fixed increments | ✗ Ignores run fatigue, stalls fast, and needs a reset logic | Classic. ACSM progression rule [21] |
| **Double progression** | Fixed rep range. Add reps until the top of the range, then add load and reset | ✓ Simple, and works for machines, dumbbells and bodyweight | Rep progression ≈ load progression for strength and size [23]. ACSM: +2–10% load when 1–2 reps over target on 2 consecutive sessions [21] |
| **RIR/RPE autoregulation** | Stop sets at a target reps-in-reserve | ✓ Adjusts to a tired-from-running day on its own | RIR scale valid (velocity r = −0.88 / −0.77) [24]. People **underpredict RIR by ~1 rep**, less so near failure and with heavier loads [25] |
| **DUP** (daily undulating) | Different rep zone each session | ✗ Extra complexity. Its 1RM edge over linear appears only in **trained** lifters. No hypertrophy difference | [22] |

**Recommendation: autoregulated double progression.** Use a rep range, an RIR target of 2 (so the real RIR lands around 1–3 given the ~1-rep error [25]), and fixed exercises per 4-week block. Training to failure isn't needed for strength [26], and ACSM 2026 calls it "not strictly necessary" [20]. That fits a conservative coach and keeps running legs fresh.

### 5.2 Per-exercise rule (run after each logged session)

Inputs: reps per set, load, per-set RIR (optional), and session rating.

```
range [lo, hi], targetRIR (intro 3, build 2, deload/maint 3)
if every set reached hi reps AND rir >= targetRIR (or rating ≤ "right"):
    next.load = load + inc(equipment); next.reps = lo          # ACSM [21]
elif every set >= lo AND rir >= targetRIR-1:
    next.load = load;  next.reps = min(hi, reps + 1)           # double progression [23]
elif any set < lo OR rir == 0 (failure):
    hold; if this happened in 2 consecutive sessions: next.load = load × 0.9
inc: barbell lower +2.5–5 kg; barbell upper +1–2.5 kg; DB → next pair;
     bodyweight → +2 reps up to the cap, then next variation in a ladder
     (e.g. split squat → rear-foot-elevated → loaded RFE; calf raise 2-leg → 1-leg → 1-leg + DB)
```

### 5.3 Phases and deloads, aligned with the app's cycles

The app already runs build/deload cycles (default 3 build + 1 deload at −25%, `DEFAULT_PERIODIZATION`) and season phases (Base→Build→Peak→Taper). Strength should ride the **same calendar**, so there is only one fatigue rhythm.

| Phase | Weeks | Lower-body compound | Plyo | Sets / RIR |
|---|---|---|---|---|
| **Intro** (first block, or return after ≥14 days off) | 3 | 10–15 reps, light | 0 → 20–30 low contacts (pogo, skips) | 2 sets, RIR 3–4. Repeated-bout protection [18] |
| **Strength** (Base/Build build weeks) | ongoing | **4–6 reps** (≥80% 1RM territory, which matters for RE [4][5]) | +10 contacts/wk up to ~60–100 | 3 sets, RIR 2 |
| **App deload week** | 1 | same load (or −10%), **half the sets** | halve contacts | RIR ≥3, no progression checks |
| **Peak** | — | 3–5 reps, same load | ≤40 contacts | 1–2 sets, RIR 2–3. Maintenance [19] |
| **Taper / race week** | — | last heavy lower-body session ≥7 days before the race `[H]`. Optional short activation ≥3 days out `[H]` | none | — |
| After deload | — | resume at **pre-deload loads** (mirrors the running rebuild logic) | resume | — |

The Delphi consensus defines a deload as a planned stretch of reduced training stress to shed fatigue and restore readiness [27]. Keeping intensity (load) while dropping volume follows the maintenance evidence [19].

**Heavier-runner caveat `[H]`:** start plyometrics at low amplitude and low contact counts, progress on contacts before height, and never add plyo in the week a new heavy lift is introduced.

### 5.4 Session templates (content comes from WS4)

A: squat or trap-bar/RDL pattern, split squat, single-leg calf raise (knee straight + bent), hip bridge/hip thrust, plyo block.
B: step-up or single-leg RDL, Copenhagen/side plank, foot-core/tib raise, upper pull + push (posture, arm swing).
Home/bodyweight variants use the variation ladders above. About 30–40 min, which matches the "short sessions for adherence" point [9][10].

---

## 6. Load accounting: session-RPE → the app's TRIMP currency

### 6.1 How load works today (code read)

| Path | Strength treatment | File |
|---|---|---|
| **CTL/ATL** (Cardio Load) | Daily **Banister HR-TRIMP** over 24/7 HR. HR inside any workout window counts at full weight (`computeStrainTrimp`). A strength session contributes only its (low) HR-TRIMP, with an activity floor from kcal / exercise minutes | `trainingLoad.ts`, `healthkit.ts` `fetchDailyCardioTrimp` |
| **Daily strain** | Strength types 20/50 are **excluded** from the HR path and counted as `muscularLoad = minutes × 1` ("~1 TRIMP-equiv per active minute") | `healthkit.ts` ~l.2249, ~l.3863 |
| **kcal load** (Strain Buildup list) | `kcal × 0.1`, or `min × 0.6` for strength | `computeWorkoutLoad` |
| Planned days | `estimateDayTrimp` knows only run intensities | `trainingLoad.ts` |

This gives three different numbers for the same session, and none of them uses effort.

### 6.2 Why HR-TRIMP under-counts lifting

- Traditional sets average about **62% HRmax**, circuits about **71% HRmax** [33]. Circuits raise HR by 39% and VO₂ by 75% at the same lifting work [34]. HR follows metabolic cost, not the mechanical and neuromuscular load.
- Banister's exponential weighting (`e^(1.92·HRr)`) makes low-HRr minutes nearly worthless.
- Foster notes that very high-intensity work such as resistance training and plyometrics cannot be judged objectively from HR [28]. Session RPE rises with %1RM **even as total work falls** [29], and it is valid and reliable across modalities [31]. sRPE tracks volume-load in lifting (r = 0.55) [32].

**Spike** (`scratchpad/strength/ws3/load_spike.py`) uses a generic athlete (HRmax 185, rest 55) with no personal data:

| Session | Avg HR | HR-TRIMP (app formula) | sRPE × min | sRPE → TRIMP (k=0.41) | HR under-count |
|---|---|---|---|---|---|
| Traditional lifting, 45 min, sRPE 6 | 115 (62%) | 32 (38 with peaks integrated) | 270 AU | 111 | **~3×** |
| Circuit, 45 min, sRPE 6 | 131 (71%) | 52 | 270 AU | 111 | ~2× |
| Easy bodyweight, 30 min, sRPE 4 | 102 | 14 | 120 AU | 49 | ~3.5× |
| (today's strain proxy for the 45-min session) | — | — | — | 45 (1/min) | — |

### 6.3 The mapping: k

The app's default TRIMP/min rates are easy 1.3, moderate 2.0 and hard 2.8. Pairing them with typical CR-10 session RPEs of 3, 5 and 7 gives **k = 0.43 / 0.40 / 0.40 TRIMP per AU**, so **k ≈ 0.41**. The RPE pairing is an assumption.

**Self-calibration (keyless):** HealthKit has `workoutEffortScore` (a user-rated 1–10 effort, CR-10-like) and `estimatedWorkoutEffortScore` (Apple-estimated, for walking/running/hiking/cycling only), on iOS 18 / watchOS 11+ [36][37]. For each run with a user or Apple effort score, k_run = HR-TRIMP ÷ (effort × minutes). Take a 28-day half-life weighted median, clamped to 0.30–0.55. This reuses the pattern of `calibrateTrimpRates`.

- The installed `@kingstinct/react-native-healthkit` 9.0.11 includes both identifiers, so **reading** works.
- **Writing and relating** a score to our strength workout (`relateWorkoutEffortSample`) is not wrapped. It would need the native module. This is optional: the app can store sRPE locally and key it by the HK workout UUID, like the manual HR-unreliable flag.

### 6.4 Merge: recommended design

```
strengthEq  = k × sRPE × sessionMinutes                 # Foster AU → TRIMP-equivalent
dailyLoad   : strength window → TrimpRepair{ s, e, trimp: max(HR-TRIMP_window, w × strengthEq) }
strain      : muscularLoad = strengthEq                 # replaces the "1 per minute" proxy
planned day : estimateDayTrimp += w × k × plannedRPE × plannedMin   # 7-Day Plan / season forward PMC
no rating   : sRPE = template's planned RPE (default 5); rating arrives later → recompute (cache bump)
```

- **Why `TrimpRepair`:** it already skips HR samples inside a window and adds a replacement, which gives **zero double-counting**. It is pure and harness-testable.
- **`w` = strength weight in the CTL/ATL series. Default 0.5 at launch `[H]`.** CTL here is fitted to Bevel's HR-based Cardio Load, and it feeds TSB-driven freshness factors. At w=1 a 45-min lift would enter as a hard interval session (111), which would inflate "fitness" with non-aerobic work. At w=0.5 it enters as about 55, versus 32 today. That registers lifting fatigue in ATL/TSB (conservative, per [17]) without hijacking the running build. Expose it as a Settings tunable next to heat sensitivity. Revisit after 6 weeks of paired data.
- **Strain** takes the full `strengthEq`, because strain is a "how hard was today" display and already treats muscular load as its own additive term.
- **Alternatives considered:** (a) w=1, pure Foster: single currency but inflates CTL. (b) Two series, ATL full and CTL discounted: cleanest physiologically but a bigger code change and a departure from Banister. (c) Separate strength AU only, outside CTL/ATL: the coach would stay blind to lifting fatigue.
- Also keep a **strength-only weekly AU** (sum, 7-day vs 28-day ratio, and Foster monotony [28]) as a strength-progression guardrail. Flag when week-over-week AU rises by more than ~+20% `[H]` outside an intro week.

---

## 7. Post-workout feedback loop (deterministic)

### 7.1 What to capture (tap budget: 1 required tap)

| Signal | When | Input | Required? |
|---|---|---|---|
| **Session rating** | Notification ~30 min after the workout ends (Foster's timing [28]). Fallback: the next app open | 3 big buttons: **Too easy / Just right / Too hard**, each mapped to an sRPE of 4 / 6 / 8, with an optional 1–10 slider for detail | Yes (1 tap) |
| **Per-set RIR** | During the set log (phone/watch) | 3 chips: **Easy (3+ left) / Solid (1–2) / Limit (0)** → RIR 3 / 1.5 / 0 | Optional |
| **Next-morning soreness** | In the morning auto-flow notification or Daily Coach card | **None / Mild / Moderate / Severe** (0–3), with a lower/upper toggle | Optional, strongly prompted after lower-body days |
| Pain flag | Any time | "Pain, not soreness" → joint/location | Optional → safety rule F9 |

The CR-10 mapping is deliberately coarse. Foster found most athletes give one gestalt number [28], and per-set RPE can differ from session RPE [29].

### 7.2 Adjustment table

| # | Trigger | Next strength session | Running impact |
|---|---|---|---|
| F1 | Too easy (sRPE ≤4) **and** RIR ≥ target on all sets | Progress per §5.2, and allow progression on **two** exercises that didn't hit the rule | — |
| F2 | Just right (5–7) | Apply §5.2 per exercise only | — |
| F3 | Too hard (≥8), first or second session ever | Hold (DOMS is expected: repeated-bout effect [18]) | — |
| F4 | Too hard (≥8), otherwise | **No load increases.** If repeated in 2 consecutive sessions: −1 set per exercise | — |
| F5 | Soreness **moderate** (2), lower body | Hold volume | A **quality** run today → move it +1 day, or make it easy if the week is full ([18]: RE loss at high intensity). Easy runs unchanged |
| F6 | Soreness **severe** (3), lower body | Next session upper/core only. Lower body −20% load `[H]` | Today: easy or rest. Tomorrow's quality run rechecked |
| F7 | Readiness red on a strength day | Maintenance version (S7) | — |
| F8 | ≥14 days without strength | Intro block, loads −10% `[H]`, mirroring the running restart logic | — |
| F9 | Pain flag (not soreness) | Remove that exercise. Suggest an alternative from the same pattern. The coach says "see a physio if it persists" | Injured status is offered |
| F10 | Two missed planned sessions in a row | Reduce the plan to 1×/wk short preset for 2 wk (adherence first [9][10]) | — |

All rules are pure functions of the logged numbers, so they are harness-testable like `coach.ts`. The LLM (if keyed) only phrases the "why".

---

## 8. Geert-specific tuning (no personal data)

| Profile trait | Implication |
|---|---|
| Conservative coaching | RIR 2 (never failure). Intro block. Maintenance fallback instead of cancel. w = 0.5 |
| Heat-sensitive | Indoor strength as the heat-day swap for **easy** runs (S9). Strength adds no heat penalty indoors |
| Central weight, body-composition goal | Full-body 2×/wk supports visceral-fat reduction [35]. Pair with the nutrition work. Report body-comp trends in Biology mode, not the strength screen |
| Goals: economy + resilience | Heavy lower body plus a little plyo [4][5]. Calf/foot block [11]. Adherence UX [10] |

---

## 9. Open questions for the PM / Geert

1. Default **w** (strength weight in CTL/ATL): 0.5 conservative, or 1.0 pure Foster?
2. Should the app **write** a `workoutEffortScore` to Health (a native change), or keep sRPE local-only?
3. Include plyometrics by default, or make them opt-in given central weight?
4. Should planned strength replace the free-text `CoachPlan.strength` and `STRENGTH_DEFAULT` entirely, or live beside them (keyless default preset)?

---

## Sources

Abstracts were read through the Europe PMC REST API (`ebi.ac.uk/europepmc/webservices/rest/search`) unless noted otherwise. The PubMed and PMC HTML pages were bot-blocked.

1. Balsalobre-Fernández C et al. 2016, J Strength Cond Res 30(8):2361–8. https://pubmed.ncbi.nlm.nih.gov/26694507/
2. Denadai BS et al. 2017, Sports Med. https://pubmed.ncbi.nlm.nih.gov/27497600/
3. Blagrove RC, Howatson G, Hayes PR. 2018, Sports Med. https://pmc.ncbi.nlm.nih.gov/articles/PMC5889786/ (full text read) · https://pubmed.ncbi.nlm.nih.gov/29249083/
4. Llanos-Lagos C et al. 2024, Sports Med (RE by speed). https://pubmed.ncbi.nlm.nih.gov/38165636/ · doi:10.1007/s40279-023-01978-y
5. Llanos-Lagos C et al. 2024, Sports Med 54:1801–33 (performance). https://pubmed.ncbi.nlm.nih.gov/38627351/ · doi:10.1007/s40279-024-02018-z
6. Rønnestad BR, Mujika I. 2014, Scand J Med Sci Sports. https://pubmed.ncbi.nlm.nih.gov/23914932/
7. Lauersen JB et al. 2014, Br J Sports Med 48:871–7. https://pubmed.ncbi.nlm.nih.gov/24100287/
8. Lauersen JB et al. 2018, Br J Sports Med. https://pubmed.ncbi.nlm.nih.gov/30131332/
9. Wu H, … Blagrove RC. 2024, Sports Med. https://pubmed.ncbi.nlm.nih.gov/38261240/
10. Desai P et al. 2023, Scand J Med Sci Sports. https://pubmed.ncbi.nlm.nih.gov/36630577/
11. Taddei UT et al. 2020, Am J Sports Med 48:3610–9. https://pubmed.ncbi.nlm.nih.gov/33156692/ *(search-engine summary only)*
12. Schumann M et al. 2022, Sports Med. https://pubmed.ncbi.nlm.nih.gov/34757594/
13. Wilson JM et al. 2012, J Strength Cond Res. https://pubmed.ncbi.nlm.nih.gov/22002517/
14. Eddens L, van Someren K, Howatson G. 2018, Sports Med. https://link.springer.com/article/10.1007/s40279-017-0784-1 *(search-engine summary only)*
15. Robineau J et al. 2016, J Strength Cond Res. https://pubmed.ncbi.nlm.nih.gov/25546450/
16. Doma K, Deakin GB. 2013, Appl Physiol Nutr Metab. https://pubmed.ncbi.nlm.nih.gov/23724883/
17. Doma K, Deakin GB, Bentley DJ. 2017, Sports Med. https://pubmed.ncbi.nlm.nih.gov/28702901/
18. Assumpção CdO et al. 2013, ScientificWorldJournal. https://pubmed.ncbi.nlm.nih.gov/23431253/
19. Spiering BA et al. 2021, J Strength Cond Res 35(5):1449–58. https://pubmed.ncbi.nlm.nih.gov/33629972/
20. ACSM 2026 resistance-training guidelines (Phillips SM et al., MSSE, 17 Mar 2026). https://acsm.org/resistance-training-guidelines-update-2026/
21. ACSM Position Stand 2009, Progression models in resistance training. https://pubmed.ncbi.nlm.nih.gov/19204579/ (full-text PDF read: https://tourniquets.org/wp-content/uploads/PDFs/ACSM-Progression-models-in-resistance-training-for-healthy-adults-2009.pdf)
22. Moesgaard L et al. 2022, Sports Med. https://pubmed.ncbi.nlm.nih.gov/35044672/
23. Plotkin D et al. 2022, PeerJ. https://pubmed.ncbi.nlm.nih.gov/36199287/
24. Zourdos MC et al. 2016, J Strength Cond Res. https://pubmed.ncbi.nlm.nih.gov/26049792/
25. Halperin I et al. 2022, Sports Med 52:377–90. https://pubmed.ncbi.nlm.nih.gov/34542869/
26. Robinson ZP et al. 2024, Sports Med. https://pubmed.ncbi.nlm.nih.gov/38970765/
27. Bell L et al. 2023, Sports Med Open 9:87. https://pubmed.ncbi.nlm.nih.gov/37730925/
28. Foster C et al. 2001, J Strength Cond Res 15(1):109–15. https://pubmed.ncbi.nlm.nih.gov/11708692/ (full text read: https://paulogentil.com/pdf/A%20New%20Approach%20to%20Monitoring%20Exercise%20Training.pdf)
29. Sweet TW et al. 2004, J Strength Cond Res. https://pubmed.ncbi.nlm.nih.gov/15574104/
30. Day ML et al. 2004, J Strength Cond Res 18(2):353–8. https://journals.lww.com/nsca-jscr/abstract/2004/05000/monitoring_exercise_intensity_during_resistance.27.aspx *(title and design only)*
31. Haddad M et al. 2017, Front Neurosci. https://pubmed.ncbi.nlm.nih.gov/29163016/
32. Genner KM, Weston M. 2014, J Strength Cond Res. https://pubmed.ncbi.nlm.nih.gov/24552797/
33. Alcaraz PE et al. 2008, J Strength Cond Res. https://pubmed.ncbi.nlm.nih.gov/18438256/
34. Marín-Pagán C et al. 2020, Biology (Basel). https://pubmed.ncbi.nlm.nih.gov/33171830/
35. Wewege MA et al. 2022, Sports Med. https://pubmed.ncbi.nlm.nih.gov/34536199/
36. Apple Developer: `workoutEffortScore`, `estimatedWorkoutEffortScore`, `relateWorkoutEffortSample(_:with:activity:completion:)`, all iOS 18.0 / watchOS 11.0 (read via Apple's doc JSON). https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier/workouteffortscore · https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier/estimatedworkouteffortscore
37. Sasquatch Studio, "Reading from, and Saving Workout Effort to, HealthKit" (2025), for the API usage and the 1–10 `appleEffortScore` unit. https://sasq.ca/blog/2025/4/28/reading-writing-workout-effort-scores
38. Code read (this repo): `src/services/trainingLoad.ts` (Banister TRIMP, `TrimpRepair`, `computeDayStrain`, `DEFAULT_TRIMP_RATES`, `estimateDayTrimp`), `src/services/healthkit.ts` (~l.2186–2260 strain `muscularLoad`; ~l.3440–3480 daily TRIMP; ~l.3846 history), `src/services/coach.ts` (`STRENGTH_DEFAULT`, `COMMITMENTS` "gym" hard rule, `DEFAULT_PERIODIZATION`, deload scaling).
39. Spike: `/private/tmp/claude-501/-Users-geertsteyaert-Claude-iphone---mcp-apple-health-integration/483e295a-fc0e-4f46-900f-6ce14d7f5462/scratchpad/strength/ws3/load_spike.py`
