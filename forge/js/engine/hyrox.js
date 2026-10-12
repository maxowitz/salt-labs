// FORGE HYROX engine — race spec, paces, HR zones, readiness check-in, race predictor and readiness score.
// Pure functions, import-safe in Node. Spec per the 2024/25 HYROX rulebook. See docs/PROMPT.md §4, §6.5a.

import { daysBetween } from '../store.js';
import { getExercise } from '../data/exercises.js';

// Race order. spec strings are display text; kg holds numeric loads where relevant.
export const STATIONS = [
  {
    id: 'skierg', name: 'SkiErg', exId: 'hx-ski', distanceM: 1000,
    spec: { open_m: '1000 m', open_w: '1000 m', pro_m: '1000 m', pro_w: '1000 m' },
    subs: ['erg-ski', 'kb-swing-double', 'kb-snatch', 'bw-band-pulldown'],
    tips: ['Start controlled — the first 200 m sets up your whole race', 'Long strokes with a hip hinge; keep the arms fresh for the sleds', 'No SkiErg? Double swings + band pull-downs, or snatches, train the same hinge-and-pull pattern'],
  },
  {
    id: 'sled-push', name: 'Sled Push', exId: 'hx-sled-push', distanceM: 50,
    spec: { open_m: '152 kg incl. sled', open_w: '102 kg incl. sled', pro_m: '202 kg incl. sled', pro_w: '152 kg incl. sled' },
    kg: { open_m: 152, open_w: 102, pro_m: 202, pro_w: 152 },
    subs: ['kb-rack-carry', 'run-hill-sprints', 'kb-bear-crawl-drag'],
    tips: ['4 × 12.5 m lengths. Low body angle, arms long, short driving steps', 'Keep it moving — restarting a stopped sled costs the most', 'Train it with heavy double front-rack walks, hill sprints and bear-crawl drags'],
  },
  {
    id: 'sled-pull', name: 'Sled Pull', exId: 'hx-sled-pull', distanceM: 50,
    spec: { open_m: '103 kg incl. sled', open_w: '78 kg incl. sled', pro_m: '153 kg incl. sled', pro_w: '103 kg incl. sled' },
    kg: { open_m: 103, open_w: 78, pro_m: 153, pro_w: 103 },
    subs: ['kb-towel-drag', 'kb-gorilla-row', 'kb-row', 'kb-high-pull'],
    tips: ['Athlete stays in the box; pull hand over hand with long strokes', 'Sit back and use your legs — step back between pulls', 'Train it with towel drags, heavy rows and high pulls'],
  },
  {
    id: 'bbj', name: 'Burpee Broad Jumps', exId: 'hx-bbj', distanceM: 80,
    spec: { open_m: '80 m', open_w: '80 m', pro_m: '80 m', pro_w: '80 m' },
    subs: ['bw-bbj', 'bw-burpee'],
    tips: ['Chest to floor, two-foot take-off and landing', 'Moderate jumps, steady rhythm — this station rewards pacing', 'Step back and step in if your legs are cooked'],
  },
  {
    id: 'row', name: 'Row', exId: 'hx-row', distanceM: 1000,
    spec: { open_m: '1000 m', open_w: '1000 m', pro_m: '1000 m', pro_w: '1000 m' },
    subs: ['erg-row', 'kb-swing', 'run'],
    tips: ['Damper 5–6, 26–30 strokes/min, legs drive first', 'Use it to bring the heart rate back under control', 'No rower? Swings + a short run replicate the hinge and the engine'],
  },
  {
    id: 'farmers', name: 'Farmers Carry', exId: 'hx-farmers', distanceM: 200,
    spec: { open_m: '2 × 24 kg', open_w: '2 × 16 kg', pro_m: '2 × 32 kg', pro_w: '2 × 24 kg' },
    kg: { open_m: 24, open_w: 16, pro_m: 32, pro_w: 24 },
    subs: ['kb-farmers-carry', 'kb-suitcase-carry'],
    tips: ['Race-spec kettlebells — train with the exact bells if you own them', 'Fast, short steps; aim for no more than one put-down', 'Grip endurance comes from heavy carries and swings'],
  },
  {
    id: 'sandbag-lunges', name: 'Sandbag Lunges', exId: 'hx-sandbag-lunge', distanceM: 100,
    spec: { open_m: '20 kg', open_w: '10 kg', pro_m: '30 kg', pro_w: '20 kg' },
    kg: { open_m: 20, open_w: 10, pro_m: 30, pro_w: 20 },
    subs: ['kb-rack-walking-lunge', 'kb-goblet-walking-lunge', 'bw-lunge'],
    tips: ['Back knee touches the ground each step, stand fully', 'Bag on the shoulders; you may not drop it to the floor and rest it there', 'Front-rack or goblet walking lunges are the best home substitute'],
  },
  {
    id: 'wall-balls', name: 'Wall Balls', exId: 'hx-wall-balls', reps: 100,
    spec: { open_m: '6 kg to 3.0 m', open_w: '4 kg to 2.7 m', pro_m: '9 kg to 3.0 m', pro_w: '6 kg to 2.7 m' },
    kg: { open_m: 6, open_w: 4, pro_m: 9, pro_w: 6 },
    subs: ['kb-goblet-thruster', 'kb-double-thruster', 'kb-thruster'],
    tips: ['100 reps, squat below parallel, ball must hit the target', 'Plan your sets (e.g. 25-20-20-15-10-10) and stick to short breaks', 'Goblet thrusters build the same squat-to-overhead engine'],
  },
];

export const specKey = (profile = {}) => `${profile.division === 'pro' ? 'pro' : 'open'}_${profile.sex === 'f' ? 'w' : 'm'}`;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fmt = (sec) => { sec = Math.round(sec); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60; return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + String(s).padStart(2, '0'); };

// Race-run pace ÷ 5 km pace with no compromised-running history (shared with predictRace).
export const RACE_RUN_FACTOR = 1.24;

// Typical 5 km by experience when the athlete has no benchmark (sec).
export function estimateFiveK(profile = {}) {
  const base = { beginner: 1920, intermediate: 1500, advanced: 1260 }[profile.experience] || 1500;
  return Math.round(base * (profile.sex === 'f' ? 1.1 : 1));
}

// Daniels-style training paces (sec/km) from a 5 km time. opts.experience refines HYROX race pace.
export function paces(fiveKSec, opts = {}) {
  const t = Number.isFinite(+fiveKSec) && +fiveKSec > 600 ? +fiveKSec : 1500;
  const r = t / 5;
  const R = (x) => Math.round(r * x);
  return {
    fiveK: R(1),
    interval: R(0.97),         // VO2max reps (~3 km pace)
    threshold: R(1.06),        // ~ 1-hour race pace
    tempo: R(1.12),            // steady / comfortably hard
    race: R(RACE_RUN_FACTOR + (opts.experience === 'advanced' ? -0.03 : 0)), // HYROX compromised 1 km pace (= predictor)
    easy: [R(1.25), R(1.4)],
    z2: [R(1.28), R(1.45)],
    long: [R(1.3), R(1.45)],
  };
}

export const defaultHrMax = (age) => Math.round(208 - 0.7 * (Number.isFinite(+age) ? +age : 35));

export function hrZones(hrMax) {
  const m = Number.isFinite(+hrMax) && +hrMax > 100 ? +hrMax : defaultHrMax(35);
  const z = [[1, 0.5, 0.65, 'Recovery'], [2, 0.65, 0.78, 'Aerobic (Zone 2)'], [3, 0.78, 0.85, 'Tempo'], [4, 0.85, 0.92, 'Threshold'], [5, 0.92, 1, 'VO2 max']];
  return z.map(([n, lo, hi, label]) => ({ z: n, lo: Math.round(m * lo), hi: Math.round(m * hi), label }));
}

// Check-in 1..5 each → 0..100. Answers map to points so a "normal" day (all 3s) = 70 → train as planned.
// Soreness and stress are inverted (5 = very sore / very stressed).
export const READINESS_POINTS = { 1: 0, 2: 40, 3: 70, 4: 85, 5: 100 };
export function readinessScore(checkin = {}) {
  const v = (k) => Math.round(clamp(Number.isFinite(+checkin[k]) && checkin[k] !== null && checkin[k] !== '' ? +checkin[k] : 3, 1, 5));
  const pos = (k) => READINESS_POINTS[v(k)], neg = (k) => READINESS_POINTS[6 - v(k)];
  const s = 0.3 * pos('sleep') + 0.3 * pos('energy') + 0.2 * neg('soreness') + 0.2 * neg('stress');
  return Math.round(clamp(s, 0, 100));
}

// ---------- Session mining helpers ----------
const recent = (sessions, todayISO, days) => (sessions || []).filter((s) => {
  if (!s || !s.date) return false;
  if (!todayISO) return true;
  const d = daysBetween(s.date, todayISO);
  return d >= 0 && d < days;
});

// Benchmark-quality run efforts in a session: time-trial templates, sessions/entries flagged `benchmark: true`,
// and manual cardio logs (no workoutId). Training reps inside intervals/circuits/sims never count.
export const TT_IDS = ['t-1k-tt', 't-5k-tt'];
export function benchmarkRuns(s) {
  const out = [];
  if (!s) return out;
  const whole = s.benchmark === true || TT_IDS.includes(s.workoutId);
  for (const c of s.cardio || []) {
    if (!c || (c.mode || 'run') !== 'run' || !(+c.distanceM > 0) || !(+c.timeSec > 0)) continue;
    if (whole || c.benchmark === true || !s.workoutId) out.push({ d: +c.distanceM, t: +c.timeSec, date: s.date });
  }
  for (const x of s.sets || []) {
    if (!x || getExercise(x.exId).category !== 'run' || !(+x.distanceM > 0) || !(+x.timeSec > 0)) continue;
    if (whole || x.benchmark === true) out.push({ d: +x.distanceM, t: +x.timeSec, date: s.date });
  }
  return out;
}
const runEfforts = (sessions) => (sessions || []).flatMap(benchmarkRuns);

const near = (d, target, tol = 0.03) => Math.abs(d - target) <= target * tol;
const best = (list) => list.reduce((a, b) => (!a || b.t < a.t ? b : a), null);

function ergEffort(sessions, mode, distance = 1000) {
  const out = [];
  for (const s of sessions || []) {
    for (const c of s.cardio || []) if (c && c.mode === mode && near(+c.distanceM, distance) && +c.timeSec > 0) out.push({ t: +c.timeSec, date: s.date });
    const ids = mode === 'ski' ? ['erg-ski', 'hx-ski'] : ['erg-row', 'hx-row'];
    for (const x of s.sets || []) if (x && ids.includes(x.exId) && near(+x.distanceM, distance) && +x.timeSec > 0) out.push({ t: +x.timeSec, date: s.date });
  }
  return best(out);
}

// Latest station benchmark per station (hx-* sets with a time), scaled to full distance if partial.
function stationBenchmarks(sessions) {
  const out = {};
  for (const s of sessions || []) {
    for (const x of s.sets || []) {
      const st = STATIONS.find((q) => q.exId === x?.exId);
      if (!st || !(+x.timeSec > 0)) continue;
      let t = +x.timeSec;
      if (st.distanceM && +x.distanceM > 0 && +x.distanceM < st.distanceM) t *= (st.distanceM / x.distanceM) * 1.1;
      if (st.reps && +x.reps > 0 && +x.reps < st.reps) t *= (st.reps / x.reps) * 1.1;
      if (!out[st.id] || (s.date || '') >= out[st.id].date) out[st.id] = { t, date: s.date || '' };
    }
  }
  return out;
}

// Best 10-minute swing test (reps × bell kg).
function swingTest(sessions) {
  let bestT = null;
  for (const s of sessions || []) {
    const isTest = s.workoutId === 't-swing-test' || /swing test/i.test(s.title || '');
    if (!isTest) continue;
    let reps = 0, kg = 0;
    for (const x of s.sets || []) if (/^kb-swing/.test(x?.exId || '')) { reps += +x.reps || 0; kg = Math.max(kg, +x.kg || 0); }
    if (reps && (!bestT || reps * kg > bestT.reps * bestT.kg)) bestT = { reps, kg, date: s.date };
  }
  return bestT;
}

const isCompromised = (s) => {
  if (!s) return false;
  if (s.type === 'hybrid' || s.type === 'hyrox') return true;
  const ids = (s.sets || []).map((x) => x?.exId);
  const run = ids.some((id) => getExercise(id).category === 'run') || (s.cardio || []).some((c) => (c?.mode || 'run') === 'run');
  const station = ids.some((id) => !!getExercise(id).hyrox);
  return run && station;
};

// ---------- Race predictor ----------
const STATION_BASE = { skierg: 290, 'sled-push': 200, 'sled-pull': 270, bbj: 300, row: 300, farmers: 120, 'sandbag-lunges': 290, 'wall-balls': 360 };
const EXP_MULT = { beginner: 1.2, intermediate: 1, advanced: 0.82 };
const EXP_MULT_ERG = { beginner: 1.15, intermediate: 1, advanced: 0.88 };
const PRO_MULT = { 'sled-push': 1.35, 'sled-pull': 1.3, farmers: 1.12, 'sandbag-lunges': 1.2, 'wall-balls': 1.2 };
const KB_HEAVY = ['sled-push', 'sled-pull', 'farmers', 'sandbag-lunges', 'wall-balls'];

export function predictRace(state = {}, todayISO) {
  const profile = state.profile || {};
  const sessions = Array.isArray(state.sessions) ? state.sessions : [];
  const basis = [];
  const today = todayISO || [...sessions].map((s) => s?.date).filter(Boolean).sort().pop() || null;
  const window = today ? recent(sessions, today, 120) : sessions;
  const exp = EXP_MULT[profile.experience] ? profile.experience : 'intermediate';
  const female = profile.sex === 'f', pro = profile.division === 'pro', doubles = profile.division === 'doubles';
  const bw = +profile.weightKg > 30 ? +profile.weightKg : (female ? 65 : 80);

  // Running fitness → 5 km equivalent pace.
  const efforts = runEfforts(window);
  const tt5 = best(efforts.filter((e) => near(e.d, 5000)));
  const tt1 = best(efforts.filter((e) => near(e.d, 1000)));
  // 5 km equivalent = best of profile time and benchmarks; a slower effort can never worsen the prediction.
  const cands = [];
  if (+profile.fiveKSec > 600) cands.push({ v: +profile.fiveKSec, label: `Profile 5 km time ${fmt(+profile.fiveKSec)}` });
  if (tt5) cands.push({ v: tt5.t, label: `5 km benchmark ${fmt(tt5.t)} (${tt5.date})`, logged: true });
  if (tt1) cands.push({ v: tt1.t * 5.5, label: `1 km benchmark ${fmt(tt1.t)} (${tt1.date})`, logged: true });
  let fiveK, runLogged = false;
  if (cands.length) {
    const bestC = cands.reduce((a, b) => (b.v < a.v ? b : a));
    fiveK = bestC.v; runLogged = cands.some((c) => c.logged);
    for (const c of cands) basis.push(c === bestC ? `${c.label} — used` : c.label);
  } else { fiveK = estimateFiveK(profile); basis.push(`No run benchmark — estimated from ${exp} experience`); }

  const compromised = (today ? recent(sessions, today, 56) : sessions).filter(isCompromised).length;
  if (compromised) basis.push(`${compromised} compromised-run session${compromised > 1 ? 's' : ''} in the last 8 weeks`);
  const runFactor = RACE_RUN_FACTOR - Math.min(compromised, 8) * 0.01 + ({ beginner: 0.04, intermediate: 0, advanced: -0.03 })[exp];
  const runPace = (fiveK / 5) * runFactor;
  const runWeights = Array.from({ length: 8 }, (_, i) => 0.965 + 0.01 * i);
  const runSplits = runWeights.map((w) => runPace * w);

  // Stations: baseline × modifiers, overridden by logged benchmarks.
  const bench = stationBenchmarks(window);
  const ski = ergEffort(window, 'ski'), row = ergEffort(window, 'row');
  const swings = swingTest(window);
  let kbFactor = 1;
  if (swings && swings.kg) {
    const ratio = (swings.reps * swings.kg / bw) / 60;
    kbFactor = clamp(1 / Math.pow(Math.max(ratio, 0.1), 0.3), 0.82, 1.25);
    basis.push(`10-min swing test ${swings.reps} × ${swings.kg} kg`);
  }
  let stationLogged = 0;
  const stationSplits = STATIONS.map((st) => {
    let t = STATION_BASE[st.id] * (st.id === 'skierg' || st.id === 'row' ? EXP_MULT_ERG : EXP_MULT)[exp] * (female ? 1.08 : 1);
    if (pro) t *= PRO_MULT[st.id] || 1;
    if (KB_HEAVY.includes(st.id)) t *= kbFactor;
    if (st.id === 'skierg' && ski) { t = ski.t * 1.06; stationLogged++; basis.push(`SkiErg 1000 m ${fmt(ski.t)}`); }
    if (st.id === 'row' && row) { t = row.t * 1.06; stationLogged++; basis.push(`Row 1000 m ${fmt(row.t)}`); }
    if (bench[st.id]) { t = bench[st.id].t; stationLogged++; }
    if (doubles) t *= 0.6;
    return t;
  });
  const benchCount = Object.keys(bench).length;
  if (benchCount) basis.push(`${benchCount} station benchmark${benchCount > 1 ? 's' : ''} logged`);

  const roxzoneSec = { beginner: 480, intermediate: 390, advanced: 300 }[exp];
  const splits = [];
  STATIONS.forEach((st, i) => {
    splits.push({ name: `Run ${i + 1}`, sec: Math.round(runSplits[i]) });
    splits.push({ name: st.name, sec: Math.round(stationSplits[i]) });
  });
  splits.push({ name: 'Roxzone (transitions)', sec: roxzoneSec });

  const runSec = Math.round(runSplits.reduce((a, b) => a + b, 0));
  const stationSec = Math.round(stationSplits.reduce((a, b) => a + b, 0));
  const totalSec = Math.round(clamp(runSec + stationSec + roxzoneSec, 45 * 60, 3 * 3600));
  const confidence = runLogged && (stationLogged >= 3 || (stationLogged >= 1 && swings)) ? 'high' : (runLogged || stationLogged || swings) ? 'med' : 'low';
  return { totalSec, runSec, stationSec, roxzoneSec, splits, basis, confidence, runPaceSec: Math.round(runPace) };
}

// ---------- HYROX readiness (0..100) ----------
function runKm(sessions, easyPace) {
  let m = 0;
  for (const s of sessions) {
    for (const c of s.cardio || []) if (c && (c.mode || 'run') === 'run') m += +c.distanceM || ((+c.timeSec || 0) / easyPace) * 1000;
    for (const x of s.sets || []) if (x && getExercise(x.exId).category === 'run') m += +x.distanceM || ((+x.timeSec || 0) / easyPace) * 1000;
  }
  return m / 1000;
}

export function hyroxReadiness(state = {}, todayISO) {
  const profile = state.profile || {};
  const sessions = (Array.isArray(state.sessions) ? state.sessions : []).filter(Boolean);
  const exp = EXP_MULT[profile.experience] ? profile.experience : 'intermediate';
  const today = todayISO || sessions.map((s) => s.date).filter(Boolean).sort().pop() || '2000-01-01';
  const p = paces(+profile.fiveKSec > 600 ? +profile.fiveKSec : estimateFiveK(profile));
  const last28 = recent(sessions, today, 28), last14 = recent(sessions, today, 14);
  const prev14 = last28.filter((s) => !last14.includes(s));

  // Aerobic base
  const kmTarget = { beginner: 15, intermediate: 25, advanced: 35 }[exp];
  const weeklyKm = runKm(last28, p.easy[0]) / 4;
  const trendUp = runKm(last14, p.easy[0]) >= runKm(prev14, p.easy[0]);
  const aerobic = Math.round(clamp((weeklyKm / kmTarget) * 100, 0, 100));

  // Strength: heaviest bell used on hinge/carry/squat vs race farmers spec
  const spec = STATIONS.find((s) => s.id === 'farmers').kg[specKey(profile)];
  let heavy = 0;
  for (const s of last28) for (const x of s.sets || []) {
    const ex = getExercise(x?.exId);
    if (ex.category === 'kb' && ['hinge', 'carry', 'squat', 'ballistic'].includes(ex.pattern)) heavy = Math.max(heavy, +x.kg || 0);
  }
  const owned = Math.max(0, ...((profile.bells || []).map((b) => +b.kg || 0)));
  if (!heavy) heavy = Math.round(owned * 0.8 / 4) * 4;
  const strength = Math.round(clamp((heavy / spec) * 100, 0, 100));

  // Station practice
  const practiced = new Set();
  let stationSessions = 0;
  for (const s of last28) {
    let any = false;
    for (const x of s.sets || []) { const st = getExercise(x?.exId).hyrox; if (st) { practiced.add(st); any = true; } }
    if (any) stationSessions++;
  }
  const station = Math.round(clamp(50 * practiced.size / 8 + 50 * Math.min(1, stationSessions / 6), 0, 100));

  // Compromised running
  const comp = recent(sessions, today, 42).filter(isCompromised).length;
  const compromised = Math.round(clamp((comp / 6) * 100, 0, 100));

  // Consistency
  const planned = Math.max(3, Math.min(6, +profile.daysPerWeek || 4)) * 4;
  const consistency = Math.round(clamp((last28.length / planned) * 100, 0, 100));

  const parts = [
    { label: 'Aerobic base', score: aerobic, weight: 0.25, tip: aerobic >= 80 ? `${weeklyKm.toFixed(1)} km/week — solid base${trendUp ? ', trending up' : ''}.` : `${weeklyKm.toFixed(1)} km/week. Build toward ${kmTarget} km/week with easy Zone 2 runs (+10%/week).` },
    { label: 'Strength', score: strength, weight: 0.15, tip: strength >= 90 ? `Heaviest working bell ${heavy} kg covers race-spec carries (${spec} kg).` : `Work up to carrying and swinging ${spec} kg bells — race-spec farmers carry.` },
    { label: 'Station practice', score: station, weight: 0.2, tip: practiced.size >= 6 ? `${practiced.size}/8 stations practised in 4 weeks.` : `Only ${practiced.size}/8 stations practised in 4 weeks — rotate all eight (subs count).` },
    { label: 'Compromised running', score: compromised, weight: 0.2, tip: comp >= 6 ? `${comp} run↔station sessions in 6 weeks — race-ready legs.` : `${comp} run↔station sessions in 6 weeks. Aim for one per week: run 1 km straight off a station.` },
    { label: 'Consistency', score: consistency, weight: 0.2, tip: consistency >= 85 ? `${last28.length} sessions in 4 weeks — keep stacking.` : `${last28.length}/${planned} planned sessions in 4 weeks. Consistency beats heroics.` },
  ];
  const score = Math.round(parts.reduce((a, x) => a + x.score * x.weight, 0));
  return { score, parts: parts.map(({ weight, ...x }) => x) };
}
