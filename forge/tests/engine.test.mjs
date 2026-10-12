// Engine unit tests: node --test forge/tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, daysBetween } from '../js/store.js';
import { EXERCISES, getExercise, hasExercise } from '../js/data/exercises.js';
import { PHASES, generatePlan, getWorkout, workoutForDate, TEMPLATES } from '../js/engine/program.js';
import { ownedBells, pairedBells, suggestWeight, tooHeavy, liveItemWeight, liveItemAdvice, lastPerformance, scaleWorkout, detectPRs, trainingLoad, weekSummary, streak } from '../js/engine/coach.js';
import { STATIONS, paces, hrZones, defaultHrMax, readinessScore, predictRace, hyroxReadiness } from '../js/engine/hyrox.js';

const START = '2026-10-12';
const PROFILE = {
  name: 'Test', sex: 'm', age: 35, heightCm: 178, weightKg: 82, units: 'imperial', experience: 'intermediate',
  bells: [{ kg: 16, count: 2 }, { kg: 24, count: 2 }, { kg: 32, count: 1 }],
  equipment: { row: false, ski: false, bike: false, pullup: false, sandbag: false, wallball: false },
  daysPerWeek: 5, raceDate: null, division: 'open', goal: 'lose', activity: 'moderate', hrMax: null, fiveKSec: null,
};
const MINIMAL = { ...PROFILE, sex: 'f', weightKg: 64, experience: 'beginner', bells: [{ kg: 16, count: 1 }], equipment: {} };
const MAIN = new Set(['strength', 'emom', 'amrap', 'intervals', 'circuit', 'cardio', 'station']);

const allItems = (w) => w.blocks.flatMap((b) => b.items || []);
const planWorkouts = (plan) => plan.weeks.flatMap((wk) => wk.days.filter((d) => d.workoutId).map((d) => plan.workouts[d.workoutId]));

function checkPlan(plan, profile, start = START) {
  const owned = ownedBells(profile);
  let i = 0;
  for (const wk of plan.weeks) {
    assert.ok(PHASES[wk.phase], `phase ${wk.phase}`);
    assert.equal(wk.days.length, 7);
    for (const d of wk.days) {
      assert.equal(d.date, addDays(start, i++), 'consecutive dates');
      assert.equal(d.rest, !d.workoutId);
      if (d.workoutId) {
        assert.match(d.workoutId, /^w\d+-d[1-7]$/);
        const w = getWorkout(plan, d.workoutId);
        assert.ok(w, `workout ${d.workoutId}`);
        assert.equal(w.id, d.workoutId);
        assert.ok(w.estMin >= 10 && w.estMin <= 200, `${w.id} estMin ${w.estMin}`);
        const kinds = w.blocks.map((b) => b.kind);
        assert.equal(kinds[0], 'warmup', `${w.id} warmup first`);
        assert.equal(kinds[kinds.length - 1], 'cooldown', `${w.id} cooldown last`);
        assert.ok(kinds.some((k) => MAIN.has(k)), `${w.id} has a main block`);
        for (const it of allItems(w)) {
          assert.ok(hasExercise(it.exId), `${w.id}: unknown exId ${it.exId}`);
          if (getExercise(it.exId).category === 'kb' && it.kg != null) assert.ok(owned.includes(it.kg), `${w.id}: ${it.exId} @${it.kg} not owned`);
        }
      }
    }
  }
  assert.equal(plan.weeks[plan.weeks.length - 1].phase, 'taper', 'taper last week');
}

for (const days of [3, 4, 5, 6]) {
  test(`plan: ${days} days/week, no race date → 12 weeks with full weekly coverage`, () => {
    const profile = { ...PROFILE, daysPerWeek: days };
    const plan = generatePlan(profile, START);
    assert.equal(plan.weeks.length, 12);
    assert.equal(plan.startDate, START);
    assert.equal(plan.raceDate, addDays(START, 83));
    checkPlan(plan, profile);
    assert.ok(plan.weeks.some((w) => w.deload), 'deloads present');
    for (const wk of plan.weeks.slice(0, -1)) {
      if (wk.deload) continue;
      assert.equal(wk.days.filter((d) => d.workoutId).length, days, `week ${wk.index + 1} session count`);
      const ws = wk.days.filter((d) => d.workoutId).map((d) => plan.workouts[d.workoutId]);
      const blocks = ws.flatMap((w) => w.blocks);
      const items = ws.flatMap(allItems);
      assert.ok(ws.some((w) => w.type === 'strength' && w.blocks.some((b) => b.kind === 'strength')), `week ${wk.index + 1} heavy KB day`);
      assert.ok(blocks.some((b) => ['emom', 'amrap', 'circuit'].includes(b.kind) && b.items.some((it) => getExercise(it.exId).category === 'kb')), `week ${wk.index + 1} KB conditioning`);
      assert.ok(items.some((it) => ['run-easy', 'run-long'].includes(it.exId) && it.timeSec >= 900), `week ${wk.index + 1} Zone 2 run`);
      assert.ok(blocks.some((b) => b.kind === 'intervals' || b.items.some((it) => ['run-tempo', 'run-threshold'].includes(it.exId))), `week ${wk.index + 1} quality run`);
      if (wk.phase === 'build' || wk.phase === 'peak') assert.ok(ws.some((w) => w.type === 'hybrid' || w.type === 'hyrox'), `week ${wk.index + 1} compromised running`);
    }
    const last = plan.weeks[plan.weeks.length - 1];
    assert.equal(last.days[6].date, plan.raceDate);
    assert.ok(plan.workouts[last.days[6].workoutId].type === 'hyrox');
  });
}

test('plan: progressive overload from week 1 to late build (run volume, bell or density)', () => {
  const plan = generatePlan(PROFILE, START);
  const minutes = (wk, ids) => plan.weeks[wk].days.filter((d) => d.workoutId).flatMap((d) => allItems(plan.workouts[d.workoutId]))
    .filter((it) => ids.includes(it.exId)).reduce((a, it) => a + (it.timeSec || 0) * (it.sets || 1), 0);
  assert.ok(minutes(8, ['run-long']) > minutes(0, ['run-long']), 'long run grows');
  const sq = (wk) => plan.weeks[wk].days.filter((d) => d.workoutId).map((d) => plan.workouts[d.workoutId]).filter((w) => w.type === 'strength')
    .flatMap(allItems).find((it) => /front-squat|goblet-squat/.test(it.exId) && it.sets);
  assert.ok(sq(8).kg > sq(0).kg || sq(8).reps * sq(8).sets > sq(0).reps * sq(0).sets, 'squat progresses');
  const titles = new Set(planWorkouts(plan).map((w) => w.title));
  assert.ok(titles.size >= 25, `varied titles (${titles.size})`);
});

test('plan: short 4-week race block ends with taper and race day', () => {
  const race = addDays(START, 26);
  const plan = generatePlan({ ...PROFILE, raceDate: race }, START);
  assert.equal(plan.weeks.length, 4);
  checkPlan(plan, PROFILE);
  const r = workoutForDate(plan, race);
  assert.equal(r.workout.title, 'HYROX Race Day');
  assert.equal(r.week.phase, 'taper');
  assert.deepEqual(plan.weeks.map((w) => w.phase), ['base', 'build', 'peak', 'taper']);
});

test('plan: race < 4 weeks out still yields a 4-week plan with race inside', () => {
  const race = addDays(START, 10);
  const plan = generatePlan({ ...PROFILE, raceDate: race }, START);
  assert.equal(plan.weeks.length, 4);
  assert.equal(workoutForDate(plan, race).workout.title, 'HYROX Race Day');
  assert.ok(plan.weeks.slice(2).every((w) => w.phase === 'base'), 'post-race weeks are recovery/base');
});

test('plan: long 30-week race date → general prep first, taper last', () => {
  const race = addDays(START, 30 * 7 - 1);
  const plan = generatePlan({ ...PROFILE, raceDate: race, daysPerWeek: 4 }, START);
  assert.equal(plan.weeks.length, 30);
  checkPlan(plan, { ...PROFILE, daysPerWeek: 4 });
  assert.match(plan.weeks[0].focus, /General prep/);
  assert.ok(plan.weeks.filter((w) => w.deload).length >= 5);
  assert.equal(plan.weeks.filter((w) => w.phase === 'peak').length, 3);
  assert.equal(workoutForDate(plan, race).workout.title, 'HYROX Race Day');
});

test('plan: 24-week race date', () => {
  const plan = generatePlan({ ...PROFILE, raceDate: addDays(START, 24 * 7 - 1), daysPerWeek: 6 }, START);
  assert.equal(plan.weeks.length, 24);
  checkPlan(plan, { ...PROFILE, daysPerWeek: 6 });
});

test('plan: minimal equipment (one 16 kg bell, no ergs) uses only what the athlete owns', () => {
  for (const days of [3, 5]) {
    const profile = { ...MINIMAL, daysPerWeek: days };
    const plan = generatePlan(profile, START);
    checkPlan(plan, profile);
    for (const w of planWorkouts(plan)) {
      if (w.title === 'HYROX Race Day') continue;
      for (const it of allItems(w)) {
        const ex = getExercise(it.exId);
        assert.ok(!['erg-row', 'erg-ski', 'erg-bike', 'hx-ski', 'hx-row', 'hx-sled-push', 'hx-sled-pull', 'hx-wall-balls', 'hx-sandbag-lunge', 'bw-pullup'].includes(it.exId), `${w.id} uses ${it.exId}`);
        if (ex.category === 'kb') { assert.ok(!ex.double, `${w.id}: double-bell ${it.exId} without a pair`); if (it.kg != null) assert.equal(it.kg, 16); }
      }
    }
  }
});

test('plan: equipment owned → real ergs/implements used', () => {
  const profile = { ...PROFILE, equipment: { row: true, ski: true, bike: false, pullup: true, sandbag: true, wallball: true } };
  const plan = generatePlan(profile, START);
  const ids = new Set(planWorkouts(plan).flatMap(allItems).map((it) => it.exId));
  for (const id of ['erg-ski', 'erg-row', 'hx-wall-balls', 'hx-sandbag-lunge', 'bw-pullup']) assert.ok(ids.has(id), id);
});

test('plan: pace notes follow units and HR zones', () => {
  const imp = generatePlan({ ...PROFILE, fiveKSec: 1500 }, START);
  const met = generatePlan({ ...PROFILE, fiveKSec: 1500, units: 'metric' }, START);
  const note = (plan) => planWorkouts(plan).flatMap(allItems).find((it) => it.exId === 'run-long').note;
  assert.match(note(imp), /\/mi/);
  assert.match(note(met), /\/km/);
  assert.match(note(met), /bpm/);
});

test('getWorkout / workoutForDate / TEMPLATES', () => {
  const plan = generatePlan(PROFILE, START);
  const r = workoutForDate(plan, START);
  assert.equal(r.day.date, START);
  assert.ok(r.workout);
  assert.deepEqual(workoutForDate(plan, '1999-01-01'), { day: null, week: null, workout: null });
  assert.equal(getWorkout(plan, 'nope'), null);
  assert.equal(getWorkout(null, 'free').id, 't-free');
  assert.ok(getWorkout(plan, 't-full-sim').blocks.length > 10);
  const ids = TEMPLATES.map((t) => t.id);
  for (const id of ['t-1k-tt', 't-5k-tt', 't-swing-test', 't-station-benchmark', 't-full-sim', 't-half-sim', 't-kb-finisher', 't-recovery-flow', 't-free']) assert.ok(ids.includes(id), id);
  for (const t of TEMPLATES) {
    assert.match(t.id, /^t-/);
    for (const it of allItems(t)) assert.ok(hasExercise(it.exId), `${t.id}: ${it.exId}`);
  }
});

test('exercises: library size, ids unique, links valid, KB lifts have loadRatio', () => {
  assert.ok(EXERCISES.length >= 70);
  const ids = new Set(EXERCISES.map((e) => e.id));
  assert.equal(ids.size, EXERCISES.length);
  const stationIds = new Set(STATIONS.map((s) => s.id));
  for (const e of EXERCISES) {
    for (const k of ['regression', 'progression']) if (e[k]) assert.ok(ids.has(e[k]), `${e.id}.${k} → ${e[k]}`);
    if (e.hyrox) assert.ok(stationIds.has(e.hyrox), `${e.id}.hyrox`);
    if (e.category === 'kb') assert.ok(e.loadRatio, `${e.id} loadRatio`);
    assert.ok(e.cues.length || e.category === 'mobility', `${e.id} cues`);
  }
  const f = getExercise('made-up-lift');
  assert.equal(f.name, 'Made Up Lift');
  assert.deepEqual(f.cues, []);
});

test('suggestWeight: always an owned bell; pairs for double lifts; null for non-KB', () => {
  assert.deepEqual(ownedBells(PROFILE), [16, 24, 32]);
  assert.deepEqual(pairedBells(PROFILE), [16, 24]);
  for (const e of EXERCISES.filter((x) => x.category === 'kb')) {
    for (const exp of ['beginner', 'intermediate', 'advanced']) for (const sex of ['m', 'f']) {
      const prof = { ...PROFILE, experience: exp, sex };
      const kg = suggestWeight(e.id, prof, []);
      if (kg === null) { assert.ok(tooHeavy(e.id, prof), `${e.id} ${exp} ${sex}: null only when too heavy`); continue; }
      assert.ok(ownedBells(PROFILE).includes(kg), `${e.id} ${exp} ${sex} → ${kg}`);
      if (e.double) assert.ok(pairedBells(PROFILE).includes(kg), `${e.id} must be a pair`);
    }
  }
  assert.equal(suggestWeight('run-easy', PROFILE, []), null);
  assert.equal(suggestWeight('bw-pushup', PROFILE, []), null);
  assert.equal(suggestWeight('kb-swing', { ...PROFILE, bells: [] }, []), null);
  assert.equal(suggestWeight('kb-double-front-squat', { ...MINIMAL, sex: 'm', experience: 'intermediate', weightKg: 80 }, []), 16, 'falls back to the single bell');
  assert.equal(suggestWeight('kb-swing', { ...PROFILE, bells: [{ kg: 20, count: 1 }, { kg: 12, count: 1 }] }, []) % 4, 0);
});

test('suggestWeight: double progression from last performance', () => {
  const sess = (reps, rpe, kg = 16) => [{ id: 's1', date: '2026-10-01', sets: [1, 2, 3].map(() => ({ exId: 'kb-press', kg, reps, rpe })) }];
  assert.equal(suggestWeight('kb-press', PROFILE, sess(8, 8)), 24, 'top of range at RPE 8 → next owned bell');
  assert.equal(suggestWeight('kb-press', PROFILE, sess(8, 9.5)), 16, 'too hard → stay');
  assert.equal(suggestWeight('kb-press', PROFILE, sess(5, 7)), 16, 'reps first');
  assert.equal(suggestWeight('kb-press', PROFILE, sess(8, 8, 32)), 32, 'no heavier bell → stay on top bell');
  assert.equal(suggestWeight('kb-press', PROFILE, sess(5, 7, 20)), 16, 'unowned history → nearest owned at or below');
  assert.equal(suggestWeight('kb-press', PROFILE, sess(5, 7), { topReps: 5 }), 24);
  const lp = lastPerformance('kb-press', sess(6, 7));
  assert.equal(lp.kg, 16); assert.equal(lp.reps, 6); assert.equal(lp.date, '2026-10-01');
  assert.equal(lastPerformance('kb-snatch', sess(6, 7)), null);
});

test('scaleWorkout: readiness tiers', () => {
  const plan = generatePlan(PROFILE, START);
  const ws = planWorkouts(plan);
  const strength = ws.find((w) => w.type === 'strength');
  const run = ws.find((w) => w.blocks.some((b) => b.kind === 'intervals' && b.items.some((it) => getExercise(it.exId).category === 'run')));
  const before = JSON.stringify(strength);

  const hi = scaleWorkout(strength, 80);
  assert.deepEqual(hi.changes, []);
  assert.deepEqual(hi.workout.blocks, strength.blocks);
  assert.deepEqual(scaleWorkout(strength, null).changes, []);

  const mid = scaleWorkout(strength, 50);
  assert.ok(mid.changes.length > 1);
  const setsOf = (w) => w.blocks.filter((b) => b.kind === 'strength').flatMap((b) => b.items).reduce((a, it) => a + (it.sets || 0), 0);
  assert.ok(setsOf(mid.workout) < setsOf(strength));
  assert.equal(JSON.stringify(strength), before, 'input not mutated');

  const midRun = scaleWorkout(run, 45);
  assert.ok(!midRun.workout.blocks.some((b) => b.kind === 'intervals' && b.items.some((it) => getExercise(it.exId).category === 'run')), 'intervals → Zone 2');
  assert.ok(midRun.changes.some((c) => /Zone 2/.test(c)));

  const lo = scaleWorkout(strength, 25);
  assert.equal(lo.workout.type, 'recovery');
  assert.equal(lo.workout.id, strength.id);
  assert.ok(lo.changes[0].includes('recovery'));
  for (const it of allItems(lo.workout)) assert.ok(hasExercise(it.exId));
});

test('readinessScore: bounds and direction', () => {
  assert.equal(readinessScore({ sleep: 5, energy: 5, soreness: 1, stress: 1 }), 100);
  assert.equal(readinessScore({ sleep: 1, energy: 1, soreness: 5, stress: 5 }), 0);
  assert.equal(readinessScore({}), 70, 'unanswered = neutral');
  assert.equal(readinessScore({ sleep: 3, energy: 3, soreness: 3, stress: 3 }), 70, 'a normal day trains as planned (> 60)');
  assert.equal(readinessScore({ sleep: 2, energy: 2, soreness: 4, stress: 4 }), 40, 'all-bad-ish → reduced tier');
  assert.ok(readinessScore({ sleep: 2, energy: 3, soreness: 3, stress: 3 }) > 60);
  assert.ok(readinessScore({ sleep: 4, energy: 4, soreness: 2, stress: 2 }) > 60);
  for (let i = 0; i < 200; i++) {
    const r = () => Math.floor(Math.random() * 7) - 1;
    const s = readinessScore({ sleep: r(), energy: r(), soreness: r(), stress: r() });
    assert.ok(s >= 0 && s <= 100);
  }
});

test('paces & HR zones', () => {
  for (const t of [1080, 1500, 2100]) {
    const p = paces(t);
    assert.ok(p.interval < p.threshold && p.threshold < p.tempo && p.tempo < p.race && p.race < p.easy[0] && p.easy[0] < p.easy[1]);
    assert.equal(p.fiveK, t / 5);
  }
  assert.ok(paces(1200).threshold < paces(1800).threshold);
  assert.equal(defaultHrMax(40), 180);
  const z = hrZones(190);
  assert.equal(z.length, 5);
  assert.ok(z.every((q, i) => q.z === i + 1 && q.lo < q.hi));
});

test('STATIONS: race order and 2024/25 spec', () => {
  assert.deepEqual(STATIONS.map((s) => s.id), ['skierg', 'sled-push', 'sled-pull', 'bbj', 'row', 'farmers', 'sandbag-lunges', 'wall-balls']);
  const st = Object.fromEntries(STATIONS.map((s) => [s.id, s]));
  assert.deepEqual(st['sled-push'].kg, { open_m: 152, open_w: 102, pro_m: 202, pro_w: 152 });
  assert.deepEqual(st['sled-pull'].kg, { open_m: 103, open_w: 78, pro_m: 153, pro_w: 103 });
  assert.deepEqual(st.farmers.kg, { open_m: 24, open_w: 16, pro_m: 32, pro_w: 24 });
  assert.deepEqual(st['sandbag-lunges'].kg, { open_m: 20, open_w: 10, pro_m: 30, pro_w: 20 });
  assert.deepEqual(st['wall-balls'].kg, { open_m: 6, open_w: 4, pro_m: 9, pro_w: 6 });
  assert.equal(st['wall-balls'].reps, 100);
  for (const s of STATIONS) { assert.ok(hasExercise(s.exId)); for (const id of s.subs) assert.ok(hasExercise(id), id); }
});

test('predictRace: sane range for many profiles; benchmarks raise confidence', () => {
  for (const experience of ['beginner', 'intermediate', 'advanced']) for (const sex of ['m', 'f']) for (const division of ['open', 'pro', 'doubles']) {
    const r = predictRace({ profile: { ...PROFILE, experience, sex, division }, sessions: [] });
    assert.ok(r.totalSec >= 50 * 60 && r.totalSec <= 150 * 60, `${experience}/${sex}/${division}: ${r.totalSec / 60}`);
    assert.equal(r.splits.length, 17);
    assert.ok(r.roxzoneSec >= 300 && r.roxzoneSec <= 480);
    assert.equal(r.confidence, 'low');
  }
  const adv = predictRace({ profile: { ...PROFILE, experience: 'advanced' }, sessions: [] }).totalSec;
  const beg = predictRace({ profile: { ...PROFILE, experience: 'beginner' }, sessions: [] }).totalSec;
  assert.ok(adv < beg);
  const sessions = [
    { id: 'a', date: '2026-10-01', type: 'run', sets: [], cardio: [{ mode: 'run', distanceM: 5000, timeSec: 1260 }] },
    { id: 'b', date: '2026-10-03', type: 'hyrox', sets: [{ exId: 'hx-ski', distanceM: 1000, timeSec: 250 }, { exId: 'hx-wall-balls', reps: 100, timeSec: 300 }, { exId: 'hx-bbj', distanceM: 80, timeSec: 260 }], cardio: [] },
  ];
  const r = predictRace({ profile: PROFILE, sessions }, '2026-10-10');
  assert.equal(r.confidence, 'high');
  assert.equal(r.splits.find((s) => s.name === 'SkiErg').sec, 250);
  assert.ok(r.basis.some((b) => /5 km/.test(b)));
  assert.ok(r.totalSec >= 50 * 60 && r.totalSec <= 150 * 60);
});

test('hyroxReadiness: 0..100 with five parts', () => {
  const empty = hyroxReadiness({ profile: PROFILE, sessions: [] }, START);
  assert.ok(empty.score >= 0 && empty.score <= 100);
  assert.equal(empty.parts.length, 5);
  const sessions = [];
  for (let i = 0; i < 24; i++) sessions.push({
    id: 's' + i, date: addDays(START, -i), type: i % 4 === 0 ? 'hybrid' : 'run', durationSec: 3600, rpe: 7,
    sets: [{ exId: 'run-1k', distanceM: 1000, timeSec: 280 }, { exId: 'kb-farmers-carry', kg: 24, distanceM: 100 }, { exId: STATIONS[i % 8].subs[0], reps: 10 }],
    cardio: [{ mode: 'run', distanceM: 8000, timeSec: 2700 }],
  });
  const full = hyroxReadiness({ profile: PROFILE, sessions }, START);
  assert.ok(full.score > empty.score);
  assert.ok(full.score <= 100);
  for (const p of full.parts) assert.ok(p.score >= 0 && p.score <= 100 && p.tip);
});

test('detectPRs: bells, reps, runs, swings', () => {
  const prior = [
    { id: 'p1', date: '2026-10-01', sets: [{ exId: 'kb-press', kg: 16, reps: 5 }, { exId: 'kb-swing', kg: 24, reps: 50 }], cardio: [{ mode: 'run', distanceM: 1000, timeSec: 270 }, { mode: 'run', distanceM: 6000, timeSec: 1800 }] },
  ];
  const s = { id: 'n', date: '2026-10-08', sets: [{ exId: 'kb-press', kg: 24, reps: 3 }, { exId: 'kb-swing', kg: 24, reps: 60 }, { exId: 'kb-swing', kg: 24, reps: 20 }], cardio: [{ mode: 'run', distanceM: 1000, timeSec: 255 }, { mode: 'run', distanceM: 8000, timeSec: 2700 }] };
  const prs = detectPRs(s, prior);
  assert.ok(prs.some((p) => /Heaviest Strict Press: 24 kg/.test(p)), prs.join('|'));
  assert.ok(prs.some((p) => /Most reps at 24 kg on Two-Hand Swing: 60/.test(p)));
  assert.ok(prs.some((p) => /Fastest 1 km: 4:15/.test(p)));
  assert.ok(prs.some((p) => /Longest run: 8.0 km/.test(p)));
  assert.ok(prs.some((p) => /Most swings in a session: 80/.test(p)));
  assert.deepEqual(detectPRs(prior[0], prior), ['First 1 km benchmark: 4:30'], 'same session is excluded from history');
  assert.deepEqual(detectPRs(null, prior), []);
  const test10 = detectPRs({ id: 't', workoutId: 't-swing-test', sets: [{ exId: 'kb-swing', kg: 24, reps: 210 }] }, []);
  assert.ok(test10.some((p) => /Most swings in 10 min: 210/.test(p)));
});

test('trainingLoad, weekSummary, streak', () => {
  const today = '2026-10-28';
  const sessions = [];
  for (let i = 0; i < 28; i += 2) sessions.push({ id: 's' + i, date: addDays(today, -i), durationSec: 3000, rpe: 6, sets: [{ exId: 'kb-swing', kg: 24, reps: 10 }, { exId: 'kb-double-press', kg: 16, reps: 5 }], cardio: [{ mode: 'run', distanceM: 5000, timeSec: 1500 }, { mode: 'row', distanceM: 2000, timeSec: 480 }] });
  const tl = trainingLoad(sessions, today);
  assert.ok(tl.acute > 0 && tl.chronic > 0);
  assert.equal(tl.status, 'optimal');
  assert.equal(trainingLoad([], today).status, 'low');
  const spike = trainingLoad([...sessions, ...[0, 1, 2, 3, 4].map((i) => ({ id: 'x' + i, date: addDays(today, -i), durationSec: 7200, rpe: 9 }))], today);
  assert.ok(['high', 'spike'].includes(spike.status));

  const ws = weekSummary(sessions, addDays(today, -6));
  assert.equal(ws.count, 4);
  assert.equal(ws.minutes, 200);
  assert.equal(ws.kbVolumeKg, 4 * (240 + 160));
  assert.equal(ws.runM, 20000);
  assert.equal(ws.cardioM, 28000);

  const plan = generatePlan({ ...PROFILE, daysPerWeek: 6 }, '2026-10-05');
  const daily = [];
  for (let i = 0; i < 10; i++) {
    const d = addDays('2026-10-05', i);
    if (workoutForDate(plan, d).workout) daily.push({ id: 'd' + i, date: d, durationSec: 1800 });
  }
  const st = streak(daily, plan, addDays('2026-10-05', 9));
  assert.ok(st.days >= 9, `days ${st.days}`);
  assert.equal(st.weeksOnPlan, 1);
  assert.deepEqual(streak([], null, today), { days: 0, weeksOnPlan: 0 });
  assert.ok(daysBetween('2026-10-05', addDays('2026-10-05', 9)) === 9);
});

// ---------- Review round 1 regressions ----------
const BEGINNER_F = { ...PROFILE, sex: 'f', weightKg: 58, experience: 'beginner', bells: [{ kg: 24, count: 1 }], equipment: {}, daysPerWeek: 4 };
const SWINGISH = /swing|snatch/;

test('P0-1: neutral check-in never downgrades the session', () => {
  const plan = generatePlan(PROFILE, START);
  const q = planWorkouts(plan).find((w) => w.title.includes('Threshold 1K'));
  const r = scaleWorkout(q, readinessScore({ sleep: 3, energy: 3, soreness: 3, stress: 3 }));
  assert.deepEqual(r.changes, []);
  assert.deepEqual(r.workout.blocks, q.blocks);
});

test('P0-2: race day, primer and benchmarks are never readiness-scaled', () => {
  const plan = generatePlan({ ...PROFILE, raceDate: addDays(START, 55) }, START);
  const race = workoutForDate(plan, addDays(START, 55)).workout;
  const primer = workoutForDate(plan, addDays(START, 54)).workout;
  assert.equal(race.fixed, true);
  assert.equal(primer.fixed, true);
  for (const score of [10, 35, 50]) {
    for (const w of [race, primer]) {
      const r = scaleWorkout(w, score);
      assert.deepEqual(r.workout.blocks, w.blocks, `${w.title} @${score}`);
      assert.equal(r.workout.title, w.title);
      assert.equal(r.changes.length, 1);
    }
    for (const id of ['t-1k-tt', 't-5k-tt', 't-swing-test', 't-station-benchmark']) {
      const t = getWorkout(plan, id);
      const r = scaleWorkout(t, score);
      assert.deepEqual(r.workout.blocks, t.blocks, id);
      assert.match(r.changes[0], /postpone/i);
    }
  }
  assert.match(scaleWorkout(race, 30).changes[0], /Race day — no changes/);
});

test('P0-3: only benchmark efforts feed predictRace and 1k/5k PRs', () => {
  const profile = { ...PROFILE, fiveKSec: 1440 };
  const base = predictRace({ profile, sessions: [] }, '2026-11-01').totalSec;
  const hybrid = { id: 'h', date: '2026-10-30', type: 'hybrid', workoutId: 'w3-d5', cardio: [{ mode: 'run', distanceM: 1000, timeSec: 540 }], sets: [{ exId: 'run-1k', distanceM: 1000, timeSec: 540 }] };
  const reps = { id: 'r', date: '2026-10-28', type: 'run', workoutId: 'w3-d1', sets: [{ exId: 'run-1k', distanceM: 1000, timeSec: 305 }, { exId: 'run-1k', distanceM: 1000, timeSec: 303 }], cardio: [] };
  assert.ok(Math.abs(predictRace({ profile, sessions: [hybrid] }, '2026-11-01').totalSec - base) < 120, 'compromised 1 km is not a benchmark');
  assert.ok(predictRace({ profile, sessions: [reps] }, '2026-11-01').totalSec <= base + 30, 'training reps never worsen the prediction');
  const slowTT = { id: 't', date: '2026-10-29', workoutId: 't-5k-tt', sets: [], cardio: [{ mode: 'run', distanceM: 5000, timeSec: 1800 }] };
  assert.ok(predictRace({ profile, sessions: [slowTT] }, '2026-11-01').totalSec <= base + 1, 'slower TT than profile → profile wins (min)');
  const fastTT = { id: 'f', date: '2026-10-29', workoutId: 't-5k-tt', sets: [], cardio: [{ mode: 'run', distanceM: 5000, timeSec: 1260 }] };
  assert.ok(predictRace({ profile, sessions: [fastTT] }, '2026-11-01').totalSec < base - 120, 'faster TT improves prediction');
  assert.deepEqual(detectPRs(hybrid, []), [], 'no fake first-1 km benchmark from a hybrid round');
  assert.deepEqual(detectPRs(reps, []), []);
  const reps2 = { ...reps, id: 'r2', sets: [{ exId: 'run-1k', distanceM: 1000, timeSec: 298 }] };
  assert.deepEqual(detectPRs(reps2, [reps]), ['Fastest 1 km rep: 4:58']);
  const tt1 = { id: 'k', date: '2026-10-31', workoutId: 't-1k-tt', sets: [{ exId: 'run-1k', distanceM: 1000, timeSec: 250, benchmark: true }] };
  assert.deepEqual(detectPRs(tt1, [hybrid, reps]), ['First 1 km benchmark: 4:10']);
  const manual = { id: 'm', date: '2026-10-31', workoutId: null, cardio: [{ mode: 'run', distanceM: 5000, timeSec: 1400 }] };
  assert.deepEqual(detectPRs(manual, [fastTT]), []);
});

test('P0-4: no unsafe bells for an athlete who owns only heavy bells; beginners never snatch', () => {
  assert.equal(suggestWeight('kb-press', BEGINNER_F, []), null);
  assert.equal(suggestWeight('kb-snatch', BEGINNER_F, []), null);
  assert.ok(tooHeavy('kb-tgu', BEGINNER_F));
  assert.equal(suggestWeight('kb-deadlift', BEGINNER_F, []), 24, 'a 24 kg deadlift is fine');
  // history overrides the guard: she has proven the bell
  assert.equal(suggestWeight('kb-press', BEGINNER_F, [{ id: 'x', date: '2026-10-01', sets: [{ exId: 'kb-press', kg: 24, reps: 2, rpe: 9 }] }]), 24);
  const plan = generatePlan(BEGINNER_F, START);
  checkPlan(plan, BEGINNER_F);
  const risky = /press|jerk|tgu|snatch|thruster|clean|windmill|overhead|halo|bottoms/;
  for (const w of planWorkouts(plan)) for (const it of allItems(w)) {
    if (it.kg == null) continue;
    assert.ok(!risky.test(it.exId), `${w.id}: ${it.exId} @${it.kg}`);
    assert.ok(!tooHeavy(it.exId, BEGINNER_F, it.kg), `${w.id}: ${it.exId} @${it.kg} too heavy`);
  }
  const beginners = generatePlan({ ...PROFILE, experience: 'beginner', daysPerWeek: 5 }, START);
  for (const w of planWorkouts(beginners)) for (const it of allItems(w)) assert.notEqual(it.exId, 'kb-snatch', `${w.id} beginner snatch`);
  for (const prof of [PROFILE, MINIMAL, { ...PROFILE, sex: 'f', weightKg: 65, experience: 'beginner', bells: [{ kg: 12, count: 1 }, { kg: 16, count: 1 }] }]) {
    for (const w of planWorkouts(generatePlan(prof, START))) for (const it of allItems(w)) if (it.kg != null) assert.ok(!tooHeavy(it.exId, prof, it.kg), `${w.id}: ${it.exId} @${it.kg}`);
  }
});

const swingReps = (w) => allItems(w).filter((it) => SWINGISH.test(it.exId)).reduce((a, it) => a + (it.reps || 0) * (it.perSide ? 2 : 1) * (it.sets || 1), 0)
  + w.blocks.filter((b) => b.kind === 'emom' && b.items.some((it) => SWINGISH.test(it.exId))).reduce((a, b) => a + b.minutes * 12, 0);

test('P1-1/P1-3: hard runs never follow heavy hinge days; enough runs per week', () => {
  for (const days of [3, 4, 5, 6]) {
    const plan = generatePlan({ ...PROFILE, daysPerWeek: days }, START);
    const flat = plan.weeks.flatMap((w) => w.days);
    for (let i = 1; i < flat.length; i++) {
      const prev = flat[i - 1].workoutId && plan.workouts[flat[i - 1].workoutId];
      const cur = flat[i].workoutId && plan.workouts[flat[i].workoutId];
      if (!prev || !cur) continue;
      const heavyHinge = /Squat & Hinge|Heavy Legs|Hinge Power/.test(prev.title) || swingReps(prev) >= 60;
      const hard = cur.type === 'hybrid' || cur.type === 'hyrox' || cur.blocks.some((b) => b.kind === 'intervals' && b.items.some((it) => getExercise(it.exId).category === 'run'));
      assert.ok(!(heavyHinge && hard && !cur.fixed), `${days}d: ${prev.id} ${prev.title} → ${cur.id} ${cur.title}`);
    }
    for (const wk of plan.weeks.filter((w) => w.phase === 'base' && !w.deload)) {
      const runs = wk.days.filter((d) => d.workoutId).map((d) => plan.workouts[d.workoutId]).filter((w) => allItems(w).some((it) => ['run-easy', 'run-long', 'run-tempo', 'run-1k', 'run-intervals', 'run-fartlek', 'run-hill-sprints', 'run-threshold'].includes(it.exId) && (it.timeSec >= 600 || it.distanceM >= 1000 || it.exId === 'run-hill-sprints')));
      assert.ok(runs.length >= (days >= 5 ? 3 : 2), `${days}d week ${wk.index + 1}: ${runs.length} runs`);
    }
  }
});

function weekRunKm(plan, wk) {
  let m = 0;
  for (const d of wk.days) if (d.workoutId) for (const b of plan.workouts[d.workoutId].blocks) {
    const mult = b.kind === 'circuit' || b.kind === 'intervals' ? b.rounds || 1 : 1;
    for (const it of b.items) if (getExercise(it.exId).category === 'run') m += (it.distanceM || ((it.timeSec || 0) / (it.paceSec || 360)) * 1000) * (it.sets || 1) * mult;
  }
  return m / 1000;
}

test('P1-2: weekly run volume ramps ≤ 15% (simulation weeks exempt) and deloads run less', () => {
  for (const profile of [PROFILE, { ...PROFILE, daysPerWeek: 6, experience: 'advanced', raceDate: addDays(START, 20 * 7 - 1) }, { ...MINIMAL, daysPerWeek: 3 }, { ...PROFILE, daysPerWeek: 4, raceDate: addDays(START, 30 * 7 - 1) }]) {
    const plan = generatePlan(profile, START);
    let prev = null;
    for (const wk of plan.weeks) {
      if (wk.phase === 'taper') continue;
      const km = weekRunKm(plan, wk);
      const sim = wk.days.some((d) => d.workoutId && plan.workouts[d.workoutId].type === 'hyrox');
      const firstBuild = wk.phase === 'build' && plan.weeks[wk.index - 1]?.phase !== 'build' && !wk.deload;
      if (prev != null && !firstBuild) {
        if (wk.deload) assert.ok(km < prev, `week ${wk.index + 1} deload ${km.toFixed(1)} vs ${prev.toFixed(1)}`);
        else if (!sim) assert.ok(km <= prev * 1.15 + 0.3, `week ${wk.index + 1}: ${km.toFixed(1)} km vs ${prev.toFixed(1)}`);
      }
      if (!wk.deload && !sim) prev = km;
    }
  }
});

test('P1-5/P1-6: press reps never drop on the same bell; single front squat is per side', () => {
  const plan = generatePlan(PROFILE, START);
  const press = planWorkouts(plan).filter((w) => !w.title.startsWith('Deload') && w.type === 'strength' && ['base', 'build'].includes(w.phase))
    .flatMap((w) => allItems(w).filter((it) => it.exId === 'kb-double-press').map((it) => ({ ...it, week: w.week })));
  const lastBase = press.filter((p) => p.week <= 3).pop();
  for (const p of press.filter((x) => x.week >= 5)) if (p.kg === lastBase.kg) assert.ok(p.reps * p.sets >= lastBase.reps * lastBase.sets, `week ${p.week}: ${p.sets}×${p.reps} @${p.kg}`);
  const single = generatePlan({ ...PROFILE, bells: [{ kg: 16, count: 1 }, { kg: 20, count: 1 }, { kg: 24, count: 1 }] }, START);
  const fs = planWorkouts(single).flatMap(allItems).filter((it) => it.exId === 'kb-front-squat' && it.sets);
  assert.ok(fs.length && fs.every((it) => it.perSide));
});

test('P1-7: mid readiness gives coherent, concise scaled sessions', () => {
  const plan = generatePlan(PROFILE, START);
  const ws = planWorkouts(plan);
  for (const w of ws.filter((x) => !x.fixed && !x.benchmark)) {
    const r = scaleWorkout(w, 50);
    assert.ok(r.changes.length <= 5, `${w.title}: ${r.changes.length} lines`);
    for (const b of r.workout.blocks) {
      if (b.kind === 'circuit' && /^\d+ rounds/.test(b.title)) assert.equal(+b.title.match(/^\d+/)[0], b.rounds, b.title);
      if (b.kind === 'warmup' || b.kind === 'cooldown') continue;
      for (const it of b.items) if (getExercise(it.exId).category === 'run' && it.paceSec) assert.ok(!/race|threshold|interval/i.test(it.note || ''), `${w.title}: ${it.exId} still ${it.note}`);
    }
  }
  const sim = ws.find((w) => w.title === 'Full HYROX Simulation');
  const r = scaleWorkout(sim, 50);
  assert.match(r.workout.title, /Half Simulation/);
  assert.ok(r.changes.some((c) => /Full sim moved/.test(c)));
});

test('P1-8: sandbag-lunge substitute approximates race spec', () => {
  for (const [prof, spec] of [[PROFILE, 20], [{ ...PROFILE, division: 'pro', bells: [{ kg: 24, count: 2 }, { kg: 28, count: 2 }, { kg: 32, count: 2 }] }, 30]]) {
    const plan = generatePlan(prof, START);
    const it = getWorkout(plan, 't-full-sim').blocks.find((b) => b.title === 'Sandbag Lunges').items[0];
    const total = it.kg * (it.exId === 'kb-rack-walking-lunge' ? 2 : 1);
    assert.ok(Math.abs(total - spec) <= 8, `${it.exId} total ${total} vs ${spec}`);
  }
});

test('liveItemWeight: applies logged double progression to planned items', () => {
  const item = { exId: 'kb-double-front-squat', sets: 4, reps: 8, kg: 16 };
  const log = (reps, rpe, kg = 16) => [{ id: 'l', date: '2026-10-20', sets: [1, 2, 3, 4].map(() => ({ exId: 'kb-double-front-squat', kg, reps, rpe })) }];
  assert.equal(liveItemWeight(item, PROFILE, []), 16, 'no history → planned');
  assert.equal(liveItemWeight(item, PROFILE, log(8, 7)), 24, 'hit top at RPE 7 → next pair');
  assert.equal(liveItemAdvice(item, PROFILE, log(8, 7)).earned, true);
  assert.equal(liveItemWeight(item, PROFILE, log(8, 9.5)), 16, 'grinder → repeat');
  assert.match(liveItemAdvice(item, PROFILE, log(6, 9)).reason, /repeat/i);
  assert.equal(liveItemWeight(item, PROFILE, log(6, 7)), 16, 'reps first');
  assert.equal(liveItemWeight({ ...item, kg: 24 }, PROFILE, log(6, 7)), 24, 'never below the planned bell unless struggling');
  assert.equal(liveItemWeight({ ...item, hold: true }, PROFILE, log(8, 7)), 16, 'held items (warm-up/deload) do not progress');
  assert.equal(liveItemWeight({ exId: 'run-easy', timeSec: 600 }, PROFILE, []), null);
  assert.ok(pairedBells(PROFILE).includes(liveItemWeight(item, PROFILE, log(8, 7, 24))), 'stays owned at the top');
});

test('P1-11: race-week openers sit ~3 days out, primer the day before', () => {
  for (const days of [3, 4, 5]) {
    const race = addDays(START, 83);
    const plan = generatePlan({ ...PROFILE, daysPerWeek: days, raceDate: race }, START);
    const last = plan.weeks[plan.weeks.length - 1];
    const titleOn = (i) => (last.days[i].workoutId ? plan.workouts[last.days[i].workoutId].title : 'rest');
    assert.equal(titleOn(6), 'HYROX Race Day');
    assert.equal(titleOn(5), 'Race Primer');
    assert.equal(titleOn(3), 'Race Openers', `${days}d`);
  }
});

test('impossible efforts are ignored by PRs, predictor, readiness and summaries', async () => {
  const { plausibleEffort } = await import('../js/engine/hyrox.js');
  assert.equal(plausibleEffort('run', 5000, 1200), true);
  assert.equal(plausibleEffort('run', 1609344e3, 1), false, 'distance > 300 km');
  assert.equal(plausibleEffort('run', 1000, 120), false, 'faster than 2:30/km');
  assert.equal(plausibleEffort('run', 10000, 90000), false, '> 24 h');
  assert.equal(plausibleEffort('row', 1000, 130), false, 'row split < 1:10/500 m');
  assert.equal(plausibleEffort('row', 1000, 200), true);
  assert.equal(plausibleEffort('run', NaN, 100), false);
  assert.equal(plausibleEffort('run', Infinity, 0), false);
  const bogus = { id: 'b', date: '2026-10-14', workoutId: null, durationSec: 1, cardio: [{ mode: 'run', distanceM: 1609344e3, timeSec: 1 }, { mode: 'run', distanceM: 1000, timeSec: 100 }, { mode: 'row', distanceM: 1000, timeSec: 60 }, { mode: 'run', distanceM: NaN, timeSec: 300 }], sets: [{ exId: 'run-1k', distanceM: 1000, timeSec: 60, benchmark: true }] };
  const real = { id: 'r', date: '2026-10-10', workoutId: null, durationSec: 1800, cardio: [{ mode: 'run', distanceM: 5000, timeSec: 1500 }], sets: [] };
  assert.deepEqual(detectPRs(bogus, [real]), []);
  const base = predictRace({ profile: PROFILE, sessions: [real] }, '2026-10-15');
  const withBogus = predictRace({ profile: PROFILE, sessions: [real, bogus] }, '2026-10-15');
  assert.equal(withBogus.totalSec, base.totalSec);
  const ws = weekSummary([bogus], '2026-10-12');
  assert.equal(ws.runM, 0); assert.equal(ws.cardioM, 0);
  assert.equal(weekSummary([{ ...real, date: '2026-10-12', durationSec: 1e12 }], '2026-10-12').minutes, 0);
  const hr = hyroxReadiness({ profile: PROFILE, sessions: [bogus] }, '2026-10-15');
  assert.ok(hr.parts[0].score < 100);
});

// ---------- Review round 2 regressions ----------
const A_PROF = { ...PROFILE, raceDate: '2027-01-03', fiveKSec: 1440 };

// An athlete who completes every prescribed set at RPE 7 using the live advice each time (review live2.mjs).
function simulateCompliant(profile, weeks, extraSet = {}) {
  const plan = generatePlan(profile, START);
  const sessions = [];
  const seen = {};
  for (const w of plan.weeks.slice(0, weeks)) for (const d of w.days) {
    if (!d.workoutId) continue;
    const wo = plan.workouts[d.workoutId];
    const sets = [];
    for (const b of wo.blocks) for (const it of b.items) {
      if (getExercise(it.exId).category !== 'kb' || it.kg == null) continue;
      const kg = liveItemWeight(it, profile, sessions, { plan });
      (seen[it.exId] ||= []).push(kg);
      for (let i = 0; i < (it.sets || 1); i++) sets.push({ exId: it.exId, kg, reps: it.reps, rpe: 7, ...extraSet(b, it) });
    }
    sessions.push({ id: d.workoutId, workoutId: d.workoutId, date: d.date, sets });
  }
  return seen;
}

test('R2 P0-1: compliant athlete does not jump bells every session (TGU/SL-RDL stay ≤ 24 kg over 9 weeks)', () => {
  for (const extra of [() => ({}), (b, it) => ({ blockKind: b.kind, targetReps: it.reps })]) {
    const seen = simulateCompliant(A_PROF, 9, extra);
    assert.ok(Math.max(...seen['kb-tgu']) <= 24, `TGU ${seen['kb-tgu']}`);
    assert.ok(Math.max(...seen['kb-sl-rdl']) <= 24, `SL-RDL ${seen['kb-sl-rdl']}`);
    assert.ok(Math.max(...seen['kb-double-press']) <= 16, 'press 16→24 is a > 30% jump');
  }
  // careful lift: needs two consecutive easy sessions at the top of the range + ≤ 30% jump
  const prof = { ...PROFILE, bells: [{ kg: 16, count: 1 }, { kg: 20, count: 1 }] };
  const item = { exId: 'kb-press', sets: 5, reps: 8, kg: 16, blockKind: 'strength' };
  const sess = (date, rpe = 7, kg = 16) => ({ date, sets: Array(5).fill({ exId: 'kb-press', kg, reps: 8, rpe, blockKind: 'strength', targetReps: 8 }) });
  assert.equal(liveItemWeight(item, prof, [sess('2026-10-01')]), 16, 'one easy session is not enough');
  assert.equal(liveItemWeight(item, prof, [sess('2026-10-01'), sess('2026-10-04')]), 20, 'two easy sessions → +25% bell');
  assert.equal(liveItemWeight(item, prof, [sess('2026-10-01'), sess('2026-10-04', 8)]), 16, 'RPE 8 is not easy for a press');
  // ≤ 1 bump per 14 days
  const sq = { exId: 'kb-goblet-squat', sets: 4, reps: 8, kg: 16, blockKind: 'strength' };
  const pr2 = { ...PROFILE, bells: [{ kg: 16, count: 1 }, { kg: 20, count: 1 }, { kg: 24, count: 1 }] };
  const g = (date, kg) => ({ date, sets: Array(4).fill({ exId: 'kb-goblet-squat', kg, reps: 8, rpe: 6, blockKind: 'strength' }) });
  assert.equal(liveItemWeight(sq, pr2, [g('2026-10-01', 16)]), 20);
  assert.equal(liveItemWeight(sq, pr2, [g('2026-10-01', 16), g('2026-10-05', 20)]), 20, 'just moved up → consolidate');
  assert.equal(liveItemWeight(sq, pr2, [g('2026-10-01', 16), g('2026-10-20', 20)]), 24);
});

test('R2 P0-2: standard starting bells are always allowed; carries up to race spec', () => {
  const begM = { ...PROFILE, sex: 'm', weightKg: 80, experience: 'beginner', bells: [{ kg: 16, count: 1 }, { kg: 24, count: 1 }] };
  assert.equal(suggestWeight('kb-press', begM, []), 16);
  assert.equal(suggestWeight('kb-tgu', begM, []), 16);
  const begF = { ...PROFILE, sex: 'f', weightKg: 65, experience: 'beginner', bells: [{ kg: 12, count: 1 }, { kg: 16, count: 1 }] };
  assert.equal(suggestWeight('kb-press', begF, []), 12);
  assert.equal(suggestWeight('kb-goblet-thruster', begF, []), 12);
  assert.equal(suggestWeight('kb-press', BEGINNER_F, []), null, '24 kg press still refused for a 58 kg beginner woman');
  assert.equal(suggestWeight('kb-suitcase-carry', BEGINNER_F, []), 24);
  const plan = generatePlan({ ...begF, daysPerWeek: 3 }, START);
  const items = planWorkouts(plan).flatMap(allItems);
  assert.ok(items.some((it) => it.exId === 'kb-press' && it.kg === 12), 'B presses a 12 kg bell');
  assert.ok(items.some((it) => it.exId === 'kb-tgu' && it.kg === 12), 'B get-ups with 12 kg');
  assert.ok(!items.some((it) => it.exId === 'mob-arm-circles'), 'no arm-circle halos');
  for (const w of planWorkouts(plan)) for (const b of w.blocks) {
    const ids = b.items.map((it) => it.exId).filter((id) => id.startsWith('bw-'));
    assert.equal(new Set(ids).size, ids.length, `${w.id} ${b.title}: duplicate ${ids}`);
  }
  const strengthSquats = planWorkouts(generatePlan(BEGINNER_F, START)).flatMap((w) => w.blocks.filter((b) => b.kind === 'strength').flatMap((b) => b.items)).filter((it) => it.exId === 'bw-air-squat');
  assert.ok(strengthSquats.every((it) => it.reps >= 12 && /tempo/.test(it.note)));
});

test('R2 P1-3: "repeat" only when a set fell short of ITS target', () => {
  const item = { exId: 'kb-double-press', sets: 5, reps: 7, kg: 16, blockKind: 'strength' };
  const done = [{ date: '2026-10-01', sets: Array(5).fill({ exId: 'kb-double-press', kg: 16, reps: 6, rpe: 7, targetReps: 6, blockKind: 'strength' }) }];
  const adv = liveItemAdvice(item, PROFILE, done);
  assert.equal(adv.kg, 16);
  assert.doesNotMatch(adv.reason, /repeat/i);
  assert.match(adv.reason, /more reps/);
  const missed = [{ date: '2026-10-01', sets: [...Array(4).fill({ exId: 'kb-double-press', kg: 16, reps: 6, rpe: 7, targetReps: 6 }), { exId: 'kb-double-press', kg: 16, reps: 4, rpe: 8, targetReps: 6 }] }];
  assert.match(liveItemAdvice(item, PROFILE, missed).reason, /Repeat this bell/);
  // fallback: target from that session's planned workout
  const plan = generatePlan(A_PROF, START);
  const w = planWorkouts(plan).find((x) => allItems(x).some((it) => it.exId === 'kb-double-press' && it.sets));
  const it0 = allItems(w).find((it) => it.exId === 'kb-double-press');
  const legacy = [{ date: '2026-10-01', workoutId: w.id, sets: Array(it0.sets).fill({ exId: 'kb-double-press', kg: 16, reps: it0.reps, rpe: 7 }) }];
  assert.doesNotMatch(liveItemAdvice({ ...item, reps: it0.reps + 1 }, PROFILE, legacy, { plan }).reason, /repeat/i);
  const legacyMiss = [{ date: '2026-10-01', workoutId: w.id, sets: Array(it0.sets).fill({ exId: 'kb-double-press', kg: 16, reps: it0.reps - 2, rpe: 7 }) }];
  assert.match(liveItemAdvice(item, PROFILE, legacyMiss, { plan }).reason, /Repeat/);
});

test('R2 P1-4: progression is like-for-like; AMRAP totals never progress a bell', () => {
  const strength = [{ date: '2026-10-01', sets: Array(5).fill({ exId: 'kb-double-front-squat', kg: 24, reps: 8, rpe: 7, blockKind: 'strength' }) }];
  assert.equal(liveItemWeight({ exId: 'kb-double-front-squat', kg: 16, reps: 6, blockKind: 'emom' }, PROFILE, strength), 16, 'EMOM ignores strength history');
  assert.equal(liveItemWeight({ exId: 'kb-swing', kg: 16, reps: 15, blockKind: 'emom' }, PROFILE, [{ date: '2026-10-01', sets: [{ exId: 'kb-swing', kg: 16, reps: 150, blockKind: 'amrap' }] }]), 16);
  assert.equal(liveItemWeight({ exId: 'kb-swing', kg: 16, reps: 15, blockKind: 'strength' }, PROFILE, [{ date: '2026-10-01', sets: [{ exId: 'kb-swing', kg: 16, reps: 150 }] }]), 16, 'legacy giant set ignored');
  assert.equal(liveItemWeight({ exId: 'kb-swing', kg: 16, reps: 15, blockKind: 'amrap' }, PROFILE, [{ date: '2026-10-01', sets: Array(5).fill({ exId: 'kb-swing', kg: 16, reps: 20, rpe: 6, blockKind: 'amrap' }) }]), 16, 'AMRAP items never progress');
  const cond = [{ date: '2026-10-01', sets: Array(10).fill({ exId: 'kb-swing', kg: 16, reps: 15, rpe: 6, blockKind: 'emom' }) }];
  assert.ok(liveItemWeight({ exId: 'kb-swing', kg: 16, reps: 15, blockKind: 'emom' }, PROFILE, cond) <= 24, 'conditioning capped at planned + one size');
  const plan = generatePlan(PROFILE, START);
  for (const w of planWorkouts(plan)) for (const b of w.blocks) for (const it of b.items) if (getExercise(it.exId).category === 'kb') assert.equal(it.blockKind, b.kind);
});

test('R2 P1-5: ramp guard keeps a real quality dose and ≥ 20-min easy runs', () => {
  const plan = generatePlan(A_PROF, START);
  for (const wk of plan.weeks.slice(4, 9).filter((x) => !x.deload)) for (const d of wk.days) {
    if (!d.workoutId) continue;
    const w = plan.workouts[d.workoutId];
    for (const b of w.blocks) {
      if (b.kind === 'intervals' && b.items[0].exId === 'run-1k' && /threshold/.test(b.title)) assert.ok(b.rounds >= 4, `${w.id} ${b.title}`);
      if (b.kind === 'intervals' && b.items[0].exId === 'run-intervals') assert.ok(b.rounds >= 4, `${w.id} ${b.title}`);
      if (b.kind === 'intervals' && b.items[0].exId === 'run-threshold') assert.ok(b.items[0].timeSec >= 480, `${w.id} ${b.title}`);
      if (b.kind === 'cardio') for (const it of b.items) if (it.exId === 'run-easy') assert.ok(it.timeSec >= 1200, `${w.id} easy ${it.timeSec}`);
    }
  }
});

test('R2 P2: scaled estMin recomputed; station names carry no distance; early taper has one opener and no KB conditioning', () => {
  const plan = generatePlan(PROFILE, START);
  for (const w of planWorkouts(plan).filter((x) => !x.fixed && !x.benchmark)) {
    const r = scaleWorkout(w, 50);
    if (r.changes.length) assert.ok(r.workout.estMin <= w.estMin, `${w.title} ${r.workout.estMin} vs ${w.estMin}`);
  }
  for (const st of STATIONS) assert.doesNotMatch(getExercise(st.exId).name, /\d+\s?m\b/);
  const race = addDays(START, 8 * 7 + 1); // Tuesday race → previous week is an early taper
  const tp = generatePlan({ ...PROFILE, raceDate: race }, START);
  const early = tp.weeks[tp.weeks.length - 2];
  assert.equal(early.phase, 'taper');
  const ws = early.days.filter((d) => d.workoutId).map((d) => tp.workouts[d.workoutId]);
  assert.equal(ws.filter((w) => w.title === 'Race Openers').length, 1, ws.map((w) => w.title).join(' | '));
  assert.ok(!ws.some((w) => w.type === 'conditioning'), ws.map((w) => w.title).join(' | '));
  const hyb = scaleWorkout(planWorkouts(plan).find((w) => w.type === 'hybrid' && !w.title.startsWith('Deload')), 50).workout;
  assert.ok(!hyb.blocks.some((b) => /same 1 km split/.test(b.notes || '')));
});

// ---------- Review round 3 regressions (live3 compliant-athlete scenarios) ----------
const LIVE = {
  A: { ...PROFILE, sex: 'm', weightKg: 82, experience: 'intermediate', bells: [{ kg: 16, count: 2 }, { kg: 24, count: 2 }, { kg: 32, count: 1 }], equipment: {}, daysPerWeek: 5, raceDate: '2027-01-03', division: 'open', fiveKSec: 1440 },
  B: { ...PROFILE, sex: 'f', weightKg: 65, experience: 'beginner', bells: [{ kg: 12, count: 1 }, { kg: 16, count: 1 }], equipment: {}, daysPerWeek: 3, raceDate: '2026-12-06', division: 'open' },
  M: { ...PROFILE, sex: 'm', weightKg: 80, experience: 'beginner', bells: [{ kg: 12, count: 1 }, { kg: 16, count: 1 }, { kg: 20, count: 1 }, { kg: 24, count: 1 }], equipment: {}, daysPerWeek: 4, raceDate: '2027-01-31', division: 'open' },
  C: { ...PROFILE, sex: 'm', weightKg: 90, experience: 'advanced', bells: [{ kg: 24, count: 2 }, { kg: 28, count: 2 }, { kg: 32, count: 2 }], equipment: { row: true, ski: true, bike: true }, daysPerWeek: 6, raceDate: '2027-02-28', division: 'pro', fiveKSec: 1260 },
};
// Logs exactly like the player: blockKind + targetReps on each set (no hold flag — detected via the plan).
function live3(profile, rpe, weeks) {
  const plan = generatePlan(profile, START);
  const sessions = [], hist = {};
  for (const w of plan.weeks.slice(0, weeks)) for (const d of w.days) {
    if (!d.workoutId) continue;
    const wo = plan.workouts[d.workoutId];
    const sets = [];
    for (const b of wo.blocks) for (const it of b.items) {
      if (getExercise(it.exId).category !== 'kb' || b.kind === 'warmup' || b.kind === 'cooldown') continue;
      const adv = liveItemAdvice(it, profile, sessions, { plan, todayISO: d.date });
      if (b.kind === 'strength') (hist[it.exId] ||= []).push({ week: w.index + 1, hold: !!it.hold, kg: adv.kg, reason: adv.reason, earned: adv.earned });
      const n = b.kind === 'strength' ? it.sets || 1 : b.rounds || b.minutes || 1;
      for (let i = 0; i < n; i++) sets.push({ exId: it.exId, kg: adv.kg, reps: it.reps ?? null, distanceM: it.distanceM ?? null, rpe: b.kind === 'strength' ? rpe : null, blockKind: b.kind, targetReps: it.reps ?? null });
    }
    sessions.push({ id: d.workoutId, workoutId: d.workoutId, date: d.date, sets, rpe });
  }
  return hist;
}

test('R3 P1-1: deloads never wipe an earned bell; "Earned" only on the actual bump', () => {
  for (const [who, rpe, weeks] of [['A', 7, 12], ['C', 6, 16], ['M', 6, 16], ['B', 6, 8]]) {
    const hist = live3(LIVE[who], rpe, weeks);
    for (const [ex, rows] of Object.entries(hist)) {
      let best = 0;
      for (const r of rows) {
        if (r.hold) continue;
        assert.ok(r.kg >= best, `${who} ${ex} w${r.week}: ${r.kg} after ${best}`);
        if (r.earned) assert.ok(r.kg > best, `${who} ${ex} w${r.week}: "Earned" without a bump`);
        best = Math.max(best, r.kg);
      }
    }
  }
  const c = live3(LIVE.C, 6, 16)['kb-tgu'].filter((r) => !r.hold);
  const firstTop = c.findIndex((r) => r.kg === 32);
  assert.ok(firstTop >= 0 && c.slice(firstTop).every((r) => r.kg === 32), 'C keeps 32 kg TGU after deload');
});

test('R3 P1-2: presses/TGU start at the standard bell and can progress one standard step', () => {
  const m = live3(LIVE.M, 6, 16);
  assert.equal(m['kb-press'][0].kg, 16, 'beginner man starts pressing 16');
  assert.equal(m['kb-tgu'][0].kg, 16, 'beginner man starts get-ups at 16');
  assert.ok(Math.max(...m['kb-press'].map((r) => r.kg)) >= 20, 'press progresses 16 → 20');
  const b = live3(LIVE.B, 6, 8);
  assert.ok(Math.max(...b['kb-tgu'].map((r) => r.kg)) >= 16, 'B TGU 12 → 16 (+4 kg step)');
  // never more than one standard size per jump
  for (const hist of [m, b, live3(LIVE.C, 6, 16)]) for (const rows of Object.values(hist)) {
    const xs = rows.filter((r) => !r.hold).map((r) => r.kg);
    for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] <= 8, `jump ${xs[i - 1]} → ${xs[i]}`);
  }
});

test('R3 P1-3: long run never shrinks through Build and reaches ≥ 60 min (intermediate, 12 weeks)', () => {
  for (const prof of [{ ...PROFILE, daysPerWeek: 4, bells: [{ kg: 16, count: 1 }, { kg: 20, count: 1 }, { kg: 24, count: 1 }] }, LIVE.A]) {
    const plan = generatePlan(prof, START);
    const longOf = (wk) => Math.max(0, ...wk.days.filter((d) => d.workoutId).flatMap((d) => allItems(plan.workouts[d.workoutId])).filter((it) => it.exId === 'run-long').map((it) => it.timeSec));
    const base = plan.weeks.filter((w) => w.phase === 'base' && !w.deload);
    const lastBaseLong = longOf(base[base.length - 1]);
    const build = plan.weeks.filter((w) => w.phase === 'build' && !w.deload);
    for (const wk of build.slice(1)) assert.ok(longOf(wk) >= lastBaseLong * 0.9, `week ${wk.index + 1}: ${longOf(wk) / 60} vs ${lastBaseLong / 60}`);
    assert.ok(longOf(build[build.length - 1]) >= 3600, `last build long ${longOf(build[build.length - 1]) / 60}`);
    let prev = 0;
    for (const wk of plan.weeks.filter((w) => !w.deload && w.phase !== 'taper')) {
      const l = longOf(wk);
      if (l && prev) assert.ok(l <= prev + 600, `long run +${(l - prev) / 60} min in week ${wk.index + 1}`);
      if (l) prev = Math.max(prev, l);
    }
  }
});
