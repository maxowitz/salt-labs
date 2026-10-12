// FORGE nutrition engine — targets, carb cycling, adaptive TDEE and food search.
// Pure functions, no DOM: safe to import from node tests. See docs/PROMPT.md §5 and §6.5a.

export const ACTIVITY_FACTORS = { sedentary: 1.2, light: 1.375, moderate: 1.55, very: 1.725, athlete: 1.9 };
export const GOAL_ADJUST = { lose: -0.2, maintain: 0, gain: 0.1 };
export const KCAL_PER_KG = 7700;          // energy density of body-mass change (§5)
export const TREND_ALPHA = 0.1;           // EMA smoothing for the weight trend (≈ 10-day memory)
export const ADAPTIVE_MIN_DAYS = 14;      // §5: need ≥ 14 days of data
export const ADAPTIVE_WINDOW = 28;        // look-back window for the energy balance
export const FIBER_PER_1000 = 14;         // g fibre per 1000 kcal (Dietary Guidelines)

const n = (v, d = 0) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
const round = (v, step = 1) => Math.round(v / step) * step;

function profileNums(p = {}) {
  return {
    kg: Math.min(300, Math.max(30, n(p.weightKg, 80))),
    cm: Math.min(250, Math.max(120, n(p.heightCm, 175))),
    age: Math.min(100, Math.max(14, n(p.age, 30))),
    female: p.sex === 'f',
  };
}

/** Mifflin-St Jeor basal metabolic rate, kcal/day (rounded). */
export function bmr(profile) {
  const { kg, cm, age, female } = profileNums(profile);
  return Math.round(10 * kg + 6.25 * cm - 5 * age + (female ? -161 : 5));
}

export function activityFactor(activity) {
  return ACTIVITY_FACTORS[activity] ?? ACTIVITY_FACTORS.moderate;
}

/** Total daily energy expenditure = BMR × activity factor. */
export function tdee(profile) {
  return Math.round(bmr(profile) * activityFactor(profile?.activity));
}

/** Goal-adjusted kcal for a given maintenance estimate, floored at BMR × 1.1, rounded to 10. */
export function goalKcal(maintenance, profile) {
  const adj = GOAL_ADJUST[profile?.goal] ?? 0;
  return round(Math.max(maintenance * (1 + adj), bmr(profile) * 1.1), 10);
}

/** Macro split for a kcal target using the §5 rules (protein g/kg, fat 0.8 g/kg ≥ 20 % kcal, carbs remainder). */
export function macrosForKcal(profile, kcal) {
  const { kg } = profileNums(profile);
  const protein = Math.round(kg * (profile?.goal === 'lose' ? 2.2 : 2.0));
  const fat = Math.round(Math.max(0.8 * kg, (0.2 * kcal) / 9));
  const carbs = Math.max(0, Math.round((kcal - protein * 4 - fat * 9) / 4));
  return { kcal: Math.round(kcal), protein, carbs, fat };
}

/** Daily targets from the profile. `opts.trainingHours` (default 1) drives the water bonus. */
export function computeTargets(profile = {}, opts = {}) {
  const { kg } = profileNums(profile);
  const kcal = goalKcal(tdee(profile), profile);
  const hours = Math.max(0, n(opts.trainingHours, 1));
  const waterMl = round(35 * kg + 500 * hours, 50);
  return { ...macrosForKcal(profile, kcal), waterMl };
}

/**
 * Carb-cycled copy of the targets: training days +10 % carbs, rest days −10 %;
 * kcal shift with the carbs (4 kcal/g). isTrainingDay null/undefined → unchanged copy.
 */
export function dayTargets(targets = {}, isTrainingDay) {
  const t = { ...targets };
  if (isTrainingDay == null) return { ...t, dayType: null };
  const carbs = n(t.carbs);
  const nc = Math.round(carbs * (isTrainingDay ? 1.1 : 0.9));
  t.kcal = Math.round(n(t.kcal) + (nc - carbs) * 4);
  t.carbs = nc;
  t.dayType = isTrainingDay ? 'training' : 'rest';
  return t;
}

export function fiberTarget(kcal) {
  return Math.round((n(kcal) / 1000) * FIBER_PER_1000);
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

/** EMA-smoothed daily weight trend (missing days linearly interpolated). */
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
      out.push({ date: dayToIso(d0 + k), kg: Math.round(ema * 100) / 100, raw: k === 0 ? w0 : null, interp: raw });
    }
  }
  return out;
}

function slope(points) {
  // least-squares slope of [{x, y}]
  const m = points.length;
  if (m < 2) return 0;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of points) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; }
  const den = m * sxx - sx * sx;
  return den ? (m * sxy - sx * sy) / den : 0;
}

/**
 * Adaptive TDEE (MacroFactor-style). Looks back up to 28 days (needs ≥ 14) and solves the energy
 * balance:  TDEE ≈ avg intake − (Δ trend weight kg × 7700 / days).
 *
 * The weight trend is the EMA-smoothed series (weightTrend). Because an EMA lags a moving signal,
 * the rate of change is taken as the least-squares slope of the daily (interpolated) weights over
 * the window — the regression line is the unbiased estimate of the same trend, so a clean
 * −0.5 kg/week at 2000 kcal gives exactly 2550 kcal. Today's intake is excluded (day not finished),
 * and only days with food logged count towards average intake.
 *
 * → { tdee, days, intakeDays, weighIns, avgIntake, weeklyChangeKg, confidence, suggestion, trendKg,
 *     formulaTdee, reason }
 */
export function adaptiveTdee(state = {}, todayISO) {
  const today = ISO_RE.test(todayISO || '') ? todayISO : new Date().toISOString().slice(0, 10);
  const tDay = isoToDay(today);
  const profile = state.profile || {};
  const formulaTdee = tdee(profile);
  const fullTrend = weightTrend((state.bodyweight || []).filter((b) => b && b.date <= today));
  const trendKg = fullTrend.filter((p) => isoToDay(p.date) > tDay - 60).map(({ date, kg }) => ({ date, kg }));
  const base = { tdee: null, days: 0, intakeDays: 0, weighIns: 0, avgIntake: null, weeklyChangeKg: null, confidence: 'low', suggestion: null, trendKg, formulaTdee, reason: '' };

  const weighIns = (state.bodyweight || []).filter((b) => b && ISO_RE.test(b.date) && b.date <= today && isoToDay(b.date) >= tDay - ADAPTIVE_WINDOW && n(b.kg) > 0);
  const firstDay = weighIns.length ? Math.min(...weighIns.map((b) => isoToDay(b.date))) : tDay;
  // window: the span of data we have, capped at 28 days, ending yesterday for intake
  const days = Math.min(ADAPTIVE_WINDOW, tDay - firstDay);
  const startDay = tDay - days;

  let intakeSum = 0, intakeDays = 0;
  const log = state.foodLog || {};
  for (let d = startDay; d < tDay; d++) {
    const list = log[dayToIso(d)];
    if (!Array.isArray(list) || !list.length) continue;
    const k = list.reduce((a, e) => a + n(e?.kcal), 0);
    if (k > 0) { intakeSum += k; intakeDays++; }
  }
  const out = { ...base, days, intakeDays, weighIns: weighIns.length, avgIntake: intakeDays ? Math.round(intakeSum / intakeDays) : null };

  if (days < ADAPTIVE_MIN_DAYS) return { ...out, reason: `Needs ${ADAPTIVE_MIN_DAYS} days of weigh-ins — you have ${Math.max(0, days)}.` };
  if (weighIns.length < 4) return { ...out, reason: 'Log your weight at least 2–3 times a week.' };
  if (intakeDays < 10) return { ...out, reason: `Log food on at least 10 of the last ${days} days — you have ${intakeDays}.` };

  const pts = fullTrend.filter((p) => { const d = isoToDay(p.date); return d >= startDay && d <= tDay; })
    .map((p, i) => ({ x: i, y: p.interp }));
  const kgPerDay = slope(pts);
  let est = out.avgIntake - kgPerDay * KCAL_PER_KG;
  const b = bmr(profile);
  let clamped = false;
  if (est < b) { est = b; clamped = true; }
  if (est > b * 3) { est = b * 3; clamped = true; }
  est = round(est, 10);

  const coverage = intakeDays / days;
  let confidence = 'low';
  if (days >= 21 && coverage >= 0.8 && weighIns.length >= 10) confidence = 'high';
  else if (coverage >= 0.6 && weighIns.length >= 6) confidence = 'med';
  if (clamped) confidence = 'low';

  let suggestion = null;
  const target = goalKcal(est, profile);
  const current = n(state.targets?.kcal, 0);
  if (confidence !== 'low' && Math.abs(target - current) >= 50) {
    suggestion = { ...macrosForKcal(profile, target), kcal: target, delta: target - current };
  }
  return { ...out, tdee: est, weeklyChangeKg: Math.round(kgPerDay * 7 * 100) / 100, confidence, suggestion, reason: clamped ? 'Estimate looks off — check that you are logging everything.' : '' };
}

/** Macros for `grams` of a food (per100 based). kcal integer, macros 1 dp. */
export function scaleFood(food, grams) {
  const p = food?.per100 || {};
  const g = Math.max(0, n(grams));
  const f = g / 100;
  const r1 = (v) => Math.round(n(v) * f * 10) / 10;
  return { kcal: Math.round(n(p.kcal) * f), p: r1(p.p), c: r1(p.c), f: r1(p.f), fiber: r1(p.fiber) };
}

// ---------- search ----------
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
export function tokenize(s) {
  return norm(s).replace(/[^a-z0-9%]+/g, ' ').trim().split(' ').filter(Boolean);
}
const singular = (w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

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

function tokenScore(tok, words, weight) {
  let best = 0;
  const st = singular(tok);
  for (const w of words) {
    let s = 0;
    if (w === tok || singular(w) === st) s = 12;
    else if (w.startsWith(tok) || (st !== tok && w.startsWith(st))) s = 10;
    else if (tok.length >= 3 && w.includes(tok)) s = 5;
    else if (tok.length >= 4 && (editDistanceWithin1(tok, w) || editDistanceWithin1(tok, w.slice(0, tok.length)))) s = 3;
    if (s > best) best = s;
    if (best === 12) break;
  }
  return best * weight;
}

const indexCache = new WeakMap();
function indexOf(food) {
  let ix = indexCache.get(food);
  if (!ix) {
    ix = { name: tokenize(food.name), brand: tokenize(food.brand), tags: (food.tags || []).flatMap(tokenize), full: norm(food.name).trim() };
    indexCache.set(food, ix);
  }
  return ix;
}

/**
 * Tokenised search. Every query token must match the name, brand or tags (prefix, substring or
 * one-edit fuzzy). Ranking: exact name > name starts with query > per-token quality; recents and
 * favourites get a boost; ties keep list order (FOODS is ordered most-common first).
 * opts: { recent:[id], favorites:[id], limit }
 */
export function searchFoods(query, foods = [], opts = {}) {
  const toks = tokenize(query);
  if (!toks.length) return [];
  const q = norm(query).trim().replace(/\s+/g, ' ');
  const recent = opts.recent || [], favs = new Set(opts.favorites || []);
  const scored = [];
  foods.forEach((food, idx) => {
    if (!food || !food.name) return;
    const ix = indexOf(food);
    let score = 0;
    for (const t of toks) {
      const s = Math.max(tokenScore(t, ix.name, 1), tokenScore(t, ix.brand, 0.6), tokenScore(t, ix.tags, 0.4));
      if (!s) return;
      score += s;
    }
    if (ix.full === q) score += 50;
    else if (ix.full.startsWith(q)) score += 25;
    if (ix.name[0] && ix.name[0].startsWith(toks[0])) score += 8;
    const ri = recent.indexOf(food.id);
    if (ri >= 0) score += Math.max(6, 20 - ri);
    if (favs.has(food.id)) score += 12;
    scored.push({ food, score, idx });
  });
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  const res = scored.map((x) => x.food);
  return opts.limit ? res.slice(0, opts.limit) : res;
}
