// Engine unit tests: node --test forge/tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, daysBetween } from '../js/store.js';
import { EXERCISES, getExercise, hasExercise } from '../js/data/exercises.js';
import { PHASES, generatePlan, getWorkout, workoutForDate, TEMPLATES } from '../js/engine/program.js';
import { ownedBells, pairedBells, suggestWeight, lastPerformance, scaleWorkout, detectPRs, trainingLoad, weekSummary, streak } from '../js/engine/coach.js';
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
  const sq = (wk) => allItems(plan.workouts[plan.weeks[wk].days[0].workoutId]).find((it) => /front-squat|goblet-squat/.test(it.exId) && it.sets);
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
      const kg = suggestWeight(e.id, { ...PROFILE, experience: exp, sex }, []);
      assert.ok(ownedBells(PROFILE).includes(kg), `${e.id} ${exp} ${sex} → ${kg}`);
      if (e.double) assert.ok(pairedBells(PROFILE).includes(kg), `${e.id} must be a pair`);
    }
  }
  assert.equal(suggestWeight('run-easy', PROFILE, []), null);
  assert.equal(suggestWeight('bw-pushup', PROFILE, []), null);
  assert.equal(suggestWeight('kb-swing', { ...PROFILE, bells: [] }, []), null);
  assert.equal(suggestWeight('kb-double-front-squat', MINIMAL, []), 16, 'falls back to the single bell');
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
  assert.equal(readinessScore({}), 50);
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
