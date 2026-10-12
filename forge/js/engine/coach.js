// FORGE coach — bell selection (double progression), readiness scaling, PRs, training load, summaries.
// Pure functions, import-safe in Node. See docs/PROMPT.md §4, §6.5a.

import { addDays, daysBetween } from '../store.js';
import { getExercise } from '../data/exercises.js';
import { benchmarkRuns, plausibleCardio, plausibleSet, STATIONS, specKey } from './hyrox.js';

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
  return ex.loadRatio[expOf(profile)] * bwOf(profile) * (profile?.sex === 'f' ? 0.85 : 1);
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

// Canonical first bells (StrongFirst-style): always acceptable for any KB lift at this level.
export const START_BELL = { m: { beginner: 16, intermediate: 20, advanced: 24 }, f: { beginner: 12, intermediate: 12, advanced: 16 } };
export const startBell = (profile) => START_BELL[profile?.sex === 'f' ? 'f' : 'm'][expOf(profile)];

// True when the lightest suitable owned bell (or `kg` if given) is unsafe for this athlete on this lift.
// Never true at or below the standard starting bell; carries are fine up to race farmers spec (or 2 × start bell).
export function tooHeavy(exId, profile, kg) {
  const ex = getExercise(exId);
  if (ex.category !== 'kb' || !ex.loadRatio) return false;
  const pool = poolFor(ex, profile);
  if (!pool.length) return false;
  const bell = kg != null ? kg : baselineKg(ex, profile);
  if (bell <= startBell(profile)) return false;
  if (ex.pattern === 'carry') {
    const spec = STATIONS.find((q) => q.id === 'farmers')?.kg?.[specKey(profile)] || 24;
    if (bell <= Math.max(spec, 2 * startBell(profile))) return false;
  }
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

// ---------- Live double progression for planned items ----------
// Lifts where bell jumps are big relative to the load: max +30% per jump and two easy sessions at target first.
const CAREFUL = new Set(['kb-tgu', 'kb-windmill', 'kb-overhead-carry', 'kb-bottoms-up-press', 'kb-armbar', 'kb-sl-rdl', 'kb-snatch']);
const isCareful = (ex) => CAREFUL.has(ex.id) || ex.pattern === 'press';
// Block-kind families: progress only from like-for-like work. AMRAP totals never drive progression.
const familyOf = (kind) => (kind === 'strength' ? 'strength' : ['emom', 'circuit', 'intervals', 'station', 'cardio'].includes(kind) ? 'conditioning' : kind || null);

// Target reps the athlete was asked for on a logged set: set.targetReps → set.target → that session's planned item.
function setTarget(x, s, plan) {
  if (+x.targetReps > 0) return +x.targetReps;
  if (+x.target > 0) return +x.target;
  const w = plan?.workouts?.[s.workoutId];
  if (!w) return null;
  for (const b of w.blocks || []) for (const it of b.items || []) if (it.exId === x.exId && +it.reps > 0 && (!x.blockKind || x.blockKind === b.kind)) return +it.reps;
  return null;
}

// Live recommendation for a planned KB item (plan bells are frozen at generation; this applies logged progress).
// Signature: liveItemAdvice(item, profile, sessions, opts?) with opts { blockKind, plan, todayISO }.
// The item's block kind comes from item.blockKind (stamped by the plan) or opts.blockKind.
// History used: sets of the same exercise in the same family (strength vs conditioning); sets with
// set.blockKind === 'amrap' are ignored; legacy sets without blockKind count only for strength items and only if reps ≤ 30.
// Returns { kg, reason, earned }:
//  - non-KB item, no bells, item.hold, AMRAP/warm-up/cool-down item, or no matching history → planned kg (no message).
//  - last matching session at bell B (top bell that session):
//    · a set below its target (set.targetReps, else that session's planned reps) → B, "Repeat this bell — own all reps first".
//    · RPE ≥ 9 → B, "Last time was a grind — repeat this bell".
//    · EARNED when every set at B reached the TOP OF THE RANGE (max(item.reps, default top: 15 swings/snatch/high pull,
//      8 squat/press, 10 hinge/pull/lunge; TGU = ≥ 5 singles) with ≥ item.sets sets, at RPE ≤ 8 (≤ 7 for careful lifts),
//      AND no bell increase for this lift in the last 14 days, AND (careful lifts: TGU, windmill, overhead carry,
//      bottoms-up, armbar, SL-RDL, snatch, presses) the previous matching session also qualified, AND the next owned
//      bell is ≤ 30% heavier for careful lifts / ≤ 50% otherwise → next owned bell, "Earned: …".
//    · otherwise B, with an explanatory reason when relevant ("Same bell, more reps…", "Next bell is a big jump…").
//  - result = max(that, planned) unless a repeat verdict applies; conditioning items never exceed planned + one size.
export function liveItemAdvice(item, profile, sessions = [], opts = {}) {
  const planned = item?.kg != null ? +item.kg : null;
  const ex = getExercise(item?.exId);
  const none = { kg: planned, reason: '', earned: false };
  if (!item || ex.category !== 'kb' || !ex.loadRatio) return none;
  const pool = poolFor(ex, profile);
  if (!pool.length || item.hold) return none;
  const kind = item.blockKind || opts.blockKind || null;
  if (kind === 'amrap' || kind === 'warmup' || kind === 'cooldown') return none;
  const fam = familyOf(kind);
  const plan = opts.plan || null;

  // Matching history, oldest → newest: [{ s, sets }]
  const hist = [];
  for (const s of (Array.isArray(sessions) ? sessions : []).filter((q) => q && Array.isArray(q.sets)).sort(byDate)) {
    const sets = s.sets.filter((x) => {
      if (!x || x.exId !== item.exId || !(+x.kg > 0)) return false;
      if (x.blockKind === 'amrap') return false;
      if (x.blockKind) return !fam || familyOf(x.blockKind) === fam;
      return (!fam || fam === 'strength') && (+x.reps || 0) <= 30; // legacy sets: strength context only
    });
    if (sets.length) hist.push({ s, sets });
  }
  if (!hist.length) return { kg: planned ?? suggestWeight(item.exId, profile, []), reason: '', earned: false };

  const top = ex.id === 'kb-tgu' ? 5 : Math.max(+item.reps || 0, topReps(ex));
  const evalSession = ({ s, sets }) => {
    const B = Math.max(...sets.map((x) => +x.kg));
    const atB = sets.filter((x) => +x.kg === B);
    const rpes = atB.map((x) => +x.rpe).filter(Number.isFinite);
    const rpe = rpes.length ? Math.max(...rpes) : (s.rpe != null && Number.isFinite(+s.rpe) ? +s.rpe : null);
    const missed = atB.some((x) => { const t = setTarget(x, s, plan); return t != null && (+x.reps || 0) < t; });
    let hitTop;
    if (ex.pattern === 'carry') hitTop = Math.max(...atB.map((x) => +x.distanceM || 0)) >= (+item.distanceM || 40);
    else if (ex.id === 'kb-tgu') hitTop = atB.reduce((a, x) => a + (+x.reps || 0), 0) >= top;
    else if (/swing/.test(ex.id) && Math.min(...atB.map((x) => +x.reps || 0)) >= 10 && atB.length >= 10) hitTop = true; // 10 × 10 standard
    else hitTop = atB.length >= (+item.sets || 1) && Math.min(...atB.map((x) => +x.reps || 0)) >= top;
    const easyCap = isCareful(ex) ? 7 : 8;
    return { B, rpe, missed, hitTop, easy: hitTop && !missed && (rpe == null || rpe <= easyCap), date: s.date, reps: Math.max(...atB.map((x) => +x.reps || 0)) };
  };
  const last = evalSession(hist[hist.length - 1]);
  const base = atOrBelow(pool, last.B);
  const capCond = (kg) => (fam === 'conditioning' && planned != null ? Math.min(kg, nextUp(pool, planned)) : kg);
  const out = (kg, reason = '', earned = false) => ({ kg: capCond(kg), reason, earned });

  if (last.missed) return out(planned != null ? Math.min(planned, base) : base, 'Repeat this bell — own all reps first');
  if (last.rpe != null && last.rpe >= 9) return out(planned != null ? Math.min(planned, base) : base, 'Last time was a grind — repeat this bell');

  const hold = Math.max(base, planned ?? 0);
  if (!last.easy) {
    const more = +item.reps > 0 && last.reps > 0 && +item.reps > last.reps && hold === base;
    return out(hold, more ? 'Same bell, more reps — that is this week’s progression' : '');
  }
  const up = nextUp(pool, base);
  if (up === base) return out(hold, 'Top owned bell — progress with reps, sets or less rest');
  if (up > base * (isCareful(ex) ? 1.3 : 1.5)) return out(hold, 'Next bell is a big jump — add reps or a set first');
  const ref = opts.todayISO || last.date;
  const recentJump = hist.some(({ s, sets }) => s.date && ref && daysBetween(s.date, ref) < 14 && daysBetween(s.date, ref) >= 0 && sets.some((x) => +x.kg < base));
  if (recentJump) return out(hold, 'Bell went up recently — consolidate it for two weeks');
  if (isCareful(ex)) {
    const prev = hist.length > 1 ? evalSession(hist[hist.length - 2]) : null;
    if (!prev || !prev.easy || prev.B !== last.B) return out(hold, 'One more easy session at this bell, then size up');
  }
  if (planned != null && planned >= up) return out(planned);
  return out(up, 'Earned: top of the rep range, easy, two weeks at this bell', true);
}

export const liveItemWeight = (item, profile, sessions, opts) => liveItemAdvice(item, profile, sessions, opts).kg;

// ---------- Time estimates ----------
const SEC_PER_M = { 'hx-bbj': 3.4, 'bw-bbj': 3.4, 'hx-sled-push': 4, 'hx-sled-pull': 5, 'hx-sandbag-lunge': 2.8, 'kb-rack-walking-lunge': 2.8, 'kb-goblet-walking-lunge': 2.8, 'kb-bear-crawl-drag': 3, 'kb-towel-drag': 4, 'bw-bear-crawl': 2, 'bw-a-skip': 0.6, 'bw-lunge': 2.5 };

function itemSec(it, easyPace) {
  const ex = getExercise(it.exId);
  const sides = it.perSide ? 2 : 1;
  const sets = ex.category === 'run' && it.sets ? it.sets : 1;
  if (it.timeSec) return it.timeSec * sides * sets;
  if (it.distanceM) {
    if (ex.category === 'run') return (it.distanceM / 1000) * (it.paceSec || easyPace);
    if (['erg-ski', 'erg-row', 'hx-ski', 'hx-row'].includes(it.exId)) return (it.distanceM / 1000) * 280;
    if (it.exId === 'erg-bike') return (it.distanceM / 1000) * 120;
    return it.distanceM * (SEC_PER_M[it.exId] || 0.9) * sides;
  }
  if (it.reps) return it.reps * sides * (ex.pattern === 'mobility' ? 4 : ex.pattern === 'ballistic' ? 2.5 : ex.id === 'kb-tgu' ? 40 : 4) + (ex.category === 'kb' ? 8 : 0);
  return 30;
}

function blockSec(b, type, easyPace) {
  const items = b.items || [];
  const sum = items.reduce((a, it) => a + itemSec(it, easyPace), 0);
  const raceLike = type === 'hyrox' && (b.kind === 'cardio' || b.kind === 'station');
  const setup = b.kind === 'warmup' || b.kind === 'cooldown' || raceLike ? 0 : 60; // transitions, chalk, bells
  switch (b.kind) {
    case 'strength': return setup + items.reduce((a, it) => a + (it.sets || 1) * (itemSec(it, easyPace) + 15 + (it.restSec ?? b.restSec ?? 90)), 0);
    case 'emom': return setup + (b.minutes || 10) * 60;
    case 'amrap': return setup + (b.durationSec || 600);
    case 'intervals': return setup + (b.rounds || 1) * ((b.workSec || 60) + (b.restSec || 0));
    case 'circuit': return setup + (b.rounds || 1) * sum + Math.max(0, (b.rounds || 1) - 1) * (b.restSec || 0);
    default: return setup + sum + (b.restSec || 0);
  }
}

// Estimated minutes for a workout (rounded to 5, min 10). Used by the plan and by scaleWorkout after scaling.
export function estimateMin(workout, opts = {}) {
  const easyPace = opts.easyPace || 360;
  const sec = (workout?.blocks || []).reduce((a, b) => a + blockSec(b, workout.type, easyPace), 0);
  return Math.max(10, Math.round(sec / 60 / 5) * 5);
}

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
      ...w, title: `Recovery Flow (was: ${w.title})`, type: 'recovery', estMin: estimateMin({ type: 'recovery', blocks: recoveryBlocks(30) }), scaled: 'recovery',
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
      let eased = 0;
      for (const it of items) if (getExercise(it.exId).category === 'run' && RUN_FAST.test(it.note || '')) { toEasy(it); easyRuns++; eased++; }
      if (eased) b.notes = 'Easy runs today — rehearse transitions, not pace.';
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
        if (it && /^Run \d+/.test(b.title || '') && it.distanceM) {
          b.title = b.title.replace(/·.*$/, `· ${it.distanceM} m easy`);
          b.notes = 'Steady and conversational — rehearse transitions, not pace.';
        }
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
  w.estMin = estimateMin(w);
  w.scaled = 'reduced';
  return { workout: w, changes: lines.slice(0, 5) };
}

// ---------- PRs ----------
const SWINGS = new Set(['kb-swing', 'kb-swing-1h', 'kb-swing-double', 'kb-dead-swing', 'kb-swing-squat']);
const near = (d, t) => Math.abs(d - t) <= t * 0.02;

function runEntries(s) {
  const out = [];
  for (const c of s?.cardio || []) if (c && (c.mode || 'run') === 'run' && +c.distanceM > 0 && plausibleCardio(c)) out.push({ d: +c.distanceM, t: +c.timeSec || 0 });
  for (const x of s?.sets || []) if (x && getExercise(x.exId).category === 'run' && +x.distanceM > 0 && plausibleSet(x)) out.push({ d: +x.distanceM, t: +x.timeSec || 0 });
  return out;
}
// 1 km reps inside interval/circuit work (not benchmarks).
const kmReps = (s) => (s?.sets || []).filter((x) => x && x.exId === 'run-1k' && !x.benchmark && near(+x.distanceM, 1000) && +x.timeSec > 0 && plausibleSet(x)).map((x) => +x.timeSec);
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
const durOf = (s) => { const d = +s?.durationSec; return Number.isFinite(d) && d > 0 && d <= 86400 ? d : 0; };
const sessionLoad = (s) => (durOf(s) / 60) * (Number.isFinite(+s.rpe) && s.rpe != null ? +s.rpe : 6);

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

/** Canonical kettlebell volume for one logged set: kg × reps × 2 for double bells × 2 when reps are per side. */
export function setVolumeKg(x) {
  if (!x || !(+x.kg > 0) || !(+x.reps > 0)) return 0;
  const ex = getExercise(x.exId);
  if (ex.category !== 'kb' && !x.double) return 0;
  return +x.kg * +x.reps * ((x.double ?? ex.double) ? 2 : 1) * (x.perSide ? 2 : 1);
}

/** Canonical session kettlebell volume (kg). Every screen must use this. */
export function sessionVolumeKg(session) {
  return Math.round((Array.isArray(session?.sets) ? session.sets : []).reduce((a, x) => a + setVolumeKg(x), 0));
}

export function weekSummary(sessions, startISO) {
  const out = { count: 0, minutes: 0, kbVolumeKg: 0, runM: 0, cardioM: 0 };
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s?.date) continue;
    const d = daysBetween(startISO, s.date);
    if (d < 0 || d > 6) continue;
    out.count++;
    out.minutes += durOf(s) / 60;
    for (const x of s.sets || []) {
      if (!x) continue;
      const ex = getExercise(x.exId);
      out.kbVolumeKg += setVolumeKg(x);
      if (+x.distanceM > 0 && ['run', 'erg', 'hyrox'].includes(ex.category) && ex.pattern === 'cardio' && plausibleSet(x)) {
        out.cardioM += +x.distanceM;
        if (ex.category === 'run') out.runM += +x.distanceM;
      }
    }
    for (const c of s.cardio || []) {
      if (!c || !(+c.distanceM > 0) || !plausibleCardio(c)) continue;
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
