// node --test forge/tests/nutrition.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bmr, tdee, computeTargets, dayTargets, adaptiveTdee, scaleFood, searchFoods, macrosForKcal, weightTrend, ACTIVITY_FACTORS,
} from '../js/engine/nutrition.js';
import { FOODS } from '../js/data/foods.js';

const male = { sex: 'm', age: 30, heightCm: 180, weightKg: 80, activity: 'moderate', goal: 'maintain' };
const female = { sex: 'f', age: 40, heightCm: 165, weightKg: 60, activity: 'light', goal: 'maintain' };

const addDays = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

test('bmr: Mifflin-St Jeor known values', () => {
  assert.equal(bmr(male), 1780);           // 800 + 1125 − 150 + 5
  assert.equal(bmr(female), 1270);         // 600 + 1031.25 − 200 − 161 = 1270.25
});

test('tdee: activity factors', () => {
  assert.deepEqual(ACTIVITY_FACTORS, { sedentary: 1.2, light: 1.375, moderate: 1.55, very: 1.725, athlete: 1.9 });
  assert.equal(tdee(male), Math.round(1780 * 1.55));
  assert.equal(tdee({ ...male, activity: 'athlete' }), Math.round(1780 * 1.9));
  assert.equal(tdee({ ...male, activity: 'sedentary' }), Math.round(1780 * 1.2));
  assert.equal(tdee(female), Math.round(1270 * 1.375));
  assert.equal(tdee({ ...male, activity: 'nonsense' }), Math.round(1780 * 1.55), 'unknown activity → moderate');
});

test('computeTargets: goals, protein, fat floor, carbs remainder', () => {
  const m = computeTargets(male);
  assert.equal(m.kcal, 2760);              // 2759 → nearest 10
  assert.equal(m.protein, 160);            // 2.0 g/kg
  assert.equal(m.fat, Math.round(Math.max(64, (0.2 * 2760) / 9)));   // 61 vs 64 → 64
  assert.equal(m.carbs, Math.round((2760 - 160 * 4 - 64 * 9) / 4));
  assert.equal(m.waterMl, 3300);           // 35 × 80 + 500 (1 h training)

  const lose = computeTargets({ ...male, goal: 'lose' });
  assert.equal(lose.kcal, Math.round((2759 * 0.8) / 10) * 10);
  assert.equal(lose.protein, 176);         // 2.2 g/kg when cutting

  const gain = computeTargets({ ...male, goal: 'gain' });
  assert.equal(gain.kcal, Math.round((2759 * 1.1) / 10) * 10);

  // fat floor is 20 % of kcal when that beats 0.8 g/kg
  const light = computeTargets({ ...male, weightKg: 55, activity: 'athlete', goal: 'gain' });
  assert.ok(light.fat * 9 >= light.kcal * 0.2 - 9);
  assert.ok(light.fat >= Math.round(0.8 * 55));

  // macros add up to kcal (within rounding)
  for (const t of [m, lose, gain, light]) assert.ok(Math.abs(t.protein * 4 + t.carbs * 4 + t.fat * 9 - t.kcal) <= 8);

  assert.equal(computeTargets(male, { trainingHours: 2 }).waterMl, 3800);
});

test('computeTargets: kcal floor at BMR × 1.1', () => {
  const tiny = { sex: 'f', age: 70, heightCm: 150, weightKg: 45, activity: 'sedentary', goal: 'lose' };
  const t = computeTargets(tiny);
  assert.ok(t.kcal >= bmr(tiny) * 1.1 - 5, `${t.kcal} ≥ ${bmr(tiny) * 1.1}`);
  assert.ok(t.carbs >= 0);
});

test('computeTargets: tolerates missing / junk profile', () => {
  const t = computeTargets({});
  for (const k of ['kcal', 'protein', 'carbs', 'fat', 'waterMl']) assert.ok(Number.isFinite(t[k]) && t[k] > 0, k);
  assert.doesNotThrow(() => computeTargets({ weightKg: 'abc', age: null }));
});

test('dayTargets: carb cycling ±10 % with kcal shift', () => {
  const base = { kcal: 2500, protein: 180, carbs: 250, fat: 70, waterMl: 3000, auto: true };
  const tr = dayTargets(base, true);
  assert.equal(tr.carbs, 275);
  assert.equal(tr.kcal, 2600);
  assert.equal(tr.protein, 180);
  assert.equal(tr.dayType, 'training');
  const rest = dayTargets(base, false);
  assert.equal(rest.carbs, 225);
  assert.equal(rest.kcal, 2400);
  assert.equal(rest.fat, 70);
  const none = dayTargets(base, null);
  assert.equal(none.kcal, 2500);
  assert.equal(base.carbs, 250, 'input not mutated');
});

function synthState({ days = 28, startKg = 85, kgPerWeek = -0.5, intake = 2000, today = '2026-10-12', noise = 0, skipFood = 0 } = {}) {
  const bodyweight = [], foodLog = {};
  let seed = 1;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  for (let i = days; i >= 0; i--) {
    const d = addDays(today, -i);
    const kg = startKg + (kgPerWeek / 7) * (days - i) + noise * rnd();
    bodyweight.push({ date: d, kg: Math.round(kg * 100) / 100 });
    if (i > 0 && (days - i) % 10 >= skipFood) foodLog[d] = [{ id: 'x' + i, meal: 'lunch', kcal: intake / 2 }, { id: 'y' + i, meal: 'dinner', kcal: intake / 2 }];
  }
  return { profile: { ...male, weightKg: startKg, goal: 'lose' }, targets: { kcal: 2400, protein: 180, carbs: 230, fat: 70, auto: true }, bodyweight, foodLog };
}

test('adaptiveTdee: −0.5 kg/week at 2000 kcal → ≈ 2550', () => {
  const r = adaptiveTdee(synthState(), '2026-10-12');
  assert.ok(Math.abs(r.tdee - 2550) <= 30, `tdee ${r.tdee}`);
  assert.equal(r.avgIntake, 2000);
  assert.equal(r.days, 28);
  assert.equal(r.confidence, 'high');
  assert.ok(Math.abs(r.weeklyChangeKg + 0.5) < 0.02);
  assert.ok(r.suggestion, 'suggests a change');
  assert.equal(r.suggestion.kcal, Math.round((r.tdee * 0.8) / 10) * 10, 'lose goal → −20 % of measured TDEE');
  assert.ok(r.trendKg.length >= 28);
});

test('adaptiveTdee: noisy daily weights still land close', () => {
  const r = adaptiveTdee(synthState({ noise: 1.2, kgPerWeek: 0.25, intake: 2800 }), '2026-10-12');
  const expected = 2800 - (0.25 / 7) * 7700; // 2525
  assert.ok(Math.abs(r.tdee - expected) < 250, `tdee ${r.tdee} vs ${expected}`);
});

test('adaptiveTdee: needs ≥ 14 days and enough logging', () => {
  const short = adaptiveTdee(synthState({ days: 10 }), '2026-10-12');
  assert.equal(short.tdee, null);
  assert.equal(short.suggestion, null);
  assert.match(short.reason, /14/);
  const sparse = adaptiveTdee(synthState({ skipFood: 7 }), '2026-10-12');
  assert.equal(sparse.tdee, null);
  const empty = adaptiveTdee({ profile: male, targets: {} }, '2026-10-12');
  assert.equal(empty.tdee, null);
  assert.deepEqual(empty.trendKg, []);
});

test('adaptiveTdee: maintenance with matching target → no suggestion', () => {
  const s = synthState({ kgPerWeek: 0, intake: 2600 });
  s.profile.goal = 'maintain';
  s.targets.kcal = 2600;
  const r = adaptiveTdee(s, '2026-10-12');
  assert.equal(r.tdee, 2600);
  assert.equal(r.suggestion, null);
});

test('weightTrend: EMA smooths and fills gaps', () => {
  const t = weightTrend([{ date: '2026-01-01', kg: 80 }, { date: '2026-01-05', kg: 84 }]);
  assert.equal(t.length, 5);
  assert.equal(t[0].kg, 80);
  assert.ok(t[4].kg > 80 && t[4].kg < 84, 'lags the raw value');
  assert.deepEqual(weightTrend([]), []);
});

test('macrosForKcal follows §5 rules', () => {
  const m = macrosForKcal(male, 2000);
  assert.equal(m.protein, 160);
  assert.equal(m.fat, 64);
  assert.equal(m.carbs, Math.round((2000 - 640 - 576) / 4));
});

test('scaleFood', () => {
  const food = { per100: { kcal: 165, p: 31, c: 0, f: 3.6, fiber: 0 } };
  assert.deepEqual(scaleFood(food, 200), { kcal: 330, p: 62, c: 0, f: 7.2, fiber: 0 });
  assert.deepEqual(scaleFood(food, 0), { kcal: 0, p: 0, c: 0, f: 0, fiber: 0 });
  assert.equal(scaleFood(food, 112).kcal, 185);
  assert.deepEqual(scaleFood({}, 100), { kcal: 0, p: 0, c: 0, f: 0, fiber: 0 });
});

test('searchFoods: ranking and matching', () => {
  const ids = (q, o) => searchFoods(q, FOODS, o).map((f) => f.id);
  assert.match(ids('chick')[0], /^chicken-/, 'chick → chicken first');
  assert.ok(ids('chick').includes('chickpeas'));
  assert.match(ids('greek yog')[0], /^greek-yogurt/);
  assert.equal(ids('banana')[0], 'banana');
  assert.ok(ids('eggs').includes('egg-whole'), 'plural matches singular');
  assert.ok(ids('chiken').some((id) => id.startsWith('chicken')), 'one typo tolerated');
  assert.ok(ids('brown rice')[0] === 'brown-rice-cooked');
  assert.ok(ids('rxbar').includes('whole-food-bar'), 'tags searchable');
  assert.deepEqual(ids(''), []);
  assert.deepEqual(ids('   '), []);
  assert.equal(ids('zzzqqq').length, 0);
  // all tokens must match
  assert.ok(ids('salmon cooked').every((id) => id.includes('salmon')));
  // recents boost
  const rec = ids('chick', { recent: ['chickpeas'] });
  assert.equal(rec[0], 'chickpeas');
  // custom foods with brand
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
    const { kcal, p, c, f: fat, fiber } = f.per100;
    for (const v of [kcal, p, c, fat, fiber]) assert.ok(Number.isFinite(v) && v >= 0, 'finite ' + f.id);
    assert.ok(p + c + fat <= 100.5, 'macros ≤ 100 g per 100 g: ' + f.id);
    assert.ok(fiber <= c + 0.01, 'fiber ≤ carbs: ' + f.id);
    if (f.tags.includes('alcohol')) { assert.ok(kcal >= 4 * p + 4 * c, 'alcohol adds kcal ' + f.id); continue; }
    // Atwater check, allowing fibre at 0–2 kcal/g (USDA uses food-specific factors)
    const est = [4 * p + 4 * c + 9 * fat, 4 * p + 4 * (c - fiber) + 2 * fiber + 9 * fat, 4 * p + 4 * (c - fiber) + 9 * fat];
    const ok = est.some((e) => Math.abs(e - kcal) <= Math.max(8, kcal * 0.15));
    assert.ok(ok, `${f.id}: ${kcal} kcal vs ${est.map(Math.round).join('/')}`);
  }
  // required staples present
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
