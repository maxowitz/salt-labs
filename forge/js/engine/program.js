// FORGE program generator — periodised kettlebell + running + HYROX plan to race day.
// Pure and import-safe in Node. See docs/PROMPT.md §4 (methodology) and §6.2 / §6.5a (contracts).
//
// Phases: Base → Build → Peak → Taper (deload every 4th Base/Build week). Weekly templates for 3–6 days
// guarantee: heavy KB strength, KB conditioning, Zone 2 running, quality running and (Build+) compromised
// run↔station work. The quality run sits on day 1 (fresh after the rest day), never the day after heavy hinging.
// Bells come from coach.suggestWeight (owned bells only, too-heavy lifts regress to safer variants);
// progression is reps/sets/density week to week and one bell size up from Build when the athlete owns it.
// Weekly run volume is capped at +15% over the previous loading week; deloads run ≤ 70% of it.
//
// Item extras beyond §6.2: paceSec (target sec/km), step (plan bell step, for coach.liveItemWeight),
// hold (do not auto-progress: warm-ups, spec-weight station work, deload/taper weeks).
// Workout extras: fixed (race day / primer — never readiness-scaled), benchmark (tests — postponed, not scaled).

import { addDays, daysBetween, todayISO } from '../store.js';
import { getExercise } from '../data/exercises.js';
import { suggestWeight, ownedBells, pairedBells, tooHeavy, estimateMin } from './coach.js';
import { paces, hrZones, defaultHrMax, estimateFiveK, STATIONS, specKey, predictRace } from './hyrox.js';

export const PHASES = {
  base: { label: 'Base', color: 'var(--base)', hex: '#22b8a6', desc: 'Aerobic engine + kettlebell strength foundation. Easy miles, crisp swings, heavy grinds at manageable volume.' },
  build: { label: 'Build', color: 'var(--build)', hex: '#f0a630', desc: 'Threshold running, KB strength-endurance and station-specific work. Bigger bells, compromised running begins.' },
  peak: { label: 'Peak', color: 'var(--peak)', hex: '#ef4b4b', desc: 'Race-pace compromised running and HYROX simulations. Strength is maintained, specificity is maximal.' },
  taper: { label: 'Taper', color: 'var(--taper)', hex: '#9b7bf2', desc: 'Volume down 40–50%, intensity kept. Arrive fresh, sharp and confident.' },
};

const SLOTS = { 3: [0, 2, 4], 4: [0, 1, 3, 5], 5: [0, 1, 2, 4, 5], 6: [0, 1, 2, 3, 4, 5] };
const WEEK = {
  3: { base: ['S:full+z', 'Q', 'C+z'], build: ['S:full+z', 'Q', 'H+e'], peak: ['S:maint+z', 'Q+c', 'X'] },
  4: { base: ['Q', 'S:full', 'C', 'Z:long'], build: ['Q', 'S:full+c', 'H', 'Z:long'], peak: ['Q', 'S:maint+c', 'Z:easy', 'X'] },
  5: { base: ['Q', 'S:lower', 'S:upper+z', 'C', 'Z:long'], build: ['Q', 'S:full+c', 'Z:easy', 'H', 'Z:long'], peak: ['Q', 'S:maint', 'C', 'Z:easy', 'X'] },
  6: {
    base: ['Q', 'S:lower', 'Z:easy', 'C', 'S:upper', 'Z:long'],
    build: ['Q', 'S:full', 'Z:strides', 'H', 'C', 'Z:long'],
    peak: ['Q', 'S:maint', 'Z:easy', 'C', 'Z:strides', 'X'],
  },
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const rq = (v, q) => Math.max(q, Math.round(v / q) * q);
const pickV = (arr, i) => arr[((i % arr.length) + arr.length) % arr.length];
const isISO = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const QF = { beginner: 0.7, intermediate: 1, advanced: 1.15 }; // quality-run volume by experience

// Safer variant when a lift is too heavy with the athlete's bells (else ex.regression, else by pattern).
const SAFE_DOWN = {
  'kb-snatch': 'kb-high-pull', 'kb-high-pull': 'kb-swing', 'kb-swing-1h': 'kb-swing', 'kb-swing-double': 'kb-swing', 'kb-swing': 'kb-deadlift',
  'kb-dead-swing': 'kb-deadlift', 'kb-swing-squat': 'kb-goblet-squat', 'kb-clean': 'kb-deadlift', 'kb-double-clean': 'kb-clean',
  'kb-clean-press': 'kb-press', 'kb-double-clean-press': 'kb-clean-press', 'kb-clean-jerk': 'kb-clean-press',
  'kb-press': 'kb-floor-press', 'kb-double-press': 'kb-press', 'kb-push-press': 'bw-pushup', 'kb-double-push-press': 'kb-push-press', 'kb-jerk': 'kb-push-press',
  'kb-floor-press': 'bw-pushup', 'kb-bottoms-up-press': 'bw-pushup',
  'kb-thruster': 'kb-goblet-thruster', 'kb-double-thruster': 'kb-goblet-thruster', 'kb-goblet-thruster': 'bw-air-squat',
  'kb-double-front-squat': 'kb-front-squat', 'kb-front-squat': 'kb-goblet-squat', 'kb-goblet-squat': 'bw-air-squat',
  'kb-windmill': 'bw-side-plank', 'kb-overhead-carry': 'kb-suitcase-carry', 'kb-rack-carry': 'kb-suitcase-carry', 'kb-farmers-carry': 'kb-suitcase-carry',
  'kb-suitcase-carry': 'bw-bear-crawl', 'kb-bear-crawl-drag': 'bw-bear-crawl', 'kb-towel-drag': 'kb-row', 'kb-gorilla-row': 'kb-row', 'kb-row': 'mob-ytw',
  'kb-renegade-row': 'bw-plank', 'kb-sl-rdl': 'kb-rdl', 'kb-rdl': 'kb-deadlift', 'kb-suitcase-deadlift': 'kb-deadlift', 'kb-double-deadlift': 'kb-deadlift',
  'kb-deadlift': 'mob-glute-bridge', 'kb-rack-walking-lunge': 'kb-goblet-walking-lunge', 'kb-goblet-walking-lunge': 'bw-lunge', 'kb-rack-lunge': 'bw-lunge',
  'kb-rack-reverse-lunge': 'bw-lunge', 'kb-step-up': 'bw-lunge', 'kb-lateral-lunge': 'bw-lunge', 'kb-around-world': 'bw-dead-bug', 'kb-halo': 'mob-arm-circles',
  'kb-armbar': 'mob-t-spine',
};
const PATTERN_BW = { squat: 'bw-air-squat', lunge: 'bw-lunge', press: 'bw-pushup', pull: 'mob-ytw', hinge: 'mob-glute-bridge', ballistic: 'bw-jump-squat', carry: 'bw-bear-crawl', core: 'bw-plank', mobility: 'mob-cat-cow' };
const BW_NOTES = { 'bw-pushup': 'Bell too heavy for now — push-ups (or pike push-ups for the press pattern)', 'bw-air-squat': 'Bell too heavy for now — bodyweight, full depth' };

// ---------- Context: everything personal the builders need ----------
function normProfile(profile) {
  const p = { ...(profile || {}) };
  p.equipment = { ...(p.equipment || {}) };
  p.bells = Array.isArray(p.bells) ? p.bells : [];
  p.daysPerWeek = clamp(Math.round(+p.daysPerWeek || 4), 3, 6);
  p.experience = ['beginner', 'intermediate', 'advanced'].includes(p.experience) ? p.experience : 'intermediate';
  return p;
}

function makeCtx(profile) {
  const generic = !profile;
  const p = normProfile(profile || { experience: 'intermediate', sex: 'm', weightKg: 80, bells: [], units: 'metric' });
  const units = p.units === 'metric' ? 'metric' : 'imperial';
  const fiveK = +p.fiveKSec > 600 ? +p.fiveKSec : estimateFiveK(p);
  const pc = paces(fiveK, { experience: p.experience });
  pc.raceFresh = Math.round((pc.tempo + pc.race) / 2);
  const zones = hrZones(+p.hrMax > 100 ? +p.hrMax : defaultHrMax(p.age));
  const owned = ownedBells(p), pairs = pairedBells(p);
  const ctx = {
    generic, p, units, pc, zones, eq: p.equipment, owned,
    pairs: generic ? true : pairs.length > 0,
    exp: p.experience, female: p.sex === 'f', spec: specKey(p),
  };
  const poolOf = (exId) => (getExercise(exId).double && pairs.length ? pairs : owned);

  ctx.pick = (dbl, single) => (ctx.pairs ? dbl : single);
  ctx.bell = (exId, step = 0) => (generic ? undefined : suggestWeight(exId, p, [], { step }) ?? undefined);
  // True when asking for `step` sizes up gives no heavier bell than step-1 → progress density instead.
  ctx.capped = (exId, step) => !generic && step > 0 && ctx.bell(exId, step) === ctx.bell(exId, step - 1);
  ctx.light = (exId) => {
    if (generic) return undefined;
    const pool = poolOf(exId);
    return pool.length ? pool[0] : undefined;
  };
  ctx.near = (exId, kg) => {
    if (generic) return undefined;
    const pool = poolOf(exId);
    if (!pool.length) return undefined;
    return pool.reduce((a, b) => (Math.abs(b - kg) < Math.abs(a - kg) || (Math.abs(b - kg) === Math.abs(a - kg) && b < a) ? b : a));
  };
  // KB item with an owned, safe bell. Explicit o.kg (light / spec bells) marks the item `hold`.
  // Too heavy → walk SAFE_DOWN / regression until a lift fits, else a bodyweight pattern.
  ctx.kb = (exId, o = {}, step = 0) => {
    if (generic) { const it = { exId, ...o }; delete it.kg; return it; }
    const explicit = o.kg !== undefined && o.kg !== null;
    let id = exId;
    for (let guard = 0; guard < 8; guard++) {
      const ex = getExercise(id);
      if (ex.category !== 'kb') {
        const it = { ...o, exId: id };
        delete it.kg; delete it.step; delete it.hold;
        if (!ex.unilateral && it.perSide) { delete it.perSide; if (it.reps) it.reps *= 2; }
        if (it.reps && ['squat', 'press', 'lunge'].includes(ex.pattern)) it.reps = Math.max(it.reps, 6);
        if (it.sets && id === 'bw-air-squat') { it.reps = Math.max(it.reps || 0, 12); it.note = 'Bell too heavy for now — tempo 3-1-1 (3 s down, 1 s pause), full depth'; return it; }
        it.note = BW_NOTES[id] || `Bell too heavy for now — ${ex.name.toLowerCase()} instead`;
        return it;
      }
      if (id === 'kb-tgu' && !explicit && ctx.bell(id, 0) == null) {
        const it = { ...o, exId: id, note: 'No bell yet — balance a shoe on the fist; earn the bell with smooth reps' };
        delete it.kg; return it;
      }
      for (let st = step; st >= 0; st--) {
        const kg = explicit ? o.kg : ctx.bell(id, st);
        if (kg != null && !tooHeavy(id, p, kg)) {
          const it = { ...o, exId: id, kg };
          if (explicit) it.hold = true;
          if (st > 0) it.step = st;
          if (id !== exId && !it.note) it.note = `Safer variant of ${getExercise(exId).name} for your bells`;
          if (ex.unilateral && !getExercise(exId).unilateral && it.reps) it.perSide = true;
          return it;
        }
        if (explicit) break;
      }
      const next = SAFE_DOWN[id] || ex.regression || PATTERN_BW[ex.pattern] || 'bw-air-squat';
      if (next === id) break;
      id = next;
    }
    return { ...o, exId: 'bw-air-squat', kg: undefined };
  };

  const fmtP = (sec) => {
    const s = Math.round(units === 'metric' ? sec : sec * 1.609344);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  ctx.fmtP = fmtP;
  const per = units === 'metric' ? '/km' : '/mi';
  const z = (n) => ctx.zones.find((q) => q.z === n);
  ctx.pace = (kind) => {
    const k = { easy: 'easy', z2: 'z2', long: 'long', recovery: 'easy' }[kind];
    return Array.isArray(pc[k]) ? pc[k][0] : pc[kind] || pc.easy[0];
  };
  ctx.note = (kind) => {
    const effort = {
      easy: 'Zone 2 — conversational', long: 'Zone 2 — conversational, finish strong not fast', recovery: 'Zone 1 — very easy',
      tempo: 'Comfortably hard, a few words at a time', threshold: 'Threshold — controlled discomfort (RPE 7–8)',
      interval: 'Hard but repeatable (RPE 8–9)', race: 'HYROX race pace — strong but sustainable', strides: '~90% speed, relaxed',
      raceFresh: 'Race rhythm on fresh legs — a touch quicker than race target',
    }[kind] || '';
    if (generic) return effort;
    const z2 = z(2), z1 = z(1), z3 = z(3), z4 = z(4), z5 = z(5);
    switch (kind) {
      case 'easy': return `Easy ${fmtP(pc.easy[0])}–${fmtP(pc.easy[1])} ${per} · Zone 2 (${z2.lo}–${z2.hi} bpm)`;
      case 'long': return `Easy ${fmtP(pc.long[0])}–${fmtP(pc.long[1])} ${per} · Zone 2 (${z2.lo}–${z2.hi} bpm)`;
      case 'recovery': return `Very easy, slower than ${fmtP(pc.easy[1])} ${per} · Zone 1 (< ${z1.hi} bpm)`;
      case 'tempo': return `Tempo ${fmtP(pc.tempo)} ${per} · Zone 3 (${z3.lo}–${z3.hi} bpm)`;
      case 'threshold': return `Threshold ${fmtP(pc.threshold)} ${per} · Zone 4 (${z4.lo}–${z4.hi} bpm)`;
      case 'interval': return `Interval ${fmtP(pc.interval)} ${per} · Zone 5 (${z5.lo}+ bpm)`;
      case 'race': return `HYROX race pace ${fmtP(pc.race)} ${per}`;
      case 'raceFresh': return `Race rhythm ${fmtP(pc.raceFresh)} ${per} on fresh legs (race target ${fmtP(pc.race)} ${per})`;
      case 'strides': return 'Build to ~90% speed over 20 s, walk back';
      default: return effort;
    }
  };
  // Run item. Strides and hill sprints are effort-based → no target pace.
  ctx.run = (exId, o, kind) => {
    const it = { exId, ...o, note: o.note || ctx.note(kind) };
    if (kind !== 'strides' && exId !== 'run-hill-sprints' && exId !== 'run-strides') it.paceSec = ctx.pace(kind);
    return it;
  };
  return ctx;
}

// ---------- Shared blocks ----------
const B = (kind, title, items, extra = {}) => ({ kind, title, notes: '', ...extra, items });

function warmKB(ctx) {
  return B('warmup', 'Kettlebell prep', [
    { exId: 'mob-cat-cow', reps: 8 },
    { exId: 'mob-90-90', reps: 6 },
    { exId: 'mob-wgs', reps: 3, perSide: true },
    ctx.kb('kb-halo', { reps: 5, perSide: true, kg: ctx.light('kb-halo') }),
    ctx.kb('kb-goblet-squat', { reps: 5, kg: ctx.light('kb-goblet-squat'), note: 'Light bell — pry the hips open at the bottom' }),
    { exId: 'mob-glute-bridge', reps: 10 },
    ctx.kb('kb-swing', { reps: 10, kg: ctx.light('kb-swing'), note: 'Crisp, light — groove the hinge' }),
  ], { notes: 'Easy pace. Breathe, open the hips, prime the hinge.' });
}

function warmRun(ctx, min = 10) {
  return B('warmup', 'Run warm-up', [
    { exId: 'mob-leg-swings', reps: 10, perSide: true },
    { exId: 'mob-ankle-rocks', reps: 10, perSide: true },
    { exId: 'mob-wgs', reps: 3, perSide: true },
    { exId: 'bw-a-skip', distanceM: 40 },
    ctx.run('run-easy', { timeSec: min * 60 }, 'easy'),
  ], { notes: 'Start slower than easy pace and let it build.' });
}

function warmHybrid(ctx) {
  return B('warmup', 'Hybrid warm-up', [
    ctx.run('run-easy', { timeSec: 360 }, 'easy'),
    { exId: 'mob-wgs', reps: 3, perSide: true },
    { exId: 'mob-ankle-rocks', reps: 8, perSide: true },
    ctx.kb('kb-swing', { reps: 10, kg: ctx.light('kb-swing') }),
    ctx.kb('kb-goblet-squat', { reps: 6, kg: ctx.light('kb-goblet-squat') }),
    { exId: 'bw-burpee', reps: 5 },
  ], { notes: 'Raise the heart rate gradually; rehearse every movement you will use.' });
}

function coolKB() {
  return B('cooldown', 'Downshift', [
    { exId: 'mob-hip-flexor', timeSec: 45, perSide: true },
    { exId: 'mob-90-90', reps: 6 },
    { exId: 'mob-childs-pose', timeSec: 60 },
    { exId: 'mob-breathing', timeSec: 90 },
  ], { notes: 'Bring the heart rate down; long exhales.' });
}

function coolRun() {
  return B('cooldown', 'Cool-down', [
    { exId: 'mob-walk', timeSec: 300 },
    { exId: 'mob-calf-stretch', timeSec: 45, perSide: true },
    { exId: 'mob-couch', timeSec: 45, perSide: true },
    { exId: 'mob-pigeon', timeSec: 45, perSide: true },
  ], { notes: 'Walk it off, then stretch calves and hips.' });
}

function z2Tail(ctx, min) {
  return B('cardio', `${min} min Zone 2 flush run`, [ctx.run('run-easy', { timeSec: min * 60 }, 'easy')], {
    notes: ctx.eq.bike || ctx.eq.row ? 'Easy aerobic work straight after lifting. Bike or row is fine if legs are heavy.' : 'Easy aerobic work straight after lifting — keep it conversational.',
  });
}

// ---------- Station substitutions (§4) ----------
// mode: false = training ids & suggested bells; 'spec' = race-spec bells; true = race-spec bells + race station ids.
function stationItems(ctx, id, frac = 1, mode = false) {
  const eq = ctx.eq;
  const race = mode === true, spec = !!mode;
  const st = STATIONS.find((s) => s.id === id);
  const specKg = st?.kg?.[ctx.spec];
  const d = (m, q = 5) => rq(m * frac, q);
  const n = (r) => Math.max(3, Math.round(r * frac));
  switch (id) {
    case 'skierg':
      if (eq.ski) return [{ exId: race ? 'hx-ski' : 'erg-ski', distanceM: d(1000, 50), note: 'Strong, long strokes — sustainable race effort' }];
      return [
        ctx.kb(ctx.pick('kb-swing-double', 'kb-swing'), { reps: n(40), note: 'SkiErg sub: powerful hinge, pull the bells back hard' }),
        ctx.exp === 'beginner'
          ? ctx.kb('kb-high-pull', { reps: n(16), note: 'SkiErg sub: elbows high, hips drive' })
          : ctx.kb('kb-snatch', { reps: n(10), perSide: true, kg: ctx.light('kb-snatch') }),
      ];
    case 'sled-push':
      if (ctx.pairs) return [
        ctx.kb('kb-rack-carry', { distanceM: d(100, 10), note: 'Sled-push sub: heaviest pair, short driving steps, lean in' }, 1),
        ctx.kb('kb-bear-crawl-drag', { distanceM: d(20, 5) }),
      ];
      return [
        ctx.kb('kb-bear-crawl-drag', { distanceM: d(30, 5), note: 'Sled-push sub: drive through the legs' }),
        { exId: 'bw-jump-squat', reps: n(12) },
      ];
    case 'sled-pull':
      return [
        ctx.kb('kb-towel-drag', { distanceM: d(25, 5), note: 'Sled-pull sub: towel through the handle, pull hand over hand, walk back' }, 1),
        ctx.pairs ? ctx.kb('kb-gorilla-row', { reps: n(10), perSide: true }) : ctx.kb('kb-row', { reps: n(10), perSide: true }),
      ];
    case 'bbj':
      return [{ exId: race ? 'hx-bbj' : 'bw-bbj', distanceM: d(80, 5), note: 'Steady rhythm, moderate jumps' }];
    case 'row':
      if (eq.row) return [{ exId: race ? 'hx-row' : 'erg-row', distanceM: d(1000, 50), note: 'Damper 5–6, legs first — bring the HR under control' }];
      return [
        ctx.kb('kb-swing', { reps: n(30), note: 'Row sub: swings + run' }),
        ctx.run('run', { distanceM: d(400, 50) }, 'race'),
      ];
    case 'farmers': {
      const note = `Race spec 2 × ${specKg} kg`;
      if (ctx.pairs) return [ctx.kb('kb-farmers-carry', { distanceM: d(200, 10), kg: spec && specKg ? ctx.near('kb-farmers-carry', specKg) : undefined, note: `${note} — use it if you own it` })];
      return [ctx.kb('kb-suitcase-carry', { distanceM: d(100, 10), perSide: true, kg: spec && specKg ? ctx.near('kb-suitcase-carry', specKg) : undefined, note: `${note}. One bell, switch hands — resist the lean` })];
    }
    case 'sandbag-lunges': {
      const sk = specKg || 20;
      if (eq.sandbag) return [{ exId: 'hx-sandbag-lunge', distanceM: d(100, 5), note: `Race spec ${sk} kg` }];
      if (ctx.generic) return [ctx.kb(ctx.pick('kb-rack-walking-lunge', 'kb-goblet-walking-lunge'), { distanceM: d(100, 5), note: `Sandbag sub (race ${sk} kg): knee touches every step` })];
      // Pick the option whose TOTAL load is closest to race spec (ties → lighter).
      const single = ctx.near('kb-goblet-walking-lunge', sk);
      const pairKg = ctx.pairs && pairedBells(ctx.p).length ? ctx.near('kb-rack-walking-lunge', sk / 2) : null;
      const usePair = pairKg != null && Math.abs(pairKg * 2 - sk) < Math.abs(single - sk);
      const total = usePair ? pairKg * 2 : single;
      return [ctx.kb(usePair ? 'kb-rack-walking-lunge' : 'kb-goblet-walking-lunge', { distanceM: d(100, 5), kg: usePair ? pairKg : single, note: `Sandbag sub ≈ ${total} kg vs race ${sk} kg — knee touches every step` })];
    }
    case 'wall-balls': {
      const wb = specKg || 6;
      if (eq.wallball) return [{ exId: 'hx-wall-balls', reps: n(100), note: `Race spec ${STATIONS[7].spec[ctx.spec]}` }];
      const light = ctx.light('kb-goblet-thruster');
      const probe = ctx.kb('kb-goblet-thruster', { reps: 1, kg: light });
      if (probe.exId !== 'kb-goblet-thruster') return [{ exId: 'bw-air-squat', reps: n(80), note: 'Wall-ball sub: full squat + fast arm press-out overhead. Better: a med ball / sandbag at race weight' }];
      if (light != null && light > wb * 2.5) return [
        ctx.kb('kb-goblet-thruster', { reps: n(50), kg: light, note: 'Wall-ball sub (part 1): lightest bell, full squat. Or a med ball / sandbag at race weight for all 100' }),
        { exId: 'bw-air-squat', reps: n(50), note: 'Wall-ball sub (part 2): squat + fast arm press-out overhead' },
      ];
      return [ctx.kb('kb-goblet-thruster', { reps: n(60), kg: light, note: 'Wall-ball sub: lightest bell, full squat, smooth rhythm' })];
    }
    default: return [];
  }
}

// ---------- Estimation & equipment ----------
function equipmentOf(ctx, w) {
  const out = new Set();
  const bells = new Map();
  let running = false;
  for (const b of w.blocks) for (const it of b.items || []) {
    const ex = getExercise(it.exId);
    if (ex.category === 'kb' && (it.kg != null || ctx.generic)) {
      const key = it.kg != null ? it.kg : 0;
      const dbl = ex.double && ctx.pairs;
      bells.set(key, Math.max(bells.get(key) || 1, dbl ? 2 : 1));
    }
    if (ex.category === 'run') running = true;
    if (ex.equip) out.add(ex.equip);
  }
  const list = [...bells.entries()].sort((a, b) => a[0] - b[0]).map(([kg, n]) => (kg ? `${n > 1 ? '2 × ' : ''}${kg} kg kettlebell${n > 1 ? 's' : ''}` : 'Kettlebell'));
  if (running) list.push('Running route');
  return [...list, ...out];
}

const estMinOf = (ctx, w) => estimateMin(w, { easyPace: ctx.pc.easy[0] });

function finalize(ctx, w, meta) {
  for (const b of w.blocks) for (const it of b.items || []) {
    if (getExercise(it.exId).category !== 'kb') continue;
    it.blockKind = b.kind; // lets coach.liveItemAdvice progress like-for-like only
    if (meta.hold && it.kg != null) it.hold = true;
  }
  // A regression can land on an exercise already in the block (e.g. two push-up stations) → drop the duplicate.
  for (const b of w.blocks) {
    const seen = new Set();
    b.items = (b.items || []).filter((it) => { const dup = seen.has(it.exId) && /too heavy/i.test(it.note || ''); seen.add(it.exId); return !dup; });
  }
  const out = {
    id: meta.id, title: w.title, type: w.type, phase: meta.phase || null, week: meta.week || null,
    estMin: w.estMin || estMinOf(ctx, w), summary: w.summary || '',
    equipment: equipmentOf(ctx, w), blocks: w.blocks,
  };
  if (w.fixed) out.fixed = true;
  if (w.benchmark) out.benchmark = true;
  return out;
}

// ---------- Session builders ----------
// wk: { phase, week, deload, taper, pl (loading weeks into phase), L (loading weeks overall), vol, step, v (variant) }

function strengthSession(ctx, wk, focus, extra) {
  const { phase, deload, taper, pl, v } = wk;
  const step = wk.step;
  const maint = focus === 'maint';
  const squatId = ctx.pick('kb-double-front-squat', ctx.exp === 'beginner' ? 'kb-goblet-squat' : 'kb-front-squat');
  const pressId = ctx.pick('kb-double-press', 'kb-press');
  const rowId = ctx.eq.pullup ? 'bw-pullup' : ctx.pick('kb-gorilla-row', 'kb-row');
  const capped = ctx.capped(squatId, step);
  const secondCycle = phase === 'build' && pl >= 4;

  // Squat: base = double progression on reps; build = heavier bell, reps rebuild; capped = density.
  let sets, reps, rest = 120;
  if (taper) { sets = 2; reps = 3; }
  else if (deload) { sets = 3; reps = 5; rest = 90; }
  else if (maint) { sets = 3; reps = 5; }
  else if (phase === 'build') {
    sets = secondCycle ? 6 : 5;
    reps = capped ? pickV([6, 7, 8, 8], pl) : pickV([3, 4, 5, 6], pl);
    if (capped) rest = 90 - 15 * Math.min(pl, 2);
  } else { sets = 4 + Math.min(pl, 1); reps = pickV([5, 6, 7, 8], pl); }
  // Goblet squats are limited by the upper back — never below 5 reps; add a set instead.
  if (squatId === 'kb-goblet-squat' && reps < 5) { reps = 5; sets += 1; }

  // Press & row progress on their own: a bell step only when the next owned bell is ≤ 30% heavier; otherwise reps keep climbing.
  const gentleStep = (id) => (step && ctx.bell(id, step) != null && ctx.bell(id, step) > (ctx.bell(id, 0) || 0) && ctx.bell(id, step) <= (ctx.bell(id, 0) || 0) * 1.3 ? step : 0);
  const pStep = gentleStep(pressId), rStep = rowId === 'bw-pullup' ? 0 : gentleStep(rowId);
  let pReps;
  if (taper) pReps = 2; else if (deload || maint) pReps = 4;
  else if (phase === 'build') pReps = pStep ? pickV([3, 4, 5, 6], pl) : pickV([6, 7, 8, 8], pl);
  else pReps = pickV([4, 5, 6, 7], pl);
  const rReps = taper ? 5 : deload || maint ? 8 : phase === 'build' ? (rStep ? pickV([6, 8, 8, 10], pl) : pickV([10, 10, 12, 12], pl)) : pickV([8, 9, 10, 10], pl);
  const pSets = phase === 'build' && !pStep && secondCycle ? 6 : sets;
  const rungNote = capped && phase === 'build' ? 'Top bell owned — progress by density: rest shorter than last week.' : '';
  const sqSide = squatId === 'kb-front-squat';

  const blocks = [warmKB(ctx)];
  let title, summary;
  const s = (exId, o, st = step) => ctx.kb(exId, o, st);
  const upper = () => [
    s(pressId, { sets: pSets, reps: pReps, perSide: pressId === 'kb-press', restSec: rest, note: 'Strict — glutes and abs locked' }, pStep),
    rowId === 'bw-pullup'
      ? { exId: 'bw-pullup', sets, reps: clamp(pReps, 3, 8), restSec: 60, note: 'Leave 1–2 reps in the tank' }
      : s(rowId, { sets, reps: rReps, perSide: true, restSec: 60 }, rStep),
  ];

  if (focus === 'lower') {
    title = pickV(['Squat & Hinge Foundations', 'Heavy Legs, Strong Hips', 'Hinge Power'], v);
    summary = 'Lower-body strength: heavy squats, single-leg hinge, power swings and a loaded carry.';
    blocks.push(B('strength', 'A · Squat', [s(squatId, { sets, reps, perSide: sqSide, restSec: rest, note: rungNote || 'Own the bottom position; drive up hard' })], { notes: 'Stop every set with 1–2 reps in reserve (RPE 7–8).' }));
    blocks.push(B('strength', 'B · Single-leg hinge', [s('kb-sl-rdl', { sets: 3, reps: 8, perSide: true, restSec: 60 }, 0)], { notes: 'Slow and balanced — 3 s lowering.' }));
    const swId = ctx.pick('kb-swing-double', 'kb-swing');
    blocks.push(B('strength', 'C · Power swings', [s(swId, { sets: deload || taper ? 5 : 8 + Math.min(pl, 2), reps: 10, restSec: 45, note: 'Every rep crisp and explosive — park the bell if speed drops' })], { notes: 'Heavy, fast, recover fully — quality over fatigue.' }));
    blocks.push(B('strength', 'D · Carry', [s(ctx.pick('kb-farmers-carry', 'kb-suitcase-carry'), { sets: 3, distanceM: 40, perSide: !ctx.pairs, restSec: 60 })]));
  } else if (focus === 'upper') {
    title = pickV(['Press & Pull', 'Get-Up & Press', 'Iron Shoulders'], v);
    summary = 'Upper-body strength and shoulder durability: presses, pulls, get-ups and overhead stability.';
    blocks.push(B('strength', 'A · Press + pull superset', upper(), { notes: 'Alternate press and pull. Rest after the pair.' }));
    blocks.push(B('strength', 'B · Turkish get-up', [s('kb-tgu', { sets: deload || taper ? 2 : 3 + Math.min(pl, 2), reps: 1, perSide: true, restSec: 45, note: 'Slow singles, pause in every position' }, 0)]));
    blocks.push(B('strength', 'C · Floor press + core', [
      s('kb-floor-press', { sets: 3, reps: 8, perSide: true, restSec: 45 }, 0),
      { exId: 'bw-hollow-hold', sets: 3, timeSec: 30, restSec: 30 },
    ]));
    blocks.push(B('strength', 'D · Overhead carry', [s('kb-overhead-carry', { sets: 2, distanceM: 30, perSide: true, restSec: 45 }, 0)]));
  } else {
    title = taper ? 'Taper Strength Primer'
      : maint ? pickV(['Strength Maintenance', 'Heavy Touch', 'Keep the Iron'], v)
      : ctx.pairs ? pickV(['Heavy Doubles', 'Iron Foundations', 'Double-Bell Grind'], v)
      : pickV(['Iron Foundations', 'Single-Bell Strength', 'Grind Day'], v);
    summary = maint || taper
      ? 'Keep strength while running and race prep dominate: few sets, crisp reps, heavy bells.'
      : 'Full-body heavy kettlebell strength: squat, press, pull, get-up. Reps first, then bell size.';
    blocks.push(B('strength', 'A · Squat', [s(squatId, { sets, reps, perSide: sqSide, restSec: rest, note: rungNote || 'RPE 7–8 — leave a rep or two' })]));
    blocks.push(B('strength', 'B · Press + pull superset', upper(), { notes: 'Alternate press and pull; rest after the pair.' }));
    if (v % 2 === 0) blocks.push(B('strength', 'C · Turkish get-up', [s('kb-tgu', { sets: maint || taper || deload || extra === 'z' ? 2 : 3, reps: 1, perSide: true, restSec: 30 }, 0)]));
    else blocks.push(B('strength', 'C · Hinge', [s(ctx.pick('kb-double-deadlift', 'kb-suitcase-deadlift'), { sets: taper || deload || maint ? 2 : 3, reps: 6, perSide: !ctx.pairs, restSec: 60 })]));
    if (!maint && !taper && extra !== 'z') blocks.push(B('strength', 'D · Carry', [s(ctx.pick('kb-farmers-carry', 'kb-suitcase-carry'), { sets: deload ? 2 : 3, distanceM: 40, perSide: !ctx.pairs, restSec: 60 })]));
  }

  if (extra === 'c') {
    const min = deload || taper ? 6 : 10;
    blocks.push(B('emom', `Finisher · ${min}-min EMOM`, [
      ctx.kb('kb-swing', { reps: 15 }),
      { exId: 'bw-burpee', reps: 6 },
    ], { minutes: min, alternate: true, notes: 'Alternate minutes. Finish each minute with ≥ 20 s rest.' }));
    title += ' + Finisher';
  }
  if (extra === 'z') blocks.push(z2Tail(ctx, Math.round(clamp(20 + 2 * wk.L, 20, 30) * (wk.vol < 1 ? 0.75 : 1))));
  blocks.push(coolKB());
  return { title: deload ? `Deload · ${title}` : title, type: 'strength', summary, blocks };
}

function conditioningSession(ctx, wk, extra) {
  const { phase, deload, taper, pl, v } = wk;
  const blocks = [warmKB(ctx)];
  const vol = wk.vol;
  const swing1 = ctx.exp === 'beginner' ? 'kb-swing' : 'kb-swing-1h';
  const variants = phase === 'base' ? ['emom', 'complex', 'density', 'ladder'] : ['emom', 'stations', 'complex', 'density'];
  const kind = pickV(variants, v);
  let title, summary;

  if (kind === 'emom') {
    const minutes = Math.round(clamp((phase === 'base' ? 16 : 20) + 2 * pl, 12, 30) * vol / 2) * 2;
    title = 'Iron Engine EMOM';
    summary = 'Every-minute-on-the-minute KB conditioning: power, strength-endurance and an aerobic engine.';
    blocks.push(B('emom', `${minutes}-min EMOM`, [
      swing1 === 'kb-swing' ? ctx.kb('kb-swing', { reps: 15 }) : ctx.kb(swing1, { reps: 5, perSide: true, note: '5 left + 5 right' }),
      ctx.kb(ctx.pick('kb-double-front-squat', 'kb-goblet-squat'), { reps: 6 + Math.min(pl, 2) }, 0),
      { exId: 'bw-pushup', reps: 8 + Math.min(pl, 4) },
      ctx.kb(ctx.pick('kb-double-clean-press', 'kb-clean-press'), { reps: ctx.pairs ? 4 : 3, perSide: !ctx.pairs }, 0),
    ], { minutes, alternate: true, notes: 'One station per minute, rotate in order. Work should take 25–35 s.' }));
  } else if (kind === 'complex') {
    const rounds = Math.max(2, Math.round(clamp(4 + pl, 3, 7) * vol));
    title = 'Complex Chaos';
    summary = 'Barbell-style KB complex: never put the bell(s) down. Grip, rack strength and work capacity.';
    blocks.push(B('circuit', `Complex × ${rounds}`, [
      ctx.kb(ctx.pick('kb-double-clean', 'kb-clean'), { reps: 5, perSide: !ctx.pairs }, 0),
      ctx.kb(ctx.pick('kb-double-front-squat', 'kb-front-squat'), { reps: 5, perSide: !ctx.pairs }, 0),
      ctx.kb(ctx.pick('kb-double-push-press', 'kb-push-press'), { reps: 5, perSide: !ctx.pairs }, 0),
      ctx.kb('kb-rack-reverse-lunge', { reps: 4, perSide: true }, 0),
    ], { rounds, restSec: 90, notes: 'Bells stay in hand for the whole complex (single bell: one side, then the other).' }));
    blocks.push(B('amrap', '5-min burner', [{ exId: 'bw-mountain-climber', reps: 20 }, ctx.kb('kb-swing', { reps: 10 })], { durationSec: 300 }));
  } else if (kind === 'density') {
    const snatch = ctx.exp !== 'beginner';
    const minutes = Math.round(clamp(10 + 2 * pl, 8, 20) * vol);
    title = snatch ? 'Snatch Density' : 'Swing Density';
    summary = snatch ? 'Snatch EMOM for power-endurance and a SkiErg-ready engine, then a short core finisher.' : 'One-arm swing EMOM building power-endurance, then a short core finisher.';
    blocks.push(B('emom', `${minutes}-min ${snatch ? 'snatch' : 'swing'} EMOM`, [
      ctx.kb(snatch ? 'kb-snatch' : 'kb-swing-1h', { reps: snatch ? 6 + Math.min(pl, 3) : 10, note: 'Switch arms every minute' }),
    ], { minutes, notes: 'Smooth and crisp. If form fades, cut reps — not quality.' }));
    blocks.push(B('circuit', 'Core', [
      ctx.kb('kb-around-world', { reps: 5, perSide: true, kg: ctx.light('kb-around-world') }),
      { exId: 'bw-side-plank', timeSec: 30, perSide: true },
      { exId: 'bw-dead-bug', reps: 8, perSide: true },
    ], { rounds: 2, restSec: 30 }));
  } else if (kind === 'ladder') {
    const dur = Math.round(clamp(12 + 2 * pl, 10, 20) * vol) * 60;
    title = 'Clean & Press Ladders';
    summary = 'Ladders build pressing volume at a heavy bell while swings keep the engine running.';
    blocks.push(B('amrap', `${dur / 60}-min ladder`, [
      ctx.kb('kb-clean-press', { reps: 3, perSide: true, note: 'Ladder rungs 1-2-3 per side, then restart at 1' }),
      ctx.kb('kb-swing', { reps: 10, note: 'Between every rung' }),
    ], { durationSec: dur, notes: 'Count completed ladders. Next time beat it — or use the next bell.' }));
  } else {
    const rounds = Math.max(2, Math.round(clamp(3 + pl, 3, 5) * vol));
    title = 'Station Strength-Endurance';
    summary = 'HYROX station work with kettlebells: carries, lunges, thrusters and a SkiErg/row substitute.';
    blocks.push(B('circuit', `Stations × ${rounds}`, [
      ...stationItems(ctx, 'farmers', 0.5),
      ...stationItems(ctx, 'sandbag-lunges', 0.25),
      ...stationItems(ctx, 'wall-balls', 0.25),
      ...stationItems(ctx, ctx.eq.ski ? 'skierg' : 'row', 0.25),
    ], { rounds, restSec: 90, notes: 'Race-like rhythm, not a sprint. Note the bell sizes for next time.' }));
  }
  if (extra === 'z') blocks.push(z2Tail(ctx, Math.round(clamp(20 + 2 * wk.L, 20, 35) * (vol < 1 ? 0.75 : 1))));
  blocks.push(coolKB());
  if (extra === 'z') title = `Iron & Engine: ${title}`;
  return { title: deload ? `Deload · ${title}` : taper ? `Taper · ${title}` : title, type: 'conditioning', summary, blocks };
}

function qualityRun(ctx, wk, extra) {
  const { phase, deload, taper, pl, v } = wk;
  const qf = QF[ctx.exp];
  const sc = (n, lo, hi) => clamp(Math.round(n * qf), lo, hi);
  const blocks = [warmRun(ctx, 10)];
  let title, summary;
  if (wk.kind === 'taperq') {
    const min = Math.max(6, Math.round((ctx.exp === 'beginner' ? 10 : 15) * 0.6));
    title = 'Taper Cruise';
    summary = 'Short threshold reps at reduced volume: keep the engine sharp without adding fatigue.';
    blocks.push(B('intervals', `2 × ${min} min threshold`, [ctx.run('run-threshold', { timeSec: min * 60 }, 'threshold')], { rounds: 2, workSec: min * 60, restSec: 120 }));
  } else if (taper || wk.kind === 'openers') {
    const reps = ctx.exp === 'beginner' ? 2 : 3;
    title = 'Race Openers';
    summary = 'Short race-pace reps to stay sharp without adding fatigue.';
    blocks.push(B('intervals', `${reps} × 1 km race pace`, [ctx.run('run-1k', { distanceM: 1000 }, 'race')], { rounds: reps, workSec: ctx.pc.race, restSec: 120, notes: 'Smooth and controlled — you should finish wanting more.' }));
    blocks.push(B('cardio', 'Strides', [ctx.run('run-strides', { timeSec: 20, sets: 4 }, 'strides')], { notes: '4 × 20 s, walk back recovery.' }));
  } else if (deload) {
    title = 'Easy Run + Strides';
    summary = 'Deload week: easy aerobic running with a few strides to keep the legs snappy.';
    blocks.push(B('cardio', '25 min easy', [ctx.run('run-easy', { timeSec: 25 * 60 }, 'easy')]));
    blocks.push(B('cardio', 'Strides', [ctx.run('run-strides', { timeSec: 20, sets: 4 }, 'strides')], { notes: '4 × 20 s, full walk-back recovery.' }));
  } else if (phase === 'base') {
    const k = pickV(['hills', 'tempo', 'fartlek'], v);
    if (k === 'hills') {
      const reps = sc(6 + pl, 4, 10);
      title = 'Hill Sprint Power';
      summary = 'Short hill sprints build power and running economy (and train the sled-push drive), then steady tempo.';
      blocks.push(B('intervals', `${reps} × 10 s hill sprints`, [ctx.run('run-hill-sprints', { timeSec: 10, note: 'Max power uphill — drive like pushing a sled' }, 'interval')], { rounds: reps, workSec: 10, restSec: 90, notes: 'Steep hill, max power, walk down. No hill? Strides on the flat.' }));
      blocks.push(B('cardio', 'Tempo', [ctx.run('run-tempo', { timeSec: sc(10 + 2 * pl, 8, 20) * 60 }, 'tempo')]));
    } else if (k === 'tempo') {
      const min = sc(15 + 3 * pl, 12, ctx.exp === 'beginner' ? 20 : 30);
      title = 'Tempo Builder';
      summary = 'Continuous tempo running raises the pace you can hold aerobically — the bedrock of HYROX running.';
      blocks.push(B('cardio', `${min} min tempo`, [ctx.run('run-tempo', { timeSec: min * 60 }, 'tempo')], { notes: 'Even splits. Last km should feel like the first.' }));
    } else {
      const rounds = sc(6 + pl, 5, 10);
      title = 'Fartlek Surges';
      summary = 'Unstructured speed: surges at 5–10 km effort with jog floats.';
      blocks.push(B('intervals', `${rounds} × 1 min on / 1 min float`, [ctx.run('run-fartlek', { timeSec: 60 }, 'interval')], { rounds, workSec: 60, restSec: 60, notes: 'Floats are a real jog, not a walk.' }));
    }
  } else if (phase === 'build') {
    const k = pickV(['1k', 'vo2', 'cruise'], v);
    if (k === '1k') {
      const reps = sc(4 + pl, 3, 7);
      title = 'Threshold 1K Repeats';
      summary = 'The HYROX unit: 1 km reps at threshold teach you to hold a strong, repeatable pace.';
      blocks.push(B('intervals', `${reps} × 1 km threshold`, [ctx.run('run-1k', { distanceM: 1000 }, 'threshold')], { rounds: reps, workSec: ctx.pc.threshold, restSec: 90, notes: '90 s jog recovery. Hit the pace, don’t beat it.' }));
    } else if (k === 'vo2') {
      const reps = sc(4 + pl, 3, 6);
      title = 'VO2 Intervals';
      summary = '3-minute reps at interval pace lift your aerobic ceiling.';
      blocks.push(B('intervals', `${reps} × 3 min`, [ctx.run('run-intervals', { timeSec: 180 }, 'interval')], { rounds: reps, workSec: 180, restSec: 120, notes: '2 min jog between reps.' }));
    } else {
      const min = clamp(8 + 2 * pl, 8, 12);
      const rounds = ctx.exp === 'beginner' ? 2 : 3;
      title = 'Cruise Intervals';
      summary = 'Long threshold reps with short rests — big aerobic stimulus, controlled fatigue.';
      blocks.push(B('intervals', `${rounds} × ${min} min threshold`, [ctx.run('run-threshold', { timeSec: min * 60 }, 'threshold')], { rounds, workSec: min * 60, restSec: 90 }));
    }
  } else {
    const k = pickV(['race1k', 'cruise'], v);
    if (k === 'race1k') {
      const reps = sc(6 + pl, 4, 8);
      title = 'Race-Pace 1K Repeats';
      summary = 'Lock in race rhythm: 1 km reps with roxzone-length recoveries. Fresh legs, so a touch quicker than race target.';
      blocks.push(B('intervals', `${reps} × 1 km race rhythm`, [ctx.run('run-1k', { distanceM: 1000 }, 'raceFresh')], { rounds: reps, workSec: ctx.pc.raceFresh, restSec: 60, notes: '60 s recovery ≈ a station transition. Every rep the same split.' }));
    } else {
      const min = ctx.exp === 'beginner' ? 10 : 15;
      title = 'Threshold Cruise';
      summary = 'Sustained threshold running to sharpen the engine before race week.';
      blocks.push(B('intervals', `2 × ${min} min threshold`, [ctx.run('run-threshold', { timeSec: min * 60 }, 'threshold')], { rounds: 2, workSec: min * 60, restSec: 120 }));
    }
  }
  if (extra === 'c') {
    blocks.push(B('emom', `Compromised finisher · ${deload || taper ? 6 : 8}-min EMOM`, [
      ctx.kb('kb-swing', { reps: 15 }),
      ...stationItems(ctx, 'wall-balls', 0.12),
    ], { minutes: deload || taper ? 6 : 8, alternate: true, notes: 'Straight from the run: practise working on tired legs.' }));
    title += ' + KB Finisher';
  }
  blocks.push(coolRun());
  return { title: deload && !taper ? `Deload · ${title}` : title, type: 'run', summary, blocks };
}

function zoneRun(ctx, wk, kind) {
  const { deload, taper, L } = wk;
  const capEasy = { beginner: 40, intermediate: 50, advanced: 60 }[ctx.exp];
  const capLong = { beginner: 60, intermediate: 80, advanced: 95 }[ctx.exp];
  const blocks = [];
  let title, summary, min;
  if (kind === 'long') {
    min = clamp(40 + 5 * L, 40, wk.phase === 'peak' ? Math.min(capLong, 70) : capLong);
    title = pickV(['Long Aerobic Run', 'Long Run', 'Engine Builder Long Run'], wk.v);
    summary = 'The cornerstone of HYROX fitness: long, easy, Zone 2. Builds the aerobic base everything else sits on.';
  } else if (kind === 'shake') {
    min = 20; title = 'Shakeout Run'; summary = 'Easy legs, a few strides. Stay loose.';
  } else {
    min = clamp(30 + 3 * L, 30, capEasy);
    title = kind === 'strides' ? 'Easy Miles + Strides' : pickV(['Aerobic Base Run', 'Zone 2 Run', 'Easy Engine Run'], wk.v);
    summary = 'Easy Zone 2 running. Conversational pace builds capillaries, mitochondria and durability.';
  }
  if (deload) min *= 0.7;
  if (taper) min = Math.min(min * 0.55, ctx.p.daysPerWeek === 3 ? 20 : 30);
  min = Math.max(15, Math.round(min / 5) * 5);
  blocks.push(B('warmup', 'Mobility primer', [
    { exId: 'mob-leg-swings', reps: 10, perSide: true },
    { exId: 'mob-ankle-rocks', reps: 10, perSide: true },
    { exId: 'mob-glute-bridge', reps: 10 },
  ], { notes: 'Two minutes to wake the hips and ankles.' }));
  blocks.push(B('cardio', `${min} min ${kind === 'long' ? 'long run' : 'easy'}`, [ctx.run(kind === 'long' ? 'run-long' : 'run-easy', { timeSec: min * 60 }, kind === 'long' ? 'long' : 'easy')], {
    notes: (ctx.eq.bike || ctx.eq.row ? 'Run if you can; bike/row at the same HR is fine if legs need a break. ' : '') + (kind === 'long' && min >= 75 ? 'Take water and a gel/carbs after 60 min.' : 'Nose-breathing pace.'),
  }));
  if (kind === 'strides' || kind === 'shake') blocks.push(B('cardio', 'Strides', [ctx.run('run-strides', { timeSec: 20, sets: kind === 'shake' ? 4 : 6 }, 'strides')], { notes: 'Fast and relaxed with full walk-back recovery.' }));
  blocks.push(coolRun());
  return { title: deload ? `Deload · ${title}` : title, type: 'run', summary, blocks };
}

const STATION_PAIRS = [['skierg', 'sled-push'], ['sandbag-lunges', 'wall-balls'], ['sled-pull', 'bbj'], ['row', 'farmers']];
const stationName = (id) => STATIONS.find((s) => s.id === id)?.name || id;

function hybridSession(ctx, wk, extra) {
  const { deload, pl } = wk;
  // Indexed by loading weeks (not calendar weeks) so a deload never "uses up" a station pair.
  const [a, b] = pickV(STATION_PAIRS, pl);
  const rounds = deload ? 2 : clamp(3 + pl, 3, 5);
  const blocks = [warmHybrid(ctx)];
  if (extra === 'e') blocks.push(B('emom', `Pre-fatigue · ${deload ? 6 : 10}-min EMOM`, [
    ctx.kb(ctx.pick('kb-swing-double', 'kb-swing'), { reps: 12 }),
    ctx.kb('kb-goblet-thruster', { reps: 8 }, 0),
  ], { minutes: deload ? 6 : 10, alternate: true, notes: 'KB conditioning first — then run on loaded legs.' }));
  const title = pickV(['Compromised 1K Repeats', 'Roxzone Grinder', 'Station Stack', 'Run–Station Ladder'], pl);
  blocks.push(B('circuit', `${rounds} rounds: 1 km + ${stationName(a)} + ${stationName(b)}`, [
    ctx.run('run-1k', { distanceM: 1000 }, 'race'),
    ...stationItems(ctx, a, 0.5),
    ...stationItems(ctx, b, 0.5),
  ], { rounds, restSec: 90, notes: 'Run straight into the stations. Hold the same 1 km split every round — that is the skill.' }));
  // Lunges and wall balls cost the most race time → practise them every hybrid session.
  if (a !== 'sandbag-lunges') blocks.push(B('circuit', `Lunge & wall-ball finisher × ${deload ? 1 : 2}`, [
    ...stationItems(ctx, 'sandbag-lunges', 0.25),
    ...stationItems(ctx, 'wall-balls', 0.3),
  ], { rounds: deload ? 1 : 2, restSec: 60, notes: 'Unbroken if you can — these two stations decide most races.' }));
  blocks.push(B('circuit', 'Core', [{ exId: 'bw-plank', timeSec: 40 }, { exId: 'bw-side-plank', timeSec: 25, perSide: true }], { rounds: 2, restSec: 20 }));
  blocks.push(coolRun());
  return { title: deload ? `Deload · ${title}` : title, type: 'hybrid', summary: `Compromised running: race-pace 1 km reps straight into ${stationName(a)} and ${stationName(b)} work, then lunges and wall balls. Learn to run well on tired legs.`, blocks };
}

function simulation(ctx, full, opts = {}) {
  const runM = full ? 1000 : 500;
  const frac = full ? 1 : 0.5;
  const mode = opts.race ? true : 'spec';
  const blocks = [warmHybrid(ctx)];
  STATIONS.forEach((st, i) => {
    blocks.push(B('cardio', `Run ${i + 1} · ${runM === 1000 ? '1 km' : '500 m'}`, [ctx.run(runM === 1000 ? 'run-1k' : 'run', { distanceM: runM }, 'race')], { notes: i === 0 ? 'Start controlled — the first km should feel easy.' : 'Settle into race pace within 200 m.' }));
    blocks.push(B('station', `${st.name}${full ? '' : ' (half)'}`, stationItems(ctx, st.id, frac, mode), { notes: st.tips[0] }));
  });
  blocks.push(coolRun());
  const title = opts.title || (full ? 'Full HYROX Simulation' : 'HYROX Half Simulation');
  const summary = full
    ? 'Race rehearsal: 8 × (1 km run + station), kettlebell substitutions where you lack sleds/ergs. Practise pacing, transitions and fuelling.'
    : 'Half simulation: 8 × (500 m + half station) — race rhythm without the full cost.';
  return { title, type: 'hyrox', summary, blocks };
}

function raceDay(ctx) {
  const pred = ctx.generic ? null : predictRace({ profile: ctx.p, sessions: [] });
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  const blocks = [B('warmup', 'Race warm-up', [
    ctx.run('run-easy', { timeSec: 600 }, 'easy'),
    { exId: 'mob-wgs', reps: 3, perSide: true },
    { exId: 'mob-leg-swings', reps: 10, perSide: true },
    ctx.run('run-strides', { timeSec: 20, sets: 3 }, 'strides'),
    { exId: 'bw-burpee', reps: 3 },
  ], { notes: 'Finish the warm-up 10–15 min before your start wave.' })];
  STATIONS.forEach((st, i) => {
    const runTarget = pred ? pred.splits[i * 2].sec : null;
    const stTarget = pred ? pred.splits[i * 2 + 1].sec : null;
    blocks.push(B('cardio', `Run ${i + 1}`, [{ exId: 'run-1k', distanceM: 1000, paceSec: runTarget || ctx.pc.race, note: runTarget ? `Target ~${mmss(runTarget)} (${ctx.fmtP(runTarget)} ${ctx.units === 'metric' ? '/km' : '/mi'})` : 'Race pace' }]));
    blocks.push(B('station', st.name, [{ exId: st.exId, ...(st.reps ? { reps: st.reps } : { distanceM: st.distanceM }), note: `${st.spec[ctx.spec]}${stTarget ? ` · target ~${mmss(stTarget)}` : ''}` }], { notes: st.tips[0] }));
  });
  blocks.push(B('cooldown', 'After the finish', [{ exId: 'mob-walk', timeSec: 600 }, { exId: 'mob-breathing', timeSec: 120 }], { notes: 'Walk, refuel (carbs + protein), hydrate. Celebrate.' }));
  return {
    title: 'HYROX Race Day', type: 'hyrox', fixed: true, blocks,
    estMin: pred ? Math.round(pred.totalSec / 60) + 20 : undefined,
    summary: pred ? `Race day. Predicted finish ~${Math.round(pred.totalSec / 60)} min. Run the first km easy, hold pace, trust the training.` : 'Race day. Run the first km easy, hold pace, trust the training.',
  };
}

function primer(ctx) {
  return {
    title: 'Race Primer', type: 'run', fixed: true, summary: 'Day before the race: 15 min easy, strides and a few race movements. Then feet up, carbs in.',
    blocks: [
      warmRun(ctx, 8),
      B('cardio', 'Strides', [ctx.run('run-strides', { timeSec: 20, sets: 4 }, 'strides')]),
      B('circuit', 'Movement rehearsal', [{ exId: 'bw-bbj', distanceM: 10 }, ctx.kb('kb-goblet-thruster', { reps: 5, kg: ctx.light('kb-goblet-thruster') }), ctx.kb('kb-goblet-walking-lunge', { distanceM: 10, kg: ctx.light('kb-goblet-walking-lunge') })], { rounds: 1, restSec: 0, notes: 'Light and crisp — just remind the body.' }),
      coolRun(),
    ],
  };
}

function recoveryFlow() {
  return {
    title: 'Recovery Mobility Flow', type: 'recovery', summary: 'Down-regulate and restore range: breathing, easy movement and hip/T-spine mobility.',
    blocks: [
      B('warmup', 'Breathe & reset', [{ exId: 'mob-breathing', timeSec: 120 }, { exId: 'mob-cat-cow', reps: 10 }]),
      B('cardio', 'Easy flush', [{ exId: 'mob-walk', timeSec: 900, note: 'Zone 1, nasal breathing' }]),
      B('cooldown', 'Mobility flow', [
        { exId: 'mob-90-90', reps: 8 }, { exId: 'mob-wgs', reps: 4, perSide: true }, { exId: 'mob-t-spine', reps: 6, perSide: true },
        { exId: 'mob-thread-needle', reps: 6, perSide: true }, { exId: 'mob-couch', timeSec: 60, perSide: true }, { exId: 'mob-pigeon', timeSec: 60, perSide: true },
        { exId: 'mob-deep-squat', timeSec: 60 }, { exId: 'mob-childs-pose', timeSec: 60 },
      ], { notes: 'Slow, 2–3 breaths per position.' }),
    ],
  };
}

// ---------- Templates (Train → "More sessions") ----------
export function buildTemplates(profile) {
  const ctx = makeCtx(profile);
  const fin = (id, w) => finalize(ctx, w, { id });
  const wk = { phase: 'build', pl: 1, L: 4, vol: 1, step: 0, v: 0 };
  const testBell = ctx.generic ? undefined : ctx.near('kb-swing', ctx.female ? 16 : 24);
  return [
    fin('t-1k-tt', {
      title: '1 km Time Trial', type: 'run', benchmark: true, summary: 'Benchmark: your best 1 km. Feeds race prediction and paces.',
      blocks: [warmRun(ctx, 12), B('cardio', 'Strides', [ctx.run('run-strides', { timeSec: 20, sets: 3 }, 'strides')]),
        B('cardio', '1 km all-out', [{ exId: 'run-1k', distanceM: 1000, benchmark: true, note: 'Even effort: controlled first 400 m, empty the tank in the last 300 m. Log your time.' }]), coolRun()],
    }),
    fin('t-5k-tt', {
      title: '5 km Time Trial', type: 'run', benchmark: true, summary: 'Benchmark: 5 km for time. Re-sets every training pace in the app.',
      blocks: [warmRun(ctx, 12), B('cardio', '5 km for time', [{ exId: 'run', distanceM: 5000, benchmark: true, note: 'Start at goal pace, settle by 1 km, push the last 1 km. Log your time.' }]), coolRun()],
    }),
    fin('t-swing-test', {
      title: '10-Min Swing Test', type: 'conditioning', benchmark: true, summary: 'Benchmark: max two-hand swings in 10 minutes with one bell. Feeds strength-endurance scores.',
      blocks: [warmKB(ctx), B('amrap', '10 min max swings', [ctx.kb('kb-swing', { reps: 10, kg: testBell, note: 'Same bell every test (Open M 24 / W 16 kg). Park when form slips. Log total reps.' })], { durationSec: 600 }), coolKB()],
    }),
    fin('t-station-benchmark', {
      title: 'Station Benchmark', type: 'hyrox', benchmark: true, summary: 'Time each HYROX station (or its substitute) fresh, with full rest. Log each time.',
      blocks: [warmHybrid(ctx), ...STATIONS.map((st) => B('station', st.name, stationItems(ctx, st.id, 1, true), { restSec: 180, notes: 'For time. Rest 3 min after.' })), coolRun()],
    }),
    fin('t-full-sim', simulation(ctx, true, { race: true, title: 'Full HYROX Simulation (KB-substituted)' })),
    fin('t-half-sim', simulation(ctx, false)),
    fin('t-kb-finisher', {
      title: '20-Min KB Finisher', type: 'conditioning', summary: 'A self-contained 20-minute kettlebell AMRAP when time is short.',
      blocks: [warmKB(ctx), B('amrap', '20-min AMRAP', [
        ctx.kb('kb-swing', { reps: 15 }), ctx.kb('kb-goblet-squat', { reps: 10 }), ctx.kb('kb-clean-press', { reps: 5, perSide: true }), { exId: 'bw-burpee', reps: 5 },
      ], { durationSec: 1200, notes: 'Steady pace you can hold for 20 min. Count rounds.' }), coolKB()],
    }),
    fin('t-iron-engine', conditioningSession(ctx, { ...wk, phase: 'base' }, null)),
    fin('t-compromised', hybridSession(ctx, wk, null)),
    fin('t-recovery-flow', recoveryFlow()),
    { id: 't-free', title: 'Free Session', type: 'conditioning', phase: null, week: null, estMin: 0, summary: 'Blank session — log whatever you did.', equipment: [], blocks: [] },
  ];
}

export const TEMPLATES = buildTemplates(null);

// ---------- Periodisation ----------
function phaseLayout(raceWeeks) {
  const B = Math.min(raceWeeks, 24);
  const gp = raceWeeks - B;
  let base, build, peak, taper;
  if (B >= 4) {
    taper = 1; peak = B >= 16 ? 3 : B >= 8 ? 2 : 1;
    const rest = B - taper - peak;
    build = Math.round(rest / 2); base = rest - build;
  } else { taper = 1; peak = B >= 2 ? 1 : 0; build = B >= 3 ? 1 : 0; base = 0; }
  return [
    ...Array(gp).fill({ phase: 'base', gp: true }),
    ...Array(base).fill({ phase: 'base' }),
    ...Array(build).fill({ phase: 'build' }),
    ...Array(peak).fill({ phase: 'peak' }),
    ...Array(taper).fill({ phase: 'taper' }),
  ];
}

function focusFor(lay, deload) {
  if (lay.post) return 'Post-race recovery: easy movement, then rebuild';
  if (deload) return 'Deload — volume down ~40%, absorb the work';
  if (lay.gp) return 'General prep: aerobic base, movement quality, bell skills';
  return {
    base: 'Aerobic base + kettlebell strength foundation',
    build: 'Threshold running, strength-endurance, station work',
    peak: 'Race-pace compromised running + simulations',
    taper: 'Taper: sharpen, freshen, race',
  }[lay.phase];
}

function buildSession(ctx, code, wk) {
  const [head, extra] = code.split('+');
  const [k, sub] = head.split(':');
  switch (k) {
    case 'S': return strengthSession(ctx, wk, sub === 'maint' || sub === 'taper' ? 'maint' : sub, extra);
    case 'C': return conditioningSession(ctx, wk, extra);
    case 'Q': return sub ? qualityRun(ctx, { ...wk, kind: sub }, extra) : qualityRun(ctx, wk, extra);
    case 'Z': return zoneRun(ctx, wk, sub || 'easy');
    case 'H': return hybridSession(ctx, wk, extra);
    case 'X': return wk.fullSim ? simulation(ctx, true, { race: true }) : simulation(ctx, false);
    case 'R': return recoveryFlow();
    case 'PRIMER': return primer(ctx);
    case 'RACE': return raceDay(ctx);
    case 'GRAD': return { ...simulation(ctx, true, { race: true }), title: 'Graduation Simulation', benchmark: true, summary: 'End of block: a full HYROX simulation to measure how far you have come. Log every split.' };
    default: return recoveryFlow();
  }
}

// ---------- Run volume (km) & ramp guard ----------
function runKmOf(ctx, raws) {
  let m = 0;
  for (const w of raws) for (const b of w.blocks) {
    const mult = b.kind === 'circuit' || b.kind === 'intervals' ? b.rounds || 1 : 1;
    for (const it of b.items || []) {
      if (getExercise(it.exId).category !== 'run') continue;
      const one = it.distanceM ? it.distanceM : ((it.timeSec || 0) / (it.paceSec || ctx.pc.easy[0])) * 1000;
      m += one * (it.sets || 1) * mult;
    }
  }
  return m / 1000;
}

// Minimum quality dose per experience when trimming for the ramp guard.
const QFLOOR = {
  beginner: { k1: 3, vo2: 3, repMin: 6, tempoMin: 15 },
  intermediate: { k1: 4, vo2: 4, repMin: 8, tempoMin: 20 },
  advanced: { k1: 5, vo2: 5, repMin: 10, tempoMin: 25 },
};

// Bring the week under `targetKm` by trimming, in order: easy runs/flush tails (floor 20 min), long run
// (floor max(30 min, 85%)), hybrid rounds (floor 3), then quality — never below the experience floor (QFLOOR).
function capRunVolume(ctx, raws, targetKm) {
  const over = () => runKmOf(ctx, raws) > targetKm + 0.05;
  const blocks = raws.flatMap((w) => w.blocks);
  const fl = QFLOOR[ctx.exp];
  const shrink = (ids, floorOf) => {
    const adj = [];
    for (const b of blocks) if (b.kind === 'cardio') for (const it of b.items) if (ids.includes(it.exId) && it.timeSec > floorOf(it)) adj.push({ b, it });
    const adjKm = adj.reduce((a, { it }) => a + it.timeSec / (it.paceSec || ctx.pc.easy[0]), 0);
    if (adjKm < 0.2) return;
    const f = clamp((targetKm - (runKmOf(ctx, raws) - adjKm)) / adjKm, 0, 1);
    for (const { b, it } of adj) {
      it.timeSec = Math.max(floorOf(it), Math.round((it.timeSec * f) / 300) * 300);
      b.title = b.title.replace(/^\d+ min/, `${Math.round(it.timeSec / 60)} min`);
    }
  };
  const cutRounds = (pred, floorOf) => {
    for (let i = 0; i < 4 && over(); i++) {
      const b = blocks.find((x) => pred(x) && x.rounds > floorOf(x));
      if (!b) break;
      b.rounds -= 1;
      b.title = b.title.replace(/^\d+ rounds/, `${b.rounds} rounds`).replace(/^\d+ ×/, `${b.rounds} ×`);
    }
  };
  const runItem = (b) => b.items?.find((it) => getExercise(it.exId).category === 'run' && it.paceSec);
  const isHybrid = (b) => b.kind === 'circuit' && b.items.some((it) => it.exId === 'run-1k');
  const isQuality = (b) => b.kind === 'intervals' && !!runItem(b);

  if (over()) shrink(['run-easy'], () => 1200);
  if (over()) { const orig = new Map(); for (const b of blocks) for (const it of b.items || []) if (it.exId === 'run-long') orig.set(it, it.timeSec); shrink(['run-long'], (it) => Math.max(1800, Math.round((orig.get(it) * 0.85) / 300) * 300)); }
  cutRounds(isHybrid, () => 3);
  // Quality: fewer reps (1 km / VO2) or shorter reps (cruise/tempo), never below the floor.
  cutRounds(isQuality, (b) => (runItem(b).exId === 'run-1k' ? fl.k1 : runItem(b).exId === 'run-intervals' ? fl.vo2 : 99));
  for (const q of blocks) {
    if (!over()) break;
    if (!['intervals', 'cardio'].includes(q.kind)) continue;
    const it = q.items?.find((x) => ['run-tempo', 'run-threshold'].includes(x.exId) && x.timeSec);
    if (!it) continue;
    const floor = (it.exId === 'run-tempo' && q.kind === 'cardio' ? fl.tempoMin : fl.repMin) * 60;
    if (it.timeSec <= floor) continue;
    const t = Math.max(floor, Math.round((it.timeSec * 0.8) / 60) * 60);
    q.title = q.title.replace(`${Math.round(it.timeSec / 60)} min`, `${Math.round(t / 60)} min`);
    it.timeSec = t; if (q.kind === 'intervals') q.workSec = t;
  }
}

export function generatePlan(profile, startISO) {
  const p = normProfile(profile);
  const start = isISO(startISO) ? startISO : todayISO();
  const ctx = makeCtx(p);
  let race = isISO(p.raceDate) && daysBetween(start, p.raceDate) >= 0 ? p.raceDate : null;
  const hasRace = !!race;
  if (!race) race = addDays(start, 12 * 7 - 1);
  const daysToRace = daysBetween(start, race);
  const raceWeeks = Math.floor(daysToRace / 7) + 1;
  const raceInPlan = raceWeeks <= 40;
  const nWeeks = raceInPlan ? Math.max(4, raceWeeks) : 12;
  const raceIdx = daysToRace % 7;

  const layout = raceInPlan ? phaseLayout(raceWeeks) : Array(nWeeks).fill({ phase: 'base', gp: true });
  while (layout.length < nWeeks) layout.push({ phase: 'base', post: true });
  // Race early in its week → the previous week starts the taper (taper = last 7–10 days).
  if (raceInPlan && raceIdx <= 2 && raceWeeks >= 6 && layout[raceWeeks - 2].phase === 'peak') layout[raceWeeks - 2] = { phase: 'taper', early: true };

  const peakWeeks = layout.map((l, i) => (l.phase === 'peak' ? i : -1)).filter((i) => i >= 0);
  const fullSimWeek = peakWeeks.length >= 2 ? peakWeeks[peakWeeks.length - 2] : -1;

  // Deloads: every 4th Base/Build week (3:1 loading).
  const deloads = new Set();
  let count = 0;
  for (let w = 0; w < nWeeks; w++) {
    const lay = layout[w];
    if (lay.post) { if (w === raceWeeks) deloads.add(w); continue; }
    if (lay.phase !== 'base' && lay.phase !== 'build') { count = 0; continue; }
    if (++count === 4) { deloads.add(w); count = 0; } // a deload opening a new block doubles as its transition week
  }

  const slots = SLOTS[p.daysPerWeek];
  const weeks = [], workouts = {};
  let L = 0, prevKm = null;
  const phaseLoad = {};

  for (let w = 0; w < nWeeks; w++) {
    const lay = layout[w];
    const phase = lay.phase;
    const deload = deloads.has(w);
    const pl = phaseLoad[phase] || 0;
    const taper = phase === 'taper';
    const step = (phase === 'build' || phase === 'peak' || taper) && !deload ? 1 : 0;
    const wk = { phase, week: w + 1, deload, taper, pl, L, vol: deload ? 0.6 : taper ? 0.55 : 1, step, v: w, fullSim: w === fullSimWeek };

    // Session codes per day index (0..6)
    const codes = Array(7).fill(null);
    const isRaceWeek = raceInPlan && w === raceWeeks - 1;
    if (isRaceWeek) {
      // Latest-first: openers 3 days out, strength early in the week, easy run between; primer the day before.
      const avail = Array.from({ length: Math.max(0, raceIdx - 2) }, (_, i) => i);
      const k = Math.min(Math.max(p.daysPerWeek - 2, 2), 3, avail.length);
      const seq = k === 1 ? ['Q:openers'] : k === 2 ? (p.daysPerWeek === 3 ? ['Z:easy', 'Q:openers'] : ['S:taper', 'Q:openers']) : k === 3 ? ['S:taper', 'Z:easy', 'Q:openers'] : [];
      const last = avail.length - 1;
      const pos = k === 1 ? [last] : k === 2 ? [0, last] : k === 3 ? [0, Math.max(1, Math.floor(last / 2)), last] : [];
      seq.forEach((c, j) => { codes[avail[pos[j]]] = c; });
      if (raceIdx >= 1) codes[raceIdx - 1] = 'PRIMER';
      codes[raceIdx] = hasRace ? 'RACE' : 'GRAD';
    } else if (lay.post) {
      const tpl = ['R', 'Z:easy', 'S:full', 'C', 'Z:long', 'Z:easy'];
      slots.forEach((d, j) => { codes[d] = tpl[j]; });
    } else {
      const t = WEEK[p.daysPerWeek][phase === 'taper' ? 'peak' : phase];
      slots.forEach((d, j) => { codes[d] = t[j]; });
      // Early taper (race early next week): one opener, one reduced cruise, no KB conditioning.
      if (phase === 'taper') for (let d = 0; d < 7; d++) {
        if (codes[d] === 'X') codes[d] = 'Q:openers';
        else if (codes[d]?.startsWith('Q')) codes[d] = 'Q:taperq';
        else if (codes[d]?.startsWith('C')) codes[d] = 'Z:easy';
      }
    }

    const raws = codes.map((code) => (code ? buildSession(ctx, code, wk) : null));
    const list = raws.filter(Boolean);
    // Ramp guard: ≤ +15% run km over the last loading week; deloads ≤ 70% of it. Sim, taper and race weeks exempt.
    // Simulation weeks may reach +25% (the sim itself is race-specific running); they don't reset the baseline.
    const hasSim = codes.some((c) => c === 'X');
    const guarded = !taper && !isRaceWeek && !lay.post;
    // The first Build week may reach +20% (new block, new session types); otherwise +15%.
    const firstBuild = phase === 'build' && pl === 0 && !deload;
    if (guarded && prevKm != null) capRunVolume(ctx, list, prevKm * (deload ? 0.7 : hasSim ? 1.25 : firstBuild ? 1.2 : 1.15));
    if (guarded && !deload && !hasSim) prevKm = runKmOf(ctx, list);

    const days = [];
    for (let d = 0; d < 7; d++) {
      const date = addDays(start, w * 7 + d);
      if (!raws[d]) { days.push({ date, workoutId: null, rest: true }); continue; }
      const id = `w${w + 1}-d${d + 1}`;
      workouts[id] = finalize(ctx, raws[d], { id, phase, week: w + 1, hold: deload || taper });
      days.push({ date, workoutId: id, rest: false });
    }
    weeks.push({ index: w, phase, deload, focus: focusFor(lay, deload), days });
    if (!deload && !taper && !lay.post) { L++; phaseLoad[phase] = pl + 1; }
  }

  for (const t of buildTemplates(p)) workouts[t.id] = t;

  return {
    generatedAt: new Date().toISOString(),
    startDate: start,
    raceDate: race,
    raceIsDefault: !hasRace,
    weeks,
    workouts,
  };
}

// ---------- Lookups ----------
export function getWorkout(plan, id) {
  if (!id) return null;
  const key = id === 'free' ? 't-free' : id;
  return plan?.workouts?.[key] || TEMPLATES.find((t) => t.id === key) || null;
}

export function workoutForDate(plan, iso) {
  for (const week of plan?.weeks || []) for (const day of week.days || []) {
    if (day.date === iso) return { day, week, workout: day.workoutId ? getWorkout(plan, day.workoutId) : null };
  }
  return { day: null, week: null, workout: null };
}
