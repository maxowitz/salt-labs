// node --test forge/tests/nutrition.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bmr, tdee, computeTargets, dayTargets, dayTargetsFor, weeklyTargets, adaptiveTdee, scaleFood, searchFoods, macrosForKcal,
  weightTrend, robustTrend, trainingKcal, sessionIntensity, assumedDailyTraining, kcalFloor, fiberTarget, referenceWeight, goalKcal,
  ACTIVITY_FACTORS, TRAINING_RATE, maxGoalRate, defaultDeficit, fatFreeMass, energyAvailability, fuelingNote, sodiumSummary, validateQuickAdd, validateCustomFood, validateWaterMl, amountError, parseNum, LIMITS,
} from '../js/engine/nutrition.js';
import { FOODS } from '../js/data/foods.js';

const male = { sex: 'm', age: 30, heightCm: 180, weightKg: 80, activity: 'moderate', goal: 'maintain', daysPerWeek: 5 };
const female = { sex: 'f', age: 40, heightCm: 165, weightKg: 60, activity: 'light', goal: 'maintain', daysPerWeek: 4 };
const addDays = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} ≈ ${b} ±${tol}`);

/** Synthetic plan: weeks starting at startISO; pattern = 7 workout types or null (rest). */
function makePlan(startISO, weeks = 2, pattern = ['hyrox', 'strength', null, 'run', 'conditioning', null, 'hybrid'], phases = []) {
  const workouts = {};
  const out = [];
  for (let w = 0; w < weeks; w++) {
    const days = [];
    for (let d = 0; d < 7; d++) {
      const date = addDays(startISO, w * 7 + d);
      const type = pattern[d];
      if (!type) { days.push({ date, workoutId: null, rest: true }); continue; }
      const id = `w${w}d${d}`;
      workouts[id] = { id, title: `${type} session`, type, estMin: type === 'strength' ? 45 : 60, blocks: type === 'run' ? [{ kind: 'cardio' }] : [] };
      days.push({ date, workoutId: id, rest: false });
    }
    out.push({ index: w, phase: phases[w] || 'build', deload: false, days });
  }
  return { weeks: out, workouts };
}

// ---------------------------------------------------------------- BMR / energy model (P0-1)
test('bmr: Mifflin-St Jeor known values', () => {
  assert.equal(bmr(male), 1780);           // 800 + 1125 − 150 + 5
  assert.equal(bmr(female), 1270);         // 600 + 1031.25 − 200 − 161
});

test('P0-1 activity factors are NEAT-only and training energy is added on top', () => {
  assert.deepEqual(ACTIVITY_FACTORS, { sedentary: 1.2, light: 1.3, moderate: 1.4, very: 1.5, athlete: 1.6 });
  const a = assumedDailyTraining(male); // 5 × 60 min × 80 kg × 0.11 / 7
  near(a.kcal, (5 * 60 * 80 * 0.11) / 7, 1);
  assert.equal(tdee(male), Math.round(1780 * 1.4 + a.kcal));
  // the reviewer's case: sedentary office worker training 5×/wk must get credit for training
  const office = { sex: 'm', age: 32, heightCm: 180, weightKg: 82, activity: 'sedentary', goal: 'maintain', daysPerWeek: 5 };
  assert.ok(tdee(office) > bmr(office) * 1.2 + 350, `tdee ${tdee(office)} includes training`);
  assert.ok(tdee({ ...office, daysPerWeek: 0 }) < tdee(office) - 350, 'no training → much lower');
  // a real plan drives the training term
  const plan = makePlan('2026-10-12');
  assert.ok(tdee(male, { plan }) !== tdee(male));
});

test('P0-1 trainingKcal: MET-style by type, minutes and bodyweight', () => {
  const hyrox = { type: 'hyrox', estMin: 60 };
  assert.equal(trainingKcal(hyrox, male), Math.round(60 * 80 * TRAINING_RATE.hyrox));
  assert.equal(trainingKcal({ type: 'strength', estMin: 45 }, male), Math.round(45 * 80 * 0.08));
  assert.equal(trainingKcal({ type: 'hyrox', estMin: 60 }, { ...male, weightKg: 60 }), Math.round(60 * 60 * 0.12), 'scales with bodyweight');
  // logged session: durationSec wins over estMin; run distance floor 0.9 kcal/kg/km
  assert.equal(trainingKcal({ type: 'run', durationSec: 1800 }, male), Math.round(30 * 80 * 0.10));
  assert.equal(trainingKcal({ type: 'run', durationSec: 1800, cardio: [{ mode: 'run', distanceM: 10000, timeSec: 1800 }] }, male), Math.round(0.9 * 80 * 10));
  assert.equal(trainingKcal(null, male), 0);
  assert.equal(sessionIntensity({ type: 'strength', blocks: [{ kind: 'emom' }] }), 'hard');
  assert.equal(sessionIntensity({ type: 'run', blocks: [{ kind: 'cardio' }] }), 'moderate');
  assert.equal(sessionIntensity({ type: 'recovery' }), 'easy');
});

// ---------------------------------------------------------------- targets
test('computeTargets: goal, protein, fat floor, carbs remainder, maintenance', () => {
  const m = computeTargets(male);
  assert.equal(m.maintenance, Math.round(tdee(male) / 10) * 10);
  assert.equal(m.kcal, Math.round(m.maintenance / 10) * 10);
  assert.equal(m.protein, 160);                                      // 2.0 g/kg
  assert.equal(m.fat, Math.round(Math.max(64, (0.2 * m.kcal) / 9)));
  assert.ok(Math.abs(m.protein * 4 + m.carbs * 4 + m.fat * 9 - m.kcal) <= 8);
  const lose = computeTargets({ ...male, goal: 'lose' });
  const defDef = Math.min(0.15 * lose.maintenance, (0.005 * 80 * 7700) / 7); // 5×/wk athlete: gentler of −15 % / 0.5 % BW
  assert.equal(lose.kcal, Math.max(Math.round((lose.maintenance - defDef) / 10) * 10, Math.round(kcalFloor(male) / 10) * 10));
  const casual = computeTargets({ ...male, goal: 'lose', daysPerWeek: 2 });
  assert.equal(casual.kcal, Math.max(Math.round((casual.maintenance * 0.8) / 10) * 10, Math.round(kcalFloor(male) / 10) * 10), 'non-athlete keeps −20 %');
  const gain = computeTargets({ ...male, goal: 'gain' });
  assert.equal(gain.kcal, Math.round((gain.maintenance * 1.1) / 10) * 10);
  for (const t of [m, gain]) assert.ok(t.carbs > 0);
});

test('P2 kcal floor ≥ max(1.2 × BMR, 1500 m / 1200 f)', () => {
  const tiny = { sex: 'f', age: 40, heightCm: 155, weightKg: 48, activity: 'sedentary', goal: 'lose', daysPerWeek: 3 };
  assert.equal(kcalFloor(tiny), Math.round(Math.max(1.2 * bmr(tiny), 1200)));
  const t = computeTargets(tiny);
  assert.ok(t.kcal >= kcalFloor(tiny), `${t.kcal} ≥ ${kcalFloor(tiny)}`);
  assert.ok(computeTargets({ ...male, weightKg: 50, heightCm: 160, activity: 'sedentary', goal: 'lose', daysPerWeek: 0 }).kcal >= 1500);
});

test('P1-2 cutting hybrid athletes keep ≥ 3.5 g/kg carbs, funded from fat then protein', () => {
  const cut = { sex: 'm', age: 32, heightCm: 180, weightKg: 82, activity: 'moderate', goal: 'lose', daysPerWeek: 5 };
  const t = computeTargets(cut);
  const ref = referenceWeight(cut);
  assert.ok(t.carbs >= 3.5 * ref - 1, `carbs ${t.carbs} ≥ ${3.5 * ref}`);
  assert.ok(t.fat >= Math.max(0.6 * ref, (0.2 * t.kcal) / 9) - 1, 'fat not below its floor');
  assert.ok(t.protein >= Math.round(1.8 * ref) - 1, 'protein ≥ 1.8 g/kg');
  // without the hybrid floor (2 days/wk) the old waterfall applies: protein stays 2.2 g/kg
  assert.equal(computeTargets({ ...cut, daysPerWeek: 2 }).protein, Math.round(2.2 * ref));
  // impossible case is flagged, not hidden
  const m = macrosForKcal(cut, 1500);
  assert.ok(m.notes.includes('carb-short'));
});

test('P1-3 protein/fat use the BMI-25 reference weight for high-BMI users', () => {
  const big = { sex: 'm', age: 40, heightCm: 178, weightKg: 120, activity: 'light', goal: 'lose', daysPerWeek: 4 };
  const ref = 25 * 1.78 ** 2; // 79.2
  near(referenceWeight(big), ref, 0.1);
  const t = computeTargets(big);
  assert.ok(t.protein <= Math.round(2.2 * ref) + 1, `protein ${t.protein} from ${ref} kg, not 120`);
  assert.ok(t.carbs / ref >= 3.4, 'carbs no longer squeezed to ~1 g/kg');
  assert.equal(referenceWeight(male), 80, 'normal BMI → actual weight');
});

test('P2 water includes training hours; fiber capped at 40 g', () => {
  const t0 = computeTargets(male, { trainingHours: 0 });
  assert.equal(t0.waterMl, 2800);                         // 35 × 80
  assert.equal(computeTargets(male, { trainingHours: 1 }).waterMl, 3300);
  assert.equal(computeTargets(male).waterMl, Math.round((2800 + 500 * (5 * 60) / 60 / 7) / 50) * 50, 'default: average daily training hours');
  assert.equal(fiberTarget(2000), 28);
  assert.equal(fiberTarget(4000), 40);
});

// ---------------------------------------------------------------- shared day targets (P0-2) & carb cycling (P1-1)
test('P0-2 dayTargetsFor: no plan & nothing logged → weekly-average day', () => {
  const targets = computeTargets(male);
  const s = { profile: male, targets, sessions: [], plan: null };
  const d = dayTargetsFor(s, '2026-10-12');
  assert.equal(d.dayType, null);
  assert.equal(d.kcal, targets.kcal);
  assert.equal(d.carbs, targets.carbs);
  assert.equal(d.protein, targets.protein);
  assert.equal(d.fiber, fiberTarget(targets.kcal));
});

test('P0-2 dayTargetsFor: a logged session (no plan) adds its energy above the assumed average', () => {
  const targets = computeTargets(male);
  const sess = { id: 's1', date: '2026-10-12', type: 'hyrox', title: 'Sim', durationSec: 75 * 60, sets: [], cardio: [] };
  const s = { profile: male, targets, sessions: [sess], plan: null };
  const d = dayTargetsFor(s, '2026-10-12');
  assert.equal(d.dayType, 'training');
  assert.equal(d.source, 'logged');
  const sk = trainingKcal(sess, male);
  near(d.kcal, targets.kcal + sk - targets.trainKcalAvg, 1);
  near(d.carbs, targets.carbs + (d.kcal - targets.kcal) / 4, 1, 'carbs carry the training energy');
  assert.equal(d.protein, targets.protein);
});

test('P0-2/P1-1 dayTargetsFor with a plan: training > rest, week averages exactly to targets.kcal', () => {
  const plan = makePlan('2026-10-12');
  const targets = computeTargets(male, { plan });
  const s = { profile: male, targets, sessions: [], plan };
  const hard = dayTargetsFor(s, '2026-10-12');   // hyrox
  const rest = dayTargetsFor(s, '2026-10-14');   // rest
  assert.equal(hard.dayType, 'training');
  assert.equal(hard.intensity, 'hard');
  assert.equal(hard.source, 'planned');
  assert.equal(rest.dayType, 'rest');
  assert.ok(hard.kcal > rest.kcal + 500, `${hard.kcal} vs ${rest.kcal}`);
  assert.ok(hard.carbs > rest.carbs);
  assert.ok(hard.waterMl > rest.waterMl, 'water follows training hours');
  const wk = weeklyTargets(s, '2026-10-15');
  assert.equal(wk.days.length, 7);
  near(wk.avgKcal, targets.kcal, 1, 'weekly balanced — no kcal creep');
  // a logged session replaces the planned one for that day
  const s2 = { ...s, sessions: [{ date: '2026-10-14', type: 'run', durationSec: 2400, cardio: [] }] };
  assert.equal(dayTargetsFor(s2, '2026-10-14').dayType, 'training');
});

test('P1-1 rest-day carb floor (3 g/kg) is funded from fat, kcal unchanged', () => {
  const plan = makePlan('2026-10-12');
  const lowCarb = { kcal: 2000, protein: 180, carbs: 150, fat: 100, waterMl: 3000, trainKcalAvg: 300 };
  const s = { profile: male, targets: lowCarb, sessions: [], plan };
  const rest = dayTargetsFor(s, '2026-10-14');
  const raw = 150 + (rest.kcal - 2000) / 4;
  assert.ok(rest.carbs > raw, 'floor raised carbs');
  assert.ok(rest.fat < 100, 'from fat');
  near(rest.protein * 4 + rest.carbs * 4 + rest.fat * 9, rest.protein * 4 + raw * 4 + 100 * 9, 6, 'same kcal');
});

test('P1-2 Peak eases a cut to −10 %, Taper to maintenance', () => {
  const cut = { ...male, goal: 'lose' };
  const plan = makePlan('2026-10-12', 3, undefined, ['build', 'peak', 'taper']);
  const targets = computeTargets(cut, { plan });
  const s = { profile: cut, targets, sessions: [], plan };
  const avg = (iso) => weeklyTargets(s, iso).avgKcal;
  near(avg('2026-10-12'), targets.kcal, 1);
  near(avg('2026-10-19'), targets.maintenance * 0.9, 15, 'peak');
  near(avg('2026-10-26'), targets.maintenance, 15, 'taper');
  assert.ok(dayTargetsFor(s, '2026-10-26').notes.includes('taper-maintenance'));
});

test('legacy dayTargets is weekly-neutral (5 training / 2 rest)', () => {
  const base = { kcal: 2500, protein: 180, carbs: 250, fat: 70, waterMl: 3000 };
  const tr = dayTargets(base, true), rest = dayTargets(base, false);
  assert.equal(tr.carbs, 275);
  assert.equal(rest.carbs, Math.round(250 - (25 * 5) / 2));
  near((5 * tr.kcal + 2 * rest.kcal) / 7, 2500, 2);
  assert.equal(dayTargets(base, null).kcal, 2500);
  assert.equal(base.carbs, 250, 'input not mutated');
});

// ---------------------------------------------------------------- adaptive TDEE (P1-8)
function synthState({ days = 28, startKg = 85, kgPerWeek = -0.5, intake = 2000, today = '2026-10-12', noise = 0, skipFood = 0, partial = 0, spike = 0, targetsKcal = 2400 } = {}) {
  const bodyweight = [], foodLog = {};
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  for (let i = days; i >= 0; i--) {
    const d = addDays(today, -i);
    let kg = startKg + (kgPerWeek / 7) * (days - i) + noise * rnd();
    if (spike && i < 4) kg += spike;
    bodyweight.push({ date: d, kg: Math.round(kg * 100) / 100 });
    if (i > 0 && (days - i) % 10 >= skipFood) {
      const isPartial = partial && (days - i) % Math.round(1 / partial) === 0;
      foodLog[d] = isPartial ? [{ id: 'p' + i, meal: 'breakfast', kcal: 450 }] : [{ id: 'x' + i, meal: 'lunch', kcal: intake / 2 }, { id: 'y' + i, meal: 'dinner', kcal: intake / 2 }];
    }
  }
  return { profile: { ...male, weightKg: startKg, goal: 'lose' }, targets: { kcal: targetsKcal, protein: 180, carbs: 230, fat: 70, auto: true }, bodyweight, foodLog, sessions: [] };
}

test('adaptiveTdee: −0.5 kg/week at 2000 kcal → ≈ 2550', () => {
  const r = adaptiveTdee(synthState(), '2026-10-12');
  near(r.tdee, 2550, 20, 'tdee');
  assert.equal(r.avgIntake, 2000);
  assert.equal(r.days, 28);
  assert.equal(r.confidence, 'high');
  near(r.weeklyChangeKg, -0.5, 0.02);
  assert.ok(r.trendKg.length >= 28);
});

test('P1-8 suggestion moves at most ±150 kcal per check-in, toward the goal', () => {
  const r = adaptiveTdee(synthState({ targetsKcal: 2400 }), '2026-10-12'); // ideal ≈ 0.8 × 2550 = 2040
  assert.ok(r.suggestion);
  assert.equal(r.suggestion.kcal, 2250);
  assert.equal(r.suggestion.capped, true);
  near(r.suggestion.ideal, Math.max(2040, kcalFloor(synthState().profile)), 20);
});

test('P1-8 goal rate (kg/week) drives the suggestion', () => {
  const s = synthState({ targetsKcal: 2200 });
  s.targets.goalRateKgWk = -0.25;
  const r = adaptiveTdee(s, '2026-10-12');
  near(r.suggestion?.ideal ?? 0, Math.round((2550 - (0.25 * 7700) / 7) / 10) * 10, 20);
  near(goalKcal(3000, { goal: 'lose', goalRateKgWk: -0.5, sex: 'm', weightKg: 80, heightCm: 180, age: 30 }), 2450, 1);
  near(goalKcal(3000, { goal: 'lose', goalRateKgWk: -2, sex: 'm', weightKg: 80, heightCm: 180, age: 30 }), 2250, 1, 'clamped at −25 %');
});

test('P1-8 partial-log days are excluded instead of dragging TDEE down', () => {
  const r = adaptiveTdee(synthState({ partial: 0.15 }), '2026-10-12');
  assert.ok(r.excludedDays >= 3, `excluded ${r.excludedDays}`);
  assert.equal(r.avgIntake, 2000);
  near(r.tdee, 2550, 30);
  // days the user flags are left out too
  const s = synthState();
  s.settings = { fuel: { incompleteDays: ['2026-10-11', '2026-10-10'] } };
  assert.equal(adaptiveTdee(s, '2026-10-12').excludedDays, 2);
});

test('P1-8 robust trend: a late water-weight spike barely moves the estimate', () => {
  const r = adaptiveTdee(synthState({ spike: 1.5 }), '2026-10-12');
  near(r.tdee, 2550, 120, 'spike');
  const noisy = adaptiveTdee(synthState({ noise: 1.2, kgPerWeek: 0.25, intake: 2800 }), '2026-10-12');
  near(noisy.tdee, 2800 - (0.25 / 7) * 7700, 250, 'noisy');
  const rt = robustTrend(Array.from({ length: 10 }, (_, x) => ({ x, y: x === 9 ? 40 : x + 1 })));
  near(rt.slope, 1, 0.01);
});

test('P1-8 short windows are blended with the formula', () => {
  const s = synthState({ days: 14 });
  s.targets.maintenance = 3000;
  const r = adaptiveTdee(s, '2026-10-12');
  near(r.tdee, Math.round((0.5 * r.dataTdee + 0.5 * 3000) / 10) * 10, 10);
  assert.notEqual(r.confidence, 'high');
});

test('adaptiveTdee: needs ≥ 14 days and enough logging', () => {
  const short = adaptiveTdee(synthState({ days: 10 }), '2026-10-12');
  assert.equal(short.tdee, null);
  assert.equal(short.suggestion, null);
  assert.match(short.reason, /14/);
  assert.equal(adaptiveTdee(synthState({ skipFood: 7 }), '2026-10-12').tdee, null);
  const empty = adaptiveTdee({ profile: male, targets: {} }, '2026-10-12');
  assert.equal(empty.tdee, null);
  assert.deepEqual(empty.trendKg, []);
});

test('weightTrend: EMA smooths and fills gaps', () => {
  const t = weightTrend([{ date: '2026-01-01', kg: 80 }, { date: '2026-01-05', kg: 84 }]);
  assert.equal(t.length, 5);
  assert.equal(t[0].kg, 80);
  assert.ok(t[4].kg > 80 && t[4].kg < 84);
  assert.deepEqual(weightTrend([]), []);
});

// ---------------------------------------------------------------- foods & scaling
test('scaleFood (+ alcohol and sodium when present)', () => {
  const food = { per100: { kcal: 165, p: 31, c: 0, f: 3.6, fiber: 0 } };
  assert.deepEqual(scaleFood(food, 200), { kcal: 330, p: 62, c: 0, f: 7.2, fiber: 0 });
  assert.deepEqual(scaleFood(food, 0), { kcal: 0, p: 0, c: 0, f: 0, fiber: 0 });
  assert.deepEqual(scaleFood({}, 100), { kcal: 0, p: 0, c: 0, f: 0, fiber: 0 });
  const beer = FOODS.find((f) => f.id === 'beer-regular');
  const b = scaleFood(beer, 356);
  near(b.alc, 13.5, 0.6, '12 oz 5 % beer ≈ 14 g alcohol');
  near(b.kcal, 4 * b.p + 4 * b.c + 9 * b.f + 7 * b.alc, 4, 'P2-8 alcohol reconciles kcal');
  const drink = FOODS.find((f) => f.id === 'sports-drink');
  near(scaleFood(drink, drink.serving.grams).na, 270, 5, 'P2-7 sodium');
});

test('P0-3 serving weights: edible portions, drained cans', () => {
  const g = (id) => FOODS.find((f) => f.id === id).serving.grams;
  assert.equal(g('chicken-drumstick-cooked'), 44);
  assert.equal(g('tuna-canned-water'), 116);
  assert.equal(g('tuna-canned-oil'), 116);
  assert.ok(g('cherries') >= 150, 'pitted');
  for (const f of FOODS) assert.ok(!/bone-in/i.test(f.serving.label) || /meat/.test(f.serving.label), 'bone-in label needs meat grams: ' + f.id);
});

// ---------------------------------------------------------------- search (P1-4)
test('P1-4 search: the 30 reviewer queries rank the intended food first', () => {
  const expected = {
    eggs: 'egg-whole', 'egg whites': 'egg-whites', chicken: 'chicken-breast-cooked', rice: 'white-rice-cooked', oatmeal: 'oatmeal-cooked',
    banana: 'banana', pb: 'peanut-butter', 'peanut butter': 'peanut-butter', 'greek yogurt': 'greek-yogurt-nonfat', 'protein shake': 'protein-shake-rtd',
    whey: 'whey-protein', bagel: 'bagel-plain', salmon: 'salmon-cooked', 'avocado toast': 'avocado-toast', 'chipotle bowl': 'burrito-bowl-chicken',
    coffee: 'coffee-black', 'oat milk latte': 'latte-oat', beer: 'beer-regular', gel: 'energy-gel', electrolyte: 'electrolyte-mix-sugar-free',
    'sweet potato': 'sweet-potato-baked', steak: 'sirloin-steak-cooked', pizza: 'pizza-cheese', burrito: 'burrito-chicken', almonds: 'almonds',
    'cottage cheese': 'cottage-cheese-2', tuna: 'tuna-canned-water', bread: 'bread-white', pasta: 'pasta-cooked', apple: 'apple',
  };
  assert.equal(Object.keys(expected).length, 30);
  const wrong = Object.entries(expected).filter(([q, id]) => searchFoods(q, FOODS, { limit: 1 })[0]?.id !== id)
    .map(([q, id]) => `${q} → ${searchFoods(q, FOODS, { limit: 1 })[0]?.id} (want ${id})`);
  assert.deepEqual(wrong, []);
});

test('search: matching rules', () => {
  const ids = (q, o) => searchFoods(q, FOODS, o).map((f) => f.id);
  assert.match(ids('chick')[0], /^chicken-/, 'chick → chicken first');
  assert.ok(ids('chick').includes('chickpeas'));
  assert.match(ids('greek yog')[0], /^greek-yogurt/);
  assert.ok(ids('chiken').some((id) => id.startsWith('chicken')), 'one typo tolerated');
  assert.ok(!ids('beer').some((id) => /beef/.test(id)), 'beer no longer fuzzy-matches beef');
  assert.ok(ids('gel')[0] !== 'gelato');
  assert.ok(ids('rxbar').includes('whole-food-bar'), 'tags searchable');
  assert.deepEqual(ids(''), []);
  assert.equal(ids('zzzqqq').length, 0);
  assert.ok(ids('tuna oil').every((id) => id.includes('tuna')), 'non-filler words must all match');
  assert.equal(ids('chick', { recent: ['chickpeas'] })[0], 'chickpeas', 'recents boost');
  const custom = [{ id: 'c1', name: 'Protein Bar', brand: 'Acme', serving: { label: '1 bar', grams: 60 }, per100: { kcal: 350, p: 33, c: 35, f: 10, fiber: 10 }, tags: [] }];
  assert.equal(searchFoods('acme', custom)[0].id, 'c1');
  assert.equal(searchFoods('chick', FOODS, { limit: 3 }).length, 3);
});

test('FOODS integrity', () => {
  assert.ok(FOODS.length >= 300, `${FOODS.length} foods`);
  const seen = new Set();
  for (const f of FOODS) {
    assert.match(f.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, f.id);
    assert.ok(!seen.has(f.id), 'duplicate id ' + f.id);
    seen.add(f.id);
    assert.ok(f.name && typeof f.name === 'string', f.id);
    assert.ok(f.serving && f.serving.label && f.serving.grams > 0, 'serving ' + f.id);
    assert.ok(Array.isArray(f.tags) && f.tags.length, 'tags ' + f.id);
    const { kcal, p, c, f: fat, fiber, alc = 0, na } = f.per100;
    for (const v of [kcal, p, c, fat, fiber, alc]) assert.ok(Number.isFinite(v) && v >= 0, 'finite ' + f.id);
    if (na != null) assert.ok(Number.isFinite(na) && na >= 0 && na <= 40000, 'sodium ' + f.id);
    assert.ok(p + c + fat <= 100.5, 'macros ≤ 100 g per 100 g: ' + f.id);
    assert.ok(fiber <= c + 0.01, 'fiber ≤ carbs: ' + f.id);
    // Atwater check (alcohol 7 kcal/g), allowing fibre at 0–2 kcal/g (USDA uses food-specific factors)
    const est = [4 * p + 4 * c + 9 * fat, 4 * p + 4 * (c - fiber) + 2 * fiber + 9 * fat, 4 * p + 4 * (c - fiber) + 9 * fat].map((e) => e + 7 * alc);
    assert.ok(est.some((e) => Math.abs(e - kcal) <= Math.max(8, kcal * 0.15)), `${f.id}: ${kcal} kcal vs ${est.map(Math.round).join('/')}`);
    if (f.tags.includes('alcohol')) assert.ok(alc > 0, 'alcohol grams ' + f.id);
  }
  for (const id of ['chicken-breast-cooked', 'chicken-thigh-cooked', 'beef-90-10-cooked', 'beef-80-20-cooked', 'salmon-cooked', 'tuna-canned-water',
    'shrimp-cooked', 'cod-cooked', 'egg-whole', 'egg-whites', 'tofu-firm', 'tempeh', 'greek-yogurt-nonfat', 'greek-yogurt-2', 'cottage-cheese-2',
    'whey-protein', 'casein-protein', 'plant-protein', 'beef-jerky', 'white-rice-cooked', 'brown-rice-cooked', 'jasmine-rice-cooked', 'oats-rolled-dry',
    'potato-baked', 'sweet-potato-baked', 'pasta-cooked', 'bagel-plain', 'tortilla-flour', 'quinoa-cooked', 'couscous-cooked', 'rice-cakes',
    'olive-oil', 'butter', 'avocado', 'peanut-butter', 'sports-drink', 'energy-gel', 'energy-chews', 'electrolyte-mix', 'recovery-shake',
    'whole-food-bar', 'energy-bar-oat', 'protein-bar-low-sugar', 'nut-bar', 'burrito-bowl-chicken', 'pizza-cheese', 'sushi-california-roll',
    'poke-bowl', 'coffee-black', 'latte-2', 'beer-regular', 'wine-red', 'cola', 'orange-juice']) {
    assert.ok(seen.has(id), 'missing staple ' + id);
  }
});

// ---------------------------------------------------------------- QA R1 P1-5 input bounds
test('QA quick add: kcal ≤ 5000, macros ≤ 500 g, numbers only, macros vs kcal', () => {
  assert.equal(validateQuickAdd({ kcal: '1e9' }).ok, false);
  assert.match(validateQuickAdd({ kcal: '1e9' }).errors.kcal, /5,000/);
  assert.equal(validateQuickAdd({ kcal: '?' }).errors.kcal, 'Enter a number');
  assert.equal(validateQuickAdd({ kcal: '-5' }).errors.kcal, 'Can’t be negative');
  assert.match(validateQuickAdd({ kcal: '300', p: '900' }).errors.p, /500/);
  assert.equal(validateQuickAdd({}).errors.kcal, 'Enter calories or macros');
  assert.deepEqual(validateQuickAdd({ p: '20', c: '30' }).value, { kcal: 200, p: 20, c: 30, f: 0 });
  assert.ok(validateQuickAdd({ kcal: '100', p: '50' }).errors.form, 'macros 200 kcal > 100 kcal');
  assert.ok(validateQuickAdd({ kcal: '450', p: '30', c: '40', f: '15' }).ok);
  assert.ok(validateQuickAdd({ kcal: '1,5' }).ok, 'decimal comma');
  assert.deepEqual(parseNum('abc'), { bad: true });
});

test('QA create food: serving ≥ 1 g, per-100 g kcal ≤ 900, macros physically consistent', () => {
  const r = validateCustomFood({ grams: '0.0001', kcal: '200' });
  assert.equal(r.ok, false);
  assert.match(r.errors.grams, /1 g/);
  assert.match(validateCustomFood({ grams: '5', kcal: '200' }).errors.kcal, /900/);
  assert.ok(validateCustomFood({ grams: '50', kcal: '200', p: '30', c: '30', fat: '20' }).errors.form, 'macros 80 g in a 50 g serving');
  assert.ok(validateCustomFood({ grams: '100', kcal: '100', p: '20', c: '20' }).errors.form, 'macros 160 kcal > 100 kcal');
  assert.ok(validateCustomFood({ grams: '100', kcal: '100', c: '10', fiber: '12' }).errors.fiber);
  assert.ok(validateCustomFood({ grams: '', kcal: '100' }).errors.grams);
  const ok = validateCustomFood({ grams: '80', kcal: '210', p: '18', c: '22', fat: '6', fiber: '3' });
  assert.ok(ok.ok);
  assert.deepEqual(ok.value.per100, { kcal: 262.5, p: 22.5, c: 27.5, f: 7.5, fiber: 3.8 });
  assert.ok(validateCustomFood({ grams: '40', p: '10', c: '20', fat: '5' }).ok, 'kcal from macros when blank');
});

test('QA water ≤ 5 L per add; amounts must be > 0 and ≤ 5 kg', () => {
  assert.equal(validateWaterMl(250).ok, true);
  assert.equal(validateWaterMl(99999 * 29.5735).ok, false);
  assert.equal(validateWaterMl(0).ok, false);
  assert.equal(validateWaterMl(NaN).ok, false);
  assert.equal(validateWaterMl(LIMITS.waterMaxMl).ok, true);
  assert.equal(amountError(-3 * 40), 'Enter an amount above 0');
  assert.equal(amountError(0), 'Enter an amount above 0');
  assert.match(amountError(6000), /5 kg/);
  assert.equal(amountError(80), null);
  assert.equal(amountError(80, '?'), 'Enter a number');
});

// ---------------------------------------------------------------- R2
test('R2 P1-1 every day ≥ kcal floor; re-balanced from training days when there is headroom', () => {
  const plan = makePlan('2026-10-12');
  // sedentary 82 kg male: floor 1.2 × BMR ≈ 2148; a 2400 weekly-average target puts rest days at ~2000
  const m82 = { sex: 'm', age: 32, heightCm: 180, weightKg: 82, activity: 'sedentary', goal: 'lose', daysPerWeek: 5 };
  const fl = kcalFloor(m82);
  const s = { profile: m82, targets: { kcal: 2400, protein: 170, carbs: 280, fat: 60, waterMl: 3000, trainKcalAvg: 400 }, sessions: [], plan };
  const wk = weeklyTargets(s, '2026-10-12');
  for (const d of wk.days) assert.ok(d.kcal >= fl, `${d.date} ${d.kcal} ≥ ${fl}`);
  const rest = wk.days.filter((d) => d.dayType === 'rest');
  assert.ok(rest.every((d) => d.kcal === fl && d.notes.includes('kcal-floor-day')), 'rest days raised to the floor');
  near(wk.avgKcal, 2400, 2, 'week still averages to target');
  // a big athlete with plenty of headroom is unaffected
  const big = computeTargets(male, { plan });
  assert.ok(weeklyTargets({ profile: male, targets: big, sessions: [], plan }, '2026-10-12').days.every((d) => !d.notes.includes('kcal-floor-day')));
});

test('R2 P1-1 when the goal sits at the floor, safety wins: training days stay fuelled', () => {
  const f55 = { sex: 'f', age: 30, heightCm: 160, weightKg: 55, activity: 'sedentary', goal: 'lose', daysPerWeek: 5 };
  const plan = makePlan('2026-10-12');
  const targets = computeTargets(f55, { plan });
  const s = { profile: f55, targets, sessions: [], plan };
  const fl = kcalFloor(f55);
  const wk = weeklyTargets(s, '2026-10-12');
  for (const d of wk.days) assert.ok(d.kcal >= fl, `${d.date} ${d.kcal} ≥ ${fl}`);
  const restMax = Math.max(...wk.days.filter((d) => d.dayType === 'rest').map((d) => d.kcal));
  for (const d of wk.days.filter((x) => x.dayType === 'training' && x.trainingKcal >= 250)) assert.ok(d.kcal > restMax + 50, `${d.date} ${d.kcal} still fuels training (rest ${restMax})`);
  assert.ok(wk.avgKcal >= targets.kcal, 'average may rise above target rather than under-fuel');
  // no plan, logged short session: floor still applies
  const s3 = { profile: f55, targets: { ...targets, kcal: fl }, sessions: [{ date: '2026-10-13', type: 'recovery', durationSec: 600 }], plan: null };
  assert.ok(dayTargetsFor(s3, '2026-10-13').kcal >= fl);
});

test('R2 P1-2 default cut for ≥ 4×/wk athletes is the gentler of −15 % / 0.5 % BW per week; EA is reported', () => {
  const ath = { sex: 'm', age: 32, heightCm: 180, weightKg: 82, activity: 'moderate', goal: 'lose', daysPerWeek: 5 };
  const M = 2800;
  near(defaultDeficit(ath, M), Math.min(420, (0.005 * 82 * 7700) / 7), 0.5);
  near(goalKcal(M, ath), Math.round((M - defaultDeficit(ath, M)) / 10) * 10, 1);
  near(defaultDeficit({ ...ath, daysPerWeek: 3 }, M), 560, 0.5, 'non-athletes keep −20 %');
  // FFM from BMI (Deurenberg): 82 kg / 180 cm / 32 y male ≈ 19 % fat
  const ffm = fatFreeMass(ath);
  assert.ok(ffm > 62 && ffm < 70, `ffm ${ffm}`);
  assert.ok(fatFreeMass({ ...ath, sex: 'f' }) < ffm, 'women: lower FFM at the same BMI');
  const plan = makePlan('2026-10-12');
  const s = { profile: ath, targets: computeTargets(ath, { plan }), sessions: [], plan };
  const ea = energyAvailability(s, '2026-10-12');
  near(ea.ea, (dayTargetsFor(s, '2026-10-12').kcal - ea.exerciseKcal) / ea.ffm, 0.11);
  assert.equal(ea.low, ea.ea < 30);
  assert.equal(energyAvailability(s, '2026-10-12', 1200).low, true, 'eating 1200 on a hard day is low EA');
  // an aggressive explicit rate surfaces low-ea in the targets
  assert.ok(computeTargets({ ...ath, goalRateKgWk: -0.8 }, { plan }).notes.includes('low-ea'));
});

test('R2 P1-3 sodium summary reports coverage; Open Food Facts sodium is parsed', () => {
  const full = sodiumSummary([{ kcal: 300, na: 400 }, { kcal: 200, na: 100 }]);
  assert.deepEqual(full, { mg: 500, known: 2, total: 2, kcalShare: 1, complete: true });
  const part = sodiumSummary([{ kcal: 600 }, { kcal: 200, na: 300 }, { kcal: 100 }]);
  assert.equal(part.complete, false);
  assert.equal(part.known, 1);
  assert.equal(part.total, 3);
  near(part.kcalShare, 0.22, 0.01);
  assert.equal(sodiumSummary([]).complete, false);
  // staples now carry USDA sodium
  const withNa = FOODS.filter((f) => f.per100.na != null).length;
  assert.ok(withNa >= FOODS.length * 0.8, `${withNa}/${FOODS.length} foods have sodium`);
});

test('R2 P1-4 goal rates are capped at what the target can deliver', () => {
  const ath = { sex: 'm', age: 32, heightCm: 180, weightKg: 82, activity: 'moderate', goal: 'lose', daysPerWeek: 5 };
  const M = 2780;
  const cap = maxGoalRate(ath, M);
  near(cap, Math.min((Math.min(0.25 * M, M - kcalFloor(ath)) * 7) / 7700, 0.82), 0.001);
  // 1.5 lb and 2 lb used to give the same target: now any rate beyond the cap is the cap
  const at = (r) => goalKcal(M, { ...ath, goalRateKgWk: r });
  assert.equal(at(-0.68), at(-0.907));
  assert.equal(at(-cap), at(-0.907));
  assert.ok(at(-0.25) > at(-0.5), 'deliverable rates still differ');
  near(at(-cap), Math.max(Math.round((M - (cap * 7700) / 7) / 10) * 10, kcalFloor(ath)), 10);
  const gainCap = maxGoalRate({ ...ath, goal: 'gain' }, M);
  near(gainCap, Math.min((0.15 * M * 7) / 7700, 0.41), 0.001);
});

test('R2 P2 search phrasing: fillet / pan-seared / plurals / cooking methods', () => {
  const top = (q) => searchFoods(q, FOODS, { limit: 1 })[0]?.id;
  assert.equal(top('salmon fillet'), 'salmon-cooked');
  assert.equal(top('pan-seared salmon'), 'salmon-cooked');
  assert.equal(top('potatoes'), 'potato-baked');
  assert.equal(top('roasted potatoes'), 'roasted-potatoes');
  assert.equal(top('mashed potatoes'), 'mashed-potatoes');
  assert.equal(top('grilled chicken'), 'chicken-breast-cooked');
  assert.equal(top('fried egg'), 'egg-fried');
  assert.ok(searchFoods('grilled', FOODS).length > 0, 'a lone cooking word still searches');
});

test('R2 P2 fuelingNote: pre-session carbs, long-session advice, carb-short warning', () => {
  const plan = makePlan('2026-10-12');
  const s = { profile: male, targets: computeTargets(male, { plan }), sessions: [], plan };
  const n = fuelingNote(s, '2026-10-12'); // hyrox 60 min
  assert.ok(n);
  assert.equal(n.intensity, 'hard');
  assert.deepEqual(n.carbsG, [80, 120]);
  assert.match(n.pre, /1–1\.5 g\/kg/);
  assert.equal(n.during, null);
  assert.equal(fuelingNote(s, '2026-10-14'), null, 'rest day');
  const long = { ...s, sessions: [{ date: '2026-10-14', type: 'run', title: 'Long run', durationSec: 95 * 60 }] };
  assert.match(fuelingNote(long, '2026-10-14').during, /30–60 g/);
  const lowCarb = { ...s, targets: { kcal: 1700, protein: 200, carbs: 120, fat: 60, waterMl: 3000, trainKcalAvg: 300 } };
  assert.match(fuelingNote(lowCarb, '2026-10-12').warn || '', /below the 5 g\/kg/);
});

test('R2 P2 adaptive: a late step change is excluded and lowers confidence', () => {
  const r = adaptiveTdee(synthState({ spike: 1.5 }), '2026-10-12');
  near(r.tdee, 2550, 60, 'spike');
  assert.equal(r.stepGuard, true);
  assert.notEqual(r.confidence, 'high');
  assert.equal(adaptiveTdee(synthState(), '2026-10-12').stepGuard, false);
});

test('R2 P2 fat ≥ 25 % when gaining; water from reference weight', () => {
  const g = computeTargets({ ...male, goal: 'gain', activity: 'athlete', daysPerWeek: 6, weightKg: 95, heightCm: 185 });
  assert.ok(g.fat * 9 >= g.kcal * 0.25 - 9);
  const big = { sex: 'm', age: 40, heightCm: 178, weightKg: 120, activity: 'light', goal: 'lose', daysPerWeek: 4 };
  const t = computeTargets(big, { trainingHours: 0 });
  assert.equal(t.waterMl, Math.round((35 * referenceWeight(big)) / 50) * 50);
});
