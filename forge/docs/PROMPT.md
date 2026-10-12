# FORGE — Internal Build Prompt

> This is the internal prompt every builder and reviewer on the team works from.
> It defines the product, the bar for "done", and the shared technical contracts.
> When a reviewer files feedback it must cite a section of this document.

## 1. Mission

Build **FORGE**, the best personal training app for one athlete whose goals are:

1. Get strong, lean and durable using **kettlebells only** (the "Kettlebell Body" style of training:
   swings, cleans, presses, snatches, squats, complexes, carries, ladders, EMOMs).
2. Build an engine with **cardio** (running first, plus row / ski erg / bike when available).
3. **Fast-track readiness for HYROX** — 8 × 1 km runs, each followed by a station:
   SkiErg 1000 m · Sled Push 50 m · Sled Pull 50 m · Burpee Broad Jumps 80 m · Row 1000 m ·
   Farmers Carry 200 m · Sandbag Lunges 100 m · Wall Balls 100 reps.
4. **Track food** with the speed of MyFitnessPal / MacroFactor / Cronometer, including macros,
   meals, water, body weight and adaptive targets.

It must feel like the best parts of the leaders, combined and focused:

| Borrowed from | What we take |
|---|---|
| Kettlebell programs (Pavel S&S, Geoff Neupert, "Kettlebell Body") | Bell-centric progressions: swing → clean → press → snatch, ladders, complexes, double-bell work, bell-size progression rules |
| Strava / Runna | Run plans with paces & HR zones, interval workouts, weekly mileage, pace trends |
| WHOOP / Garmin | Readiness check-in, training load (acute:chronic), recovery-aware day adjustments |
| Strong / Hevy | Fast set logging, previous-performance ghosting, PR detection, rest timer |
| SugarWOD / Wodify / Seconds Pro | EMOM / AMRAP / Tabata / interval timers with audio + voice cues |
| ROXFIT / HYROX community plans | Periodised race block, station substitutions, simulations, race-time predictor |
| MyFitnessPal / MacroFactor / Cronometer | Quick food search, recent & favourite foods, custom foods, meals, barcode lookup, macro rings, adaptive TDEE from weight trend |
| Apple Fitness | Rings, streaks, clean daily summary |

## 2. Constraints

- **Static, no build step.** Vanilla ES modules, HTML, CSS. Lives in `/forge/` of the Salt Labs repo
  and is served by the existing `server.js` (behind its password). Must also work from `npx serve`.
- **Offline-first PWA**: manifest + service worker, installable on iPhone home screen.
- **Local-first data**: all state in `localStorage` via `js/store.js`; JSON export/import for backup.
  The only network call allowed is optional Open Food Facts lookup (barcode/search) — the app must
  work fully without it.
- **Mobile first** (iPhone width 375–430 px), thumb-reachable bottom tab bar, works on desktop too.
- **Internal units are metric** (kg, m, sec, ml). Display honours `profile.units` (`imperial`|`metric`).
  Kettlebells are always shown in kg with lb in muted text (bells are sold in kg).
- No external JS libraries. Charts are hand-rolled SVG (`js/charts.js`).
- Accessibility: semantic buttons, labels on inputs, ≥44 px touch targets, `prefers-reduced-motion`,
  colour contrast AA, everything reachable by keyboard.

## 3. Product surface

Bottom tabs: **Today · Train · Fuel · Progress · Me**

### 3.1 Onboarding (first run)
Name, sex, age, height, weight, units, experience, kettlebells owned (multi-select of standard sizes
8/12/16/20/24/28/32/36/40/48 kg, singles vs pairs), cardio equipment available (run always; row,
ski, bike optional), training days/week (3–6), HYROX race date (optional → defaults to 12 weeks out),
division (Open / Pro / Doubles), nutrition goal (lose / maintain / gain) and activity level.
Produces macro targets and the training plan. Everything editable later in **Me**.

### 3.2 Today
- Greeting, days-to-race countdown, current phase & week.
- **Readiness check-in** (sleep, soreness, energy, stress 1–5) → readiness score → today's session
  is auto-scaled (e.g. low readiness: −1 set / Zone 2 instead of intervals) with an explanation.
- Today's planned session card with **Start**.
- Rings: Training (session done), Fuel (kcal vs target), Protein, Water.
- Quick actions: log food, log water (+250 ml), log weight, start a free timer.
- Streak and this week's completion.

### 3.3 Train
- Week view of the plan (phase colour, done/missed/today markers), browse other weeks.
- Session detail (blocks, est. time, equipment, suggested bell per exercise).
- **Workout player** (`#/workout/<id>`): block-by-block, supports kinds
  `warmup | strength | emom | amrap | intervals | circuit | cardio | station | cooldown`.
  Big timer, audio beeps (WebAudio) + optional speech cues, screen wake lock, haptics where supported,
  set logging with weight/reps/RPE pre-filled from last time, rest timer, skip/back, pause/resume,
  finish → summary with volume, time, PRs, session RPE. Survives refresh (in-progress state persisted).
- **Library**: every exercise with cues, common faults, muscles, regression/progression, HYROX link.
- **Timers**: free EMOM / AMRAP / Tabata / custom interval timer.
- **Log cardio** manually (mode, distance, time, avg HR) and **log an ad-hoc workout**.
- **HYROX**: station guide with kettlebell/no-sled substitutions, race-time predictor from
  logged benchmarks, pacing plan per run & station, simulation workouts.

### 3.4 Fuel
- Date switcher; macro rings (kcal, P, C, F) + remaining.
- Meals: Breakfast, Lunch, Dinner, Snacks — each with items, totals and **+ Add**.
- Add-food sheet: search (built-in DB ≥ 250 common foods incl. athlete staples), tabs for
  Recent / Favourites / My Foods, serving size + quantity, quick-add calories/macros,
  barcode scan (`BarcodeDetector` when available, manual entry fallback) via Open Food Facts.
- Copy yesterday's meal, save meal as template, delete/edit items.
- Water tracker. Training-day vs rest-day carb adjustment.
- **Adaptive targets**: weekly, compare weight trend vs intake to estimate real TDEE (MacroFactor-style)
  and suggest a new target.

### 3.5 Progress
- Body weight trend (raw + 7-day EMA), goal line.
- Training: weekly sessions, minutes, KB volume (kg moved), run km; training load (ACWR) gauge.
- PRs: heaviest bell per lift, most swings in 10 min, fastest 1 km, 5 km, station benchmarks.
- HYROX readiness score (0–100) and predicted finish time trend.
- Nutrition adherence: avg kcal / protein vs target over 7/30 days.
- Calendar heatmap of activity.

### 3.6 Me
Profile, equipment, targets (auto or manual), plan regeneration, units, theme, sound/voice,
export / import / reset data, about.

## 4. Training methodology (the coach brain)

- **Periodisation** from today to race date (min 4, max 24 weeks; >24 weeks → general prep first):
  `Base` (aerobic + KB strength foundation) → `Build` (threshold runs, KB strength-endurance,
  station-specific work) → `Peak` (race-pace compromised running, full/half simulations) →
  `Taper` (last 7–10 days, volume −40–50 %, keep intensity). Deload every 4th week in Base/Build.
- **Weekly template** by days/week (3–6). Always includes: ≥1 heavy KB strength day, ≥1 KB
  conditioning (EMOM/complex) day, ≥1 Zone-2 run, ≥1 quality run (intervals/tempo), and from Build
  onwards ≥1 hybrid "compromised running" session (run ↔ station alternation).
- **Bell selection**: suggested weight per exercise based on experience, sex, bodyweight and owned bells;
  progress by reps first (double progression), then bell size. Never suggest a bell the user doesn't own;
  if the next size isn't owned, progress density (less rest) or volume instead.
- **Station substitutions** (no sled/ski/rower at home):
  Sled push → heavy KB front-rack walking / hill sprints / bear-crawl push;
  Sled pull → KB rows + backward walking drags (towel) / heavy KB high pulls;
  Ski → double-KB swings + band pull-downs or KB snatches;
  Row → KB swings + run; Wall balls → KB goblet thrusters;
  Sandbag lunges → KB front-rack / goblet walking lunges;
  Farmers carry → KB farmers carry (race spec 2×24 kg Open M / 2×16 kg Open W).
- **Run paces** from a 5 km time or 1 km benchmark (Daniels-style: easy, threshold, interval, race pace).
  HR zones from HRmax (default 208 − 0.7 × age).
- **Readiness scaling**: score < 40 → recovery session; 40–60 → reduce volume 25 %, intervals → Zone 2;
  > 60 → as planned.

## 5. Nutrition methodology

- BMR: Mifflin-St Jeor. TDEE = BMR × activity factor. Goal: lose −20 %, maintain 0, gain +10 %
  (floor at BMR × 1.1).
- Protein 2.0 g/kg (lose 2.2), fat 0.8 g/kg (min 20 % kcal), carbs = remainder.
  Training days +10 % carbs, rest days −10 % carbs (kcal shifted accordingly).
- Water 35 ml/kg + 500 ml per training hour.
- Adaptive TDEE: ≥ 14 days of data → TDEE ≈ avg intake − (Δ trend weight kg × 7700 / days).

## 6. Technical contracts (MUST follow — other modules depend on them)

### 6.1 Files
```
forge/
  index.html            app shell (tab bar, <main id="view">, sheet/toast roots)
  manifest.json, sw.js, icon.svg
  css/app.css           tokens + components (see 6.4)
  js/app.js             boot, hash router, onboarding gate
  js/store.js           state, persistence, selectors (6.2)
  js/ui.js              h(), toast(), sheet(), confirm(), formatters (6.3)
  js/charts.js          ring(), lineChart(), barChart(), heatmap(), gauge()
  js/data/exercises.js  EXERCISES (6.5)
  js/data/foods.js      FOODS
  js/engine/program.js  generatePlan(profile, today) → plan; getWorkout(plan, id)
  js/engine/hyrox.js    STATIONS, predictRace(), readinessScore(), paces()
  js/engine/nutrition.js computeTargets(profile), dayTargets(), adaptiveTdee()
  js/engine/timer.js    IntervalTimer, beep(), speak(), wakeLock()
  js/engine/coach.js    scaleWorkout(workout, readiness), suggestWeight(), detectPRs()
  js/views/*.js         each exports `render(root, params)` and may return a cleanup fn
  tests/*.test.mjs      node --test unit tests for engine + store
```

### 6.2 Store (`js/store.js`)
`import { store } from './store.js'`
- `store.get()` → full state (read-only by convention).
- `store.update(fn)` → `fn(draft)` mutates a structured clone; saves + notifies.
- `store.subscribe(fn)` → unsubscribe fn.
- Helpers: `todayISO()`, `uid()`.
State shape (all metric):
```js
{
  version, createdAt,
  profile: { name, sex, age, heightCm, weightKg, units, experience, bells:[{kg,count}],
             equipment:{row,ski,bike,pullup,sandbag,wallball}, daysPerWeek, raceDate, division,
             goal, activity, hrMax, fiveKSec, onboarded },
  targets: { auto:true, kcal, protein, carbs, fat, waterMl },
  plan: { generatedAt, startDate, raceDate, weeks:[ { index, phase, deload, focus, days:[ DayPlan ] } ], workouts:{ [id]: Workout } },
  sessions: [ Session ],                 // completed/logged workouts, newest last
  activeWorkout: null | { workoutId, startedAt, blockIndex, stepIndex, log:[], paused, elapsed },
  readiness: { [date]: { sleep, soreness, energy, stress, score } },
  foodLog: { [date]: [ FoodEntry ] },
  customFoods: [ Food ], favorites: [foodId], recentFoods: [foodId], mealTemplates: [ {id,name,items} ],
  water: { [date]: ml },
  bodyweight: [ { date, kg } ],
  settings: { theme:'dark'|'light'|'system', sound:true, voice:true, haptics:true }
}
```
- `DayPlan = { date, workoutId|null, rest:boolean }`
- `Workout = { id, title, type:'strength'|'conditioning'|'run'|'hybrid'|'hyrox'|'recovery', phase, week,
  estMin, summary, equipment:[string], blocks:[Block] }` — stored in `plan.workouts`; look up with `getWorkout(plan, id)`.
- `Block = { kind, title, notes, rounds?, workSec?, restSec?, durationSec?, minutes?,
  items:[ Item ] }` where `Item = { exId, sets?, reps?, timeSec?, distanceM?, kg?, perSide?, restSec?, note? }`.
  Semantics: `strength` → sets×reps with restSec; `emom` → `minutes`, each minute do items in order
  (or alternate if `alternate:true`); `amrap` → `durationSec`, cycle items; `intervals` → `rounds` of
  `workSec`/`restSec` cycling items; `circuit` → `rounds` through items with `restSec` between rounds;
  `cardio` → items with distance/time and `note` pace/zone; `station` → HYROX station item(s) for time;
  `warmup`/`cooldown` → guided list, each item `timeSec` or `reps`.
- `Session = { id, date, workoutId|null, title, type, startedAt, durationSec, sets:[ {exId, kg, reps,
  timeSec, distanceM, rpe, block} ], cardio:[ {mode, distanceM, timeSec, avgHr} ], rpe, notes,
  readiness, prs:[ string ] }`
- `FoodEntry = { id, meal:'breakfast'|'lunch'|'dinner'|'snacks', foodId|null, name, qty, unit,
  grams, kcal, p, c, f, fiber }`
- `Food = { id, name, brand?, serving:{ label, grams }, per100:{ kcal, p, c, f, fiber }, tags:[] }`

### 6.3 UI helpers (`js/ui.js`)
`h(tag, attrs, ...children)` (attrs: `class`, `on:{click}`, `style`, `html` for trusted strings only,
plus any attribute), `toast(msg)`, `sheet({title, content, onClose}) → {close}`, `confirmDialog(msg)`,
`fmtWeight(kg, units)`, `fmtBell(kg)`, `fmtDist(m, units)`, `fmtDur(sec)`, `fmtPace(secPerKm, units)`,
`fmtDate(iso)`, `num(v, d)`, `navigate(hash)`. Never inject user text via `html`.

### 6.4 Design system
Dark-first, "forged iron": near-black graphite surfaces, warm molten-orange accent `--accent`,
electric lime `--go` for success/active, phase colours (`--base` teal, `--build` amber,
`--peak` red, `--taper` violet). Tokens defined on `:root` in `app.css`. Components:
`.card`, `.btn`, `.btn.primary|ghost|danger|sm`, `.chip`, `.pill`, `.stat`, `.list`, `.row`,
`.field`, `.seg` (segmented control), `.ring`, `.empty`, `.sheet`. Big numerals use
`font-variant-numeric: tabular-nums`.

### 6.5a Engine APIs (exact exports — code against these)
```js
// js/data/exercises.js
export const EXERCISES;            // Exercise[] (≥ 70 entries: KB, run/erg, bodyweight, HYROX stations, mobility)
export function getExercise(id);   // → Exercise, or a safe fallback {id, name: prettified id, category:'kb', cues:[]...}

// js/engine/program.js
export const PHASES;               // { base:{label,color,desc}, build:{…}, peak:{…}, taper:{…} }
export function generatePlan(profile, startISO);   // → plan (see 6.2) — plan.workouts is a map {id: Workout}
export function getWorkout(plan, id);              // plan.workouts[id] || TEMPLATES lookup || null
export function workoutForDate(plan, iso);         // → {day, week, workout|null}
export const TEMPLATES;            // Workout[] extra sessions with ids 't-<slug>' (benchmarks, HYROX sims, quick KB finishers,
                                   // recovery flow, 'free' blank) shown in Train → "More sessions"

// js/engine/coach.js
export function ownedBells(profile);                       // sorted unique kg[]
export function suggestWeight(exId, profile, sessions);    // → kg | null (null = bodyweight/cardio). Must be an owned bell.
export function lastPerformance(exId, sessions);           // → {kg, reps, timeSec, distanceM, date} | null
export function scaleWorkout(workout, readinessScore);     // → {workout, changes: string[]}  (pure, returns a copy)
export function detectPRs(session, priorSessions);         // → string[] human-readable PRs
export function trainingLoad(sessions, todayISO);          // → {acute, chronic, ratio, status:'low'|'optimal'|'high'|'spike'}
export function weekSummary(sessions, startISO);           // → {count, minutes, kbVolumeKg, runM, cardioM}
export function streak(sessions, plan, todayISO);          // → consecutive days/weeks metric {days, weeksOnPlan}

// js/engine/hyrox.js
export const STATIONS;      // [{id, name, spec:{open_m, open_w, pro_m, pro_w}, distanceM|reps, subs:[exId], tips:[]}] in race order
export function paces(fiveKSec);          // sec/km → {easy:[lo,hi], tempo, threshold, interval, race, z2}
export function hrZones(hrMax);           // [{z:1..5, lo, hi, label}]
export function defaultHrMax(age);        // 208 - 0.7*age
export function readinessScore(checkin);  // {sleep, soreness, energy, stress} 1..5 → 0..100 (soreness/stress inverted)
export function predictRace(state);       // → {totalSec, runSec, stationSec, roxzoneSec, splits:[{name, sec}], basis:string[], confidence:'low'|'med'|'high'}
export function hyroxReadiness(state, todayISO); // → {score 0..100, parts:[{label, score, tip}]}

// js/engine/nutrition.js
export function bmr(profile); export function tdee(profile);
export function computeTargets(profile);           // → {kcal, protein, carbs, fat, waterMl}
export function dayTargets(targets, isTrainingDay); // carb-cycled copy
export function adaptiveTdee(state, todayISO);      // → {tdee, days, confidence, suggestion:{kcal}|null, trendKg:[{date,kg}]}
export function scaleFood(food, grams);             // → {kcal,p,c,f,fiber}
export function searchFoods(query, foods);          // ranked Food[]

// js/engine/timer.js
export class IntervalTimer { constructor(segments, {onTick, onSegment, onDone}); start(); pause(); resume(); skip(); back(); stop(); get state(); }
//   segments: [{label, sec, kind:'work'|'rest'|'prep', meta}]; uses Date.now() deltas (never drifts, survives tab sleep)
export function beep(kind);   // 'tick'|'go'|'rest'|'done' via WebAudio; no-op when settings.sound false
export function speak(text);  // speechSynthesis; no-op when settings.voice false
export function wakeLock();   // → release fn
export function buildSegments(block); // Block → segments for emom/amrap/intervals/tabata
```

### 6.5 Exercise model
`{ id, name, category:'kb'|'run'|'erg'|'bodyweight'|'hyrox'|'mobility', pattern:'hinge'|'squat'|
'press'|'pull'|'carry'|'lunge'|'core'|'ballistic'|'cardio'|'mobility', unilateral, double,
muscles:[], cues:[], faults:[], regression?, progression?, hyrox?:stationId, loadRatio?:{beginner,
intermediate,advanced} /* × bodyweight, for suggestWeight */ }`

## 7. Definition of done (review rubric)

Every reviewer scores 1–10 on each; ship when all ≥ 9:
1. **Coaching quality** — would a HYROX coach & StrongFirst instructor sign off on the plan?
2. **Logging speed** — log a food in ≤ 3 taps from Today; log a set in 1 tap.
3. **Robustness** — no console errors; bad/empty/corrupt storage handled; refresh mid-workout resumes;
   unit tests pass; works offline.
4. **Clarity & polish** — consistent design, readable at a glance mid-workout, dark & light.
5. **Completeness** — every section in §3 works end to end, no dead buttons.
