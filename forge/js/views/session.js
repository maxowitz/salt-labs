// FORGE — Session detail (#/session/<workoutId>) + shared Train helpers (block/item formatting, session saving).
import { store, todayISO, uid } from '../store.js';
import {
  h, icon, toast, sheet, confirmDialog, fmtBell, bellLb, fmtDist, fmtDur, fmtDate, navigate, field, emptyState, clear,
} from '../ui.js';
import { getWorkout, PHASES } from '../engine/program.js';
import { scaleWorkout, suggestWeight, detectPRs } from '../engine/coach.js';
import { getExercise } from '../data/exercises.js';
import { exerciseSheet } from './library.js';

// ---------------------------------------------------------------- shared helpers
export const TYPE_META = {
  strength: { icon: 'bell', label: 'Strength' },
  conditioning: { icon: 'flame', label: 'Conditioning' },
  run: { icon: 'run', label: 'Run' },
  cardio: { icon: 'run', label: 'Cardio' },
  hybrid: { icon: 'zap', label: 'Hybrid' },
  hyrox: { icon: 'flag', label: 'HYROX' },
  recovery: { icon: 'heart', label: 'Recovery' },
};
export const typeMeta = (t) => TYPE_META[t] || { icon: 'bell', label: t ? String(t) : 'Workout' };

export function typeBadge(type, size = 40) {
  const m = typeMeta(type);
  return h('span', { class: `tr-tbadge t-${type || 'other'}`, style: { width: size + 'px', height: size + 'px' }, 'aria-hidden': 'true' }, icon(m.icon, Math.round(size * 0.5)));
}

export function phaseLabel(p) {
  if (!p) return '';
  return PHASES?.[p]?.label || String(p).charAt(0).toUpperCase() + String(p).slice(1);
}
export function phasePill(p) {
  return p ? h('span', { class: `pill ${p}` }, phaseLabel(p)) : null;
}

/** Seconds → compact human: 30s · 2 min · 1:30 */
export function fmtSec(sec) {
  sec = Math.round(+sec || 0);
  if (sec <= 0) return '0s';
  if (sec < 60) return `${sec}s`;
  if (sec % 60 === 0) return `${sec / 60} min`;
  return fmtDur(sec);
}

const KIND_LABEL = {
  warmup: 'Warm-up', strength: 'Strength', emom: 'EMOM', amrap: 'AMRAP', intervals: 'Intervals', tabata: 'Tabata',
  circuit: 'Circuit', cardio: 'Cardio', station: 'Station', cooldown: 'Cool-down',
};
export const kindLabel = (k) => KIND_LABEL[k] || (k ? String(k) : 'Block');

export function blockStructure(b) {
  const items = b.items || [];
  switch (b.kind) {
    case 'emom': {
      const m = b.minutes || Math.round((b.durationSec || 0) / 60);
      if (b.alternate && items.length > 1) return `Every minute for ${m} min — alternate: minute 1 ${exName(items[0])}, minute 2 ${exName(items[1])}${items.length > 2 ? '…' : ''}`;
      return `Every minute for ${m} min: ${items.length > 1 ? 'complete each item in order, rest the remainder of the minute' : 'do the work, rest the remainder of the minute'}`;
    }
    case 'amrap': return `As many rounds as possible in ${fmtSec(b.durationSec || (b.minutes || 0) * 60)} — cycle the items below`;
    case 'intervals':
    case 'tabata': {
      const r = b.rounds || 8, w = b.workSec || 20, rest = b.restSec ?? 10;
      return `${r} × ${fmtSec(w)} on / ${fmtSec(rest)} off${items.length > 1 ? ' — cycle the items' : ''}`;
    }
    case 'circuit': return `${b.rounds || 1} round${(b.rounds || 1) > 1 ? 's' : ''} through the list${b.restSec ? ` · ${fmtSec(b.restSec)} rest between rounds` : ''}`;
    case 'strength': return b.restSec ? `Rest ${fmtSec(b.restSec)} between sets` : '';
    case 'station': return 'For time — race pace, smooth transitions';
    case 'cardio': return b.durationSec ? `About ${fmtSec(b.durationSec)}` : 'Steady, controlled effort';
    case 'warmup': return b.durationSec ? `${fmtSec(b.durationSec)} · move well, raise temperature` : '';
    case 'cooldown': return b.durationSec ? `${fmtSec(b.durationSec)} · bring the heart rate down` : '';
    default: return '';
  }
}

export function blockShort(b) {
  switch (b.kind) {
    case 'emom': return `EMOM ${b.minutes || Math.round((b.durationSec || 0) / 60)}′`;
    case 'amrap': return `AMRAP ${Math.round((b.durationSec || (b.minutes || 0) * 60) / 60)}′`;
    case 'intervals': case 'tabata': return `${b.rounds || 8}×${fmtSec(b.workSec || 20)}`;
    case 'circuit': return `${b.rounds || 1} rd circuit`;
    case 'station': return b.title || 'Station';
    case 'warmup': case 'cooldown': return null;
    default: return b.title || kindLabel(b.kind);
  }
}
export function blockSummary(w) {
  return (w?.blocks || []).map(blockShort).filter(Boolean).join(' · ');
}

function exName(item) { return safeEx(item?.exId).name; }
export function safeEx(id) {
  try { return getExercise(id) || { id, name: prettify(id), category: 'kb', cues: [] }; }
  catch { return { id, name: prettify(id), category: 'kb', cues: [] }; }
}
const prettify = (id) => String(id || 'Exercise').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** Describe an item's dose. Returns {dose:string, kg:number|null, suggested:boolean, double:boolean, extra:string[]} */
export function describeItem(item, block, profile, sessions) {
  const u = profile?.units || 'metric';
  const ex = safeEx(item.exId);
  const side = item.perSide ? ' /side' : '';
  let dose = '';
  const pre = item.sets && item.sets > 1 ? `${item.sets} × ` : item.sets === 1 ? '1 × ' : '';
  if (item.reps) dose = `${pre}${item.reps}${pre ? '' : ' reps'}${side}`;
  else if (item.distanceM) dose = `${pre}${fmtDist(item.distanceM, u)}${side}`;
  else if (item.timeSec) dose = `${pre}${fmtSec(item.timeSec)}${side}`;
  else if (pre) dose = pre.replace(' × ', ' sets');
  const extra = [];
  if (item.reps && item.distanceM) extra.push(fmtDist(item.distanceM, u));
  if ((item.reps || item.distanceM) && item.timeSec) extra.push(item.distanceM && !item.reps ? `in ~${fmtSec(item.timeSec)}` : fmtSec(item.timeSec));
  if (item.restSec) extra.push(`rest ${fmtSec(item.restSec)}`);
  let kg = Number.isFinite(+item.kg) && +item.kg > 0 ? +item.kg : null;
  let suggested = false;
  if (kg == null && ex.category === 'kb') {
    try { const s = suggestWeight(item.exId, profile, sessions); if (s) { kg = s; suggested = true; } } catch {}
  }
  return { ex, dose, kg, suggested, double: !!ex.double, extra };
}

export function bellTag(kg, { double = false, suggested = false } = {}) {
  if (!kg) return null;
  return h('span', { class: 'tr-bell' + (suggested ? ' sug' : '') },
    h('b', null, (double ? '2 × ' : '') + fmtBell(kg)),
    h('small', null, (double ? '2 × ' : '') + bellLb(kg)),
    suggested ? h('small', { class: 'tr-sug' }, 'suggested') : null);
}

export function itemRow(item, block, profile, sessions) {
  const d = describeItem(item, block, profile, sessions);
  return h('div', { class: 'tr-item' },
    h('div', { class: 'tr-item-top' },
      h('button', { type: 'button', class: 'tr-exname', on: { click: () => exerciseSheet(item.exId) }, 'aria-label': `${d.ex.name} — technique` }, d.ex.name, icon('info', 14)),
      bellTag(d.kg, d)),
    d.dose || d.extra.length ? h('div', { class: 'tr-item-dose' }, d.dose ? h('b', null, d.dose) : null, d.extra.length ? h('span', { class: 'muted' }, (d.dose ? ' · ' : '') + d.extra.join(' · ')) : null) : null,
    item.note ? h('div', { class: 'tr-item-note' }, item.note) : null);
}

export function blockCard(b, i, profile, sessions) {
  return h('section', { class: `card tr-block k-${b.kind || 'other'}` },
    h('div', { class: 'tr-block-head' },
      h('span', { class: 'tr-block-num', 'aria-hidden': 'true' }, String(i + 1)),
      h('div', { class: 'grow' },
        h('div', { class: 'tr-kind' }, kindLabel(b.kind)),
        h('h3', null, b.title || kindLabel(b.kind)))),
    blockStructure(b) ? h('p', { class: 'tr-struct' }, icon(b.kind === 'emom' || b.kind === 'intervals' || b.kind === 'amrap' ? 'timer' : 'repeat', 16), blockStructure(b)) : null,
    b.notes ? h('p', { class: 'small dim tr-bnotes' }, b.notes) : null,
    (b.items || []).length ? h('div', { class: 'tr-items' }, b.items.map((it) => itemRow(it, b, profile, sessions))) : null);
}

/** Locate a plan workout's scheduled day: {weekIndex, day} | null */
export function findPlanned(plan, workoutId) {
  if (!plan?.weeks) return null;
  for (let wi = 0; wi < plan.weeks.length; wi++) {
    const day = (plan.weeks[wi].days || []).find((d) => d.workoutId === workoutId);
    if (day) return { weekIndex: wi, week: plan.weeks[wi], day };
  }
  return null;
}

export const planOrEmpty = (s) => s.plan || { weeks: [], workouts: {} };
export function safeGetWorkout(plan, id) {
  try { return getWorkout(plan || { weeks: [], workouts: {} }, id) || null; } catch (e) { console.warn(e); return null; }
}

/** Persist a logged session (computes PRs, keeps sessions date-sorted, newest last). */
export function saveSession(sess) {
  const s = store.get();
  let prs = [];
  try { prs = detectPRs(sess, s.sessions) || []; } catch (e) { console.warn('detectPRs failed', e); }
  sess.prs = prs;
  if (sess.readiness == null) sess.readiness = s.readiness?.[sess.date]?.score ?? null;
  store.update((d) => {
    d.sessions.push(sess);
    d.sessions.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  });
  return sess;
}

export function rpePicker(value, onChange, label = 'Session RPE') {
  const wrap = h('div', { class: 'tr-rpe', role: 'radiogroup', 'aria-label': label });
  const paint = (v) => {
    clear(wrap);
    for (let i = 1; i <= 10; i++) {
      wrap.append(h('button', {
        type: 'button', role: 'radio', 'aria-checked': String(i === v), class: i === v ? 'on' : '', 'aria-label': `RPE ${i}`,
        on: { click: () => { paint(i); onChange(i); } },
      }, String(i)));
    }
  };
  paint(value);
  return h('div', { class: 'stack sm' }, wrap, h('div', { class: 'row between xs muted' }, h('span', null, 'Easy'), h('span', null, 'Max effort')));
}

export function backBar(href, label = 'Back', right) {
  return h('div', { class: 'tr-topbar' },
    h('a', { class: 'tr-back', href }, icon('chevL', 20), label),
    right || null);
}

/** "Mark done" / log-without-tracking sheet. */
export function markDoneSheet(workout, defaultDate) {
  const today = todayISO();
  let rpe = 6;
  const date = h('input', { type: 'date', value: defaultDate && defaultDate <= today ? defaultDate : today, max: today });
  const mins = h('input', { type: 'number', inputmode: 'numeric', min: '1', max: '600', value: String(workout?.estMin || 45) });
  const notes = h('textarea', { placeholder: 'How did it go? (optional)', rows: 3 });
  sheet({
    title: 'Mark as done',
    content: ({ close }) => h('div', { class: 'stack' },
      h('p', { class: 'small muted' }, `Log “${workout.title}” as completed without tracking sets. It counts toward your plan and streak.`),
      h('div', { class: 'grid2' }, field('Date', date), field('Duration (min)', mins)),
      field('How hard was it?', rpePicker(rpe, (v) => (rpe = v))),
      field('Notes', notes),
      h('button', {
        class: 'btn primary block xl', on: {
          click: () => {
            const m = Math.max(1, Math.min(600, +mins.value || workout.estMin || 30));
            const d = date.value || today;
            const sess = saveSession({
              id: uid('s'), date: d, workoutId: workout.id, title: workout.title, type: workout.type || 'strength',
              startedAt: new Date(d + 'T12:00:00').toISOString(), durationSec: m * 60, sets: [], cardio: [],
              rpe, notes: notes.value.trim(), readiness: null, prs: [], untracked: true,
            });
            close();
            toast(sess.prs?.length ? `Logged · ${sess.prs.length} PR!` : 'Marked as done ✓', { kind: 'go', action: { label: 'View', fn: () => navigate('#/history/' + sess.id) } });
          },
        },
      }, icon('check'), 'Save as done')),
  });
}

// ---------------------------------------------------------------- view
let viewMode = null; // 'planned' | 'scaled' — kept across re-renders of the same workout
let viewModeFor = null;

export function render(root, { args }) {
  const id = args[0];
  const draw = () => {
    const s = store.get();
    clear(root);
    const workout = safeGetWorkout(s.plan, id);
    if (!workout) {
      root.append(backBar('#/train', 'Train'), emptyState('calendar', 'Session not found', 'This workout is no longer in your plan — it may have been regenerated.',
        h('a', { class: 'btn primary', href: '#/train' }, 'Back to Train')));
      return;
    }
    const today = todayISO();
    const planned = findPlanned(s.plan, id);
    const weekNo = planned ? planned.weekIndex + 1 : null;
    const phase = workout.phase || planned?.week?.phase;
    const done = s.sessions.filter((x) => x.workoutId === id);
    const readinessScore = s.readiness?.[today]?.score;
    if (viewModeFor !== id) { viewMode = null; viewModeFor = id; }

    // readiness scaling preview
    let shown = workout, changes = [];
    const scaleRelevant = Number.isFinite(+readinessScore) && (!planned || planned.day.date === today || planned.day.date > today);
    if (scaleRelevant) {
      try {
        const r = scaleWorkout(workout, +readinessScore);
        changes = r?.changes || [];
        if (changes.length) {
          if (!viewMode) viewMode = planned?.day.date === today ? 'scaled' : 'planned';
          if (viewMode === 'scaled') shown = r.workout;
        }
      } catch (e) { console.warn(e); }
    }

    const back = planned ? `#/train/week/${weekNo}` : '#/train';
    root.append(backBar(back, planned ? `Week ${weekNo}` : 'Train'));

    // hero
    const meta = typeMeta(workout.type);
    root.append(h('div', { class: 'card hero tr-shero' },
      h('div', { class: 'row wrap', style: { gap: '6px' } },
        phasePill(phase),
        weekNo ? h('span', { class: 'pill' }, `Week ${weekNo}`) : h('span', { class: 'pill' }, 'Extra session'),
        planned?.week?.deload ? h('span', { class: 'pill recovery' }, 'Deload') : null,
        planned ? h('span', { class: 'pill' + (planned.day.date === today ? ' accent' : '') }, planned.day.date === today ? 'Today' : fmtDate(planned.day.date)) : null),
      h('div', { class: 'row gap mt top' }, typeBadge(workout.type, 48),
        h('div', { class: 'grow' }, h('h1', { class: 'tr-stitle' }, workout.title), h('div', { class: 'small muted' }, meta.label))),
      h('div', { class: 'tr-sstats' },
        stat(shown.estMin ? String(shown.estMin) : '–', 'min', 'Est. time'),
        stat(String((shown.blocks || []).length), '', 'Blocks'),
        stat(String(countMoves(shown)), '', 'Movements')),
      workout.summary ? h('p', { class: 'dim tr-ssum' }, workout.summary) : null,
      (workout.equipment || []).length ? h('div', { class: 'chips mt' }, workout.equipment.map((e) => h('span', { class: 'chip tr-eq' }, icon(eqIcon(e), 14), String(e)))) : null));

    if (done.length) {
      const last = done[done.length - 1];
      root.append(h('a', { class: 'callout go tr-done-call', href: '#/history/' + last.id },
        icon('check', 18), h('span', { class: 'grow' }, `Completed ${fmtDate(last.date)}${done.length > 1 ? ` · ${done.length}× total` : ''}${last.durationSec ? ' · ' + fmtDur(last.durationSec, { long: true }) : ''}`), icon('chevR', 16)));
    } else if (planned && planned.day.date < today) {
      root.append(h('div', { class: 'callout danger small' }, `Planned for ${fmtDate(planned.day.date)} and not logged. Train it now, mark it done, or swap it to another day.`));
    }

    if (changes.length) {
      root.append(h('div', { class: 'card tr-ready' },
        h('div', { class: 'row between' },
          h('div', null, h('div', { class: 'eyebrow' }, 'Readiness today'), h('div', { class: 'big num' }, String(Math.round(readinessScore)), h('small', { class: 'muted small' }, ' / 100'))),
          h('div', { class: 'seg tr-seg', role: 'radiogroup', 'aria-label': 'Version' },
            ['planned', 'scaled'].map((m) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(viewMode === m), class: viewMode === m ? 'on' : '', on: { click: () => { viewMode = m; draw(); } } }, m === 'planned' ? 'As planned' : 'Adjusted')))),
        h('ul', { class: 'tr-changes' }, changes.map((c) => h('li', null, c)))));
    } else if (Number.isFinite(+readinessScore) && scaleRelevant) {
      root.append(h('div', { class: 'callout go small' }, `Readiness ${Math.round(readinessScore)}/100 — good to go as planned.`));
    }

    // blocks
    const blocks = shown.blocks || [];
    if (!blocks.length) {
      root.append(h('div', { class: 'card mt' }, emptyState('edit', 'Freestyle session', 'No fixed blocks — start the player and log whatever you do, or log it after the fact.')));
    } else {
      root.append(h('div', { class: 'stack mt tr-blocks' }, blocks.map((b, i) => blockCard(b, i, s.profile, s.sessions))));
    }

    // secondary actions
    root.append(h('div', { class: 'tr-sactions' },
      planned ? h('button', { class: 'btn ghost', on: { click: () => swapSheet(id) } }, icon('repeat', 18), 'Swap day') : null,
      h('button', { class: 'btn ghost', on: { click: () => markDoneSheet(workout, planned?.day.date) } }, icon('check', 18), 'Mark as done')));

    // sticky start
    const active = s.activeWorkout;
    const resuming = active && active.workoutId === id;
    root.append(h('div', { class: 'tr-sticky' },
      h('button', {
        class: 'btn primary xl block tr-start', on: {
          click: async () => {
            const cur = store.get().activeWorkout;
            if (cur && cur.workoutId !== id) {
              const other = safeGetWorkout(store.get().plan, cur.workoutId);
              const ok = await confirmDialog(`“${other?.title || 'Another workout'}” is still in progress. Discard it and start this one?`, { ok: 'Discard & start', danger: true });
              if (!ok) return;
              store.update((d) => { d.activeWorkout = null; });
            }
            navigate('#/workout/' + encodeURIComponent(id));
          },
        },
      }, icon('play', 20), resuming ? 'Resume workout' : done.length ? 'Start again' : 'Start workout')));
  };
  draw();
  const unsub = store.subscribe(draw);
  return () => unsub();
}

function stat(v, unit, k) {
  return h('div', { class: 'stat' }, h('div', { class: 'v' }, v, unit ? h('small', null, unit) : null), h('div', { class: 'k' }, k));
}
function countMoves(w) {
  const ids = new Set();
  for (const b of w.blocks || []) for (const it of b.items || []) ids.add(it.exId);
  return ids.size;
}
function eqIcon(e) {
  const t = String(e).toLowerCase();
  if (/bell|kb/.test(t)) return 'bell';
  if (/run|shoe|tread/.test(t)) return 'run';
  if (/row|ski|bike|erg/.test(t)) return 'zap';
  if (/timer|clock/.test(t)) return 'timer';
  return 'check';
}

function swapSheet(workoutId) {
  const s = store.get();
  const p = findPlanned(s.plan, workoutId);
  if (!p) return;
  const from = p.day.date;
  const days = [...p.week.days].sort((a, b) => a.date.localeCompare(b.date));
  sheet({
    title: 'Swap day',
    content: ({ close }) => h('div', { class: 'stack' },
      h('p', { class: 'small muted' }, 'Move this session to another day this week. Whatever is on that day moves here.'),
      h('div', { class: 'card flush' }, h('div', { class: 'list' }, days.map((d) => {
        const w = d.workoutId ? safeGetWorkout(s.plan, d.workoutId) : null;
        const isFrom = d.date === from;
        const logged = s.sessions.some((x) => x.date === d.date || (d.workoutId && x.workoutId === d.workoutId));
        return h('button', {
          class: 'li', disabled: isFrom, 'aria-current': isFrom ? 'true' : null,
          on: {
            click: () => {
              if (isFrom) return;
              store.update((st) => {
                const wk = st.plan.weeks[p.weekIndex];
                const a = wk.days.find((x) => x.date === from), b = wk.days.find((x) => x.date === d.date);
                if (!a || !b) return;
                const tmp = { workoutId: a.workoutId ?? null, rest: !!a.rest };
                a.workoutId = b.workoutId ?? null; a.rest = !!b.rest;
                b.workoutId = tmp.workoutId; b.rest = tmp.rest;
              });
              close();
              toast(`Moved to ${fmtDate(d.date)}`, { kind: 'go' });
            },
          },
        },
        h('div', { class: 'badge' }, fmtDate(d.date, { weekday: 'short' })),
        h('div', { class: 'li-main' },
          h('div', { class: 'li-title' }, isFrom ? 'This session' : w ? w.title : 'Rest day'),
          h('div', { class: 'li-sub' }, fmtDate(d.date, { month: 'short', day: 'numeric' }) + (d.date === todayISO() ? ' · today' : '') + (logged ? ' · logged' : ''))),
        isFrom ? h('span', { class: 'pill accent' }, 'Here') : icon('repeat', 18));
      })))),
  });
}

