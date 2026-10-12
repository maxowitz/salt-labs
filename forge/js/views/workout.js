// FORGE workout player — #/workout/<workoutId> and #/workout/free. Immersive (router hides the tab bar).
// Block-by-block player with set logging, rest timer, interval timers, cardio logging, persistence & summary.
import { store, todayISO, uid } from '../store.js';
import {
  h, clear, icon, toast, sheet, confirmDialog, navigate, fmtWeight, fmtBell, bellLb, fmtDist, fmtDur, fmtPace,
  num, haptic, parseDur, M_PER_MI, stepper,
} from '../ui.js';
import * as program from '../engine/program.js';
import * as coach from '../engine/coach.js';
import * as exdb from '../data/exercises.js';
import * as sessionApi from './session.js';
import { IntervalTimer, buildSegments, beep, speak, wakeLock, unlockAudio } from '../engine/timer.js';
import { timerFace, timerControls, roundCounter, phaseOf, faceTime, fmtClock } from './_timerui.js';

/** append that skips null/false and flattens arrays (native append would stringify them) */
const put = (el, ...kids) => { el.append(...kids.flat(Infinity).filter((k) => k != null && k !== false)); return el; };

// ---------------------------------------------------------------- helpers
const TIMED = new Set(['emom', 'amrap', 'intervals', 'circuit', 'tabata']);
const CARDIO = new Set(['cardio', 'station']);
const LIST = new Set(['warmup', 'cooldown']);
const KIND_LABEL = {
  warmup: 'Warm-up', strength: 'Strength', emom: 'EMOM', amrap: 'AMRAP', intervals: 'Intervals', circuit: 'Circuit',
  tabata: 'Tabata', cardio: 'Cardio', station: 'Station', cooldown: 'Cool-down',
};
const SAVE_MS = 800;

function safe(fn, fallback) {
  try { const v = fn(); return v === undefined ? fallback : v; } catch (e) { console.warn('FORGE player:', e); return fallback; }
}
const pretty = (id) => String(id || 'exercise').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
function ex(id) {
  const e = safe(() => exdb.getExercise?.(id), null);
  return e && typeof e === 'object' ? e : { id, name: pretty(id), category: 'kb', cues: [], faults: [], muscles: [] };
}
const exName = (id) => ex(id).name || pretty(id);
function isCardioEx(id) {
  const e = ex(id);
  if (e.category === 'run' || e.category === 'erg') return true;
  if (e.category === 'hyrox') return e.pattern === 'cardio'; // SkiErg / Row stations
  return e.unknown ? /^(run|row|ski|bike|erg)/.test(id || '') : false;
}
function cardioMode(id) {
  const s = String(id || '');
  if (/row/.test(s)) return 'row';
  if (/ski/.test(s)) return 'ski';
  if (/bike|cycle|assault|echo/.test(s)) return 'bike';
  if (/walk|hike/.test(s)) return 'walk';
  return 'run';
}
const isKbEx = (id) => ex(id).category === 'kb' || /^kb[-_]/.test(id || '');
const isDouble = (id) => !!ex(id).double || /double|^kb-?2|2kb|-x2/.test(id || '');

/** "24 kg", or "2 × 24 kg" for double-bell lifts. */
const bellText = (kg, exId) => (isDouble(exId) ? `2 × ${fmtBell(kg)}` : fmtBell(kg));

function pairedBells(profile) {
  const fromCoach = safe(() => coach.pairedBells?.(profile), null);
  if (Array.isArray(fromCoach)) return fromCoach;
  const m = new Map();
  for (const b of profile?.bells || []) if (+b.kg > 0) m.set(+b.kg, (m.get(+b.kg) || 0) + Math.max(1, +b.count || 1));
  return [...m].filter(([, n]) => n >= 2).map(([kg]) => kg).sort((a, b) => a - b);
}

function ownedBells(profile) {
  const fromCoach = safe(() => coach.ownedBells?.(profile), null);
  if (Array.isArray(fromCoach) && fromCoach.length) return fromCoach;
  return [...new Set((profile?.bells || []).map((b) => +b.kg).filter((k) => k > 0))].sort((a, b) => a - b);
}

function itemTarget(it, block) {
  const parts = [];
  if (block?.kind === 'strength' && it.sets) parts.push(`${it.sets} ×`);
  if (it.reps) parts.push(`${it.reps}${it.perSide ? '/side' : ''} reps`.replace(' reps', block?.kind === 'strength' ? '' : ' reps'));
  if (it.timeSec && !it.reps) parts.push(fmtDur(it.timeSec));
  if (it.distanceM) parts.push(fmtTarget(it.distanceM));
  if (it.paceSec > 0) { const p = fmtPace(it.paceSec, units()); if (!String(it.note || '').includes(p)) parts.push(`@ ${p}`); }
  return parts.join(' ').trim();
}
const units = () => store.get().profile?.units || 'metric';
// Reps of a distance (400 m repeats, 50 m sled push) read best in metres in either unit system.
const fmtTarget = (m) => (m < 1000 ? `${Math.round(m)} m` : fmtDist(m, units()));
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const CAT_LABEL = { kb: 'Kettlebell', run: 'Run', erg: 'Erg', bodyweight: 'Bodyweight', hyrox: 'HYROX', mobility: 'Mobility' };

function readinessToday() {
  const r = store.get().readiness?.[todayISO()];
  return r && Number.isFinite(+r.score) ? +r.score : null;
}

function getPlanned(id) {
  const s = store.get();
  return safe(() => program.getWorkout?.(s.plan, id), null) || s.plan?.workouts?.[id] || null;
}

function freeWorkout() {
  return { id: 'free', title: 'Free session', type: 'strength', estMin: null, summary: 'Add exercises as you go and log sets or cardio.', equipment: [], blocks: [] };
}

/** Fallback only — coach.sessionVolumeKg is canonical. kg × reps (× 2 double bells, × 2 per side). */
function setVolume(st) {
  if (!(st.kg > 0) || !(st.reps > 0)) return 0;
  return st.kg * st.reps * (st.double ? 2 : 1) * (st.perSide ? 2 : 1);
}

// ---------------------------------------------------------------- view
export async function render(root, { args = [], query = {} } = {}) {
  // The router's fade-in leaves a transform on the view root, which would turn our position:fixed
  // header/footer/rest dock into children of the view box. The player manages its own transitions.
  root.classList.remove('fade-in');
  const id = args[0] ? decodeURIComponent(args[0]) : null;
  const disposers = [];
  const ctx = { root, disposers, dead: false };
  const cleanup = () => {
    ctx.dead = true;
    for (const d of disposers.splice(0)) { try { d(); } catch (e) { console.error(e); } }
  };

  if (!id) { notFound(root, null); return cleanup; }

  const s = store.get();
  const aw = s.activeWorkout;
  if (aw && aw.workoutId === id) {
    const clean = sanitizeActive(aw, id);
    if (!clean) { broken(ctx, aw); return cleanup; }
    try { player(ctx, clean); }
    catch (e) { console.error('FORGE player: could not restore workout', e); cleanup(); ctx.dead = false; broken(ctx, aw); }
    return cleanup;
  }
  if (aw && aw.workoutId) {
    conflict(ctx, aw, id);
    return cleanup;
  }
  const w = id === 'free' ? freeWorkout() : getPlanned(id);
  if (!w) { notFound(root, id); return cleanup; }
  if (query.go === '1' || query.go === 'true') {
    // Session detail already showed the whole session — start straight away (honours ?scaled=1|0).
    const { scaled, score } = scaledVersion(w);
    const useScaled = !!scaled && query.scaled !== '0';
    history.replaceState(null, '', location.pathname + location.search + '#/workout/' + encodeURIComponent(id));
    startWorkout(ctx, w, useScaled ? scaled : null, score);
    return cleanup;
  }
  preStart(ctx, w);
  return cleanup;
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const finiteOr = (v, d) => (Number.isFinite(+v) && v !== null && v !== '' ? +v : d);

/** Validate a restored activeWorkout (it may come from an old schema, an import or a hand edit).
 *  Returns a clean deep copy, or null when it is unusable. */
function sanitizeActive(raw, id) {
  if (!isObj(raw)) return null;
  let w = isObj(raw.workout) && Array.isArray(raw.workout.blocks) ? raw.workout : null;
  if (!w) w = id === 'free' ? freeWorkout() : getPlanned(id);
  if (!isObj(w)) return null;
  let aw;
  try { aw = structuredClone({ ...raw, workout: w }); } catch { return null; }
  const W = aw.workout;
  W.title = typeof W.title === 'string' ? W.title : 'Workout';
  W.blocks = (Array.isArray(W.blocks) ? W.blocks : []).filter(isObj).map((b) => ({
    ...b, kind: typeof b.kind === 'string' ? b.kind : 'strength',
    items: (Array.isArray(b.items) ? b.items : []).filter((it) => isObj(it) && typeof it.exId === 'string'),
  }));
  const n = W.blocks.length;
  aw.blockIndex = Math.max(0, Math.min(Math.max(0, n - 1), Math.trunc(finiteOr(aw.blockIndex, 0))));
  aw.stepIndex = Math.max(0, Math.trunc(finiteOr(aw.stepIndex, 0)));
  aw.log = (Array.isArray(aw.log) ? aw.log : []).filter((l) => isObj(l) && Number.isInteger(l.block) && l.block >= 0 && l.block < n);
  aw.blocks = isObj(aw.blocks) ? aw.blocks : {};
  for (const k of Object.keys(aw.blocks)) if (!isObj(aw.blocks[k]) || !(+k >= 0 && +k < n)) delete aw.blocks[k];
  for (const bs of Object.values(aw.blocks)) {
    for (const k of ['draft', 'extra', 'kg', 'items', 'checked']) if (k in bs && !isObj(bs[k])) bs[k] = {};
    for (const k of ['timer', 'itemTimer']) if (k in bs && !isObj(bs[k])) bs[k] = null;
    if (isObj(bs.draft)) for (const [i, d] of Object.entries(bs.draft)) if (!isObj(d)) delete bs.draft[i];
    if (isObj(bs.items)) for (const [i, d] of Object.entries(bs.items)) if (!isObj(d)) delete bs.items[i];
  }
  aw.elapsed = Math.max(0, finiteOr(aw.elapsed, 0));
  aw.runningSince = Number.isFinite(+aw.runningSince) && aw.runningSince > 0 ? +aw.runningSince : null;
  aw.paused = !!aw.paused || aw.runningSince == null;
  if (aw.paused) aw.runningSince = null;
  aw.rest = isObj(aw.rest) && isObj(aw.rest.snap) && Number.isFinite(+aw.rest.sec) ? aw.rest : null;
  if (typeof aw.startedAt !== 'string' || Number.isNaN(Date.parse(aw.startedAt))) aw.startedAt = new Date().toISOString();
  return aw;
}

function broken(ctx, aw) {
  const title = isObj(aw?.workout) && typeof aw.workout.title === 'string' ? aw.workout.title : 'the workout in progress';
  put(clear(ctx.root), h('div', { class: 'wo-empty' },
    icon('info', 36),
    h('h2', null, 'This workout can’t be resumed'),
    h('p', { class: 'muted' }, `The saved progress for ${title} is damaged, so FORGE can’t restore it.`),
    h('div', { class: 'stack wo-conflict-actions' },
      h('button', {
        class: 'btn primary xl block', on: {
          click: () => { store.update((d) => { d.activeWorkout = null; }); toast('Broken workout discarded'); navigate('#/today'); },
        },
      }, 'Discard broken workout'),
      h('a', { class: 'btn ghost block', href: '#/today' }, 'Back to Today'))));
}

function notFound(root, id) {
  put(clear(root), h('div', { class: 'wo-empty' },
    icon('info', 36),
    h('h2', null, 'Workout not found'),
    h('p', { class: 'muted' }, id ? `We couldn't find a session with id “${id}”. Your plan may have been regenerated.` : 'No workout was specified.'),
    h('div', { class: 'row gap' },
      h('a', { class: 'btn ghost', href: '#/train' }, 'Back to Train'),
      h('a', { class: 'btn primary', href: '#/workout/free' }, 'Start a free session'))));
}

function conflict(ctx, aw, id) {
  const title = (isObj(aw.workout) && typeof aw.workout.title === 'string' && aw.workout.title) || getPlanned(aw.workoutId)?.title || 'Unfinished workout';
  const mins = Math.round(elapsedOf(aw) / 60);
  put(clear(ctx.root), h('div', { class: 'wo-empty' },
    icon('timer', 36),
    h('h2', null, 'A workout is already in progress'),
    h('p', { class: 'muted' }, `“${title}” — ${mins} min in, ${(Array.isArray(aw.log) ? aw.log : []).filter((l) => l.type === 'set' || l.type === 'cardio').length} entries logged.`),
    h('div', { class: 'stack wo-conflict-actions' },
      h('button', { class: 'btn primary xl block', on: { click: () => navigate('#/workout/' + encodeURIComponent(aw.workoutId)) } }, 'Resume it'),
      h('button', {
        class: 'btn ghost block', on: {
          click: async () => {
            if (!(await confirmDialog(`Discard “${title}”? Logged sets from it will be lost.`, { ok: 'Discard', danger: true }))) return;
            store.update((d) => { d.activeWorkout = null; });
            navigate('#/workout/' + encodeURIComponent(id));
          },
        },
      }, 'Discard it and start this one'),
      h('a', { class: 'btn ghost block', href: '#/today' }, 'Not now'))));
}

function elapsedOf(aw) {
  return (+aw.elapsed || 0) + (aw.runningSince ? Math.max(0, (Date.now() - aw.runningSince) / 1000) : 0);
}

// ---------------------------------------------------------------- pre-start
const isLocked = (w) => !!(w?.fixed || w?.benchmark);

/** Readiness-scaled copy of a workout, or null when nothing would change. Fixed (race) and benchmark
 *  sessions are never scaled — scaleWorkout only returns advice for them. */
function scaledVersion(original) {
  const score = !(original.blocks || []).length ? null : readinessToday();
  let scaled = null, advice = [];
  if (score != null) {
    const r = safe(() => coach.scaleWorkout?.(original, score), null);
    if (r && Array.isArray(r.changes) && r.changes.length) {
      if (isLocked(original)) advice = r.changes;
      else if (r.workout) scaled = r;
    }
  }
  return { score, scaled, advice };
}

function startWorkout(ctx, original, scaled, score) {
  if (ctx.started) return; // double-tap on Start
  ctx.started = true;
  unlockAudio();
  const isFree = original.id === 'free' || !(original.blocks || []).length;
  const w = scaled ? scaled.workout : original;
  const aw = {
    workoutId: original.id, startedAt: new Date().toISOString(), blockIndex: 0, stepIndex: 0, log: [],
    paused: false, elapsed: 0, runningSince: Date.now(),
    workout: structuredClone(w), scaled: !!scaled, changes: scaled ? scaled.changes : [],
    readiness: score, blocks: {}, rest: null, finishing: false, free: isFree,
  };
  store.update((d) => { d.activeWorkout = aw; });
  player(ctx, structuredClone(aw), { fresh: true });
}

function preStart(ctx, original) {
  const { score, scaled, advice } = scaledVersion(original);
  let useScaled = !!scaled;
  const isFree = original.id === 'free' || !(original.blocks || []).length;
  const root = clear(ctx.root);
  const body = h('div', { class: 'wo-pre-body' });

  const draw = () => {
    const w = useScaled ? scaled.workout : original;
    put(clear(body), 
      h('div', { class: 'wo-pre-stats' },
        stat(w.estMin ? `${w.estMin}` : '—', 'min est.'),
        stat(String((w.blocks || []).length), 'blocks'),
        stat(String(countMoves(w)), 'exercises')),
      w.equipment?.length ? h('div', { class: 'chips' }, w.equipment.map((e) => h('span', { class: 'chip' }, e))) : null,
      readinessCard(),
      isFree ? h('div', { class: 'callout info' }, 'Add any exercise from the library once you start — sets, carries, runs or erg pieces. Everything is logged to your history.') : null,
      (w.blocks || []).length ? h('div', { class: 'card flush' }, h('div', { class: 'list' }, w.blocks.map((b, i) => h('div', { class: 'li' },
        h('span', { class: 'badge' }, String(i + 1).padStart(2, '0')),
        h('div', { class: 'li-main' },
          h('div', { class: 'li-title' }, b.title || KIND_LABEL[b.kind] || b.kind),
          h('div', { class: 'li-sub' }, blockSub(b))),
        h('span', { class: 'pill kind-' + b.kind }, KIND_LABEL[b.kind] || b.kind))))) : null);
  };

  function readinessCard() {
    if (isFree) return null;
    if (score == null) {
      return h('a', { class: 'callout wo-ready-hint', href: '#/today' }, h('strong', null, 'No readiness check-in today. '), 'Check in on Today and FORGE will scale this session to how you feel.');
    }
    if (advice.length) return h('div', { class: 'callout' }, h('strong', null, `Readiness ${Math.round(score)}. `), advice.join(' '));
    if (!scaled) return h('div', { class: 'callout go' }, h('strong', null, `Readiness ${Math.round(score)} — `), 'good to go as planned.');
    return h('div', { class: 'card wo-ready' },
      h('div', { class: 'row between' },
        h('div', null, h('div', { class: 'eyebrow' }, 'Readiness'), h('div', { class: 'big num' }, String(Math.round(score)))),
        h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Version' },
          ['Scaled', 'Original'].map((t, i) => h('button', {
            type: 'button', role: 'radio', 'aria-checked': String(useScaled === (i === 0)), class: useScaled === (i === 0) ? 'on' : '',
            on: { click: () => { useScaled = i === 0; draw(); } },
          }, t)))),
      h('ul', { class: 'wo-changes' + (useScaled ? '' : ' off') }, scaled.changes.map((c) => h('li', null, c))),
      useScaled ? null : h('p', { class: 'small muted' }, 'Running the original plan. Listen to your body.'));
  }

  const start = h('button', {
    class: 'btn primary xl block wo-start', on: {
      click: () => startWorkout(ctx, original, useScaled ? scaled : null, score),
    },
  }, h('span', null, isFree ? 'Start free session' : 'Start workout'), h('span', { class: 'k' }, '→'));
  start.addEventListener('click', () => { start.disabled = true; }, { capture: true });

  put(root, h('div', { class: 'wo-pre' },
    h('div', { class: 'wo-pre-top' },
      h('button', { class: 'icon-btn', 'aria-label': 'Back', on: { click: () => (history.length > 1 ? history.back() : navigate('#/train')) } }, icon('chevL')),
      h('span', { class: 'eyebrow' }, isFree ? 'Free session' : [original.type, original.phase && `${original.phase} · wk ${original.week ?? ''}`].filter(Boolean).join(' · '))),
    h('h1', { class: 'wo-pre-title' }, original.title || 'Workout'),
    original.summary ? h('p', { class: 'dim' }, original.summary) : null,
    body,
    h('div', { class: 'wo-pre-cta' }, start)));
  draw();
}

const stat = (v, k) => h('div', { class: 'stat' }, h('div', { class: 'v' }, v), h('div', { class: 'k' }, k));
const countMoves = (w) => new Set((w.blocks || []).flatMap((b) => (b.items || []).map((i) => i.exId))).size;
function blockSub(b) {
  const its = (b.items || []).map((i) => `${exName(i.exId)}${itemTarget(i, b) ? ' ' + itemTarget(i, b) : ''}`);
  const head = b.kind === 'emom' ? `${b.minutes || ''} min · ` : b.kind === 'amrap' ? `${fmtDur(b.durationSec || (b.minutes || 0) * 60)} · `
    : (b.kind === 'intervals' || b.kind === 'tabata') ? `${b.rounds || 8}×${b.workSec ? fmtDur(b.workSec) : ''}${b.restSec ? '/' + fmtDur(b.restSec) : ''} · `
      : b.kind === 'circuit' ? `${b.rounds || 3} rounds · ` : '';
  return head + its.join(' · ');
}

// ---------------------------------------------------------------- player
function player(ctx, aw, { fresh = false } = {}) {
  const st = store.get();
  const profile = st.profile || {};
  const priorSessions = st.sessions || [];
  const bells = ownedBells(profile);
  const pairs = pairedBells(profile);
  const bellPool = (exId) => (isDouble(exId) && pairs.length ? pairs : bells);
  aw.blocks = aw.blocks || {};
  aw.log = Array.isArray(aw.log) ? aw.log : [];
  aw.workout.blocks = Array.isArray(aw.workout.blocks) ? aw.workout.blocks : [];
  const W = aw.workout;
  const isFree = aw.workoutId === 'free' || !!aw.free;

  // ---- persistence (throttled)
  let saveTimer = null;
  let alive = true;
  const blockTimers = new Map(); // key → IntervalTimer (persisted via snapshot)
  const flush = () => {
    clearTimeout(saveTimer); saveTimer = null;
    if (!alive) return;
    for (const [key, t] of blockTimers) setPath(aw, key, t.snapshot());
    if (restTimer) aw.rest = { ...aw.rest, snap: restTimer.snapshot() };
    const copy = structuredClone(aw);
    store.update((d) => { d.activeWorkout = copy; });
  };
  let footKey = null;
  const save = () => {
    if (!saveTimer) saveTimer = setTimeout(flush, SAVE_MS);
    // keep the footer's primary action in sync with block completion
    const k = `${aw.blockIndex}|${W.blocks.length}|${blockComplete(aw.blockIndex)}`;
    if (footKey !== null && k !== footKey) drawFoot();
  };
  const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', flush);
  const releaseWake = wakeLock();
  // iOS only lets WebAudio/speech start inside a user gesture — after a refresh, unlock on the first touch.
  const onFirstTouch = () => unlockAudio();
  ctx.root.addEventListener('pointerdown', onFirstTouch, { once: true, capture: true });
  ctx.disposers.push(() => {
    flush(); alive = false;
    document.removeEventListener('visibilitychange', onHide);
    ctx.root.removeEventListener('pointerdown', onFirstTouch, { capture: true });
    window.removeEventListener('pagehide', flush);
    releaseWake();
    for (const t of blockTimers.values()) t.stop();
    restTimer?.stop();
    clearInterval(uiTick);
    document.body.classList.remove('wo-running');
  });

  // ---- sheets opened by the player are closed when the route changes (e.g. browser Back)
  const openSheets = new Set();
  const psheet = (opts) => {
    const sh = sheet({ ...opts, onClose: () => { openSheets.delete(sh); opts.onClose?.(); } });
    openSheets.add(sh);
    return sh;
  };
  ctx.disposers.push(() => { for (const sh of [...openSheets]) { try { sh.close(); } catch {} } });

  // ---- tickers (UI refresh), cleared on block re-render
  let tickers = new Set();
  const uiTick = setInterval(() => { for (const f of tickers) { try { f(); } catch (e) { console.error(e); } } }, 250);
  const elapsed = () => elapsedOf(aw);

  // ---- global pause
  function setPaused(p) {
    if (!!aw.paused === p) return;
    if (p) { aw.elapsed = elapsed(); aw.runningSince = null; aw.paused = true; for (const t of blockTimers.values()) t.pause(); restTimer?.pause(); }
    else { aw.runningSince = Date.now(); aw.paused = false; for (const t of blockTimers.values()) t.resume(); restTimer?.resume(); }
    haptic();
    syncPause();
    save();
  }

  // ---- rest timer (strength)
  let restTimer = null;
  function startRest(sec, label) {
    restTimer?.stop();
    aw.rest = { sec, label, block: aw.blockIndex };
    restTimer = new IntervalTimer([{ label: 'Rest', sec, kind: 'rest' }], { doneBeep: 'go', doneSay: 'Go', onDone: () => endRest() });
    restTimer.start();
    if (aw.paused) restTimer.pause();
    drawRest();
    save();
  }
  function restoreRest() {
    if (!aw.rest?.snap || aw.rest.block !== aw.blockIndex) { aw.rest = null; return; }
    const t = new IntervalTimer([{ label: 'Rest', sec: aw.rest.sec, kind: 'rest' }], { restore: aw.rest.snap, onDone: () => { endRest(); } });
    if (t.state.done) { aw.rest = null; return; }
    restTimer = t;
    t.tick();
    if (!restTimer) return; // finished during catch-up
    if (aw.paused) t.pause();
  }
  function endRest() {
    restTimer?.stop(); restTimer = null; aw.rest = null;
    drawRest(); save();
  }

  // ---- layout
  const root = clear(ctx.root);
  document.body.classList.add('wo-running');
  const elapsedEl = h('span', { class: 'wo-elapsed num' }, fmtClock(elapsed()));
  const pauseBtn = h('button', { class: 'icon-btn filled wo-pause', 'aria-label': 'Pause workout', on: { click: () => setPaused(!aw.paused) } }, icon('pause', 22));
  const progEl = h('button', { class: 'wo-prog', 'aria-label': 'Show all blocks', on: { click: () => blocksSheet() } });
  const header = h('header', { class: 'wo-head' },
    h('button', { class: 'icon-btn filled', 'aria-label': 'End or leave workout', on: { click: () => endSheet() } }, icon('x', 22)),
    h('div', { class: 'wo-head-mid' }, h('div', { class: 'wo-head-title' }, W.title || 'Workout'), elapsedEl),
    pauseBtn);
  const main = h('div', { class: 'wo-main' });
  const restDock = h('div', { class: 'wo-rest-dock' });
  const foot = h('footer', { class: 'wo-foot' });
  const pausedVeil = h('div', { class: 'wo-veil', hidden: true },
    h('div', { class: 'wo-veil-card' },
      h('div', { class: 'eyebrow' }, 'Paused'),
      h('div', { class: 'wo-veil-time num' }, ''),
      h('button', { class: 'btn primary xl block', on: { click: () => setPaused(false) } }, 'Resume'),
      h('button', { class: 'btn ghost block', on: { click: () => endSheet() } }, 'End workout…')));
  put(root, h('div', { class: 'wo' }, header, progEl, main, restDock, foot, pausedVeil));

  tickers.add(() => { elapsedEl.textContent = fmtClock(elapsed()); });
  const veilTime = pausedVeil.querySelector('.wo-veil-time');
  function syncPause() {
    pauseBtn.replaceChildren(icon(aw.paused ? 'play' : 'pause', 22));
    pauseBtn.setAttribute('aria-label', aw.paused ? 'Resume workout' : 'Pause workout');
    pausedVeil.hidden = !aw.paused;
    veilTime.textContent = fmtClock(elapsed());
    for (const f of pauseSyncers) f();
  }
  const pauseSyncers = new Set();

  function drawProgress() {
    const n = W.blocks.length;
    put(clear(progEl), 
      h('div', { class: 'wo-prog-bars' }, W.blocks.map((b, i) => h('span', { class: 'wo-pseg ' + (blockDone(i) ? 'done ' : '') + (i === aw.blockIndex ? 'cur' : '') },
        h('b', null, String(i + 1).padStart(2, '0')), h('small', null, blockDone(i) ? '✓' : i === aw.blockIndex ? `${Math.min(aw.blockIndex + 1, n)}/${n}` : '')))),
      h('span', { class: 'wo-prog-txt num sr-only' }, n ? `Block ${Math.min(aw.blockIndex + 1, n)} of ${n}` : '0/0'));
  }
  function blockDone(i) {
    const bs = aw.blocks[i];
    if (bs?.done) return true;
    const b = W.blocks[i];
    if (b?.kind === 'strength') {
      const total = (b.items || []).reduce((a, it, ii) => a + setCount(i, ii), 0);
      return total > 0 && aw.log.filter((l) => l.block === i && l.type === 'set').length >= total;
    }
    return false;
  }

  // ---- navigation between blocks
  const mountedAt = Date.now();
  function goBlock(i) {
    if (i < 0 || i >= W.blocks.length) return;
    if (Date.now() - mountedAt < 500) return; // 2nd tap of a double-tap on Start would land on Next block
    if (restTimer && aw.rest?.block !== i) endRest();
    aw.blockIndex = i; aw.stepIndex = 0;
    save();
    drawAll();
    window.scrollTo(0, 0);
  }
  function drawFoot() {
    const n = W.blocks.length, i = aw.blockIndex, last = i >= n - 1;
    footKey = `${i}|${n}|${blockComplete(i)}`;
    put(clear(foot), 
      h('button', { class: 'btn ghost wo-nav', disabled: i <= 0, 'aria-label': 'Previous block', on: { click: () => goBlock(i - 1) } }, icon('chevL')),
      isFree ? h('button', { class: 'btn subtle wo-nav-add', on: { click: () => addExerciseSheet() } }, 'Exercise') : null,
      last || !n
        ? h('button', { class: 'btn grow wo-next' + (blockComplete(i) || !n ? ' primary' : ''), on: { click: () => finish() } }, 'Finish')
        : h('button', { class: 'btn grow wo-next', on: { click: () => { markDone(i); goBlock(i + 1); } } }, h('span', null, 'Next block'), h('span', { class: 'k' }, `${String(i + 2).padStart(2, '0')} →`)));
  }
  // Is everything in block i logged/checked? (Decides whether the footer's Finish is the primary action.)
  function blockComplete(i) {
    const b = W.blocks[i], bs = aw.blocks[i] || {};
    if (!b) return true;
    if (bs.done || blockDone(i)) return true;
    if (TIMED.has(b.kind)) return !!bs.logged;
    if (CARDIO.has(b.kind)) return (b.items || []).every((_, ii) => aw.log.some((l) => l.block === i && l.item === ii));
    if (LIST.has(b.kind)) return (b.items || []).every((_, ii) => bs.checked?.[ii]);
    return false;
  }
  function markDone(i) { aw.blocks[i] = { ...(aw.blocks[i] || {}), done: true }; }

  function drawAll() {
    tickers = new Set([...tickers].slice(0, 1)); // keep elapsed ticker only
    pauseSyncers.clear();
    // stop timers that belong to other blocks (their state is kept in snapshots)
    for (const [key, t] of blockTimers) {
      if (!key.startsWith(`blocks.${aw.blockIndex}.`)) { setPath(aw, key, t.snapshot()); t.stop(); blockTimers.delete(key); }
    }
    drawProgress();
    drawFoot();
    clear(main);
    if (!W.blocks.length) { put(main, emptyFree()); drawRest(); return; }
    const b = W.blocks[aw.blockIndex];
    put(main, blockHead(b, aw.blockIndex));
    if (b.kind === 'strength' || (!TIMED.has(b.kind) && !CARDIO.has(b.kind) && !LIST.has(b.kind))) put(main, strengthBlock(b, aw.blockIndex));
    else if (TIMED.has(b.kind)) put(main, timedBlock(b, aw.blockIndex));
    else if (CARDIO.has(b.kind)) put(main, cardioBlock(b, aw.blockIndex));
    else put(main, listBlock(b, aw.blockIndex));
    drawRest();
    syncPause();
  }

  function emptyFree() {
    return h('div', { class: 'wo-empty' }, h('h2', null, 'Add your first exercise'),
      h('p', { class: 'muted' }, 'Pick a kettlebell lift, carry, run or erg. Strength moves get sets; cardio gets a stopwatch.'),
      h('button', { class: 'btn primary xl', on: { click: () => addExerciseSheet() } }, 'Add exercise'));
  }

  function blockHead(b, i) {
    return h('div', { class: 'wo-bhead' },
      h('div', { class: 'row between' },
        h('span', { class: 'pill kind-' + b.kind }, KIND_LABEL[b.kind] || b.kind),
        h('span', { class: 'eyebrow num' }, `Block ${String(i + 1).padStart(2, '0')} / ${String(W.blocks.length).padStart(2, '0')}`)),
      h('h2', { class: 'wo-btitle' }, b.title || KIND_LABEL[b.kind] || 'Block'),
      b.notes ? h('p', { class: 'wo-bnotes' }, b.notes) : null);
  }

  // ======================================================= STRENGTH
  function setCount(bi, ii) {
    const it = W.blocks[bi].items[ii];
    return Math.max(0, (+it.sets || 1) + (aw.blocks[bi]?.extra?.[ii] || 0));
  }
  function draftFor(bi, ii) {
    const bs = (aw.blocks[bi] = aw.blocks[bi] || {});
    bs.draft = bs.draft || {};
    if (!bs.draft[ii]) {
      const it = W.blocks[bi].items[ii];
      const last = safe(() => coach.lastPerformance?.(it.exId, priorSessions), null);
      const e = ex(it.exId);
      let kg, reason = '', tooHeavy = false;
      if (isKbEx(it.exId) && coach.liveItemAdvice) {
        const adv = safe(() => coach.liveItemAdvice(it, profile, priorSessions, { plan: store.get().plan, todayISO: todayISO() }), null) || {};
        kg = adv.kg ?? null; reason = adv.reason || '';
        // suggestWeight → null for a loaded KB lift means every owned bell is too heavy
        if (kg == null && e.loadRatio && bells.length) tooHeavy = true;
      } else {
        kg = it.kg ?? safe(() => coach.suggestWeight?.(it.exId, profile, priorSessions), null) ?? last?.kg ?? null;
      }
      if (kg == null && !tooHeavy && isKbEx(it.exId) && bellPool(it.exId).length) kg = bellPool(it.exId)[0];
      const track = ex(it.exId).track || 'reps';
      const hasT = it.reps != null || it.timeSec != null || it.distanceM != null;
      bs.draft[ii] = {
        kg: kg ?? null, reason, tooHeavy,
        reps: it.reps ?? (!hasT && track === 'reps' ? last?.reps ?? 5 : null),
        timeSec: it.reps == null ? it.timeSec ?? (!hasT && track === 'time' ? last?.timeSec ?? 30 : null) : null,
        distanceM: it.reps == null && it.timeSec == null ? it.distanceM ?? (!hasT && track === 'distance' ? last?.distanceM ?? 40 : null) : null,
      };
    }
    return bs.draft[ii];
  }

  function strengthBlock(b, bi) {
    const wrap = h('div', { class: 'stack' });
    const draw = () => {
      clear(wrap);
      const logged = aw.log.filter((l) => l.block === bi && l.type === 'set');
      // the "current" set = first unlogged set in item order
      let cur = null;
      b.items.forEach((it, ii) => {
        if (cur) return;
        for (let si = 0; si < setCount(bi, ii); si++) if (!logged.some((l) => l.item === ii && l.set === si)) { cur = { ii, si }; return; }
      });
      b.items.forEach((it, ii) => put(wrap, exCard(b, bi, it, ii, logged, cur, draw)));
      if (!b.items.length) put(wrap, h('p', { class: 'muted' }, 'No exercises in this block.'));
      if (!cur && b.items.length) put(wrap, h('div', { class: 'callout go wo-block-done' }, '✓ Block complete — nice work.'));
    };
    draw();
    return wrap;
  }

  function exCard(b, bi, it, ii, logged, cur, redraw) {
    const d = draftFor(bi, ii);
    const e = ex(it.exId);
    const last = safe(() => coach.lastPerformance?.(it.exId, priorSessions), null);
    const showBells = d.kg != null || isKbEx(it.exId);
    const n = setCount(bi, ii);
    const rest = it.restSec ?? b.restSec ?? 90;

    const bellRow = showBells ? bellPicker(d.kg, (kg) => { d.kg = kg; d.tooHeavy = false; save(); redraw(); }, it.exId) : null;
    const hint = [d.kg ? `${bellText(d.kg, it.exId)} = ${isDouble(it.exId) ? '2 × ' : ''}${bellLb(d.kg)}` : null, d.reason || null].filter(Boolean).join(' · ');
    const regress = d.tooHeavy && d.kg == null ? h('div', { class: 'callout wo-regress' },
      h('div', null, 'Your lightest bell is too heavy for this lift today.'),
      e.regression ? h('button', { class: 'btn sm mt', on: { click: () => { it.exId = e.regression; delete aw.blocks[bi].draft[ii]; save(); redraw(); } } }, `Swap to ${exName(e.regression)}`) : null,
      h('div', { class: 'small muted mt' }, e.regression ? 'Or pick a bell below if you feel ready.' : 'Pick a bell below if you feel ready, or skip these sets.')) : null;
    const rows = [];
    for (let si = 0; si < n; si++) {
      const lg = logged.find((l) => l.item === ii && l.set === si);
      const isCur = cur && cur.ii === ii && cur.si === si;
      rows.push(setRow({ it, ii, si, lg, isCur, d, rest, bi, redraw }));
    }
    return h('section', { class: 'card wo-ex' + (cur?.ii === ii ? ' active' : ''), 'aria-label': e.name },
      h('div', { class: 'wo-ex-head' },
        h('div', { class: 'grow' },
          h('h3', { class: 'wo-ex-name' }, e.name),
          h('div', { class: 'wo-ex-target' },
            [it.sets ? `${it.sets} × ${it.reps ?? (it.timeSec ? fmtDur(it.timeSec) : it.distanceM ? it.distanceM + ' m' : '')}${it.perSide ? ' / side' : ''}` : itemTarget(it, b), `rest ${fmtDur(rest)}`, it.note].filter(Boolean).join(' · ')),
          last ? h('div', { class: 'wo-ghost' }, `Last: ${last.kg ? bellText(last.kg, it.exId) + ' × ' : ''}${last.reps ?? (last.timeSec ? fmtDur(last.timeSec) : '')}${last.rpe ? ' @ RPE ' + last.rpe : ''}${last.date ? ' · ' + last.date.slice(5) : ''}`) : null),
        infoBtn(it.exId)),
      regress,
      bellRow,
      hint ? h('div', { class: 'wo-hint' + (d.reason && /^Earned/.test(d.reason) ? ' earned' : '') }, hint) : null,
      h('div', { class: 'wo-sets', role: 'list' },
        h('div', { class: 'wo-sets-hd', 'aria-hidden': 'true' }, h('span', null, 'Set'), h('span', null, 'Load × reps'), h('span', null, 'RPE'), h('span', null, '')),
        rows),
      h('button', { class: 'link-btn wo-addset', on: { click: () => { const bs = aw.blocks[bi]; bs.extra = bs.extra || {}; bs.extra[ii] = (bs.extra[ii] || 0) + 1; save(); redraw(); } } }, '+ Add set'));
  }

  function setRow({ it, ii, si, lg, isCur, d, rest, bi, redraw }) {
    const done = !!lg;
    const kg = done ? lg.kg : d.kg;
    const reps = done ? lg.reps : d.reps;
    const timeSec = done ? lg.timeSec : d.timeSec;
    const dist = done ? lg.distanceM : d.distanceM;
    const amount = reps != null ? String(reps) + (it.perSide ? ' / side' : '') : timeSec != null ? fmtDur(timeSec) : dist != null ? `${Math.round(dist)} m` : '—';
    let edit = null;
    if (isCur && !done) {
      if (reps != null) edit = stepper(reps, { min: 0, max: 300, label: 'reps', onChange: (v) => { d.reps = v; save(); } });
      else if (timeSec != null) edit = stepper(timeSec, { min: 5, max: 3600, step: 5, label: 'seconds', fmt: (v) => fmtDur(v), onChange: (v) => { d.timeSec = v; save(); } });
      else if (dist != null) edit = stepper(dist, { min: 5, max: 5000, step: 5, label: 'metres', fmt: (v) => `${v} m`, onChange: (v) => { d.distanceM = v; save(); } });
    }
    const val = h('div', { class: 'wo-set-val' },
      h('span', { class: 'wo-set-kg num' }, kg ? [isDouble(it.exId) ? h('small', { class: 'unit' }, '2×') : null, fmtBell(kg).replace(/\s*kg$/, ''), h('small', { class: 'unit' }, 'kg')] : d.tooHeavy && !done ? '—' : 'BW'),
      h('span', { class: 'wo-x' }, '×'),
      edit || h('span', { class: 'wo-set-reps num' }, reps != null ? String(reps) : amount, reps != null && it.perSide ? h('small', { class: 'wo-side' }, ' / side') : null));
    const check = h('button', {
      class: 'wo-check' + (done ? ' done' : '') + (isCur ? ' cur' : ''), type: 'button',
      'aria-label': done ? `Undo set ${si + 1}` : `Log set ${si + 1}: ${kg ? bellText(kg, it.exId) : 'bodyweight'} × ${amount}`,
      on: {
        click: () => {
          if (done) {
            if (Date.now() - (+lg.at || 0) < 600) return; // second tap of a double-tap, not an undo
            aw.log = aw.log.filter((l) => l !== lg && !(l.type === 'set' && l.block === bi && l.item === ii && l.set === si));
            toast('Set removed');
          } else {
            aw.log.push({
              type: 'set', block: bi, item: ii, set: si, blockKind: W.blocks[bi].kind || 'strength', targetReps: it.reps ?? null, exId: it.exId, kg: kg ?? null, reps: reps ?? null, timeSec: reps == null ? timeSec ?? null : null,
              distanceM: reps == null && timeSec == null ? dist ?? null : null, rpe: null, double: isDouble(it.exId), perSide: !!it.perSide, at: Date.now(),
              ...(it.benchmark ? { benchmark: true } : {}),
            });
            rpeOpen = aw.log[aw.log.length - 1].at;
            haptic(25);
            const more = aw.log.filter((l) => l.block === bi && l.type === 'set').length < W.blocks[bi].items.reduce((a, _, k) => a + setCount(bi, k), 0);
            if (more && rest > 0) startRest(rest, nextLabel(bi)); else if (!more) { endRest(); beep('done'); markDone(bi); drawProgress(); }
          }
          save(); redraw();
        },
      },
    }, icon('check', 26));
    const rpeBtn = done ? h('button', {
      class: 'wo-rpe-tag' + (lg.rpe ? ' set' : ''), type: 'button', 'aria-label': lg.rpe ? `RPE ${lg.rpe}, change` : 'Rate effort (RPE)',
      on: { click: () => { rpeOpen = rpeOpen === lg.at ? null : lg.at; redraw(); } },
    }, lg.rpe ? `@${lg.rpe}` : 'RPE') : null;
    const row = h('div', { class: 'wo-set' + (done ? ' done' : '') + (isCur ? ' cur' : ''), role: 'listitem' },
      h('span', { class: 'wo-set-n num' }, String(si + 1)), val, rpeBtn, check);
    if (!done || rpeOpen !== lg.at) return row;
    return [row, rpePicker(lg, redraw)];
  }

  // Optional per-set effort rating (liveItemAdvice uses RPE to decide whether a bell was earned).
  let rpeOpen = null;
  function rpePicker(lg, redraw) {
    return h('div', { class: 'wo-rpe-pick', role: 'radiogroup', 'aria-label': 'How hard was that set? RPE' },
      h('span', { class: 'wo-rpe-q' }, 'How hard?'),
      [6, 7, 8, 9, 10].map((v) => h('button', {
        type: 'button', role: 'radio', 'aria-checked': String(lg.rpe === v), class: 'wo-rpe-opt' + (lg.rpe === v ? ' on' : ''),
        title: v === 10 ? 'Max effort' : `${10 - v} rep${10 - v > 1 ? 's' : ''} in reserve`,
        on: { click: () => { lg.rpe = lg.rpe === v ? null : v; rpeOpen = null; haptic(); save(); redraw(); } },
      }, String(v))));
  }

  function nextLabel(bi) {
    const logged = aw.log.filter((l) => l.block === bi && l.type === 'set');
    const b = W.blocks[bi];
    for (let ii = 0; ii < b.items.length; ii++) for (let si = 0; si < setCount(bi, ii); si++) {
      if (!logged.some((l) => l.item === ii && l.set === si)) {
        const d = draftFor(bi, ii);
        return `Next: ${exName(b.items[ii].exId)} · set ${si + 1} · ${d.kg ? bellText(d.kg, b.items[ii].exId) + ' × ' : ''}${d.reps ?? (d.timeSec != null ? fmtDur(d.timeSec) : d.distanceM != null ? d.distanceM + ' m' : '')}`;
      }
    }
    return '';
  }

  function bellPicker(value, onPick, exId) {
    const pool = bellPool(exId);
    if (!pool.length) {
      return h('div', { class: 'wo-bells-step' }, stepper(value || 16, { min: 2, max: 100, step: 2, label: 'kg', fmt: (v) => `${v} kg`, onChange: onPick }));
    }
    const opts = [...new Set([...pool, ...(value && !pool.includes(value) ? [value] : [])])].sort((a, b) => a - b);
    const dbl = isDouble(exId);
    const row = h('div', { class: 'chips scroll wo-bells', role: 'radiogroup', 'aria-label': dbl ? 'Kettlebell pair' : 'Kettlebell' },
      opts.map((kg) => h('button', {
        type: 'button', class: 'chip wo-bell' + (kg === value ? ' on' : ''), role: 'radio', 'aria-checked': String(kg === value),
        on: { click: () => { haptic(); onPick(kg); } },
      }, dbl ? h('small', { class: 'unit' }, '2×') : null, h('span', { class: 'num' }, fmtBell(kg).replace(/\s*kg$/, '')), h('small', { class: 'unit' }, 'kg'))));
    if (dbl && !pairs.length) return [row, h('div', { class: 'wo-hint' }, 'Double-bell lift — you don’t own a matching pair, so use one bell per side or swap the exercise.')];
    return row;
  }

  function infoBtn(exId) {
    return h('button', { class: 'icon-btn wo-info', 'aria-label': `How to: ${exName(exId)}`, on: { click: () => exerciseSheet(exId) } }, icon('info', 22));
  }

  // ---- rest dock
  let restTicker = null;
  function drawRest() {
    if (restTicker) tickers.delete(restTicker);
    restTicker = null;
    clear(restDock);
    restDock.classList.toggle('on', !!restTimer);
    main.classList.toggle('has-rest', !!restTimer);
    if (!restTimer) return;
    const face = h('div', { class: 'wo-rest-time num' }, '');
    const NT = 45;
    const bar = h('div', { class: 'ticks wo-rest-ticks', 'aria-hidden': 'true' }, Array.from({ length: NT }, () => h('i')));
    const lbl = h('div', { class: 'wo-rest-next' }, aw.rest?.label || '');
    put(restDock, h('div', { class: 'wo-rest', role: 'timer', 'aria-label': 'Rest timer' },
      h('div', { class: 'wo-rest-top' },
        h('div', null, h('div', { class: 'eyebrow' }, aw.rest?.sec ? `Rest · of ${fmtClock(aw.rest.sec)}` : 'Rest'), face),
        h('div', { class: 'wo-rest-btns' },
          h('button', { class: 'btn subtle', 'aria-label': 'Minus 15 seconds', on: { click: () => { restTimer?.adjust(-15); aw.rest.sec = restTimer?.current?.sec; save(); } } }, '−15'),
          h('button', { class: 'btn subtle', 'aria-label': 'Plus 15 seconds', on: { click: () => { restTimer?.adjust(15); aw.rest.sec = restTimer?.current?.sec; save(); } } }, '+15'),
          h('button', { class: 'btn primary', on: { click: () => endRest() } }, 'Skip'))),
      bar,
      lbl));
    const upd = () => {
      if (!restTimer) return;
      const s = restTimer.state;
      face.textContent = fmtClock(s.segRemaining, { countdown: true });
      face.classList.toggle('warn', s.segRemaining <= 3.05);
      const on = Math.round(NT * (1 - (s.progress || 0)));
      if (bar.dataset.on !== String(on)) { bar.dataset.on = String(on); [...bar.children].forEach((t, k) => t.classList.toggle('on', k < on)); }
    };
    upd();
    restTicker = upd;
    tickers.add(upd);
  }

  // ======================================================= TIMED (emom/amrap/intervals/circuit/tabata)
  function timedBlock(b, bi) {
    const key = `blocks.${bi}.timer`;
    const bs = (aw.blocks[bi] = aw.blocks[bi] || {});
    bs.kg = bs.kg || {};
    b.items.forEach((it, ii) => { if (bs.kg[ii] === undefined) bs.kg[ii] = draftFor(bi, ii).kg; });
    const segs = buildSegments(b);
    const wrap = h('div', { class: 'wo-timed' });
    let timer = blockTimers.get(key);
    if (!timer && bs.timer?.started) {
      timer = makeTimer(segs, bs.timer);
      blockTimers.set(key, timer);
    }
    const isAmrap = b.kind === 'amrap';
    const totalRounds = isAmrap ? null : Math.max(1, ...segs.filter((s) => s.kind === 'work').map((s) => s.meta.round || 1));

    function makeTimer(sg, snap) {
      const t = new IntervalTimer(sg, {
        restore: snap,
        onSegment: (state) => { announce(state); updateFace(); },
        onDone: () => { bs.timerDone = true; save(); draw(); },
      });
      if (aw.paused) t.pause();
      return t;
    }
    function announce(state) {
      const sgm = state.segment;
      if (!sgm) return;
      if (sgm.kind === 'work') {
        const it = sgm.meta.items?.[0];
        if (it && (sgm.meta.items.length === 1 || b.kind !== 'emom')) speak(`${it.reps ? it.reps + ' ' : ''}${exName(it.exId)}`);
        else if (b.kind === 'emom') speak(`Minute ${sgm.meta.round}`);
      } else if (sgm.kind === 'rest') speak('Rest');
    }

    const face = timerFace({});
    const nowEl = h('div', { class: 'wo-now' });
    const nextEl = h('div', { class: 'wo-nextup' });
    const ctl = timerControls({
      onToggle: () => {
        if (!timer || !timer.started) {
          unlockAudio();
          timer = makeTimer(segs);
          blockTimers.set(key, timer);
          if (aw.paused) setPaused(false);
          timer.start();
          save();
          draw();
          return;
        }
        setPaused(!aw.paused);
      },
      onBack: () => { timer?.back(); save(); updateFace(); },
      onSkip: () => { if (!timer?.started) return; timer.skip(); save(); updateFace(); },
    });

    function itemLine(it, ii, big) {
      const kg = bs.kg[ii];
      return h('div', { class: 'wo-item' + (big ? ' big' : '') },
        h('span', { class: 'wo-item-reps num' }, it.reps ? `${it.reps}${it.perSide ? ' / side' : ''}` : it.timeSec ? fmtDur(it.timeSec) : it.distanceM ? fmtTarget(it.distanceM) : '—'),
        h('span', { class: 'wo-item-name' }, exName(it.exId)),
        kg ? h('span', { class: 'wo-item-kg num' }, bellText(kg, it.exId)) : null,
        infoBtn(it.exId));
    }

    let lastSegIdx = -1;
    function updateFace() {
      const s = timer?.state;
      const phase = s ? phaseOf(s) : 'idle';
      const sg = s?.segment;
      let label = sg?.kind === 'prep' ? 'Get ready' : sg?.kind === 'rest' ? 'Rest' : isAmrap ? 'AMRAP' : sg ? `${b.kind === 'emom' ? 'Minute' : 'Round'} ${sg.meta.round}/${sg.meta.rounds}` : '';
      if (!s) {
        const total = segs.reduce((a, x) => a + (Number.isFinite(x.sec) && x.kind !== 'prep' ? x.sec : 0), 0);
        face.update({ time: total, phase: 'idle', label: KIND_LABEL[b.kind], sub: total ? 'tap play to start' : 'reps for time', countdown: true });
      } else if (s.done) {
        face.update({ time: s.totalElapsed, phase: 'done', label: 'Done', sub: 'log your result below', countdown: false });
      } else {
        const sub = s.open ? 'tap ⏭ when done' : s.totalRemaining != null ? `${fmtClock(s.totalRemaining, { countdown: true })} left` : '';
        face.update({ time: faceTime(s), progress: s.progress, phase, label, sub, countdown: !s.open });
      }
      ctl.sync(!!s && s.running, { started: !!s?.started, done: !!s?.done });
      if (s?.done || bs.logged) { clear(nowEl); clear(nextEl); lastSegIdx = -2; }
      else if (s && s.index !== lastSegIdx) {
        lastSegIdx = s.index;
        const its = sg?.meta?.items || [];
        put(clear(nowEl), 
          h('div', { class: 'eyebrow' }, sg?.kind === 'rest' || sg?.kind === 'prep' ? 'Up next' : isAmrap ? 'Each round' : 'Now'),
          its.map((it) => itemLine(it, b.items.indexOf(it) >= 0 ? b.items.indexOf(it) : sg.meta.itemIndex ?? 0, true)));
        const nx = segs.slice(s.index + 1).find((x) => x.kind === 'work');
        put(clear(nextEl), nx && sg?.kind === 'work' && !isAmrap
          ? [h('span', { class: 'eyebrow' }, 'Next '), (nx.meta.items || []).map((it) => `${it.reps ? it.reps + ' ' : ''}${exName(it.exId)}`).join(' + ')]
          : []);
      }
    }

    function resultForm() {
      const state = timer?.state;
      const reached = state ? Math.max(0, ...(state.segLog || []).map((l) => segs[l.index]).filter((x) => x && x.kind === 'work').map((x) => x.meta.round || 0)) : 0;
      if (bs.roundsDone == null) bs.roundsDone = isAmrap ? bs.rounds || 0 : reached || totalRounds;
      const extra = { v: bs.extraReps || 0 };
      const splits = (state?.segLog || []).filter((l) => segs[l.index]?.kind === 'work' && segs[l.index]?.open);
      return h('div', { class: 'card wo-result' },
        h('h3', null, bs.logged ? 'Logged' : 'Log result'),
        h('div', { class: 'grid2' },
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, isAmrap ? 'Full rounds' : b.kind === 'emom' ? 'Minutes completed' : 'Rounds completed'),
            stepper(bs.roundsDone, { min: 0, max: 999, label: 'rounds', onChange: (v) => { bs.roundsDone = v; save(); } })),
          isAmrap ? h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Extra reps'),
            stepper(extra.v, { min: 0, max: 999, label: 'extra reps', onChange: (v) => { bs.extraReps = v; save(); } })) : null),
        splits.length ? h('div', { class: 'wo-splits' }, h('div', { class: 'eyebrow' }, 'Splits'),
          h('div', { class: 'chips' }, splits.map((l, k) => h('span', { class: 'chip num' }, `${k + 1}: ${fmtDur(l.sec)}`)))) : null,
        h('button', { class: 'btn primary xl block', on: { click: () => logTimed() } }, bs.logged ? 'Update & continue' : 'Log & continue'));
    }

    function logTimed() {
      aw.log = aw.log.filter((l) => l.block !== bi);
      const rounds = Math.max(0, bs.roundsDone || 0);
      const state = timer?.state;
      const splits = (state?.segLog || []).filter((l) => segs[l.index]?.kind === 'work');
      if (isAmrap) {
        // reps per item = rounds × reps + extra reps distributed in item order
        // One entry per completed round (+ the partial round), tagged blockKind 'amrap' so progression can skip it.
        for (let r = 0; r < rounds; r++) b.items.forEach((it, ii) => pushItem(it, ii, it.reps || null, 1, it.reps ? null : it.timeSec ?? null));
        let extraLeft = bs.extraReps || 0;
        b.items.forEach((it, ii) => {
          const add = Math.min(extraLeft, it.reps || 0); extraLeft -= add;
          if (add > 0) pushItem(it, ii, add, 1, null);
        });
      } else {
        const work = segs.filter((x) => x.kind === 'work').filter((x) => (x.meta.round || 0) <= rounds);
        work.forEach((x) => {
          const segIdx = segs.indexOf(x);
          const spent = splits.find((l) => l.index === segIdx)?.sec;
          (x.meta.items || []).forEach((it) => pushItem(it, b.items.indexOf(it), it.reps ?? null, 1, x.open ? spent : (it.timeSec || (it.reps ? null : x.sec))));
        });
      }
      aw.log.push({ type: 'block', block: bi, kind: b.kind, title: b.title, rounds, extraReps: isAmrap ? bs.extraReps || 0 : 0, at: Date.now() });
      bs.logged = true; bs.done = true;
      timer?.stop(); blockTimers.delete(key); bs.timer = timer ? timer.snapshot() : bs.timer;
      haptic(30);
      toast(isAmrap ? `${plural(rounds, 'round')}${bs.extraReps ? ' + ' + plural(bs.extraReps, 'rep') : ''} logged` : `${plural(rounds, b.kind === 'emom' ? 'minute' : 'round')} logged`, { kind: 'go' });
      save();
      if (aw.blockIndex < W.blocks.length - 1) goBlock(aw.blockIndex + 1); else { drawAll(); }
    }

    function pushItem(it, ii, reps, rounds, timeSec) {
      if (isCardioEx(it.exId)) {
        aw.log.push({ type: 'cardio', block: bi, item: ii, exId: it.exId, mode: cardioMode(it.exId), distanceM: (it.distanceM || 0) * (rounds || 1) || null, timeSec: timeSec ?? null, avgHr: null, at: Date.now(), ...(it.benchmark ? { benchmark: true } : {}) });
      } else {
        aw.log.push({ type: 'set', block: bi, item: ii, set: null, blockKind: b.kind, targetReps: it.reps ?? null, exId: it.exId, kg: bs.kg[ii] ?? null, reps: reps || null, timeSec: reps ? null : timeSec ?? null, distanceM: it.distanceM ? it.distanceM * (rounds || 1) : null, rpe: null, double: isDouble(it.exId), perSide: !!it.perSide, at: Date.now(), ...(it.benchmark ? { benchmark: true } : {}) });
      }
    }

    function draw() {
      clear(wrap);
      lastSegIdx = -1;
      const started = !!timer?.started;
      const finished = !!(timer?.state.done || bs.logged);
      put(wrap, h('div', { class: 'wo-stage' }, face.el, nowEl, nextEl));
      if (isAmrap && started && !finished) {
        const rc = roundCounter(bs.rounds || 0, (v) => { bs.rounds = v; bs.roundsDone = v; save(); });
        put(wrap, rc.el);
      }
      if (!finished) put(wrap, ctl.el);
      if (!started && !bs.logged) {
        // setup: items with bell choice
        put(wrap, h('div', { class: 'card wo-setup' },
          h('div', { class: 'eyebrow' }, 'Each ' + (b.kind === 'emom' && !b.alternate ? 'minute' : b.kind === 'amrap' ? 'round' : b.kind === 'emom' ? 'minute, alternate' : 'round')),
          b.items.map((it, ii) => h('div', { class: 'wo-setup-item' },
            h('div', { class: 'row between' }, itemLine(it, ii, false)),
            bs.kg[ii] != null || isKbEx(it.exId) ? bellPicker(bs.kg[ii], (kg) => { bs.kg[ii] = kg; save(); draw(); }, it.exId) : null))));
      }
      if (finished || bs.manual) put(wrap, resultForm());
      else if (started) put(wrap, h('button', { class: 'link-btn wo-endblock', on: { click: () => { timer.end(); bs.timerDone = true; bs.roundsDone = null; save(); draw(); } } }, 'End block early & log'));
      else put(wrap, h('button', { class: 'link-btn wo-endblock', on: { click: () => { bs.manual = true; bs.roundsDone = isAmrap ? 0 : totalRounds || 0; save(); draw(); } } }, 'Already done? Log result without timer'));
      updateFace();
    }

    draw();
    tickers.add(updateFace);
    pauseSyncers.add(updateFace);
    return wrap;
  }

  // ======================================================= CARDIO / STATION
  function cardioBlock(b, bi) {
    const wrap = h('div', { class: 'stack' });
    const bs = (aw.blocks[bi] = aw.blocks[bi] || {});
    bs.items = bs.items || {};
    const u = units();

    b.items.forEach((it, ii) => {
      const key = `blocks.${bi}.items.${ii}.timer`;
      const is = (bs.items[ii] = bs.items[ii] || {});
      const cardio = isCardioEx(it.exId);
      const meters = !cardio || (it.distanceM && it.distanceM < 1000);
      const showDist = cardio || it.distanceM > 0;
      const timedCountdown = it.timeSec > 0 && !(it.distanceM > 0);
      const segs = [{ label: it.note || exName(it.exId), sec: timedCountdown ? it.timeSec : Infinity, kind: 'work' }];
      let t = blockTimers.get(key);
      if (!t && is.timer?.started) { t = mk(is.timer); blockTimers.set(key, t); }
      function mk(snap) {
        const x = new IntervalTimer(segs, { restore: snap, cues: timedCountdown, onDone: () => { if (!is.timeManual) is.timeSec = Math.round(x.state.totalElapsed || it.timeSec || 0); save(); redraw(); } });
        if (aw.paused) x.pause();
        return x;
      }
      if (is.dist === undefined) is.dist = it.distanceM ? (meters ? it.distanceM : u === 'metric' ? it.distanceM / 1000 : it.distanceM / M_PER_MI) : '';
      const distUnit = meters ? 'm' : u === 'metric' ? 'km' : 'mi';
      const toM = (v) => (v === '' || v == null || !Number.isFinite(+v) ? null : meters ? +v : u === 'metric' ? +v * 1000 : +v * M_PER_MI);

      let cardEl = null;
      let cardTickers = [];
      function redraw() { const n = drawCard(); cardEl.replaceWith(n); cardEl = n; }
      function drawCard() {
        for (const f of cardTickers) { tickers.delete(f); pauseSyncers.delete(f); }
        cardTickers = [];
        const lg = aw.log.find((l) => l.block === bi && l.item === ii && (l.type === 'cardio' || l.type === 'set'));
        const c = h('section', { class: 'card wo-ex wo-cardio' + (lg ? ' logged' : '') });
        put(c, h('div', { class: 'wo-ex-head' },
          h('div', { class: 'grow' },
            h('h3', { class: 'wo-ex-name' }, exName(it.exId)),
            h('div', { class: 'wo-ex-target' }, [itemTarget(it, b), it.note].filter(Boolean).join(' · ') || 'For time')),
          infoBtn(it.exId)));
        if (lg) {
          put(c, h('div', { class: 'wo-cardio-done' },
            h('span', { 'aria-hidden': 'true' }, '✓'),
            h('span', { class: 'num' }, [lg.distanceM ? fmtDist(lg.distanceM, u) : null, lg.timeSec ? fmtDur(lg.timeSec) : null,
              lg.distanceM && lg.timeSec && cardio ? fmtPace(lg.timeSec / (lg.distanceM / 1000), u) : null, lg.avgHr ? `${lg.avgHr} bpm` : null].filter(Boolean).join(' · ')),
            h('button', { class: 'link-btn', on: { click: () => { aw.log = aw.log.filter((l) => l !== lg); save(); redrawAll(); } } }, 'Edit')));
          return c;
        }
        const face = timerFace({ size: 'md' });
        const ctl = timerControls({
          onToggle: () => {
            if (!t || !t.started) { unlockAudio(); t = mk(); blockTimers.set(key, t); if (aw.paused) setPaused(false); t.start(); save(); upd(); return; }
            if (t.state.done) return;
            setPaused(!aw.paused);
          },
          onBack: () => { if (!t) return; t.stop(); blockTimers.delete(key); t = null; is.timer = null; if (!is.timeManual) { is.timeSec = null; timeIn.value = ''; } save(); upd(); updPace(); },
          onSkip: () => { if (!t?.started || t.state.done) return; t.skip(); },
          labels: { back: 'Reset stopwatch', skip: 'Stop & record time' },
        });
        const timeIn = h('input', { type: 'text', inputmode: 'numeric', placeholder: 'mm:ss', value: is.timeSec ? fmtDur(is.timeSec) : '', 'aria-label': 'Time (mm:ss)',
          on: { input: () => { is.timeSec = parseDur(timeIn.value); is.timeManual = !!timeIn.value; save(); updPace(); } } });
        const distIn = h('input', { type: 'number', inputmode: 'decimal', step: meters ? '1' : '0.01', min: '0', max: meters ? '300000' : u === 'metric' ? '300' : '186', value: is.dist === '' ? '' : String(+(+is.dist).toFixed(meters ? 0 : 2)), 'aria-label': `Distance (${distUnit})`,
          on: { input: () => { is.dist = distIn.value; save(); updPace(); } } });
        const hrIn = h('input', { type: 'number', inputmode: 'numeric', min: '30', max: '240', placeholder: 'bpm', value: is.hr || '', 'aria-label': 'Average heart rate',
          on: { input: () => { is.hr = hrIn.value; save(); } } });
        const paceEl = h('div', { class: 'wo-pace num' });
        const errEl = h('div', { class: 'wo-field-err small danger-text', role: 'alert' });
        // Sanity bounds: distance <= 300 km, time <= 24 h, HR 30-240 bpm.
        function validate() {
          const m = toM(is.dist), sec = is.timeSec, hr = is.hr === '' || is.hr == null ? null : +is.hr;
          const msgs = [];
          if (is.dist !== '' && is.dist != null && !(Number.isFinite(+is.dist) && +is.dist >= 0)) msgs.push('Distance must be a positive number.');
          else if (m > 300000) msgs.push(`Distance looks too long (max ${meters ? '300000 m' : u === 'metric' ? '300 km' : '186 mi'}).`);
          if (timeIn.value && sec == null) msgs.push('Time should look like mm:ss or h:mm:ss.');
          else if (sec > 86400) msgs.push('Time must be under 24 h.');
          if (hr != null && !(hr >= 30 && hr <= 240)) msgs.push('Heart rate should be 30–240 bpm.');
          errEl.textContent = msgs.join(' ');
          distIn.toggleAttribute('aria-invalid', /Distance/.test(errEl.textContent));
          timeIn.toggleAttribute('aria-invalid', /Time/.test(errEl.textContent));
          hrIn.toggleAttribute('aria-invalid', /Heart/.test(errEl.textContent));
          return !msgs.length;
        }
        for (const el of [distIn, timeIn, hrIn]) el.addEventListener('change', validate);
        function updPace() {
          const m = toM(is.dist), sec = is.timeSec;
          paceEl.textContent = m > 0 && sec > 0 && cardio ? `Pace ${fmtPace(sec / (m / 1000), u)}` : m > 0 && sec > 0 ? `${num(m / sec, 2)} m/s` : '';
        }
        function upd() {
          const s = t?.state;
          if (!s) face.update({ time: timedCountdown ? it.timeSec : 0, phase: 'idle', label: timedCountdown ? 'Countdown' : 'Stopwatch', sub: 'tap play', countdown: timedCountdown });
          else if (s.done) face.update({ time: is.timeSec || s.totalElapsed, phase: 'done', label: 'Stopped', sub: '', countdown: false });
          else face.update({ time: faceTime(s), progress: s.progress, phase: s.open ? 'open' : 'work', label: s.running ? (timedCountdown ? 'Remaining' : 'Elapsed') : 'Paused', sub: '', countdown: !s.open });
          ctl.sync(!!s?.running, { started: !!s?.started, done: !!s?.done });
          if (s?.done && document.activeElement !== timeIn && is.timeSec && timeIn.value !== fmtDur(is.timeSec)) { timeIn.value = fmtDur(is.timeSec); updPace(); }
        }
        put(c, h('div', { class: 'wo-cardio-stage' }, face.el, ctl.el),
          h('div', { class: (showDist ? 'grid3' : 'grid2') + ' wo-cardio-fields' },
            showDist ? h('label', { class: 'field' }, h('span', { class: 'field-label' }, `Distance (${distUnit})`), distIn) : null,
            h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Time'), timeIn),
            h('label', { class: 'field' }, h('span', { class: 'field-label' }, cardio ? 'Avg HR' : 'Avg HR (opt.)'), hrIn)),
          paceEl,
          errEl,
          h('button', {
            class: 'btn primary xl block', on: {
              click: () => {
                if (!validate()) { haptic(); return; }
                if (t?.started && !t.state.done) { t.skip(); }
                const m = toM(is.dist), sec = is.timeSec || (t?.state.totalElapsed ? Math.round(t.state.totalElapsed) : null);
                if (!m && !sec) { toast('Enter a time or distance first'); return; }
                const hr = +is.hr > 0 ? Math.round(+is.hr) : null;
                if (cardio) aw.log.push({ type: 'cardio', block: bi, item: ii, exId: it.exId, mode: cardioMode(it.exId), distanceM: m ? Math.round(m) : null, timeSec: sec ? Math.round(sec) : null, avgHr: hr, at: Date.now(), ...(it.benchmark ? { benchmark: true } : {}) });
                else aw.log.push({ type: 'set', block: bi, item: ii, set: 0, blockKind: b.kind, targetReps: it.reps ?? null, exId: it.exId, kg: it.kg ?? null, reps: it.reps ?? null, timeSec: sec ? Math.round(sec) : null, distanceM: m ? Math.round(m) : null, rpe: null, avgHr: hr, at: Date.now(), ...(it.benchmark ? { benchmark: true } : {}) });
                t?.stop(); blockTimers.delete(key); is.timer = t ? t.snapshot() : null; t = null;
                haptic(30); beep('done');
                save(); redrawAll();
              },
            },
          }, 'Log ' + (cardio ? cardioMode(it.exId) : 'station')));
        upd(); updPace();
        tickers.add(upd);
        pauseSyncers.add(upd);
        cardTickers.push(upd);
        return c;
      }
      cardEl = drawCard();
      put(wrap, cardEl);
    });
    if (!b.items.length) put(wrap, h('p', { class: 'muted' }, 'No items in this block.'));
    function redrawAll() { drawAll(); }
    return wrap;
  }

  // ======================================================= WARMUP / COOLDOWN
  function listBlock(b, bi) {
    const bs = (aw.blocks[bi] = aw.blocks[bi] || {});
    bs.checked = bs.checked || {};
    const wrap = h('div', { class: 'stack' });
    const key = `blocks.${bi}.itemTimer`;
    let t = blockTimers.get(key);
    if (!t && bs.itemTimer?.started && !bs.itemTimer.done && bs.runIdx != null) { t = mk(bs.runIdx, bs.itemTimer); blockTimers.set(key, t); }
    function mk(ii, snap) {
      const it = b.items[ii];
      const x = new IntervalTimer([{ label: exName(it.exId), sec: it.timeSec, kind: 'work' }], {
        restore: snap,
        onDone: () => { bs.checked[ii] = true; bs.runIdx = null; blockTimers.delete(key); t = null; bs.itemTimer = null; save(); draw(); },
      });
      if (aw.paused) x.pause();
      return x;
    }
    const list = h('div', { class: 'card flush' });
    function draw() {
      const rows = b.items.map((it, ii) => {
        const checked = !!bs.checked[ii];
        const running = t && bs.runIdx === ii;
        const timeEl = h('span', { class: 'wo-li-time num' }, it.timeSec ? fmtDur(it.timeSec) : it.reps ? `${it.reps}${it.perSide ? '/side' : ''}` : '');
        if (running) tickers.add(() => { if (t) timeEl.textContent = fmtClock(t.state.segRemaining, { countdown: true }); });
        return h('div', { class: 'wo-li' + (checked ? ' checked' : '') + (running ? ' running' : '') },
          h('button', {
            class: 'wo-li-main', type: 'button', role: 'checkbox', 'aria-checked': String(checked),
            on: { click: () => { bs.checked[ii] = !checked; haptic(); save(); draw(); } },
          },
          h('span', { class: 'wo-li-box' }, checked ? icon('check', 18) : null),
          h('span', { class: 'grow' }, h('span', { class: 'wo-li-name' }, exName(it.exId)), it.note ? h('span', { class: 'wo-li-note' }, it.note) : null),
          timeEl),
          it.timeSec ? h('button', {
            class: 'icon-btn wo-li-play', 'aria-label': running ? 'Stop timer' : `Start ${fmtDur(it.timeSec)} timer`,
            on: {
              click: () => {
                unlockAudio();
                if (running) { t.stop(); blockTimers.delete(key); t = null; bs.runIdx = null; bs.itemTimer = null; }
                else {
                  if (t) { t.stop(); blockTimers.delete(key); }
                  bs.runIdx = ii; t = mk(ii); blockTimers.set(key, t);
                  if (aw.paused) setPaused(false);
                  t.start(); speak(exName(it.exId));
                }
                save(); draw();
              },
            },
          }, icon(running ? 'pause' : 'play', 20)) : infoBtn(it.exId));
      });
      put(clear(list), h('div', { class: 'list' }, rows));
    }
    draw();
    const allBtn = h('button', { class: 'btn ghost block', on: { click: () => { b.items.forEach((_, ii) => { bs.checked[ii] = true; }); bs.done = true; save(); draw(); drawProgress(); } } }, 'Mark all done');
    put(wrap, list, allBtn);
    if (!b.items.length) put(wrap, h('p', { class: 'muted' }, 'Move freely for a few minutes.'));
    return wrap;
  }

  // ======================================================= sheets
  function exerciseSheet(exId) {
    const e = ex(exId);
    const lst = (title, arr) => (arr && arr.length ? h('div', { class: 'stack sm' }, h('h4', null, title), h('ul', { class: 'wo-bullets' }, arr.map((x) => h('li', null, x)))) : null);
    psheet({
      title: e.name,
      content: h('div', { class: 'stack' },
        h('div', { class: 'chips' }, [CAT_LABEL[e.category] || e.category, e.pattern, e.double ? 'double bell' : null, e.unilateral ? 'unilateral' : null].filter(Boolean).map((x) => h('span', { class: 'pill' }, x))),
        e.muscles?.length ? h('p', { class: 'small dim' }, e.muscles.join(' · ')) : null,
        lst('Cues', e.cues),
        lst('Common faults', e.faults),
        e.regression || e.progression ? h('p', { class: 'small muted' },
          e.regression ? `Easier: ${exName(e.regression)}. ` : '', e.progression ? `Harder: ${exName(e.progression)}.` : '') : null,
        !e.cues?.length && !e.faults?.length ? h('p', { class: 'muted' }, 'No coaching notes for this exercise yet.') : null),
    });
  }

  function blocksSheet() {
    const s = psheet({
      title: 'Blocks',
      content: ({ close }) => h('div', { class: 'stack' },
        h('div', { class: 'card flush' }, h('div', { class: 'list' }, W.blocks.map((b, i) => h('button', {
          class: 'li', on: { click: () => { close(); goBlock(i); } },
        },
        h('span', { class: 'badge' + (blockDone(i) ? ' wo-badge-done' : '') }, blockDone(i) ? '✓' : String(i + 1).padStart(2, '0')),
        h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, b.title || KIND_LABEL[b.kind]), h('div', { class: 'li-sub' }, blockSub(b))),
        i === aw.blockIndex ? h('span', { class: 'pill' }, 'Now') : null)))),
        h('button', { class: 'btn ghost block', on: { click: () => { close(); addExerciseSheet(); } } }, 'Add an exercise')),
    });
    return s;
  }

  function addExerciseSheet() {
    const all = safe(() => exdb.EXERCISES, []) || [];
    let q = '', cat = 'all';
    const cats = ['all', ...new Set(all.map((e) => e.category).filter(Boolean))];
    const listEl = h('div', { class: 'list' });
    const s = psheet({
      title: 'Add exercise', full: true,
      content: () => h('div', { class: 'stack' },
        h('label', { class: 'search' }, icon('search'), h('input', { type: 'search', placeholder: 'Search exercises', 'aria-label': 'Search exercises', on: { input: (e) => { q = e.target.value.toLowerCase(); draw(); } } })),
        h('div', { class: 'chips scroll' }, cats.map((c) => h('button', { class: 'chip' + (c === cat ? ' on' : ''), 'aria-pressed': String(c === cat), on: { click: (e) => { cat = c; for (const b of e.target.parentElement.children) b.classList.toggle('on', b === e.target); draw(); } } }, c === 'all' ? 'All' : CAT_LABEL[c] || c))),
        h('div', { class: 'card flush' }, listEl)),
    });
    function draw() {
      const res = all.filter((e) => (cat === 'all' || e.category === cat) && (!q || e.name.toLowerCase().includes(q) || e.id.includes(q))).slice(0, 80);
      put(clear(listEl), res.length ? res.map((e) => h('button', { class: 'li', on: { click: () => { s.close(); addExercise(e.id); } } },
        h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, e.name), h('div', { class: 'li-sub' }, [CAT_LABEL[e.category] || e.category, e.pattern].filter(Boolean).join(' · '))),
        icon('plus'))) : h('div', { class: 'empty' }, 'No matches'));
    }
    draw();
  }

  function addExercise(exId) {
    const e = ex(exId);
    let block;
    if (isCardioEx(exId)) block = { kind: 'cardio', title: e.name, notes: '', items: [{ exId, distanceM: cardioMode(exId) === 'run' ? 1000 : null }] };
    else if (e.category === 'hyrox') block = { kind: 'station', title: e.name, notes: '', items: [{ exId }] };
    else {
      const track = e.track || 'reps';
      block = { kind: 'strength', title: e.name, notes: '', restSec: 90, items: [{ exId, sets: 3, reps: track === 'reps' ? 8 : null, timeSec: track === 'time' ? 30 : null, distanceM: track === 'distance' ? 40 : null }] };
    }
    W.blocks.push(block);
    save();
    goBlock(W.blocks.length - 1);
    toast(`${e.name} added`);
  }

  function endSheet() {
    const entries = aw.log.filter((l) => l.type === 'set' || l.type === 'cardio').length;
    psheet({
      title: 'End workout?',
      content: ({ close }) => h('div', { class: 'stack' },
        h('p', { class: 'muted' }, `${fmtDur(elapsed())} elapsed · ${entries} ${entries === 1 ? 'entry' : 'entries'} logged.`),
        h('button', { class: 'btn primary xl block', on: { click: () => { close(); finish(); } } }, 'Finish & review'),
        h('button', { class: 'btn ghost block', on: { click: () => { close(); flush(); navigate('#/today'); } } }, 'Leave — keep it in progress'),
        h('button', {
          class: 'btn ghost block danger-text', on: {
            click: async () => {
              close();
              if (!(await confirmDialog('Discard this workout? Nothing will be saved.', { ok: 'Discard', danger: true }))) return;
              alive = false; clearTimeout(saveTimer);
              store.update((d) => { d.activeWorkout = null; });
              navigate('#/today');
            },
          },
        }, 'Discard workout')),
    });
  }

  // ======================================================= finish / summary
  function finish() {
    const entries = aw.log.filter((l) => l.type === 'set' || l.type === 'cardio').length;
    const go = () => {
      endRest();
      for (const t of blockTimers.values()) t.pause();
      if (!aw.paused) { aw.elapsed = elapsed(); aw.runningSince = null; }
      aw.paused = true; aw.finishing = true;
      flush();
      summary();
    };
    if (!entries) {
      confirmDialog('Nothing has been logged yet. Finish anyway?', { ok: 'Finish' }).then((ok) => ok && go());
    } else go();
  }

  function buildSession() {
    const sets = aw.log.filter((l) => l.type === 'set').map((l) => ({
      exId: l.exId, kg: l.kg ?? null, reps: l.reps ?? null, timeSec: l.timeSec ?? null, distanceM: l.distanceM ?? null, rpe: l.rpe ?? null,
      block: W.blocks[l.block]?.title || KIND_LABEL[W.blocks[l.block]?.kind] || String(l.block),
      blockKind: l.blockKind || W.blocks[l.block]?.kind || 'strength', targetReps: l.targetReps ?? null,
      ...(l.double ? { double: true } : {}), ...(l.perSide ? { perSide: true } : {}), ...(l.benchmark ? { benchmark: true } : {}),
    }));
    const cardio = aw.log.filter((l) => l.type === 'cardio').map((l) => ({ mode: l.mode, distanceM: l.distanceM ?? null, timeSec: l.timeSec ?? null, avgHr: l.avgHr ?? null, exId: l.exId, ...(l.benchmark ? { benchmark: true } : {}) }));
    const results = aw.log.filter((l) => l.type === 'block').map((l) => ({ title: l.title, kind: l.kind, rounds: l.rounds, extraReps: l.extraReps }));
    let type = W.type;
    if (isFree) type = cardio.length && sets.length ? 'hybrid' : cardio.length ? 'run' : 'strength';
    return {
      id: uid('s-'), date: todayISO(aw.startedAt ? new Date(aw.startedAt) : new Date()), workoutId: aw.workoutId === 'free' ? null : aw.workoutId, title: W.title || 'Workout', type: type || 'strength',
      startedAt: aw.startedAt, durationSec: Math.round(elapsed()), sets, cardio, rpe: 7, notes: '',
      readiness: aw.readiness ?? null, prs: [], ...(results.length ? { results } : {}), ...(aw.scaled ? { scaled: true } : {}),
    };
  }

  function summary() {
    tickers = new Set();
    pauseSyncers.clear();
    document.body.classList.remove('wo-running');
    const sess = buildSession();
    const prior = store.get().sessions || [];
    sess.prs = safe(() => coach.detectPRs?.(sess, prior), []) || [];
    if (aw.summary) { sess.rpe = aw.summary.rpe ?? 7; sess.notes = aw.summary.notes || ''; }
    const vol = safe(() => coach.sessionVolumeKg?.(sess), null) ?? Math.round(sess.sets.reduce((a, x) => a + setVolume(x), 0));
    const cDist = sess.cardio.reduce((a, c) => a + (+c.distanceM || 0), 0);
    const cTime = sess.cardio.reduce((a, c) => a + (+c.timeSec || 0), 0);
    const u = units();
    const root = clear(ctx.root);

    const rpeOut = h('output', { class: 'wo-rpe-val num' }, String(sess.rpe));
    const rpeWord = h('span', { class: 'muted small' }, rpeLabel(sess.rpe));
    const rpe = h('input', { type: 'range', min: '1', max: '10', step: '1', value: String(sess.rpe), 'aria-label': 'Session RPE 1 to 10',
      on: { input: () => { sess.rpe = +rpe.value; rpeOut.textContent = rpe.value; rpeWord.textContent = rpeLabel(sess.rpe); aw.summary = { rpe: sess.rpe, notes: sess.notes }; save(); } } });
    const notes = h('textarea', { placeholder: 'How did it feel? Bell sizes, niggles, wins…', 'aria-label': 'Notes',
      on: { input: () => { sess.notes = notes.value; aw.summary = { rpe: sess.rpe, notes: sess.notes }; save(); } } });
    notes.value = sess.notes;

    const byEx = new Map();
    for (const st of sess.sets) {
      const k = st.exId; const e = byEx.get(k) || { sets: 0, reps: 0, top: 0, time: 0 };
      e.sets++; e.reps += +st.reps || 0; e.top = Math.max(e.top, +st.kg || 0); e.time += +st.timeSec || 0; e.dist = (e.dist || 0) + (+st.distanceM || 0); byEx.set(k, e);
    }

    const save$ = h('button', {
      class: 'btn primary xl block', on: {
        click: (ev) => {
          if (ev.currentTarget.disabled) return;
          ev.currentTarget.disabled = true; // no double-submit
          sess.rpe = +rpe.value; sess.notes = notes.value.trim();
          alive = false; clearTimeout(saveTimer);
          // Shared saver: recomputes PRs, fills readiness, stamps planGeneratedAt for plan workouts, keeps sessions sorted.
          if (typeof sessionApi.saveSession === 'function') {
            sessionApi.saveSession(sess);
            store.update((d) => { d.activeWorkout = null; });
          } else {
            const gen = store.get().plan?.generatedAt;
            if (sess.workoutId && gen && !String(sess.workoutId).startsWith('t-')) sess.planGeneratedAt = gen;
            store.update((d) => { d.sessions.push(sess); d.activeWorkout = null; });
          }
          beep('done'); haptic(40);
          saved(sess, vol);
        },
      },
    }, 'Save session');

    put(root, h('div', { class: 'wo-sum' },
      h('div', { class: 'wo-pre-top' },
        h('button', { class: 'icon-btn', 'aria-label': 'Back to workout', on: { click: () => { aw.finishing = false; aw.summary = { rpe: sess.rpe, notes: sess.notes }; flush(); navigate('#/workout/' + encodeURIComponent(aw.workoutId)); } } }, icon('chevL')),
        h('span', { class: 'eyebrow' }, 'Workout summary')),
      h('h1', { class: 'wo-pre-title' }, W.title || 'Workout'),
      h('div', { class: 'grid2 wo-sum-stats' },
        sumStat(fmtDur(sess.durationSec), 'Duration'),
        sumStat(String(sess.sets.length), 'Sets'),
        sumStat(vol ? (u === 'metric' ? num(vol) : num(vol / 0.45359237)) : '0', `Volume (${u === 'metric' ? 'kg' : 'lb'})`),
        cDist || cTime ? sumStat(cDist ? fmtDist(cDist, u) : fmtDur(cTime), cDist ? `Cardio · ${fmtDur(cTime)}` : 'Cardio time') : sumStat(sess.readiness != null ? String(Math.round(sess.readiness)) : '—', 'Readiness')),
      sess.prs.length ? h('div', { class: 'card wo-prs' }, h('div', { class: 'row' }, h('span', { class: 'stamp go' }, 'PR'), h('h3', null, sess.prs.length === 1 ? 'New PR' : `${sess.prs.length} new PRs`)),
        h('ul', null, sess.prs.map((p) => h('li', null, p)))) : null,
      byEx.size || sess.cardio.length ? h('div', { class: 'card flush' }, h('div', { class: 'list' },
        [...byEx].map(([exId, e]) => h('div', { class: 'li' },
          h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, exName(exId)), h('div', { class: 'li-sub' }, `${plural(e.sets, 'set')}${e.reps ? ` · ${e.reps} reps` : ''}${e.time ? ' · ' + fmtDur(e.time) : ''}${e.dist ? ' · ' + fmtTarget(e.dist) : ''}`)),
          h('div', { class: 'li-end num' }, e.top ? bellText(e.top, exId) : 'BW'))),
        sess.cardio.map((c) => h('div', { class: 'li' },
          h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, pretty(c.mode)), h('div', { class: 'li-sub' }, [c.timeSec ? fmtDur(c.timeSec) : null, c.avgHr ? c.avgHr + ' bpm' : null].filter(Boolean).join(' · '))),
          h('div', { class: 'li-end num' }, c.distanceM ? fmtDist(c.distanceM, u) : '', c.distanceM && c.timeSec ? h('div', { class: 'xs muted' }, fmtPace(c.timeSec / (c.distanceM / 1000), u)) : null))))) : null,
      h('div', { class: 'card stack' },
        h('div', { class: 'row between' }, h('span', { class: 'field-label' }, 'Session RPE'), h('div', { class: 'row' }, rpeWord, rpeOut)),
        rpe,
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Notes'), notes)),
      h('div', { class: 'wo-pre-cta' }, save$)));
  }

  function saved(sess, vol) {
    const root = clear(ctx.root);
    put(root, h('div', { class: 'wo-done' },
      h('div', { class: 'wo-done-mark lbl', 'aria-hidden': 'true' }, h('span', { class: 'go' }, '✓ '), 'Session complete'),
      h('h1', null, 'Session saved'),
      h('p', { class: 'dim' }, [`${fmtDur(sess.durationSec, { long: true })}`, sess.sets.length ? `${sess.sets.length} sets` : null,
        vol ? fmtWeight(vol, units()) + ' moved' : null, sess.prs.length ? `${sess.prs.length} PR${sess.prs.length > 1 ? 's' : ''}` : null].filter(Boolean).join(' · ')),
      sess.prs.length ? h('div', { class: 'chips wo-done-prs' }, sess.prs.slice(0, 4).map((p) => h('span', { class: 'stamp go' }, 'PR · ' + p))) : null,
      h('div', { class: 'stack wo-done-actions' },
        h('a', { class: 'btn primary xl block', href: '#/today' }, 'Back to Today'),
        h('a', { class: 'btn ghost block', href: '#/history/' + encodeURIComponent(sess.id) }, 'View in history'))));
  }

  // ---- go
  if (aw.finishing) { summary(); return; }
  restoreRest();
  drawAll();
  if (fresh) {
    speak(W.blocks[0] ? `${W.title}. First up, ${W.blocks[0].title || KIND_LABEL[W.blocks[0].kind]}` : '');
    if (isFree && !W.blocks.length) setTimeout(() => !ctx.dead && addExerciseSheet(), 250);
  } else {
    toast(aw.paused ? 'Workout restored — paused' : 'Workout resumed');
  }
}

const sumStat = (v, k) => h('div', { class: 'stat-card stat' }, h('div', { class: 'v' }, v), h('div', { class: 'k' }, k));
const rpeLabel = (v) => (v <= 2 ? 'very easy' : v <= 4 ? 'easy' : v <= 6 ? 'moderate' : v <= 8 ? 'hard' : v === 9 ? 'very hard' : 'max effort');

function setPath(obj, path, val) {
  const ks = path.split('.');
  let o = obj;
  for (let i = 0; i < ks.length - 1; i++) { o[ks[i]] = o[ks[i]] && typeof o[ks[i]] === 'object' ? o[ks[i]] : {}; o = o[ks[i]]; }
  o[ks[ks.length - 1]] = val;
}
