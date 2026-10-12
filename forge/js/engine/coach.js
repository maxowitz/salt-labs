// FORGE coach — bell selection (double progression), readiness scaling, PRs, training load, summaries.
// Pure functions, import-safe in Node. See docs/PROMPT.md §4, §6.5a.

import { addDays, daysBetween } from '../store.js';
import { getExercise } from '../data/exercises.js';
import { benchmarkRuns } from './hyrox.js';

const EXP = ['beginner', 'intermediate', 'advanced'];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fmtT = (sec) => { sec = Math.round(sec); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60; return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + String(s).padStart(2, '0'); };
const byDate = (a, b) => String(a?.date || '').localeCompare(String(b?.date || '')) || String(a?.startedAt || '').localeCompare(String(b?.startedAt || ''));

// ---------- Bells ----------
function bellCounts(profile) {
  const m = new Map();
  for (const b of profile?.bells || []) {
    const kg = +b?.kg;
    if (Number.isFinite(kg) && kg > 0) m.set(kg, (m.get(kg) || 0) + Math.max(1, +b.count || 1));
  }
  return m;
}

export function ownedBells(profile) {
  return [...bellCounts(profile).keys()].sort((a, b) => a - b);
}

// Bells owned as a matching pair (for double-bell work).
export function pairedBells(profile) {
  return [...bellCounts(profile).entries()].filter(([, n]) => n >= 2).map(([kg]) => kg).sort((a, b) => a - b);
}

const atOrBelow = (pool, kg) => { let r = null; for (const b of pool) if (b <= kg + 1e-9) r = b; return r ?? pool[0]; };
const nextUp = (pool, kg) => pool.find((b) => b > kg) ?? kg;

// Default "top of the rep range" per pattern for double progression.
function topReps(ex) {
  if (/swing|high-pull|snatch/.test(ex.id)) return 15;
  return { ballistic: 10, press: 8, squat: 8, hinge: 10, pull: 10, lunge: 10, core: 3, carry: 1, mobility: 10 }[ex.pattern] || 8;
}

export function lastPerformance(exId, sessions) {
  const list = (Array.isArray(sessions) ? sessions : []).filter((s) => s && Array.isArray(s.sets)).sort(byDate);
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    const sets = s.sets.filter((x) => x && x.exId === exId);
    if (!sets.length) continue;
    const kg = Math.max(0, ...sets.map((x) => +x.kg || 0));
    const atKg = sets.filter((x) => (+x.kg || 0) === kg);
    const rpes = sets.map((x) => +x.rpe).filter(Number.isFinite);
    return {
      kg: kg || null,
      reps: Math.max(0, ...atKg.map((x) => +x.reps || 0)) || null,
      timeSec: Math.max(0, ...sets.map((x) => +x.timeSec || 0)) || null,
      distanceM: Math.max(0, ...sets.map((x) => +x.distanceM || 0)) || null,
      date: s.date,
      sets: atKg.length,
      minReps: Math.min(...atKg.map((x) => +x.reps || 0)),
      rpe: rpes.length ? Math.max(...rpes) : (Number.isFinite(+s.rpe) && s.rpe != null ? +s.rpe : null),
    };
  }
  return null;
}

// ---------- Bell targets & safety ----------
const STRICT = new Set(['kb-tgu', 'kb-snatch', 'kb-overhead-carry', 'kb-windmill', 'kb-thruster', 'kb-double-thruster', 'kb-goblet-thruster', 'kb-armbar']);
const NEAREST_PATTERNS = new Set(['squat', 'hinge', 'pull', 'carry']);

const expOf = (profile) => (EXP.includes(profile?.experience) ? profile.experience : 'intermediate');
const bwOf = (profile) => (+profile?.weightKg > 30 ? +profile.weightKg : (profile?.sex === 'f' ? 65 : 80));

// Ideal bell (kg, per bell) from experience, sex and bodyweight.
export function targetKg(exId, profile) {
  const ex = getExercise(exId);
  if (ex.category !== 'kb' || !ex.loadRatio) return null;
  return ex.loadRatio[expOf(profile)] * bwOf(profile) * (profile?.sex === 'f' ? 0.75 : 1);
}

// How far above target a bell may be before it is unsafe for a first exposure.
function heavyLimit(ex) {
  if (ex.pattern === 'press' || STRICT.has(ex.id)) return 1.35;
  if (ex.pattern === 'carry' || ex.id === 'kb-bear-crawl-drag' || ex.id === 'kb-towel-drag') return ex.pattern === 'carry' ? 2 : 2.5; // drags slide on the floor
  if (ex.pattern === 'hinge') return 1.8;
  return 1.6;
}

const poolFor = (ex, profile) => {
  const pairs = pairedBells(profile);
  return ex.double && pairs.length ? pairs : ownedBells(profile);
};

function baselineKg(ex, profile) {
  const pool = poolFor(ex, profile);
  if (!pool.length) return null;
  const target = targetKg(ex.id, profile);
  if (NEAREST_PATTERNS.has(ex.pattern)) {
    const near = pool.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
    if (near <= target * 1.15) return near;
  }
  return atOrBelow(pool, target * 1.08);
}

// True when the lightest suitable owned bell (or `kg` if given) is unsafe for this athlete on this lift.
export function tooHeavy(exId, profile, kg) {
  const ex = getExercise(exId);
  if (ex.category !== 'kb' || !ex.loadRatio) return false;
  const pool = poolFor(ex, profile);
  if (!pool.length) return false;
  const bell = kg != null ? kg : baselineKg(ex, profile);
  return bell > targetKg(exId, profile) * heavyLimit(ex);
}

// Suggested bell (kg) for a KB exercise, always one the athlete owns (a pair for double-bell lifts when owned).
// Returns null for non-KB work, when no bells are owned, or when every owned bell is too heavy (see tooHeavy) and the
// athlete has no logged history with this lift — the caller should then regress the exercise.
// opts: { topReps } overrides the rep target that triggers a bell jump; { step } moves n owned sizes up (plan progression).
export function suggestWeight(exId, profile, sessions = [], opts = {}) {
  const ex = getExercise(exId);
  if (ex.category !== 'kb' || !ex.loadRatio) return null;
  const pool = poolFor(ex, profile);
  if (!pool.length) return null;
  let kg = baselineKg(ex, profile);

  const last = lastPerformance(exId, sessions);
  if (last && last.kg) {
    kg = atOrBelow(pool, last.kg);
    const top = opts.topReps || topReps(ex);
    const hitTop = ex.pattern === 'carry' ? (last.distanceM || 0) >= 40 || (last.timeSec || 0) >= 45 : last.minReps >= top;
    if (hitTop && (last.rpe == null || last.rpe <= 8)) kg = nextUp(pool, kg);
  } else if (tooHeavy(exId, profile, kg)) return null;
  for (let i = 0; i < (opts.step || 0); i++) kg = nextUp(pool, kg);
  return kg;
}

// Live recommendation for a planned KB item (plan bells are frozen at generation; this applies logged progress).
// Returns { kg, reason, earned }:
//  - non-KB item, or no bells owned → item.kg ?? null, reason ''.
//  - item.hold (warm-ups, deload/taper, spec-weight station work) → item.kg unchanged.
//  - no history with this lift → item.kg (or the baseline suggestion when the item has none).
//  - last session at bell B: all sets reached item.reps (or the default top of range) at RPE ≤ 8 → next owned bell
//    above B ("earned"); RPE ≥ 9 or missed reps → B ("repeat"); otherwise B.
//  - result is max(planned kg, history kg) except after a "repeat" verdict on the planned bell; always an owned bell.
export function liveItemAdvice(item, profile, sessions = []) {
  const planned = item?.kg != null ? +item.kg : null;
  const ex = getExercise(item?.exId);
  if (!item || ex.category !== 'kb' || !ex.loadRatio) return { kg: planned, reason: '', earned: false };
  const pool = poolFor(ex, profile);
  if (!pool.length) return { kg: planned, reason: '', earned: false };
  if (item.hold) return { kg: planned, reason: '', earned: false };
  const last = lastPerformance(item.exId, sessions);
  if (!last || !last.kg) return { kg: planned ?? suggestWeight(item.exId, profile, []), reason: '', earned: false };
  const base = atOrBelow(pool, last.kg);
  const top = +item.reps > 0 ? +item.reps : topReps(ex);
  const hitTop = ex.pattern === 'carry' ? (last.distanceM || 0) >= (+item.distanceM || 40) : last.minReps >= top;
  if (last.rpe != null && last.rpe >= 9 || (!hitTop && ex.pattern !== 'carry' && last.minReps < top && planned != null && base >= planned)) {
    return { kg: planned != null ? Math.min(planned, base) : base, reason: 'Repeat this bell — own all reps first', earned: false };
  }
  if (hitTop && (last.rpe == null || last.rpe <= 8)) {
    const up = nextUp(pool, base);
    const kg = Math.max(up, planned ?? 0);
    if (up > base && up >= (planned ?? 0)) return { kg, reason: 'Earned: you hit the top of the rep range last time', earned: true };
    return { kg, reason: up === base ? 'Top owned bell — progress with reps, sets or less rest' : '', earned: false };
  }
  return { kg: Math.max(base, planned ?? 0), reason: '', earned: false };
}

export const liveItemWeight = (item, profile, sessions) => liveItemAdvice(item, profile, sessions).kg;

// ---------- Readiness scaling ----------
const QUALITY_RUN = new Set(['run-tempo', 'run-threshold', 'run-intervals', 'run-1k', 'run-hill-sprints', 'run-fartlek']);
const scaleN = (v, f, min = 1) => Math.max(min, Math.round(v * f));

function recoveryBlocks(minutes = 25) {
  return [
    { kind: 'warmup', title: 'Breathe & reset', notes: 'Down-regulate first: slow nasal breathing.', items: [{ exId: 'mob-breathing', timeSec: 120 }, { exId: 'mob-cat-cow', reps: 10 }] },
    { kind: 'cardio', title: 'Easy flush', notes: 'Zone 1 — walk or very easy spin. Nothing should feel hard.', items: [{ exId: 'mob-walk', timeSec: Math.max(10, minutes - 15) * 60, note: 'Zone 1, nasal breathing' }] },
    {
      kind: 'cooldown', title: 'Mobility flow', notes: 'Move slowly, 2–3 breaths per position.', items: [
        { exId: 'mob-90-90', reps: 8 }, { exId: 'mob-wgs', reps: 4, perSide: true }, { exId: 'mob-t-spine', reps: 6, perSide: true },
        { exId: 'mob-couch', timeSec: 60, perSide: true }, { exId: 'mob-pigeon', timeSec: 60, perSide: true }, { exId: 'mob-childs-pose', timeSec: 60 },
      ],
    },
  ];
}

const BENCH_IDS = new Set(['t-1k-tt', 't-5k-tt', 't-swing-test', 't-station-benchmark']);
const RUN_FAST = /race|threshold|interval|tempo/i;

export function scaleWorkout(workout, readinessScore) {
  if (!workout) return { workout: null, changes: [] };
  const w = structuredClone(workout);
  const score = Number(readinessScore);
  if (readinessScore == null || !Number.isFinite(score) || score > 60 || w.type === 'recovery' || !Array.isArray(w.blocks)) return { workout: w, changes: [] };

  // Race-day sessions are never altered; benchmarks are postponed rather than diluted.
  if (w.fixed) {
    return { workout: w, changes: [/race/i.test(w.title || '') ? 'Race day — no changes. Low readiness: start the first 2 km 10 s/km slower than target and fuel early.' : `${w.title} — no changes. Keep it light and controlled today.`] };
  }
  if (w.benchmark || BENCH_IDS.has(w.id)) {
    return { workout: w, changes: [`Readiness ${Math.round(score)}/100 — postpone the benchmark to a day you feel fresh (score > 60); a tired test under-reports your fitness.`] };
  }

  if (score < 40) {
    const out = {
      ...w, title: `Recovery Flow (was: ${w.title})`, type: 'recovery', estMin: 30, scaled: 'recovery',
      summary: 'Low readiness — today is about recovery. Easy movement, mobility and breathing; the planned session can wait.',
      equipment: [], blocks: recoveryBlocks(30),
    };
    return { workout: out, changes: [`Readiness ${Math.round(score)}/100 is low — swapped "${w.title}" for a 30-min recovery flow.`, 'Prioritise sleep, food and hydration today.'] };
  }

  const changes = new Map(); // one line per kind of change
  const add = (k, msg) => { if (!changes.has(k)) changes.set(k, msg); };
  const sim = w.type === 'hyrox';
  const toEasy = (it) => { it.exId = it.exId === 'run-long' ? 'run-long' : 'run-easy'; delete it.paceSec; it.note = 'Zone 2 — conversational'; };
  const cut5 = (m, f) => Math.max(5, Math.round((m * f) / 5) * 5);
  let easyRuns = 0;

  for (const b of w.blocks) {
    const items = b.items || [];
    if (b.kind === 'warmup' || b.kind === 'cooldown') continue;
    if (b.kind === 'strength') {
      for (const it of items) if (it.sets > 1) it.sets = scaleN(it.sets, 0.75);
      add('sets', 'Strength: ~25% fewer sets, same bells');
    } else if (b.kind === 'emom' && b.minutes) {
      const n = scaleN(b.minutes, 0.75, 4);
      b.title = (b.title || '').replace(/\d+(?=-min)/, String(n));
      b.minutes = n; add('emom', 'EMOM/AMRAP: ~25% shorter');
    } else if (b.kind === 'amrap' && b.durationSec) {
      const n = Math.max(180, Math.round((b.durationSec * 0.75) / 30) * 30);
      b.title = (b.title || '').replace(/\d+(?=-min)/, String(Math.round(n / 60)));
      b.durationSec = n; add('emom', 'EMOM/AMRAP: ~25% shorter');
    } else if (b.kind === 'intervals') {
      const cardio = items.some((it) => ['run', 'erg'].includes(getExercise(it.exId).category));
      if (cardio) {
        const total = (b.rounds || 1) * ((b.workSec || 60) + (b.restSec || 0));
        const sec = Math.max(900, Math.round((total * 0.75) / 300) * 300);
        add('intervals', `Intervals → ${Math.round(sec / 60)} min easy Zone 2 (no intensity today)`);
        b.kind = 'cardio'; b.title = `${Math.round(sec / 60)} min Zone 2 (instead of intervals)`; b.notes = 'Conversational pace only. Readiness says aerobic work today, not intensity.';
        delete b.rounds; delete b.workSec; delete b.restSec;
        b.items = [{ exId: 'run-easy', timeSec: sec, note: 'Zone 2 — conversational' }];
      } else if (b.rounds) {
        b.rounds = scaleN(b.rounds, 0.75); add('rounds', 'Circuits: ~25% fewer rounds');
      }
    } else if (b.kind === 'circuit') {
      if (b.rounds > 1) {
        const n = scaleN(b.rounds, 0.75);
        b.title = (b.title || '').replace(/^\d+(?= rounds)/, String(n)).replace(/× \d+$/, `× ${n}`);
        b.rounds = n; add('rounds', 'Circuits: ~25% fewer rounds');
      }
      for (const it of items) if (getExercise(it.exId).category === 'run' && RUN_FAST.test(it.note || '')) { toEasy(it); easyRuns++; }
    } else if (b.kind === 'cardio' || b.kind === 'station') {
      const f = sim ? 0.5 : 0.75;
      for (const it of items) {
        const isRun = getExercise(it.exId).category === 'run';
        if (isRun && (QUALITY_RUN.has(it.exId) || RUN_FAST.test(it.note || ''))) { toEasy(it); easyRuns++; }
        if (it.timeSec) it.timeSec = Math.max(60, Math.round((it.timeSec * f) / 60) * 60);
        if (it.distanceM) it.distanceM = isRun ? Math.max(200, Math.round((it.distanceM * f) / 50) * 50) : cut5(it.distanceM, f);
        if (it.reps && b.kind === 'station') it.reps = scaleN(it.reps, f);
      }
      if (b.kind === 'cardio') {
        const it = items[0];
        if (it && /^Run \d+/.test(b.title || '') && it.distanceM) b.title = b.title.replace(/·.*$/, `· ${it.distanceM} m easy`);
        else if (it && it.timeSec && /^\d+ min/.test(b.title || '')) b.title = b.title.replace(/^\d+ min/, `${Math.round(it.timeSec / 60)} min`);
        if (!sim) add('cardio', 'Steady runs: ~25% shorter');
      } else {
        if (sim) b.title = `${(b.title || '').replace(/ \(half\)$/, '')} (half)`;
        add('station', sim ? 'Stations: half volume' : 'Stations: ~25% less volume');
      }
    }
  }
  if (easyRuns) add('easy', `${easyRuns} race/threshold-pace run${easyRuns > 1 ? 's' : ''} → easy Zone 2 effort`);

  const lines = [`Readiness ${Math.round(score)}/100 — volume down ~25%, intensity capped at easy/steady.`];
  if (sim) {
    w.title = `Half Simulation, steady (was: ${w.title})`;
    lines.push('Full sim moved — do it within 3 days when readiness > 60.');
  }
  lines.push(...changes.values());
  w.estMin = Math.max(15, Math.round(((w.estMin || 45) * (sim ? 0.55 : 0.78)) / 5) * 5);
  w.scaled = 'reduced';
  return { workout: w, changes: lines.slice(0, 5) };
}

// ---------- PRs ----------
const SWINGS = new Set(['kb-swing', 'kb-swing-1h', 'kb-swing-double', 'kb-dead-swing', 'kb-swing-squat']);
const near = (d, t) => Math.abs(d - t) <= t * 0.02;

function runEntries(s) {
  const out = [];
  for (const c of s?.cardio || []) if (c && (c.mode || 'run') === 'run' && +c.distanceM > 0) out.push({ d: +c.distanceM, t: +c.timeSec || 0 });
  for (const x of s?.sets || []) if (x && getExercise(x.exId).category === 'run' && +x.distanceM > 0) out.push({ d: +x.distanceM, t: +x.timeSec || 0 });
  return out;
}
// 1 km reps inside interval/circuit work (not benchmarks).
const kmReps = (s) => (s?.sets || []).filter((x) => x && x.exId === 'run-1k' && !x.benchmark && near(+x.distanceM, 1000) && +x.timeSec > 0).map((x) => +x.timeSec);
const swingTotal = (s) => (s?.sets || []).reduce((a, x) => a + (x && SWINGS.has(x.exId) ? (+x.reps || 0) : 0), 0);

export function detectPRs(session, priorSessions = []) {
  if (!session) return [];
  const prior = (Array.isArray(priorSessions) ? priorSessions : []).filter((s) => s && s !== session && s.id !== session.id);
  const prs = [];
  const priorSets = prior.flatMap((s) => s.sets || []).filter(Boolean);

  // Heaviest bell / most reps at a weight (KB only, needs prior history of the lift)
  const seen = new Set();
  for (const x of session.sets || []) {
    if (!x || !(+x.kg > 0) || getExercise(x.exId).category !== 'kb') continue;
    const hist = priorSets.filter((p) => p.exId === x.exId && +p.kg > 0);
    if (!hist.length) continue;
    const name = getExercise(x.exId).name;
    const maxKg = Math.max(...hist.map((p) => +p.kg));
    const kgKey = `kg:${x.exId}`;
    if (+x.kg > maxKg && !seen.has(kgKey)) { seen.add(kgKey); prs.push(`Heaviest ${name}: ${+x.kg} kg`); continue; }
    const atKg = hist.filter((p) => +p.kg === +x.kg);
    const repKey = `reps:${x.exId}:${x.kg}`;
    if (atKg.length && +x.reps > Math.max(...atKg.map((p) => +p.reps || 0)) && !seen.has(repKey) && !seen.has(kgKey)) {
      const bestReps = Math.max(...(session.sets || []).filter((q) => q && q.exId === x.exId && +q.kg === +x.kg).map((q) => +q.reps || 0));
      seen.add(repKey); prs.push(`Most reps at ${+x.kg} kg on ${name}: ${bestReps}`);
    }
  }

  // Benchmark runs only (time trials, manual logs, flagged efforts): fastest 1 km / 5 km
  const mine = benchmarkRuns(session), past = prior.flatMap(benchmarkRuns);
  for (const [dist, label] of [[1000, '1 km'], [5000, '5 km']]) {
    const cur = mine.filter((e) => near(e.d, dist) && e.t > 0).map((e) => e.t);
    if (!cur.length) continue;
    const t = Math.min(...cur);
    const prev = past.filter((e) => near(e.d, dist) && e.t > 0).map((e) => e.t);
    if (!prev.length) prs.push(`First ${label} benchmark: ${fmtT(t)}`);
    else if (t < Math.min(...prev)) prs.push(`Fastest ${label}: ${fmtT(t)} (−${fmtT(Math.min(...prev) - t)})`);
  }
  // Interval 1 km reps: only compared with earlier reps
  const reps = kmReps(session), prevReps = prior.flatMap(kmReps);
  if (reps.length && prevReps.length && Math.min(...reps) < Math.min(...prevReps)) prs.push(`Fastest 1 km rep: ${fmtT(Math.min(...reps))}`);

  const all = runEntries(session), allPast = prior.flatMap(runEntries);
  if (all.length && allPast.length) {
    const longest = Math.max(...all.map((e) => e.d)), prevLong = Math.max(...allPast.map((e) => e.d));
    if (longest > prevLong && longest >= 3000) prs.push(`Longest run: ${(longest / 1000).toFixed(1)} km`);
  }

  // Swings
  const sw = swingTotal(session);
  if (sw > 0) {
    const prevMax = Math.max(0, ...prior.map(swingTotal));
    const isTest = session.workoutId === 't-swing-test' || /swing test/i.test(session.title || '');
    if (isTest) {
      const prevTest = Math.max(0, ...prior.filter((s) => s.workoutId === 't-swing-test' || /swing test/i.test(s.title || '')).map(swingTotal));
      if (sw > prevTest) prs.push(`Most swings in 10 min: ${sw}`);
    } else if (prevMax > 0 && sw > prevMax) prs.push(`Most swings in a session: ${sw}`);
  }
  return prs;
}

// ---------- Load & summaries ----------
const sessionLoad = (s) => ((+s.durationSec || 0) / 60) * (Number.isFinite(+s.rpe) && s.rpe != null ? +s.rpe : 6);

export function trainingLoad(sessions, todayISO) {
  let acute = 0, chronicSum = 0;
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s?.date) continue;
    const d = daysBetween(s.date, todayISO);
    if (d < 0 || d >= 28) continue;
    const l = sessionLoad(s);
    chronicSum += l;
    if (d < 7) acute += l;
  }
  const chronic = chronicSum / 4;
  let ratio = 0, status = 'low';
  if (chronic > 0) {
    ratio = acute / chronic;
    status = ratio < 0.8 ? 'low' : ratio <= 1.3 ? 'optimal' : ratio <= 1.5 ? 'high' : 'spike';
  }
  return { acute: Math.round(acute), chronic: Math.round(chronic), ratio: Math.round(ratio * 100) / 100, status };
}

export function weekSummary(sessions, startISO) {
  const out = { count: 0, minutes: 0, kbVolumeKg: 0, runM: 0, cardioM: 0 };
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s?.date) continue;
    const d = daysBetween(startISO, s.date);
    if (d < 0 || d > 6) continue;
    out.count++;
    out.minutes += (+s.durationSec || 0) / 60;
    for (const x of s.sets || []) {
      if (!x) continue;
      const ex = getExercise(x.exId);
      if (ex.category === 'kb' && +x.kg > 0 && +x.reps > 0) out.kbVolumeKg += +x.kg * +x.reps * (ex.double ? 2 : 1);
      if (+x.distanceM > 0 && ['run', 'erg', 'hyrox'].includes(ex.category) && ex.pattern === 'cardio') {
        out.cardioM += +x.distanceM;
        if (ex.category === 'run') out.runM += +x.distanceM;
      }
    }
    for (const c of s.cardio || []) {
      if (!c || !(+c.distanceM > 0)) continue;
      out.cardioM += +c.distanceM;
      if ((c.mode || 'run') === 'run') out.runM += +c.distanceM;
    }
  }
  out.minutes = Math.round(out.minutes);
  out.kbVolumeKg = Math.round(out.kbVolumeKg);
  out.runM = Math.round(out.runM);
  out.cardioM = Math.round(out.cardioM);
  return out;
}

// days: consecutive days (ending today, or yesterday if today is still open) with a session or a planned rest day.
// weeksOnPlan: consecutive plan weeks (current one counts once complete) where sessions ≥ planned workouts.
export function streak(sessions, plan, todayISO) {
  const dates = new Set((Array.isArray(sessions) ? sessions : []).map((s) => s?.date).filter(Boolean));
  const restDays = new Set();
  const weeks = Array.isArray(plan?.weeks) ? plan.weeks : [];
  for (const w of weeks) for (const d of w.days || []) if (d?.rest) restDays.add(d.date);

  let cur = dates.has(todayISO) ? todayISO : addDays(todayISO, -1);
  let days = 0, sawSession = false;
  while ((dates.has(cur) || restDays.has(cur)) && days < 3650) {
    days++;
    if (dates.has(cur)) sawSession = true;
    cur = addDays(cur, -1);
  }
  if (!sawSession) days = 0; // rest days only count when bridged by real sessions

  let weeksOnPlan = 0;
  const done = (start, end) => [...dates].filter((d) => d >= start && d <= end).length;
  if (weeks.length) {
    const sorted = [...weeks].filter((w) => w.days?.length).sort((a, b) => a.days[0].date.localeCompare(b.days[0].date));
    for (let i = sorted.length - 1; i >= 0; i--) {
      const w = sorted[i];
      const start = w.days[0].date, end = w.days[w.days.length - 1].date;
      if (start > todayISO) continue;
      const planned = w.days.filter((d) => d.workoutId && !d.rest).length;
      const ok = done(start, end) >= planned;
      if (end >= todayISO && !ok) continue; // current week still in progress
      if (!ok) break;
      weeksOnPlan++;
    }
  } else {
    for (let i = 0; i < 520; i++) {
      const end = addDays(todayISO, -7 * i), start = addDays(end, -6);
      if (done(start, end) >= 3) weeksOnPlan++;
      else if (i > 0) break;
    }
  }
  return { days, weeksOnPlan };
}

export { clamp };
