// FORGE Today — the hero screen (docs/PROMPT.md §3.2).
import { store, sel, todayISO, addDays, daysBetween } from '../store.js';
import { h, clear, icon, toast, sheet, navigate, haptic, num, fmtDur, fmtDate, fmtWeight, fmtBell,
  toDisplayWeight, fromDisplayWeight, stepper, sectionHead, fig, masthead } from '../ui.js';
import { ticks, ribbon } from '../charts.js';
import { startWorkout } from './session.js';
import * as program from '../engine/program.js';
import * as coach from '../engine/coach.js';
import * as hyrox from '../engine/hyrox.js';
import * as nutrition from '../engine/nutrition.js';

export const TYPE_META = {
  strength: { label: 'Strength', short: 'STR', icon: 'bell' },
  conditioning: { label: 'Conditioning', short: 'KB', icon: 'flame' },
  run: { label: 'Run', short: 'RUN', icon: 'run' },
  hybrid: { label: 'Hybrid', short: 'HYB', icon: 'zap' },
  hyrox: { label: 'HYROX', short: 'HRX', icon: 'flag' },
  recovery: { label: 'Recovery', short: 'REC', icon: 'heart' },
};

const READINESS_Q = [
  { key: 'sleep', label: 'Sleep', lo: 'Awful', hi: 'Great' },
  { key: 'soreness', label: 'Soreness', lo: 'Fresh', hi: 'Wrecked' },
  { key: 'energy', label: 'Energy', lo: 'Flat', hi: 'Fired up' },
  { key: 'stress', label: 'Stress', lo: 'Calm', hi: 'Maxed' },
];

export function readinessBand(score) {
  if (!Number.isFinite(score)) return null;
  if (score < 40) return { key: 'red', color: 'var(--danger)', title: 'Recover today', short: 'Today becomes a recovery session.', text: 'Low readiness — today becomes a recovery session. Mobility, easy movement, sleep early.' };
  if (score <= 60) return { key: 'amber', color: 'var(--warn)', title: 'Train smart', short: 'Volume trimmed ~25 %, intervals → Zone 2.', text: 'Moderate readiness — volume trimmed about 25 % and hard intervals swapped for Zone 2.' };
  return { key: 'green', color: 'var(--go)', title: 'Green light', short: 'Train as planned.', text: 'Good to go — train as planned and own the session.' };
}

export const TIPS = [
  'Swing: hike the bell back high between the thighs, then snap the hips. The arms are just ropes.',
  'Breathe with the bell: sharp exhale at the top of every swing — “tss” — to brace and reset.',
  'Grip fading on swings? Switch to a hook grip and shake the hands out between sets instead of squeezing harder.',
  'Clean the bell close: zip it up the body and “punch through” the handle so it doesn’t bang your forearm.',
  'Press from a tight rack: squeeze glutes and quads, and push yourself away from the bell.',
  'Double progression: own the top of the rep range on every set before moving up a bell.',
  'No heavier bell? Progress density — same work, 10–15 seconds less rest.',
  'Snatch: high pull, then punch the hand up and through at the top. Smooth catch, no flop.',
  'Goblet squat: elbows inside knees at the bottom, chest proud, pause for a breath, then drive up.',
  'Farmers carry: shoulders packed, short quick steps, look ahead — not at your feet.',
  'HYROX is 50+ % running. Every station rep you save is undone by a slow ROXZONE — walk in briskly, never stop.',
  'Start run 1 slower than you think. The best HYROX splits are even, not heroic early.',
  'Wall balls: break them early and on your terms — 25/20/20/15/10/10 beats failing at 30.',
  'Sled push: low hips, arms locked, small fast steps. No sled? Heavy front-rack walks and hill sprints build the same legs.',
  'Burpee broad jumps: step up if you must, but keep jumping — rhythm beats speed here.',
  'SkiErg: hinge and crunch, then let the arms finish. It’s a swing pattern — your kettlebell base transfers.',
  'Row: legs, body, arms — arms, body, legs. Aim for a smooth 26–30 strokes per minute in the race.',
  'Sandbag lunges: tap the back knee every rep, bag high on the shoulders, breathe on the way up.',
  'Compromised running: practise the first 200 m after a station. That transition is where races are won.',
  'Zone 2 should feel conversational. If you can’t speak in sentences, slow down — the engine grows anyway.',
  'Most of your running should be easy. Keep it easy so the hard days can be truly hard.',
  'Sleep is the cheapest performance drug. 7–9 hours turns training into fitness.',
  'Protein at every meal — around 30–50 g — makes hitting your daily target effortless.',
  'Eat most of your carbs around training. Fuel the work, recover the work.',
  'Hydration: aim for pale-yellow urine. Add a pinch of salt on sweaty training days.',
  'Weigh in first thing after the bathroom, before food. Trust the 7-day trend, not one day.',
  'A deload week is not a week off — it’s when adaptation catches up. Don’t skip it.',
  'Low readiness? Moving gently still counts. A walk and mobility beat forcing a bad session.',
  'Log every set. Seeing last week’s numbers is the easiest way to beat them.',
  'When race week comes: keep the intensity, cut the volume. You can’t get fitter in the last 7 days — only fresher.',
  'Practise race-day breakfast on a long session first. Nothing new on race day.',
  'Turkish get-up once a week keeps shoulders bulletproof for all the pressing and snatching.',
  'Carry a pair of bells for time when short on time — grip, core and conditioning in one.',
  'Fibre and veg keep you full on a deficit. Fill half the plate before the carbs.',
];

export function tipForDate(iso) {
  const n = daysBetween('2024-01-01', iso);
  return TIPS[((n % TIPS.length) + TIPS.length) % TIPS.length];
}

export function greeting(d = new Date()) {
  const hr = d.getHours();
  return hr < 5 ? 'Late night' : hr < 12 ? 'Morning' : hr < 18 ? 'Afternoon' : 'Evening';
}

const safe = (fn, fallback = null) => { try { return fn(); } catch (e) { console.warn('FORGE today:', e); return fallback; } };

/** Monday of the week containing iso. */
export function weekStart(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return addDays(iso, -dow);
}

export function phaseOf(s, iso) {
  const day = sel.dayPlan(s, iso);
  const wk = day?.week;
  if (!wk && s.plan?.weeks?.length) {
    const first = s.plan.weeks[0], last = s.plan.weeks.at(-1);
    if (iso < (first.days[0]?.date || '')) return { phase: first.phase, weekNo: 0, total: s.plan.weeks.length, deload: false, before: true };
    return { phase: last.phase, weekNo: s.plan.weeks.length, total: s.plan.weeks.length, deload: false, after: true };
  }
  if (!wk) return null;
  return { phase: wk.phase, weekNo: (wk.index ?? s.plan.weeks.indexOf(wk)) + 1, total: s.plan.weeks.length, deload: !!wk.deload, focus: wk.focus };
}

/** Upsert today's bodyweight; recompute auto targets. Shared with Progress. */
export function saveWeight(kg, date = todayISO()) {
  store.update((st) => {
    st.bodyweight = st.bodyweight.filter((b) => b.date !== date);
    st.bodyweight.push({ date, kg });
    st.bodyweight.sort((a, b) => a.date.localeCompare(b.date));
    // Targets follow the smoothed trend, and only when it has moved > 1 kg (no daily jitter).
    const trend = safe(() => nutrition.weightTrend(st.bodyweight).at(-1)?.kg, null) ?? kg;
    if (!(Math.abs(trend - (+st.profile.weightKg || 0)) <= 1)) {
      st.profile.weightKg = Math.round(trend * 10) / 10;
      if (st.targets.auto) {
        const t = safe(() => nutrition.computeTargets(st.profile, { plan: st.plan }));
        if (t) st.targets = { ...st.targets, ...t, auto: true };
      }
    }
  });
}

export function openWeightSheet() {
  const s = store.get();
  const units = s.profile.units;
  const unit = units === 'metric' ? 'kg' : 'lb';
  const today = todayISO();
  const existing = s.bodyweight.find((b) => b.date === today);
  let v = Math.round(toDisplayWeight(existing?.kg ?? sel.latestWeight(s), units) * 10) / 10;
  const input = h('input', {
    type: 'number', inputmode: 'decimal', step: '0.1', min: units === 'metric' ? 30 : 66, max: units === 'metric' ? 300 : 660,
    value: String(v), 'aria-label': `Body weight in ${unit}`, class: 'weight-input',
    on: { input: (e) => { v = Number(e.target.value); } },
  });
  const nudge = (d) => { v = Math.round(((Number(input.value) || v) + d) * 10) / 10; input.value = String(v); haptic(); };
  const err = h('div', { role: 'alert', class: 'small danger-text' });
  sheet({
    title: 'Log weight',
    content: ({ close }) => {
      const save = () => {
        const kg = fromDisplayWeight(Number(input.value), units);
        if (!Number.isFinite(kg) || kg < 30 || kg > 300) { err.textContent = `Enter a weight between ${units === 'metric' ? '30 and 300 kg' : '66 and 660 lb'}.`; return; }
        saveWeight(Math.round(kg * 100) / 100, today);
        close();
        toast(`Logged ${fmtWeight(kg, units, 1)}`, { kind: 'go' });
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
      return h('div', { class: 'stack' },
        h('p', { class: 'muted small' }, existing ? 'Updating today’s weigh-in.' : 'Morning weigh-in, after the bathroom, before food.'),
        h('div', { class: 'weight-entry' },
          h('button', { type: 'button', class: 'icon-btn filled', 'aria-label': `Decrease by 0.1 ${unit}`, on: { click: () => nudge(-0.1) } }, icon('minus')),
          h('div', { class: 'weight-field' }, input, h('span', null, unit)),
          h('button', { type: 'button', class: 'icon-btn filled', 'aria-label': `Increase by 0.1 ${unit}`, on: { click: () => nudge(0.1) } }, icon('plus'))),
        err,
        h('button', { type: 'button', class: 'btn primary xl block', on: { click: save } }, icon('check'), 'Save weight'));
    },
  });
}

function addWater(ml) {
  const today = todayISO();
  store.update((st) => { st.water[today] = Math.max(0, (st.water[today] || 0) + ml); });
  haptic();
  const now = store.get().water[today] || 0;
  const metric = store.get().profile.units === 'metric';
  toast(metric ? `+${ml} ml water · ${num(now / 1000, 2)} L today` : `+${num(ml / 29.5735)} oz water · ${num(now / 29.5735)} oz today`, {
    action: { label: 'Undo', fn: () => store.update((st) => { st.water[today] = Math.max(0, (st.water[today] || 0) - ml); }) },
  });
}

// ---------- Cards ----------
function headerBlock(s, today) {
  const ph = phaseOf(s, today);
  const raceDate = s.profile.raceDate || s.plan?.raceDate;
  const days = raceDate ? daysBetween(today, raceDate) : null;
  const P = safe(() => program.PHASES, {}) || {};
  const name = String(s.profile.name ?? '').trim();
  const dateline = fmtDate(today, { weekday: 'short', day: 'numeric', month: 'short' }) + (ph && !ph.before && !ph.after ? ` · Wk ${String(ph.weekNo).padStart(2, '0')}/${String(ph.total).padStart(2, '0')}` : '');
  const phaseLine = !ph ? null : ph.before ? 'Your plan starts soon.' : ph.after ? 'Plan complete — time to set the next goal.'
    : `${P[ph.phase]?.label || ph.phase} phase, week ${ph.weekNo} of ${ph.total}${ph.deload ? ' — deload, keep it easy.' : '.'}`;
  const weeks = s.plan?.weeks || [];
  const cur = ph && !ph.before && !ph.after ? ph.weekNo - 1 : ph?.after ? weeks.length : -1;
  return h('div', { class: 'today-top' },
    masthead(dateline),
    h('header', { class: 'today-head' + (days != null && days >= 0 ? '' : ' solo') },
      h('div', { class: 'today-hello' },
        h('h1', null, greeting(), name ? ',' : '', name ? h('br') : null, name ? h('span', { class: 'today-name' }, name + '.') : null),
        phaseLine ? h('p', { class: 'today-sub' }, phaseLine) : null),
      days != null && days >= 0 ? h('div', { class: 'countdown', role: 'img', 'aria-label': `${days} days to ${s.profile.raceDate ? 'race' : 'target date'}` },
        h('span', { class: 'lbl' }, s.profile.raceDate ? 'HYROX' : 'Target'),
        h('div', null, h('span', { class: 'countdown-n fig' }, String(days)), h('span', { class: 'countdown-k lbl' }, days === 1 ? 'Day out' : 'Days out'))) : null),
    weeks.length ? safe(() => ribbon({ weeks, current: cur, ariaLabel: phaseLine || 'Plan weeks' }), null) : null);
}

function readinessCard(s, today, ui, repaint) {
  const saved = s.readiness[today];
  const score = saved?.score;
  // Answered → figure + tick meter + the four answers.
  if (saved && Number.isFinite(score) && !ui.editing) {
    const band = readinessBand(score);
    return h('section', { class: `readiness done ${band.key}`, 'aria-label': 'Readiness' },
      h('span', { class: 'rd-score fig' }, String(Math.round(score))),
      h('div', { class: 'grow rd-line' },
        h('div', { class: 'row between' },
          h('div', { class: 'rd-title' }, band.title),
          h('button', { type: 'button', class: 'icon-btn rd-edit', 'aria-label': 'Edit readiness check-in', on: { click: () => { ui.editing = true; ui.open = true; ui.picks = { ...saved }; repaint(); } } }, icon('edit', 18))),
        ticks({ value: score, max: 100, n: 41, color: band.color, label: `Readiness ${Math.round(score)} of 100` }),
        h('p', { class: 'small dim rd-short' }, band.short),
        h('div', { class: 'data rd-data' }, `sleep ${saved.sleep} · sore ${saved.soreness} · energy ${saved.energy} · stress ${saved.stress}`)));
  }
  // Collapsed → a single ruled row that expands in place.
  if (!ui.open) {
    return h('button', { type: 'button', class: 'readiness rd-collapsed', 'aria-expanded': 'false', on: { click: () => { ui.open = true; repaint(); } } },
      h('span', { class: 'grow rd-line' }, h('span', { class: 'rd-title' }, 'How ready are you?'), h('span', { class: 'data' }, '10-second check-in · today’s session adapts')),
      h('span', { class: 'lbl acc' }, 'Check in'), icon('chevR', 18));
  }
  const picks = ui.picks || (ui.picks = {});
  const answered = READINESS_Q.filter((q) => picks[q.key]).length;
  const save = () => {
    const checkin = { sleep: picks.sleep, soreness: picks.soreness, energy: picks.energy, stress: picks.stress };
    const val = Math.round(hyrox.readinessScore(checkin));
    store.update((st) => { st.readiness[today] = { ...checkin, score: val }; });
    ui.editing = false; ui.open = false; ui.picks = null;
    haptic(20);
  };
  return h('section', { class: 'readiness rd-open', 'aria-label': 'Readiness check-in' },
    h('div', { class: 'row between' },
      h('div', { class: 'rd-title' }, 'How ready are you?'),
      h('div', { class: 'row' },
        h('span', { class: 'lbl num', 'aria-live': 'polite' }, `${answered} / 4`),
        h('button', { type: 'button', class: 'link-btn', on: { click: () => { ui.editing = false; ui.open = false; ui.picks = null; repaint(); } } }, ui.editing ? 'Cancel' : 'Later'))),
    h('div', { class: 'rq-list' },
      READINESS_Q.map((q) => h('div', { class: 'rq' },
        h('div', { class: 'rq-head' }, h('span', { class: 'rq-label' }, q.label), h('span', { class: 'rq-ends data' }, `1 ${q.lo.toLowerCase()} → 5 ${q.hi.toLowerCase()}`)),
        h('div', { class: 'rq-picks', role: 'radiogroup', 'aria-label': `${q.label}, 1 ${q.lo} to 5 ${q.hi}` },
          [1, 2, 3, 4, 5].map((n) => h('button', {
            type: 'button', role: 'radio', 'aria-checked': String(picks[q.key] === n), 'aria-label': `${q.label} ${n}${n === 1 ? ' ' + q.lo : n === 5 ? ' ' + q.hi : ''}`,
            class: 'rq-pick' + (picks[q.key] === n ? ' on' : ''),
            on: { click: () => {
              picks[q.key] = n; haptic();
              if (READINESS_Q.every((x) => picks[x.key])) save(); else repaint();
            } },
          }, String(n))))))));
}

function blockKindLabel(k) {
  return { warmup: 'Warm-up', strength: 'Strength', emom: 'EMOM', amrap: 'AMRAP', intervals: 'Intervals', circuit: 'Circuit', cardio: 'Cardio', station: 'Station', cooldown: 'Cool-down' }[k] || k;
}

function sessionSummary(sess) {
  const vol = safe(() => coach.sessionVolumeKg(sess), 0) || 0;
  const dist = (sess.cardio || []).reduce((a, c) => a + (+c.distanceM || 0), 0) + (sess.sets || []).reduce((a, x) => a + (+x.distanceM || 0), 0);
  return { vol, dist, sets: (sess.sets || []).length };
}

const BLOCK_LETTER = (i) => String(i + 1).padStart(2, '0');

function statRow(items) {
  return h('div', { class: 'stat-row' }, items.filter(Boolean).map(([v, unit, k]) => h('div', { class: 'stat' }, h('span', { class: 'v' }, v, unit ? h('small', null, unit) : null), h('span', { class: 'k' }, k))));
}

/** Today's workout after readiness scaling (fixed/benchmark sessions are never scaled). Single source for minutes. */
function scaledFor(s, today, workout) {
  const score = s.readiness[today]?.score;
  const locked = !!(workout?.fixed || workout?.benchmark);
  const scaled = workout && Number.isFinite(score) && !locked ? safe(() => coach.scaleWorkout(workout, score), null) : null;
  return { score, locked, scaled, workout: scaled?.workout || workout };
}

/** One-line pre-session fuelling note from the nutrition engine (if available). */
function fuelNote(s, today) {
  if (typeof nutrition.fuelingNote !== 'function' || sel.sessionsOn(s, today).length) return null;
  const n = safe(() => nutrition.fuelingNote(s, today), null);
  const text = n && (n.headline ?? (n.warn || n.pre));
  if (!text) return null;
  const severe = n.severe ?? (!n.headline && !!n.warn);
  return h('p', { class: 'fuel-note' + (severe ? ' warn' : ''), title: [n.pre, n.during, n.warn].filter(Boolean).join(' ') },
    h('span', { class: 'lbl' }, severe ? 'Fuel ⚠' : 'Fuel'), ' ', text);
}

function sessionCard(s, today) {
  const units = s.profile.units;
  const volTxt = (kg) => (units === 'metric' ? num(Math.round(kg)) : num(Math.round(kg / 0.45359237)));
  const active = s.activeWorkout;
  const done = sel.sessionsOn(s, today);
  const wfd = s.plan ? safe(() => program.workoutForDate(s.plan, today), null) : null;
  const workout = wfd?.workout || null;

  if (!s.plan) {
    return h('section', { class: 'session-card' },
      h('div', { class: 'eyebrow' }, 'No plan yet'), h('h2', { class: 'session-title' }, 'Build your training plan'),
      h('p', { class: 'small dim' }, 'Your plan was cleared. Regenerate it from Me → Plan.'),
      h('a', { class: 'btn primary block mt', href: '#/me' }, 'Go to plan settings'));
  }

  const resumeBtn = active ? h('a', { class: 'btn primary xl block', href: `#/workout/${encodeURIComponent(active.workoutId || 'free')}` },
    h('span', null, `Resume ${safe(() => program.getWorkout(s.plan, active.workoutId)?.title, null) || 'workout'}`), h('span', { class: 'k' }, 'Live →')) : null;

  // Done state
  const doneSession = done.find((x) => workout && x.workoutId === workout.id) || done[0];
  if (doneSession) {
    const sm = sessionSummary(doneSession);
    return h('section', { class: 'session-card done' },
      h('div', { class: 'eyebrow' }, h('span', { class: 'go' }, '✓ '), 'Session complete'),
      h('h2', { class: 'session-title' }, doneSession.title || 'Workout'),
      statRow([
        [fmtDur(doneSession.durationSec || 0, { long: true }), null, 'Time'],
        sm.vol ? [volTxt(sm.vol), units === 'metric' ? 'kg' : 'lb', 'Volume']
          : [sm.dist ? (units === 'metric' ? num(sm.dist / 1000, 1) : num(sm.dist / 1609.344, 1)) : String(sm.sets), sm.dist ? (units === 'metric' ? 'km' : 'mi') : 'sets', sm.dist ? 'Distance' : 'Logged'],
        [doneSession.rpe ? String(doneSession.rpe) : '–', null, 'Session RPE'],
      ]),
      doneSession.prs?.length ? h('div', { class: 'pr-strip' }, doneSession.prs.slice(0, 3).map((p) => h('span', { class: 'stamp go' }, 'PR · ' + p))) : null,
      h('div', { class: 'row gap mt' },
        h('a', { class: 'btn ghost grow', href: `#/history/${encodeURIComponent(doneSession.id)}` }, 'View summary'),
        h('a', { class: 'btn subtle grow', href: '#/fuel?add=auto' }, 'Refuel')),
      resumeBtn ? h('div', { class: 'mt' }, resumeBtn) : null);
  }

  // Rest day
  if (!workout) {
    const rec = safe(() => (program.TEMPLATES || []).find((t) => t.type === 'recovery' || /mobility|recovery/.test(t.id)), null);
    return h('section', { class: 'session-card rest' },
      h('div', { class: 'eyebrow' }, 'Rest day'),
      h('h2', { class: 'session-title' }, 'Recover to adapt'),
      h('p', { class: 'small dim' }, 'Fitness is built between sessions. Keep moving gently and eat your protein.'),
      h('div', { class: 'list rest-list mt' },
        rec ? h('a', { class: 'li', href: `#/session/${encodeURIComponent(rec.id)}` },
          h('span', { class: 'badge' }, 'MOB'),
          h('span', { class: 'li-main' }, h('div', { class: 'li-title' }, rec.title || 'Mobility flow'), h('div', { class: 'li-sub' }, `${rec.estMin || 15} min · hips, T-spine, shoulders`)),
          icon('chevR', 18)) : null,
        h('div', { class: 'li' },
          h('span', { class: 'badge' }, 'Z1'),
          h('span', { class: 'li-main' }, h('div', { class: 'li-title' }, 'Easy walk'), h('div', { class: 'li-sub' }, '30–45 min outdoors, nasal breathing, Zone 1'))),
        h('a', { class: 'li', href: '#/train' },
          h('span', { class: 'badge' }, 'ALT'),
          h('span', { class: 'li-main' }, h('div', { class: 'li-title' }, 'Want to train anyway?'), h('div', { class: 'li-sub' }, 'Pick a session from Train')),
          icon('chevR', 18))),
      resumeBtn ? h('div', { class: 'mt' }, resumeBtn) : null);
  }

  // Planned session with readiness scaling preview
  const { score, locked, scaled, workout: w } = scaledFor(s, today, workout);
  const changes = scaled?.changes || [];
  const tm = TYPE_META[w.type] || TYPE_META.strength;
  const P = safe(() => program.PHASES, {}) || {};
  const blocks = (w.blocks || []);
  const blockMin = (b) => {
    const sec = b.durationSec || (b.minutes ? b.minutes * 60 : 0) || (b.rounds && (b.workSec || b.restSec) ? b.rounds * ((b.workSec || 0) + (b.restSec || 0)) : 0);
    return sec ? `${Math.round(sec / 60)}′` : '';
  };
  return h('section', { class: `session-card type-${w.type || 'strength'}` },
    h('div', { class: 'eyebrow' }, [tm.label, w.phase ? (P[w.phase]?.label || w.phase) : null, ...(w.equipment || []).slice(0, 2)].filter(Boolean).join(' · ')),
    h('h2', { class: 'session-title' }, w.title || 'Today’s session'),
    w.summary ? h('p', { class: 'small dim' }, w.summary) : null,
    blocks.length ? h('ol', { class: 'block-peek ledger' },
      blocks.slice(0, 6).map((b, i) => h('li', { class: 'lrow' },
        h('span', { class: 'ix' }, BLOCK_LETTER(i)),
        h('span', { class: 'bk' }, new RegExp(blockKindLabel(b.kind).replace('-', '.?'), 'i').test(b.title || '') ? '' : blockKindLabel(b.kind)),
        h('span', { class: 'bt' }, b.title || ''),
        h('span', { class: 'bm data' }, blockMin(b))))) : null,
    changes.length ? h('div', { class: 'callout scaled mt' },
      h('strong', null, `Auto-scaled for readiness ${Math.round(score)}`),
      h('ul', null, changes.map((c) => h('li', null, c)))) : locked ? h('p', { class: 'xs muted mt' }, workout.fixed ? 'Fixed session — run it as written, whatever the readiness score.' : 'Benchmark — do it fresh. If you feel off, move it to another day rather than scaling it.') : !Number.isFinite(score) ? h('p', { class: 'xs muted mt' }, 'Check in above and FORGE scales this session to how you feel.') : null,
    h('div', { class: 'session-cta' },
      resumeBtn || h('button', { type: 'button', class: 'btn primary xl block start-btn', on: { click: () => startWorkout(w.id, changes.length > 0 && !locked) } }, h('span', null, 'Start session'), h('span', { class: 'k' }, `~${w.estMin || 45} min →`)),
      h('a', { class: 'link-btn', href: `#/session/${encodeURIComponent(w.id)}` }, 'Session details →')));
}

function ringsRow(s, today) {
  const units = s.profile.units;
  const wfd = s.plan ? safe(() => program.workoutForDate(s.plan, today), null) : null;
  const isTraining = !!wfd?.workout;
  const t = safe(() => nutrition.dayTargetsFor(s, today), null) || s.targets;
  const tot = sel.totalsFor(s, today);
  const water = sel.waterFor(s, today);
  const done = sel.sessionsOn(s, today).length > 0;
  const items = [
    { k: 'Train', value: done ? 1 : 0, max: 1, main: done ? '✓' : isTraining ? (s.activeWorkout ? 'Live' : '0') : '—', unit: done || !isTraining || s.activeWorkout ? '' : '/1', sub: done ? 'done' : isTraining ? 'to do' : 'rest day', href: '#/train', n: 9 },
    { k: 'Kcal', value: tot.kcal, max: t.kcal, main: num(tot.kcal), unit: '', sub: `of ${num(t.kcal)}`, href: '#/fuel' },
    { k: 'Protein', color: 'var(--protein)', value: tot.p, max: t.protein, main: num(tot.p), unit: 'g', sub: `of ${num(t.protein)} g`, href: '#/fuel' },
    { k: 'Carbs', color: 'var(--carbs)', value: tot.c, max: t.carbs, main: num(tot.c), unit: 'g', sub: `of ${num(t.carbs)} g`, href: '#/fuel' },
    { k: 'Water', color: 'var(--water)', value: water, max: t.waterMl, main: units === 'metric' ? num(water / 1000, 1) : num(water / 29.5735, 0), unit: units === 'metric' ? 'L' : 'oz',
      sub: units === 'metric' ? `of ${num(t.waterMl / 1000, 1)} L` : `of ${num(t.waterMl / 29.5735, 0)} oz`, href: '#/fuel' },
  ];
  return h('section', { class: 'daily', 'aria-label': 'Today’s numbers' },
    items.map((it) => h('a', { class: 'daily-cell', href: it.href, 'aria-label': `${it.k}: ${it.main} ${it.unit} ${it.sub}` },
      h('span', { class: 'lbl' }, it.k),
      fig(it.main, it.unit),
      ticks({ value: it.value, max: it.max || 1, n: 9, color: it.color }),
      h('span', { class: 'data' }, it.sub))));
}

function quickActions(units) {
  const qa = (label, on, cls = '', plus = false) => h('button', { type: 'button', class: 'qa ' + cls, on: { click: on } }, plus ? h('b', { 'aria-hidden': 'true' }, '+') : null, label);
  return h('section', { class: 'qa-row', 'aria-label': 'Quick actions' },
    qa('Food', () => navigate('#/fuel?add=auto'), 'qa-food', true),
    qa(units === 'metric' ? '250 ml' : '8 oz', () => addWater(units === 'metric' ? 250 : 237), 'qa-water', true),
    qa('Weigh-in', () => openWeightSheet(), 'qa-weight'),
    qa('Timer', () => navigate('#/timer'), 'qa-timer'));
}

function weekStrip(s, today) {
  const wk = sel.dayPlan(s, today)?.week;
  let days;
  if (wk) days = wk.days;
  else {
    const mon = weekStart(today);
    days = Array.from({ length: 7 }, (_, i) => ({ date: addDays(mon, i), workoutId: null, rest: true }));
  }
  const sessionDates = new Set(s.sessions.map((x) => x.date));
  let planned = 0, doneCount = 0;
  const cells = days.map((d) => {
    const done = sessionDates.has(d.date);
    const w = d.workoutId ? safe(() => program.getWorkout(s.plan, d.workoutId), null) : null;
    if (d.workoutId && !d.rest) planned++;
    if (done) doneCount++;
    const status = done ? 'done' : d.date === today ? 'today' : d.rest || !d.workoutId ? 'rest' : d.date < today ? 'missed' : 'planned';
    const tm = TYPE_META[w?.type] || null;
    const label = fmtDate(d.date, { weekday: 'narrow' });
    return h(d.workoutId ? 'a' : 'div', {
      class: `wc ${status}` + (d.date === today ? ' is-today' : ''), href: d.workoutId ? `#/session/${encodeURIComponent(d.workoutId)}` : null,
      'aria-label': `${fmtDate(d.date)}: ${w?.title || 'Rest'} — ${status}`, title: w?.title || 'Rest day',
    },
    h('span', { class: 'sq', 'aria-hidden': 'true' }, tm ? tm.short : status === 'rest' ? '' : '·'),
    h('span', { class: 'lbl' + (d.date === today ? ' ink' : '') }, label));
  });
  const st = safe(() => coach.streak(s.sessions, s.plan, today), null) || {};
  const sd = st.days || 0;
  return h('section', { class: 'week-card', 'aria-label': 'This week' },
    sectionHead('This week', h('span', { class: 'lbl' }, `${doneCount}/${planned || '–'} done${sd ? ` · ${sd}-day streak` : ''}`), 3),
    h('div', { class: 'weekcells' }, cells),
    h('p', { class: 'data wk-legend' }, 'STR strength · KB conditioning · RUN run · HYB hybrid · HRX race-specific · REC recovery'));
}

function upNext(s, today) {
  if (!s.plan) return null;
  const out = [];
  for (const w of s.plan.weeks) for (const d of w.days) {
    if (d.date > today && d.workoutId && !d.rest && out.length < 2) out.push({ d, w });
  }
  if (!out.length) return null;
  return h('section', null,
    sectionHead('Up next', h('a', { class: 'link-btn', href: '#/train' }, 'Full plan'), 4),
    h('div', { class: 'list' },
      out.map(({ d }) => {
        const wo = safe(() => program.getWorkout(s.plan, d.workoutId), null);
        const tm = TYPE_META[wo?.type] || TYPE_META.strength;
        const inDays = daysBetween(today, d.date);
        return h('a', { class: 'li', href: `#/session/${encodeURIComponent(d.workoutId)}` },
          h('span', { class: `badge t-${wo?.type || 'strength'}` }, tm.short),
          h('span', { class: 'li-main' }, h('div', { class: 'li-title' }, wo?.title || 'Session'),
            h('div', { class: 'li-sub' }, `${inDays === 1 ? 'Tomorrow' : fmtDate(d.date)} · ${tm.label} · ~${wo?.estMin || 45} min`)),
          icon('chevR', 18));
      })));
}

/** Gentle nudge when there's no backup for 7+ days and cloud sync is off. Filled async. */
function backupNudge(s) {
  const host = h('div', { class: 'nudge-host' });
  const DAY = 86400000;
  const last = Date.parse(s.settings.lastBackupAt || s.createdAt || '') || Date.now();
  const snoozed = Date.parse(s.settings.backupNudgeUntil || '') > Date.now();
  if (snoozed || Date.now() - last < 7 * DAY) return host;
  import('../sync.js').then((sy) => safe(() => sy.syncStatus(), null)).catch(() => null).then((st) => {
    if (st?.enabled) return;
    const days = Math.floor((Date.now() - last) / DAY);
    host.append(h('section', { class: 'nudge', 'aria-label': 'Backup reminder' },
      h('div', { class: 'row gap top' },
        h('div', { class: 'grow' },
          h('div', { class: 'li-title' }, 'Back up your training'),
          h('p', { class: 'small muted' }, `${s.settings.lastBackupAt ? `Last backup ${days} days ago.` : 'No backup yet.'} Your data lives only on this device — turn on encrypted backup so a lost phone doesn’t mean lost progress.`),
          h('div', { class: 'row gap mt' },
            h('a', { class: 'btn sm primary', href: '#/me?section=backup' }, 'Set up backup'),
            h('button', { type: 'button', class: 'btn sm ghost', on: { click: () => store.update((x) => { x.settings.backupNudgeUntil = new Date(Date.now() + 3 * DAY).toISOString(); }) } }, 'Later'))))));
  });
  return host;
}

function tipCard(today) {
  return h('section', { class: 'tip-card', 'aria-label': 'Coach tip of the day' },
    sectionHead('Coach’s note', null, 5),
    h('p', { class: 'tip-text' }, tipForDate(today)));
}

export function render(root) {
  const ui = { editing: false, open: false, picks: null };
  const paint = () => {
    const s = store.get();
    const today = todayISO();
    const y = window.scrollY;
    const wfdNow = s.plan ? safe(() => program.workoutForDate(s.plan, today), null) : null;
    const nowW = wfdNow?.workout ? scaledFor(s, today, wfdNow.workout).workout : null;
    clear(root).append(h('div', { class: 'today' },
      headerBlock(s, today),
      readinessCard(s, today, ui, paint),
      sectionHead('Session', h('span', { class: 'lbl' }, nowW ? `~${nowW.estMin || 45} min` : 'Today'), 1),
      sessionCard(s, today),
      fuelNote(s, today),
      sectionHead('Daily', h('span', { class: 'lbl' }, wfdNow?.workout ? 'Training day' : 'Rest day'), 2),
      ringsRow(s, today),
      quickActions(s.profile.units),
      weekStrip(s, today),
      upNext(s, today),
      backupNudge(s),
      tipCard(today)));
    window.scrollTo(0, y);
  };
  paint();
  const unsub = store.subscribe(() => paint());
  // roll over at midnight
  const tick = setInterval(() => { if (root.dataset.day !== todayISO()) { root.dataset.day = todayISO(); paint(); } }, 60000);
  root.dataset.day = todayISO();
  return () => { unsub(); clearInterval(tick); };
}
