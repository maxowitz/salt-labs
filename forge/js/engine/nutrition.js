// FORGE nutrition engine — energy targets, day targets, adaptive TDEE and food search.
// Pure functions, no DOM: safe to import from node tests. See docs/PROMPT.md §5 and §6.5a.
//
// Energy model (R1 P0-1):
//   maintenance = BMR × NEAT factor  +  training energy
//   - The activity question means NON-EXERCISE activity (steps, job). Factors are NEAT-only.
//   - Training energy is computed from the actual plan / logged sessions (trainingKcal), never
//     folded into the multiplier.
//   - targets.kcal is the WEEKLY-AVERAGE daily target. A given day = targets.kcal + (that day's
//     training kcal − the week's average training kcal), so the week always balances (no creep).
//     Carbs carry the difference.

export const ACTIVITY_FACTORS = { sedentary: 1.2, light: 1.3, moderate: 1.4, very: 1.5, athlete: 1.6 }; // NEAT only
export const GOAL_ADJUST = { lose: -0.2, maintain: 0, gain: 0.1 };
export const KCAL_PER_KG = 7700;          // energy density of body-mass change (§5)
export const TREND_ALPHA = 0.1;           // EMA smoothing for the displayed weight trend
export const ADAPTIVE_MIN_DAYS = 14;      // §5: need ≥ 14 days of data
export const ADAPTIVE_WINDOW = 28;        // look-back window for the energy balance
export const ADAPTIVE_MAX_STEP = 150;     // max kcal change per weekly check-in
export const FIBER_PER_1000 = 14;         // g fibre per 1000 kcal (Dietary Guidelines)
export const FIBER_CAP = 40;              // g — more causes GI distress on hard days
export const DEFAULT_SESSION_MIN = 60;
export const ASSUMED_RATE = 0.11;           // mixed KB / run / hybrid week, kcal/kg/min
/** Net (above-NEAT) training cost, kcal per kg per minute, by workout type. */
export const TRAINING_RATE = { strength: 0.08, conditioning: 0.11, run: 0.10, hybrid: 0.12, hyrox: 0.12, recovery: 0.04, cardio: 0.10, other: 0.08 };
const HARD_KINDS = new Set(['intervals', 'emom', 'amrap', 'station', 'circuit', 'tabata']);
/** Day carb floors, g per kg reference weight. */
export const CARB_FLOOR = { rest: 3, easy: 4, moderate: 4, hard: 5 };

const n = (v, d = 0) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
const round = (v, step = 1) => Math.round(v / step) * step;

function profileNums(p = {}) {
  const kg = Math.min(300, Math.max(30, n(p.weightKg, 80)));
  const cm = Math.min(250, Math.max(120, n(p.heightCm, 175)));
  return {
    kg, cm,
    age: Math.min(100, Math.max(14, n(p.age, 30))),
    female: p.sex === 'f',
    refKg: Math.min(kg, 25 * (cm / 100) ** 2), // BMI-25 reference weight for protein/fat/carb g/kg (R1 P1-3)
  };
}
export function referenceWeight(profile) { return Math.round(profileNums(profile).refKg * 10) / 10; }

/** Mifflin-St Jeor basal metabolic rate, kcal/day (rounded). */
export function bmr(profile) {
  const { kg, cm, age, female } = profileNums(profile);
  return Math.round(10 * kg + 6.25 * cm - 5 * age + (female ? -161 : 5));
}

export function activityFactor(activity) {
  return ACTIVITY_FACTORS[activity] ?? ACTIVITY_FACTORS.moderate;
}

/** Absolute kcal floor: max(1.2 × BMR, 1500 men / 1200 women). */
export function kcalFloor(profile) {
  return Math.round(Math.max(1.2 * bmr(profile), profile?.sex === 'f' ? 1200 : 1500));
}

// ---------- training energy ----------
function workoutMinutes(w) {
  if (!w) return 0;
  let min = n(w.durationSec) > 0 ? w.durationSec / 60 : n(w.estMin);
  if (!(min > 0) && Array.isArray(w.cardio)) min = w.cardio.reduce((a, c) => a + n(c?.timeSec) / 60, 0);
  return Math.min(300, Math.max(0, min));
}

/** 'hard' | 'moderate' | 'easy' for a workout or session. */
export function sessionIntensity(w) {
  if (!w) return 'easy';
  const t = w.type || 'other';
  if (t === 'recovery') return 'easy';
  if (t === 'hybrid' || t === 'hyrox' || t === 'conditioning') return 'hard';
  if ((w.blocks || []).some((b) => HARD_KINDS.has(b?.kind))) return 'hard';
  if (n(w.rpe) >= 8) return 'hard';
  return 'moderate';
}

/**
 * Net training energy (kcal above everyday activity) for a planned Workout or a logged Session.
 * MET-style: minutes × kg × rate(type). Logged runs with distance use max(time-based, 0.9 kcal/kg/km).
 */
export function trainingKcal(w, profile) {
  if (!w) return 0;
  const { kg } = profileNums(profile);
  const rate = TRAINING_RATE[w.type] ?? TRAINING_RATE.other;
  let kcal = workoutMinutes(w) * kg * rate;
  if (Array.isArray(w.cardio)) {
    const runKm = w.cardio.filter((c) => c && (c.mode === 'run' || !c.mode)).reduce((a, c) => a + n(c.distanceM) / 1000, 0);
    kcal = Math.max(kcal, 0.9 * kg * runKm);
  }
  return Math.round(kcal);
}

/** Assumed average daily training kcal when no plan is available (profile.daysPerWeek × 60 min, mixed training). */
export function assumedDailyTraining(profile = {}) {
  const { kg } = profileNums(profile);
  const days = Math.min(7, Math.max(0, n(profile.daysPerWeek, 4)));
  return { kcal: Math.round((days * DEFAULT_SESSION_MIN * kg * ASSUMED_RATE) / 7), hours: (days * DEFAULT_SESSION_MIN) / 60 / 7 };
}

/** Average daily training kcal/hours across a whole plan (all weeks). */
export function planDailyTraining(plan, profile) {
  let kcal = 0, min = 0, days = 0;
  for (const wk of plan?.weeks || []) for (const d of wk.days || []) {
    days++;
    const w = d.workoutId && !d.rest ? plan.workouts?.[d.workoutId] : null;
    if (w) { kcal += trainingKcal(w, profile); min += workoutMinutes(w); }
  }
  if (!days) return assumedDailyTraining(profile);
  return { kcal: Math.round(kcal / days), hours: min / 60 / days };
}

/** Total daily energy expenditure (weekly average): BMR × NEAT + average training energy. */
export function tdee(profile, opts = {}) {
  const train = opts.plan ? planDailyTraining(opts.plan, profile) : assumedDailyTraining(profile);
  return Math.round(bmr(profile) * activityFactor(profile?.activity) + train.kcal);
}

/**
 * Goal-adjusted kcal for a maintenance estimate.
 *  - An explicit goal rate (kg/week) wins, clamped to what is deliverable (maxGoalRate).
 *  - Default cut (R2 P1-2): athletes training ≥ 4×/wk get the gentler of −15 % or 0.5 % body weight per
 *    week; others −20 %. Gain +10 %. Never below kcalFloor.
 */
export function goalKcal(maintenance, profile = {}, opts = {}) {
  const goal = profile?.goal;
  const rate = n(opts.goalRateKgWk ?? profile?.goalRateKgWk, NaN);
  let kcal;
  if (goal !== 'maintain' && Number.isFinite(rate) && rate !== 0) {
    const r = goal === 'lose' ? -Math.min(Math.abs(rate), maxGoalRate(profile, maintenance)) : Math.min(Math.abs(rate), maxGoalRate({ ...profile, goal: 'gain' }, maintenance));
    kcal = maintenance + (r * KCAL_PER_KG) / 7;
  } else if (goal === 'lose') {
    kcal = maintenance - defaultDeficit(profile, maintenance);
  } else {
    kcal = maintenance * (1 + (GOAL_ADJUST[goal] ?? 0));
  }
  return round(Math.max(kcal, kcalFloor(profile)), 10);
}

/** Default daily deficit for "lose" with no explicit rate. */
export function defaultDeficit(profile = {}, maintenance) {
  const { kg } = profileNums(profile);
  if (n(profile.daysPerWeek, 4) >= 4) return Math.min(0.15 * maintenance, (0.005 * kg * KCAL_PER_KG) / 7);
  return 0.2 * maintenance;
}

/**
 * Fastest weekly rate (kg/week, positive) the target can actually deliver (R2 P1-4):
 * lose → min(25 % of maintenance, maintenance − kcal floor, 1 % body weight/week);
 * gain → min(15 % of maintenance, 0.5 % body weight/week).
 */
export function maxGoalRate(profile = {}, maintenance) {
  const { kg } = profileNums(profile);
  if (profile.goal === 'gain') return Math.max(0, Math.min((0.15 * maintenance * 7) / KCAL_PER_KG, 0.005 * kg));
  const deficit = Math.max(0, Math.min(0.25 * maintenance, maintenance - kcalFloor(profile)));
  return Math.max(0, Math.min((deficit * 7) / KCAL_PER_KG, 0.01 * kg));
}

/**
 * Macro split for a kcal target (R1 P1-2/P1-3, R2 P2-8):
 *   protein 2.0 g/kg (2.2 when cutting) and fat 0.8 g/kg of the BMI-25 reference weight, fat ≥ 20 % kcal
 *   (≥ 25 % when gaining), carbs = remainder. Cutting hybrid athletes (≥ 4 days/wk) get a 3.5 g/kg carb
 *   floor, funded first from fat (down to max(0.6 g/kg, 20 % kcal)), then protein (down to 1.8 g/kg).
 */
export function macrosForKcal(profile = {}, kcal) {
  const { refKg } = profileNums(profile);
  const lose = profile.goal === 'lose';
  let protein = Math.round(refKg * (lose ? 2.2 : 2.0));
  const fatPct = ((profile.goal === 'gain' ? 0.25 : 0.2) * kcal) / 9;
  let fat = Math.round(Math.max(0.8 * refKg, fatPct));
  let carbs = (kcal - protein * 4 - fat * 9) / 4;
  const notes = [];
  const hybrid = n(profile.daysPerWeek, 4) >= 4;
  if (lose && hybrid) {
    const floor = 3.5 * refKg;
    if (carbs < floor) {
      const fatMin = Math.ceil(Math.max(0.6 * refKg, fatPct));
      const cutFat = Math.min(fat - fatMin, ((floor - carbs) * 4) / 9);
      if (cutFat > 0) { fat -= Math.ceil(cutFat); carbs = (kcal - protein * 4 - fat * 9) / 4; }
      if (carbs < floor) {
        const pMin = Math.round(1.8 * refKg);
        const cutP = Math.min(protein - pMin, floor - carbs);
        if (cutP > 0) { protein -= Math.ceil(cutP); carbs = (kcal - protein * 4 - fat * 9) / 4; }
      }
      if (carbs < floor - 1) notes.push('carb-short');
    }
  }
  return { kcal: Math.round(kcal), protein, carbs: Math.max(0, Math.round(carbs)), fat, notes };
}

/**
 * Daily targets from the profile — kcal is the weekly-average day.
 * opts: { plan } to use the real plan's training load (else profile.daysPerWeek × 60 min).
 * Water: 35 ml per kg of reference weight + 500 ml per average training hour (R2 P2-9).
 */
export function computeTargets(profile = {}, opts = {}) {
  const { refKg } = profileNums(profile);
  const train = opts.plan ? planDailyTraining(opts.plan, profile) : assumedDailyTraining(profile);
  const hours = opts.trainingHours != null ? Math.max(0, n(opts.trainingHours)) : train.hours;
  const maintenance = round(bmr(profile) * activityFactor(profile.activity) + train.kcal, 10);
  const kcal = goalKcal(maintenance, profile);
  const m = macrosForKcal(profile, kcal);
  const notes = [...m.notes];
  if (kcal <= kcalFloor(profile) + 10) notes.push('kcal-floor');
  const ea = (kcal - train.kcal) / fatFreeMass(profile);
  if (ea < 30) notes.push('low-ea');
  return {
    kcal: m.kcal, protein: m.protein, carbs: m.carbs, fat: m.fat,
    waterMl: round(35 * refKg + 500 * hours, 50),
    maintenance, trainKcalAvg: train.kcal, trainHoursAvg: Math.round(train.hours * 100) / 100,
    notes,
  };
}

/** Fat-free mass estimate (kg): body fat from BMI (Deurenberg 1991), clamped 6–50 %. */
export function fatFreeMass(profile = {}) {
  const { kg, cm, age, female } = profileNums(profile);
  const bmi = kg / (cm / 100) ** 2;
  const bf = Math.min(50, Math.max(6, 1.2 * bmi + 0.23 * age - 10.8 * (female ? 0 : 1) - 5.4));
  return Math.round(kg * (1 - bf / 100) * 10) / 10;
}

/**
 * Energy availability for a day (R2 P1-2): (intake − exercise kcal) / FFM.
 * intakeKcal defaults to that day's target, so it reads as "planned EA".
 * → {ea, ffm, exerciseKcal, intakeKcal, low: ea < 30}
 */
export function energyAvailability(state = {}, dateISO, intakeKcal) {
  const d = dayTargetsFor(state, dateISO);
  const ffm = fatFreeMass(state.profile || {});
  const intake = intakeKcal != null ? n(intakeKcal) : d.kcal;
  const ea = Math.round(((intake - d.trainingKcal) / ffm) * 10) / 10;
  return { ea, ffm, exerciseKcal: d.trainingKcal, intakeKcal: Math.round(intake), low: ea < 30 };
}

/**
 * Legacy carb-cycled copy (prefer dayTargetsFor). Weekly-neutral: training days +10 % carbs,
 * rest days −10 % × nTrain / nRest, so a week with `nTrain` training days averages to the base.
 */
export function dayTargets(targets = {}, isTrainingDay, { nTrain = 5 } = {}) {
  const t = { ...targets };
  if (isTrainingDay == null) return { ...t, dayType: null };
  const nt = Math.min(6, Math.max(1, nTrain)), nr = 7 - nt;
  const carbs = n(t.carbs);
  const d = 0.1 * carbs;
  const nc = Math.max(0, Math.round(isTrainingDay ? carbs + d : carbs - (d * nt) / nr));
  t.kcal = Math.round(n(t.kcal) + (nc - carbs) * 4);
  t.carbs = nc;
  t.dayType = isTrainingDay ? 'training' : 'rest';
  return t;
}

export function fiberTarget(kcal) {
  return Math.min(FIBER_CAP, Math.round((n(kcal) / 1000) * FIBER_PER_1000));
}

// ---------- dates ----------
function isoToDay(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}
function dayToIso(day) {
  return new Date(day * 86400000).toISOString().slice(0, 10);
}
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function planDay(state, iso) {
  for (const week of state?.plan?.weeks || []) for (const day of week.days || []) if (day.date === iso) return { day, week };
  return null;
}

/** Training on a date: logged sessions win; else the planned workout; else none. */
export function dayTraining(state = {}, iso) {
  const profile = state.profile || {};
  const sessions = (state.sessions || []).filter((s) => s && s.date === iso);
  if (sessions.length) {
    const items = sessions.map((s) => ({ title: s.title || 'Session', type: s.type || 'other', min: Math.round(workoutMinutes(s)), kcal: trainingKcal(s, profile), intensity: sessionIntensity(s), source: 'logged' }));
    return { kcal: items.reduce((a, x) => a + x.kcal, 0), min: items.reduce((a, x) => a + x.min, 0), intensity: maxIntensity(items), items, source: 'logged' };
  }
  const pd = planDay(state, iso);
  if (pd && !pd.day.rest && pd.day.workoutId) {
    const w = state.plan.workouts?.[pd.day.workoutId];
    if (w) {
      const it = { title: w.title || 'Session', type: w.type || 'other', min: Math.round(workoutMinutes(w)), kcal: trainingKcal(w, profile), intensity: sessionIntensity(w), source: 'planned' };
      return { kcal: it.kcal, min: it.min, intensity: it.intensity, items: [it], source: 'planned' };
    }
  }
  return { kcal: 0, min: 0, intensity: 'rest', items: [], source: pd ? 'rest' : 'none' };
}
const RANK = { rest: 0, easy: 1, moderate: 2, hard: 3 };
function maxIntensity(items) { return items.reduce((a, x) => (RANK[x.intensity] > RANK[a] ? x.intensity : a), 'easy'); }

/** 7 dates of the plan week containing iso, else the Monday-based week. */
export function weekDates(state, iso) {
  const pd = planDay(state, iso);
  if (pd && pd.week.days?.length === 7) return pd.week.days.map((d) => d.date);
  const day = isoToDay(iso);
  const dow = (new Date(day * 86400000).getUTCDay() + 6) % 7; // Monday = 0
  return Array.from({ length: 7 }, (_, i) => dayToIso(day - dow + i));
}

function weekAvgTraining(state, iso) {
  const profile = state.profile || {};
  const t = state.targets || {};
  const pd = planDay(state, iso);
  if (pd) {
    const dates = weekDates(state, iso);
    const tr = dates.map((d) => dayTraining(state, d));
    return { kcal: tr.reduce((a, x) => a + x.kcal, 0) / 7, hours: tr.reduce((a, x) => a + x.min, 0) / 60 / 7, source: 'plan' };
  }
  const assumed = assumedDailyTraining(profile);
  return { kcal: n(t.trainKcalAvg, assumed.kcal), hours: n(t.trainHoursAvg, assumed.hours), source: 'assumed' };
}

/** Un-floored kcal for one day: weekly-average target ± training difference, with Peak/Taper easing. */
function rawDayKcal(state, iso) {
  const profile = state.profile || {};
  const t = state.targets || {};
  const baseKcal = n(t.kcal, 2400);
  const tr = dayTraining(state, iso);
  const wk = weekAvgTraining(state, iso);
  const known = tr.source !== 'none';
  const pd = planDay(state, iso);
  const phase = pd?.week?.phase || null;
  const notes = [];
  let kcal = baseKcal + (known ? tr.kcal - wk.kcal : 0);
  if (profile.goal === 'lose' && (phase === 'peak' || phase === 'taper')) {
    const maint = n(t.maintenance, 0) || tdee(profile, { plan: state.plan });
    const cap = phase === 'taper' ? 0 : -0.10;
    const cur = baseKcal / maint - 1;
    if (cur < cap) { kcal += maint * (cap - cur); notes.push(phase === 'taper' ? 'taper-maintenance' : 'peak-deficit-eased'); }
  }
  return { kcal, tr, wk, known, pd, phase, notes };
}

/**
 * Per-day kcal floor with weekly re-balance (R2 P1-1): every day ≥ kcalFloor(profile); what the low days
 * are raised by is taken back from the days with headroom so the week still averages to the target
 * (when there is enough headroom). Without a plan week only the floor applies.
 */
function flooredDayKcal(state, iso, raw) {
  const fl = kcalFloor(state.profile || {});
  if (!raw.pd) return { kcal: Math.max(raw.kcal, fl), raised: raw.kcal < fl };
  const dates = weekDates(state, iso);
  const raws = dates.map((d) => (d === iso ? raw.kcal : rawDayKcal(state, d).kcal));
  const need = raws.reduce((a, k) => a + Math.max(0, fl - k), 0);
  const i = dates.indexOf(iso);
  if (raws[i] < fl) return { kcal: fl, raised: true };
  if (!need) return { kcal: raws[i], raised: false };
  const headroom = raws.map((k) => Math.max(0, k - fl));
  const H = headroom.reduce((a, x) => a + x, 0);
  const take = Math.min(need, H);
  return { kcal: raws[i] - (H ? (take * headroom[i]) / H : 0), raised: false, rebalanced: true };
}

/**
 * THE shared day-target selector (Today, Fuel, Progress all use this).
 * dayTargetsFor(state, dateISO) → {
 *   kcal, protein, carbs, fat, waterMl, fiber,
 *   dayType: 'training'|'rest'|null,   // null = unknown (no plan, nothing logged) → weekly-average day
 *   intensity: 'hard'|'moderate'|'easy'|'rest'|null, trainingKcal, trainingMin,
 *   sessions: [{title, type, min, kcal, intensity, source:'logged'|'planned'}],
 *   source: 'logged'|'planned'|'rest'|'none', phase, weekAvgTrainingKcal, notes: string[]
 * }
 * kcal = targets.kcal + (day training kcal − week-average training kcal), floored per day and
 * re-balanced across the plan week. Carbs carry the difference, then a session-scaled g/kg floor is
 * funded from fat (kcal unchanged). Cutting in Peak (−10 % max) / Taper (maintenance) eases the deficit.
 */
export function dayTargetsFor(state = {}, dateISO) {
  const profile = state.profile || {};
  const t = state.targets || {};
  const { kg, refKg } = profileNums(profile);
  const base = { kcal: n(t.kcal, 2400), protein: n(t.protein, 160), carbs: n(t.carbs, 250), fat: n(t.fat, 70), waterMl: n(t.waterMl, 3000) };
  const raw = rawDayKcal(state, dateISO);
  const { tr, wk, known, phase } = raw;
  const notes = [...raw.notes];
  const fl = flooredDayKcal(state, dateISO, raw);
  if (fl.raised) notes.push('kcal-floor-day');
  const kcal = Math.round(fl.kcal);
  let carbs = base.carbs + (kcal - base.kcal) / 4;
  let fat = base.fat;
  const intensity = known ? (tr.kcal > 0 ? tr.intensity : 'rest') : null;
  if (intensity) {
    const floor = CARB_FLOOR[intensity] * refKg;
    if (carbs < floor) {
      const fatMin = Math.max(0.6 * refKg, (0.2 * kcal) / 9);
      const cut = Math.max(0, Math.min(fat - fatMin, ((floor - carbs) * 4) / 9));
      fat -= cut; carbs += (cut * 9) / 4;
      if (carbs < floor - 1) notes.push('carb-floor-unmet');
    }
  }
  const hours = known ? tr.min / 60 : wk.hours;
  const waterMl = round(base.waterMl + 500 * (hours - wk.hours), 50);
  return {
    kcal, protein: Math.round(base.protein), carbs: Math.max(0, Math.round(carbs)), fat: Math.round(fat),
    waterMl: Math.max(round(30 * refKg, 50), waterMl), fiber: fiberTarget(kcal),
    dayType: known ? (tr.kcal > 0 ? 'training' : 'rest') : null, intensity,
    trainingKcal: tr.kcal, trainingMin: tr.min, sessions: tr.items, source: tr.source,
    phase, weekAvgTrainingKcal: Math.round(wk.kcal), carbsPerKg: Math.round((Math.max(0, carbs) / refKg) * 10) / 10, notes,
  };
}

/**
 * Pre-session fuelling prompt for a date (R2 P2-5).
 * fuelingNote(state, dateISO) → null (no session) | {
 *   title, min, intensity,          // the day's (first) session
 *   pre:    string|null,            // e.g. "Hill Sprint Power (45 min): 1–1.5 g/kg carbs 2–3 h before (≈ 80–120 g)."
 *   during: string|null,            // ≥ 75 min: carbs + fluid per hour
 *   warn:   string|null,            // hard day whose carbs are below the session floor
 *   carbsG: [lo, hi] | null         // pre-session carb range in grams
 * }
 */
export function fuelingNote(state = {}, dateISO) {
  const d = dayTargetsFor(state, dateISO);
  if (d.dayType !== 'training' || !d.sessions?.length) return null;
  const s0 = d.sessions.reduce((a, x) => (RANK[x.intensity] > RANK[a.intensity] ? x : a), d.sessions[0]);
  const { refKg } = profileNums(state.profile || {});
  const range = s0.intensity === 'hard' ? [1, 1.5] : s0.intensity === 'moderate' ? [0.5, 1] : null;
  const carbsG = range ? [Math.round((range[0] * refKg) / 10) * 10, Math.round((range[1] * refKg) / 10) * 10] : null;
  const label = `${s0.title}${s0.min ? ` (${s0.min} min)` : ''}`;
  const pre = range
    ? `${label}: have ${range[0]}–${range[1]} g/kg carbs 2–3 h before (≈ ${carbsG[0]}–${carbsG[1]} g), plus a little protein.`
    : `${label}: an easy session — a normal meal 2–3 h before is plenty.`;
  const during = d.trainingMin >= 75 ? `It’s ${d.trainingMin} min: take 30–60 g carbs per hour and 500–750 ml fluid with sodium during.` : null;
  const floorG = CARB_FLOOR[d.intensity] ?? 4;
  const warn = d.intensity === 'hard' && d.notes.includes('carb-floor-unmet')
    ? `Today’s carbs (${d.carbs} g ≈ ${d.carbsPerKg} g/kg) are below the ${floorG} g/kg we’d suggest for a hard session — consider easing the deficit today.`
    : null;
  return { title: s0.title, min: s0.min, intensity: s0.intensity, pre, during, warn, carbsG };
}

/**
 * Sodium total with coverage (R2 P1-3). Items without sodium data make the total a lower bound.
 * → {mg, known, total, kcalShare (0–1 of kcal from items with data), complete: kcalShare ≥ 0.8}
 */
export function sodiumSummary(entries = []) {
  let mg = 0, known = 0, total = 0, kAll = 0, kKnown = 0;
  for (const e of entries) {
    if (!e) continue;
    total++;
    const k = Math.max(0, n(e.kcal));
    kAll += k;
    if (e.na != null && Number.isFinite(+e.na)) { known++; mg += +e.na; kKnown += k; }
  }
  const kcalShare = kAll ? kKnown / kAll : known === total && total ? 1 : 0;
  return { mg: Math.round(mg), known, total, kcalShare: Math.round(kcalShare * 100) / 100, complete: total > 0 && kcalShare >= 0.8 };
}

/** Weekly-average view: the 7 day targets of the week containing iso and their averages. */
export function weeklyTargets(state, iso) {
  const days = weekDates(state, iso).map((d) => ({ date: d, ...dayTargetsFor(state, d) }));
  const avg = (k) => Math.round(days.reduce((a, d) => a + d[k], 0) / 7);
  return { start: days[0].date, days, avgKcal: avg('kcal'), avgCarbs: avg('carbs'), avgProtein: avg('protein'), avgFat: avg('fat') };
}

/** EMA-smoothed daily weight trend for display (missing days linearly interpolated). */
export function weightTrend(bodyweight = [], alpha = TREND_ALPHA) {
  const byDay = new Map();
  for (const b of bodyweight) {
    if (!b || !ISO_RE.test(b.date) || !(n(b.kg) > 0)) continue;
    byDay.set(isoToDay(b.date), +b.kg);
  }
  const days = [...byDay.keys()].sort((a, b) => a - b);
  if (!days.length) return [];
  const out = [];
  let ema = byDay.get(days[0]);
  for (let i = 0; i < days.length; i++) {
    const d0 = days[i], w0 = byDay.get(d0);
    const d1 = days[i + 1], w1 = d1 != null ? byDay.get(d1) : w0;
    const span = d1 != null ? d1 - d0 : 1;
    for (let k = 0; k < span; k++) {
      const raw = w0 + ((w1 - w0) * k) / span;
      ema = i === 0 && k === 0 ? raw : ema + alpha * (raw - ema);
      out.push({ date: dayToIso(d0 + k), kg: Math.round(ema * 100) / 100, raw: k === 0 ? w0 : null });
    }
  }
  return out;
}

/** Robust (Theil–Sen) trend line through [{x, y}] → {slope, intercept, mad}. */
export function robustTrend(points) {
  const m = points.length;
  if (m < 2) return { slope: 0, intercept: points[0]?.y ?? 0, mad: 0 };
  const slopes = [];
  for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) if (points[j].x !== points[i].x) slopes.push((points[j].y - points[i].y) / (points[j].x - points[i].x));
  const med = (a) => { const s = [...a].sort((x, y) => x - y); const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
  const slope = slopes.length ? med(slopes) : 0;
  const intercept = med(points.map((p) => p.y - slope * p.x));
  const mad = med(points.map((p) => Math.abs(p.y - (intercept + slope * p.x))));
  return { slope, intercept, mad };
}

/**
 * Adaptive TDEE (MacroFactor-style), compared like-for-like with the weekly-average target.
 *   TDEE ≈ avg intake − (trend slope kg/day × 7700)
 * - Window: last 28 days (needs ≥ 14). Today excluded (unfinished).
 * - Intake: only complete days — logged kcal ≥ 50 % of that day's target and not marked incomplete
 *   (state.settings.fuel.incompleteDays).
 * - Trend: robust Theil–Sen fit through the weigh-ins (unbiased like a regression, but ignores
 *   water-weight spikes); confidence drops when residuals are large. trendKg is the EMA for display.
 * - Blended with the formula while data is short: w = days / 28.
 * - Suggestion: goal rate (targets/profile.goalRateKgWk) or goal %, capped at ±150 kcal per check-in.
 */
export function adaptiveTdee(state = {}, todayISO) {
  const today = ISO_RE.test(todayISO || '') ? todayISO : new Date().toISOString().slice(0, 10);
  const tDay = isoToDay(today);
  const profile = state.profile || {};
  const targets = state.targets || {};
  const formulaTdee = n(targets.maintenance, 0) || tdee(profile, { plan: state.plan });
  const fullTrend = weightTrend((state.bodyweight || []).filter((b) => b && b.date <= today));
  const trendKg = fullTrend.filter((p) => isoToDay(p.date) > tDay - 60).map(({ date, kg }) => ({ date, kg }));
  const base = { tdee: null, days: 0, intakeDays: 0, excludedDays: 0, weighIns: 0, avgIntake: null, weeklyChangeKg: null, confidence: 'low', suggestion: null, trendKg, formulaTdee, dataTdee: null, reason: '' };

  const weighIns = (state.bodyweight || []).filter((b) => b && ISO_RE.test(b.date) && b.date <= today && isoToDay(b.date) >= tDay - ADAPTIVE_WINDOW && n(b.kg) > 0);
  const firstDay = weighIns.length ? Math.min(...weighIns.map((b) => isoToDay(b.date))) : tDay;
  const days = Math.min(ADAPTIVE_WINDOW, tDay - firstDay);
  const startDay = tDay - days;

  const flagged = new Set(state.settings?.fuel?.incompleteDays || []);
  let intakeSum = 0, intakeDays = 0, excludedDays = 0;
  const log = state.foodLog || {};
  for (let d = startDay; d < tDay; d++) {
    const iso = dayToIso(d);
    const list = log[iso];
    if (!Array.isArray(list) || !list.length) continue;
    const k = list.reduce((a, e) => a + n(e?.kcal), 0);
    if (!(k > 0)) continue;
    const dayTarget = n(targets.kcal, 0) ? dayTargetsFor(state, iso).kcal : 0;
    if (flagged.has(iso) || (dayTarget && k < dayTarget * 0.5)) { excludedDays++; continue; }
    intakeSum += k; intakeDays++;
  }
  const out = { ...base, days, intakeDays, excludedDays, weighIns: weighIns.length, avgIntake: intakeDays ? Math.round(intakeSum / intakeDays) : null };

  if (days < ADAPTIVE_MIN_DAYS) return { ...out, reason: `Needs ${ADAPTIVE_MIN_DAYS} days of weigh-ins — you have ${Math.max(0, days)}.` };
  if (weighIns.length < 4) return { ...out, reason: 'Log your weight at least 2–3 times a week.' };
  if (intakeDays < 10) return { ...out, reason: `Log complete food days on at least 10 of the last ${days} days — you have ${intakeDays}.` };

  let pts = weighIns.map((b) => ({ x: isoToDay(b.date) - startDay, y: +b.kg }));
  let fit = robustTrend(pts);
  // R2 P2-6: drop gross outliers, then guard against a step change at the end of the window
  // (carb-load / creatine / sodium water): if the last 3 days' residuals all share a sign and are large,
  // fit without them and lower confidence one notch.
  let stepGuard = false;
  const tol = Math.max(0.25, 2.5 * fit.mad);
  const kept = pts.filter((p) => Math.abs(p.y - (fit.intercept + fit.slope * p.x)) <= tol);
  if (kept.length >= 4 && kept.length < pts.length) {
    const dropped = pts.filter((p) => !kept.includes(p));
    const lateSameSign = dropped.filter((p) => p.x > days - 4);
    if (lateSameSign.length >= 2 && new Set(lateSameSign.map((p) => Math.sign(p.y - (fit.intercept + fit.slope * p.x)))).size === 1) stepGuard = true;
    pts = kept; fit = robustTrend(pts);
  }
  const tail = pts.filter((p) => p.x > days - 3);
  if (tail.length >= 2 && pts.length - tail.length >= 4) {
    const res = tail.map((p) => p.y - (fit.intercept + fit.slope * p.x));
    const thr = Math.max(0.3, 1.5 * fit.mad);
    if (res.every((r) => r > thr) || res.every((r) => r < -thr)) {
      pts = pts.filter((p) => p.x <= days - 3);
      fit = robustTrend(pts);
      stepGuard = true;
    }
  }
  const dataTdee = out.avgIntake - fit.slope * KCAL_PER_KG;
  const w = Math.min(1, days / ADAPTIVE_WINDOW);
  let est = w * dataTdee + (1 - w) * formulaTdee;
  const b = bmr(profile);
  let clamped = false;
  if (est < b) { est = b; clamped = true; }
  if (est > b * 3) { est = b * 3; clamped = true; }
  est = round(est, 10);

  const coverage = intakeDays / days;
  let confidence = 'low';
  if (days >= 21 && coverage >= 0.8 && weighIns.length >= 10 && fit.mad <= 0.8) confidence = 'high';
  else if (coverage >= 0.6 && weighIns.length >= 6 && fit.mad <= 1.5) confidence = 'med';
  if (clamped) confidence = 'low';
  if (stepGuard) confidence = confidence === 'high' ? 'med' : 'low';

  let suggestion = null;
  const rate = targets.goalRateKgWk ?? profile.goalRateKgWk;
  const ideal = goalKcal(est, profile, { goalRateKgWk: rate });
  const current = n(targets.kcal, 0);
  let kcal = current ? Math.min(current + ADAPTIVE_MAX_STEP, Math.max(current - ADAPTIVE_MAX_STEP, ideal)) : ideal;
  kcal = round(Math.max(kcal, kcalFloor(profile)), 10);
  if (confidence !== 'low' && Math.abs(kcal - current) >= 50) {
    const m = macrosForKcal(profile, kcal);
    suggestion = { kcal, protein: m.protein, carbs: m.carbs, fat: m.fat, delta: kcal - current, ideal, capped: kcal !== ideal, maintenance: est };
  }
  return {
    ...out, tdee: est, dataTdee: Math.round(dataTdee), weeklyChangeKg: Math.round(fit.slope * 7 * 100) / 100, confidence, suggestion,
    stepGuard,
    reason: clamped ? 'Estimate looks off — check that you are logging everything.' : stepGuard ? 'Your last few weigh-ins jumped (water, carbs or creatine?) — they’re left out until the trend settles.' : '',
  };
}

/** Macros for `grams` of a food (per100 based). kcal integer, macros 1 dp. Adds alc / na when the food has them. */
export function scaleFood(food, grams) {
  const p = food?.per100 || {};
  const g = Math.max(0, n(grams));
  const f = g / 100;
  const r1 = (v) => Math.round(n(v) * f * 10) / 10;
  const out = { kcal: Math.round(n(p.kcal) * f), p: r1(p.p), c: r1(p.c), f: r1(p.f), fiber: r1(p.fiber) };
  if (p.alc != null) out.alc = r1(p.alc);
  if (p.na != null) out.na = Math.round(n(p.na) * f);
  return out;
}

// ---------- search ----------
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
export function tokenize(s) {
  return norm(s).replace(/[^a-z0-9%]+/g, ' ').trim().split(' ').filter(Boolean);
}
const singular = (w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
/** Words a user adds that the database may not repeat ("pan-seared salmon", "salmon fillet"). */
const SOFT_WORDS = new Set(['pan', 'seared', 'grilled', 'roasted', 'baked', 'fried', 'steamed', 'boiled', 'poached', 'sauteed', 'broiled', 'fresh', 'homemade',
  'fillet', 'fillets', 'filet', 'sliced', 'chopped', 'diced', 'plain', 'cooked', 'organic', 'my', 'a', 'an', 'the', 'of', 'with', 'some', 'piece', 'serving', 'portion']);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function editDistanceWithin1(a, b) {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (la > lb) i++;
    else if (lb > la) j++;
    else if (a[i + 1] === b[j] && a[j + 1] === b[i] && i === j) { i += 2; j += 2; } // transposition
    else { i++; j++; }
  }
  return edits + (la - i) + (lb - j) <= 1;
}

function tokenScore(tok, words, weight, fuzzy) {
  let best = 0;
  const st = singular(tok);
  for (const w of words) {
    let s = 0;
    if (w === tok || singular(w) === st) s = 12;
    else if (w.startsWith(tok) || (st !== tok && w.startsWith(st))) s = 10;
    else if (tok.length >= 3 && w.includes(tok)) s = 5;
    else if (fuzzy && tok.length >= 5 && w.length >= 5 && (editDistanceWithin1(tok, w) || editDistanceWithin1(tok, w.slice(0, tok.length)))) s = 3;
    if (s > best) best = s;
    if (best === 12) break;
  }
  return best * weight;
}

const indexCache = new WeakMap();
function indexOf(food) {
  let ix = indexCache.get(food);
  if (!ix) {
    ix = { name: tokenize(food.name), brand: tokenize(food.brand), tags: (food.tags || []).flatMap(tokenize), full: norm(food.name).trim(),
      serving: tokenize(food.serving?.label).filter((w) => !/^\d/.test(w)),
      primary: (food.primary || []).map((a) => norm(a).trim()) };
    indexCache.set(food, ix);
  }
  return ix;
}

/**
 * Tokenised search. Every query token must match the name, brand or tags (prefix, substring, or one
 * typo on name words ≥ 5 letters). Ranking (R1 P1-4): curated alias (food.primary) > exact name >
 * name starts with the query as whole words > head word equals the first query word > token quality;
 * recents and favourites get a boost; ties keep list order (FOODS is ordered most-common first).
 * opts: { recent:[id], favorites:[id], limit }
 */
export function searchFoods(query, foods = [], opts = {}) {
  const toks = tokenize(query);
  if (!toks.length) return [];
  const q = toks.join(' ');
  const qRe = new RegExp('^' + escapeRe(norm(query).trim().replace(/\s+/g, ' ')) + '\\b');
  const recent = opts.recent || [], favs = new Set(opts.favorites || []);
  const allSoft = toks.every((t) => SOFT_WORDS.has(t));
  const scored = [];
  foods.forEach((food, idx) => {
    if (!food || !food.name) return;
    const ix = indexOf(food);
    let score = 0, hard = 0;
    for (const t of toks) {
      if (SOFT_WORDS.has(t) && !allSoft) {
        // cooking method / filler: counts only as a whole-word hit on the name or tags, else a small penalty (R2 P2-1)
        const soft = Math.max(tokenScore(t, ix.name, 1, false), tokenScore(t, ix.tags, 0.4, false), tokenScore(t, ix.serving, 0.3, false));
        score += soft >= 4 ? soft : -2;
        continue;
      }
      const s = Math.max(tokenScore(t, ix.name, 1, true), tokenScore(t, ix.brand, 0.6, false), tokenScore(t, ix.tags, 0.4, false), tokenScore(t, ix.serving, 0.3, false));
      if (!s) return;
      hard++;
      score += s;
    }
    if (!hard) return;
    if (ix.primary.includes(q)) score += 60; // curated alias is explicit intent: beats any name-prefix bonus
    if (ix.full === q) score += 50;
    else if (qRe.test(ix.full)) score += 25;
    if (ix.name[0] && singular(ix.name[0]) === singular(toks[0])) score += 8;
    const ri = recent.indexOf(food.id);
    if (ri >= 0) score += Math.max(6, 20 - ri);
    if (favs.has(food.id)) score += 12;
    scored.push({ food, score, idx });
  });
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  const res = scored.map((x) => x.food);
  return opts.limit ? res.slice(0, opts.limit) : res;
}

// ---------- input validation (QA R1 P1-5): pure, shared by every Fuel form ----------
export const LIMITS = { entryKcal: 5000, entryMacroG: 500, per100Kcal: 900, servingMinG: 1, servingMaxG: 5000, entryMaxG: 5000, waterMaxMl: 5000 };

/** '' → {empty}, junk → {bad}, else {value}. Accepts "1,5". */
export function parseNum(v) {
  if (v == null || String(v).trim() === '') return { empty: true };
  const x = Number(String(v).trim().replace(',', '.'));
  return Number.isFinite(x) ? { value: x } : { bad: true };
}

function readNums(raw, keys, errors, { maxFor = () => Infinity, unitFor = () => '' } = {}) {
  const out = {};
  for (const k of keys) {
    const r = parseNum(raw[k]);
    if (r.bad) { errors[k] = 'Enter a number'; continue; }
    if (r.empty) { out[k] = null; continue; }
    if (r.value < 0) { errors[k] = 'Can’t be negative'; continue; }
    if (r.value > maxFor(k)) { errors[k] = `Max ${maxFor(k).toLocaleString('en-US')} ${unitFor(k)}`.trim(); continue; }
    out[k] = r.value;
  }
  return out;
}

/**
 * Quick add: kcal ≤ 5000 per entry, each macro ≤ 500 g, numbers only. Blank kcal = from macros.
 * Macros may not add up to clearly more energy than the calories entered.
 * → {ok, errors:{kcal?,p?,c?,f?,form?}, value:{kcal,p,c,f}}
 */
export function validateQuickAdd(raw = {}) {
  const errors = {};
  const v = readNums(raw, ['kcal', 'p', 'c', 'f'], errors, {
    maxFor: (k) => (k === 'kcal' ? LIMITS.entryKcal : LIMITS.entryMacroG), unitFor: (k) => (k === 'kcal' ? 'kcal per entry' : 'g'),
  });
  const p = v.p || 0, c = v.c || 0, f = v.f || 0;
  const macroKcal = Math.round(4 * p + 4 * c + 9 * f);
  let kcal = v.kcal;
  if (!errors.kcal && kcal == null) {
    kcal = macroKcal;
    if (kcal > LIMITS.entryKcal) errors.kcal = `Macros add up to ${macroKcal.toLocaleString('en-US')} kcal — max ${LIMITS.entryKcal.toLocaleString('en-US')} per entry`;
  }
  if (!errors.kcal && !(kcal > 0) && !['p', 'c', 'f'].some((k) => errors[k])) errors.kcal = 'Enter calories or macros';
  if (!Object.keys(errors).length && v.kcal != null && macroKcal > v.kcal * 1.2 + 20) {
    errors.form = `Macros add up to ${macroKcal.toLocaleString('en-US')} kcal — more than the ${Math.round(v.kcal).toLocaleString('en-US')} kcal entered.`;
  }
  return { ok: !Object.keys(errors).length, errors, value: { kcal: Math.round(kcal || 0), p, c, f } };
}

/**
 * Create food: serving 1–5000 g; per-serving values ≥ 0; per 100 g kcal ≤ 900, macros ≤ 100 g,
 * fibre ≤ carbs, and macros may not add up to clearly more energy than the calories.
 * → {ok, errors:{grams?,kcal?,p?,c?,fat?,fiber?,form?}, value:{grams, perServing:{…}, per100:{kcal,p,c,f,fiber}}}
 */
export function validateCustomFood(raw = {}) {
  const errors = {};
  const g = parseNum(raw.grams);
  let grams = null;
  if (g.bad || g.empty) errors.grams = 'Enter the serving weight in grams';
  else if (g.value < LIMITS.servingMinG) errors.grams = `At least ${LIMITS.servingMinG} g`;
  else if (g.value > LIMITS.servingMaxG) errors.grams = `Max ${LIMITS.servingMaxG.toLocaleString('en-US')} g`;
  else grams = g.value;
  const v = readNums(raw, ['kcal', 'p', 'c', 'fat', 'fiber'], errors, {
    maxFor: (k) => (k === 'kcal' ? LIMITS.entryKcal * 4 : 2000), unitFor: (k) => (k === 'kcal' ? 'kcal' : 'g'),
  });
  const p = v.p || 0, c = v.c || 0, f = v.fat || 0, fiber = v.fiber || 0;
  let kcal = v.kcal;
  if (!errors.kcal && kcal == null) kcal = Math.round(4 * p + 4 * c + 9 * f);
  if (!errors.kcal && !(kcal > 0)) errors.kcal = 'Enter calories per serving';
  if (!errors.fiber && fiber > c + 1e-9) errors.fiber = 'Fiber is part of carbs — it can’t exceed them';
  let per100 = null;
  if (grams && !Object.keys(errors).length) {
    const k = 100 / grams;
    per100 = { kcal: Math.round(kcal * k * 10) / 10, p: Math.round(p * k * 10) / 10, c: Math.round(c * k * 10) / 10, f: Math.round(f * k * 10) / 10, fiber: Math.round(fiber * k * 10) / 10 };
    if (per100.kcal > LIMITS.per100Kcal) errors.kcal = `That’s ${Math.round(per100.kcal).toLocaleString('en-US')} kcal per 100 g — more than pure fat (900). Check the serving size.`;
    else if (per100.p + per100.c + per100.f > 100.5) errors.form = 'Protein + carbs + fat weigh more than the serving itself. Check the serving size.';
    else if (4 * p + 4 * (c - fiber) + 9 * f > kcal * 1.25 + 10) errors.form = `Macros add up to ${Math.round(4 * p + 4 * (c - fiber) + 9 * f)} kcal — more than the ${Math.round(kcal)} kcal entered.`;
  }
  return { ok: !Object.keys(errors).length, errors, value: { grams, perServing: { kcal: Math.round(kcal || 0), p, c, f, fiber }, per100 } };
}

/** One water entry: 0 < ml ≤ 5000. → {ok, error, ml} */
export function validateWaterMl(ml) {
  if (!Number.isFinite(ml)) return { ok: false, error: 'Enter an amount' };
  if (ml <= 0) return { ok: false, error: 'Enter an amount above 0' };
  if (ml > LIMITS.waterMaxMl) return { ok: false, error: 'Max 5 L (169 oz) at a time' };
  return { ok: true, error: null, ml: Math.round(ml) };
}

/** A logged amount: grams must be > 0 and ≤ 5000. → error string | null */
export function amountError(grams, raw) {
  if (raw != null && parseNum(raw).bad) return 'Enter a number';
  if (!Number.isFinite(grams) || grams <= 0) return 'Enter an amount above 0';
  if (grams > LIMITS.entryMaxG) return 'Max 5 kg per entry — split it into several';
  return null;
}
