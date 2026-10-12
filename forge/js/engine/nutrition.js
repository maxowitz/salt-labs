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
export const DEFAULT_SESSION_MIN = 55;
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

/** Assumed average daily training kcal when no plan is available (profile.daysPerWeek × 55 min). */
export function assumedDailyTraining(profile = {}) {
  const { kg } = profileNums(profile);
  const days = Math.min(7, Math.max(0, n(profile.daysPerWeek, 4)));
  return { kcal: Math.round((days * DEFAULT_SESSION_MIN * kg * 0.10) / 7), hours: (days * DEFAULT_SESSION_MIN) / 60 / 7 };
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

/** Goal-adjusted kcal for a maintenance estimate. A goal rate (kg/week) wins over the % rule. */
export function goalKcal(maintenance, profile = {}, opts = {}) {
  const goal = profile?.goal;
  const rate = n(opts.goalRateKgWk ?? profile?.goalRateKgWk, NaN);
  let kcal;
  if (goal !== 'maintain' && Number.isFinite(rate) && rate !== 0) {
    kcal = maintenance + (rate * KCAL_PER_KG) / 7;
    kcal = Math.min(maintenance * 1.15, Math.max(maintenance * 0.75, kcal));
  } else {
    kcal = maintenance * (1 + (GOAL_ADJUST[goal] ?? 0));
  }
  return round(Math.max(kcal, kcalFloor(profile)), 10);
}

/**
 * Macro split for a kcal target (R1 P1-2/P1-3):
 *   protein 2.0 g/kg (2.2 when cutting) and fat 0.8 g/kg (≥ 20 % kcal) of the BMI-25 reference weight,
 *   carbs = remainder. Cutting hybrid athletes (≥ 4 days/wk) get a 3.5 g/kg carb floor, funded first
 *   from fat (down to max(0.6 g/kg, 20 % kcal)), then protein (down to 1.8 g/kg).
 */
export function macrosForKcal(profile = {}, kcal) {
  const { refKg } = profileNums(profile);
  const lose = profile.goal === 'lose';
  let protein = Math.round(refKg * (lose ? 2.2 : 2.0));
  const fatPct = (0.2 * kcal) / 9;
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
 * opts: { plan } to use the real plan's training load (else profile.daysPerWeek × 55 min).
 */
export function computeTargets(profile = {}, opts = {}) {
  const { kg } = profileNums(profile);
  const train = opts.plan ? planDailyTraining(opts.plan, profile) : assumedDailyTraining(profile);
  const hours = opts.trainingHours != null ? Math.max(0, n(opts.trainingHours)) : train.hours;
  const maintenance = round(bmr(profile) * activityFactor(profile.activity) + train.kcal, 10);
  const kcal = goalKcal(maintenance, profile);
  const m = macrosForKcal(profile, kcal);
  const notes = [...m.notes];
  if (kcal <= kcalFloor(profile)) notes.push('kcal-floor');
  return {
    kcal: m.kcal, protein: m.protein, carbs: m.carbs, fat: m.fat,
    waterMl: round(35 * kg + 500 * hours, 50),
    maintenance, trainKcalAvg: train.kcal, trainHoursAvg: Math.round(train.hours * 100) / 100,
    notes,
  };
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

/**
 * THE shared day-target selector (Today, Fuel, Progress all use this).
 * dayTargetsFor(state, dateISO) → {
 *   kcal, protein, carbs, fat, waterMl, fiber,
 *   dayType: 'training'|'rest'|null,   // null = unknown (no plan, nothing logged) → weekly-average day
 *   intensity: 'hard'|'moderate'|'easy'|'rest'|null, trainingKcal, trainingMin,
 *   sessions: [{title, type, min, kcal, intensity, source:'logged'|'planned'}],
 *   source: 'logged'|'planned'|'rest'|'none', phase, weekAvgTrainingKcal, notes: string[]
 * }
 * kcal = targets.kcal + (day training kcal − week-average training kcal): weekly balanced.
 * Carbs carry the difference, then a session-scaled g/kg floor is funded from fat (kcal unchanged).
 * Cutting in Peak (−10 % max) / Taper (maintenance) eases the deficit.
 */
export function dayTargetsFor(state = {}, dateISO) {
  const profile = state.profile || {};
  const t = state.targets || {};
  const { kg, refKg } = profileNums(profile);
  const base = { kcal: n(t.kcal, 2400), protein: n(t.protein, 160), carbs: n(t.carbs, 250), fat: n(t.fat, 70), waterMl: n(t.waterMl, 3000) };
  const tr = dayTraining(state, dateISO);
  const wk = weekAvgTraining(state, dateISO);
  const known = tr.source !== 'none';
  const pd = planDay(state, dateISO);
  const phase = pd?.week?.phase || null;
  const notes = [];

  let kcal = base.kcal + (known ? tr.kcal - wk.kcal : 0);
  // gentler deficit close to the race
  if (profile.goal === 'lose' && (phase === 'peak' || phase === 'taper')) {
    const maint = n(t.maintenance, 0) || tdee(profile, { plan: state.plan });
    const cap = phase === 'taper' ? 0 : -0.10;
    const cur = base.kcal / maint - 1;
    if (cur < cap) { kcal += maint * (cap - cur); notes.push(phase === 'taper' ? 'taper-maintenance' : 'peak-deficit-eased'); }
  }
  kcal = Math.round(kcal);
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
    waterMl: Math.max(round(30 * kg, 50), waterMl), fiber: fiberTarget(kcal),
    dayType: known ? (tr.kcal > 0 ? 'training' : 'rest') : null, intensity,
    trainingKcal: tr.kcal, trainingMin: tr.min, sessions: tr.items, source: tr.source,
    phase, weekAvgTrainingKcal: Math.round(wk.kcal), notes,
  };
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

  const pts = weighIns.map((b) => ({ x: isoToDay(b.date) - startDay, y: +b.kg }));
  const fit = robustTrend(pts);
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
    reason: clamped ? 'Estimate looks off — check that you are logging everything.' : '',
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
  const scored = [];
  foods.forEach((food, idx) => {
    if (!food || !food.name) return;
    const ix = indexOf(food);
    let score = 0;
    for (const t of toks) {
      const s = Math.max(tokenScore(t, ix.name, 1, true), tokenScore(t, ix.brand, 0.6, false), tokenScore(t, ix.tags, 0.4, false));
      if (!s) return;
      score += s;
    }
    if (ix.primary.includes(q)) score += 40;
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
