// FORGE Today — the hero screen (docs/PROMPT.md §3.2).
import { store, sel, todayISO, addDays, daysBetween } from '../store.js';
import { h, clear, icon, toast, sheet, navigate, haptic, num, fmtDur, fmtDate, fmtWeight, fmtBell,
  toDisplayWeight, fromDisplayWeight, stepper, sectionHead } from '../ui.js';
import { ring } from '../charts.js';
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
  if (score < 40) return { key: 'red', color: 'var(--danger)', title: 'Recover today', text: 'Low readiness — today becomes a recovery session. Mobility, easy movement, sleep early.' };
  if (score <= 60) return { key: 'amber', color: 'var(--warn)', title: 'Train smart', text: 'Moderate readiness — volume trimmed about 25 % and hard intervals swapped for Zone 2.' };
  return { key: 'green', color: 'var(--go)', title: 'Green light', text: 'Good to go — train as planned and own the session.' };
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
  return hr < 5 ? 'Late night' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
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
    const latest = st.bodyweight.at(-1);
    if (latest) st.profile.weightKg = latest.kg;
    if (st.targets.auto) {
      const t = safe(() => nutrition.computeTargets({ ...st.profile, weightKg: latest?.kg ?? kg }));
      if (t) st.targets = { ...st.targets, ...t, auto: true };
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
  toast(`+${ml} ml water · ${num(now / 1000, 2)} L today`, {
    action: { label: 'Undo', fn: () => store.update((st) => { st.water[today] = Math.max(0, (st.water[today] || 0) - ml); }) },
  });
}

// ---------- Cards ----------
function headerBlock(s, today) {
  const ph = phaseOf(s, today);
  const raceDate = s.profile.raceDate || s.plan?.raceDate;
  const days = raceDate ? daysBetween(today, raceDate) : null;
  const P = safe(() => program.PHASES, {}) || {};
  const name = (s.profile.name || '').trim();
  return h('header', { class: 'today-head' },
    h('div', { class: 'today-hello' },
      h('div', { class: 'eyebrow' }, fmtDate(today, { weekday: 'long', month: 'long', day: 'numeric' })),
      h('h1', null, greeting(), name ? ',' : '', name ? h('br') : null, name ? h('span', { class: 'accent' }, name) : null),
      ph ? h('div', { class: 'row wrap mt' },
        h('span', { class: `pill ${ph.phase}` }, P[ph.phase]?.label || ph.phase),
        h('span', { class: 'pill' }, ph.before ? 'Starts soon' : ph.after ? 'Plan complete' : `Week ${ph.weekNo} of ${ph.total}`),
        ph.deload ? h('span', { class: 'pill recovery' }, 'Deload') : null) : null),
    days != null && days >= 0 ? h('div', { class: 'countdown', role: 'img', 'aria-label': `${days} days to ${s.profile.raceDate ? 'race' : 'target date'}` },
      h('span', { class: 'countdown-n' }, String(days)),
      h('span', { class: 'countdown-k' }, days === 1 ? 'day to' : 'days to', h('br'), s.profile.raceDate ? 'HYROX' : 'target')) : null);
}

function readinessCard(s, today, ui, repaint) {
  const saved = s.readiness[today];
  const score = saved?.score;
  if (saved && Number.isFinite(score) && !ui.editing) {
    const band = readinessBand(score);
    return h('section', { class: `card readiness done ${band.key}`, 'aria-label': 'Readiness' },
      h('div', { class: 'row gap' },
        ring({ value: score, max: 100, size: 76, stroke: 8, color: band.color, label: String(Math.round(score)), sub: 'ready' }),
        h('div', { class: 'grow' },
          h('div', { class: 'eyebrow' }, 'Readiness'),
          h('div', { class: 'card-title', style: { color: band.color } }, band.title),
          h('p', { class: 'small dim' }, band.text)),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Edit readiness check-in', on: { click: () => { ui.editing = true; ui.picks = { ...saved }; repaint(); } } }, icon('edit', 18))));
  }
  const picks = ui.picks || (ui.picks = {});
  const complete = READINESS_Q.every((q) => picks[q.key]);
  const saveBtn = h('button', { type: 'button', class: 'btn primary block', disabled: !complete, on: { click: () => {
    const checkin = { sleep: picks.sleep, soreness: picks.soreness, energy: picks.energy, stress: picks.stress };
    const sc = safe(() => hyrox.readinessScore(checkin), null);
    const val = Number.isFinite(sc) ? Math.round(sc) : Math.round(((checkin.sleep + checkin.energy + (6 - checkin.soreness) + (6 - checkin.stress)) - 4) / 16 * 100);
    store.update((st) => { st.readiness[today] = { ...checkin, score: val }; });
    ui.editing = false; ui.picks = null;
    haptic(20);
  } } }, complete ? 'Save check-in' : `Answer ${READINESS_Q.filter((q) => !picks[q.key]).length} more`);
  return h('section', { class: 'card readiness', 'aria-label': 'Readiness check-in' },
    h('div', { class: 'row between' },
      h('div', null, h('div', { class: 'eyebrow' }, 'Morning check-in'), h('div', { class: 'card-title' }, 'How ready are you?')),
      ui.editing ? h('button', { type: 'button', class: 'link-btn', on: { click: () => { ui.editing = false; ui.picks = null; repaint(); } } }, 'Cancel') : h('span', { class: 'muted xs' }, '10 sec')),
    h('div', { class: 'rq-list' },
      READINESS_Q.map((q) => h('div', { class: 'rq' },
        h('div', { class: 'rq-head' }, h('span', { class: 'rq-label' }, q.label), h('span', { class: 'rq-ends' }, `1 ${q.lo} · 5 ${q.hi}`)),
        h('div', { class: 'rq-picks', role: 'radiogroup', 'aria-label': q.label },
          [1, 2, 3, 4, 5].map((n) => h('button', {
            type: 'button', role: 'radio', 'aria-checked': String(picks[q.key] === n), 'aria-label': `${q.label} ${n}${n === 1 ? ' ' + q.lo : n === 5 ? ' ' + q.hi : ''}`,
            class: 'rq-pick' + (picks[q.key] === n ? ' on' : ''),
            on: { click: () => { picks[q.key] = n; haptic(); repaint(); } },
          }, String(n))))))),
    saveBtn);
}

function blockKindLabel(k) {
  return { warmup: 'Warm-up', strength: 'Strength', emom: 'EMOM', amrap: 'AMRAP', intervals: 'Intervals', circuit: 'Circuit', cardio: 'Cardio', station: 'Station', cooldown: 'Cool-down' }[k] || k;
}

function sessionSummary(sess) {
  const vol = (sess.sets || []).reduce((a, x) => a + (+x.kg || 0) * (+x.reps || 0), 0);
  const dist = (sess.cardio || []).reduce((a, c) => a + (+c.distanceM || 0), 0) + (sess.sets || []).reduce((a, x) => a + (+x.distanceM || 0), 0);
  return { vol, dist, sets: (sess.sets || []).length };
}

function sessionCard(s, today) {
  const units = s.profile.units;
  const active = s.activeWorkout;
  const done = sel.sessionsOn(s, today);
  const wfd = s.plan ? safe(() => program.workoutForDate(s.plan, today), null) : null;
  const workout = wfd?.workout || null;

  if (!s.plan) {
    return h('section', { class: 'card hero session-card' },
      h('div', { class: 'eyebrow' }, 'No plan yet'), h('div', { class: 'card-title' }, 'Build your training plan'),
      h('p', { class: 'small dim mt' }, 'Your plan was cleared. Regenerate it from Me → Plan.'),
      h('a', { class: 'btn primary block mt', href: '#/me' }, 'Go to plan settings'));
  }

  const resumeBtn = active ? h('a', { class: 'btn go xl block', href: `#/workout/${encodeURIComponent(active.workoutId || 'free')}` }, icon('play', 20),
    `Resume ${safe(() => program.getWorkout(s.plan, active.workoutId)?.title, null) || 'workout'}`) : null;

  // Done state
  const doneSession = done.find((x) => workout && x.workoutId === workout.id) || done[0];
  if (doneSession) {
    const sm = sessionSummary(doneSession);
    return h('section', { class: 'card session-card done' },
      h('div', { class: 'row gap' },
        h('span', { class: 'done-badge', 'aria-hidden': 'true' }, icon('check', 26)),
        h('div', { class: 'grow' }, h('div', { class: 'eyebrow go' }, 'Session complete'), h('div', { class: 'card-title' }, doneSession.title || 'Workout'))),
      h('div', { class: 'grid3 mt' },
        h('div', { class: 'stat' }, h('span', { class: 'v' }, fmtDur(doneSession.durationSec || 0, { long: true })), h('span', { class: 'k' }, 'time')),
        sm.vol ? h('div', { class: 'stat' }, h('span', { class: 'v' }, num(Math.round(sm.vol)), h('small', null, 'kg')), h('span', { class: 'k' }, 'volume'))
          : h('div', { class: 'stat' }, h('span', { class: 'v' }, sm.dist ? (units === 'metric' ? num(sm.dist / 1000, 1) : num(sm.dist / 1609.344, 1)) : String(sm.sets), h('small', null, sm.dist ? (units === 'metric' ? 'km' : 'mi') : 'sets')), h('span', { class: 'k' }, sm.dist ? 'distance' : 'logged')),
        h('div', { class: 'stat' }, h('span', { class: 'v' }, doneSession.rpe ? String(doneSession.rpe) : '–'), h('span', { class: 'k' }, 'session RPE'))),
      doneSession.prs?.length ? h('div', { class: 'pr-strip mt' }, icon('trophy', 16), h('span', null, doneSession.prs.slice(0, 2).join(' · '))) : null,
      h('div', { class: 'row gap mt' },
        h('a', { class: 'btn ghost grow', href: `#/history/${encodeURIComponent(doneSession.id)}` }, 'View summary'),
        h('a', { class: 'btn subtle grow', href: '#/fuel?add=auto' }, icon('fuel', 18), 'Refuel')),
      resumeBtn ? h('div', { class: 'mt' }, resumeBtn) : null);
  }

  // Rest day
  if (!workout) {
    const rec = safe(() => (program.TEMPLATES || []).find((t) => t.type === 'recovery' || /mobility|recovery/.test(t.id)), null);
    return h('section', { class: 'card session-card rest' },
      h('div', { class: 'eyebrow' }, 'Rest day'),
      h('div', { class: 'card-title' }, 'Recover to adapt'),
      h('p', { class: 'small dim' }, 'Fitness is built between sessions. Keep moving gently and eat your protein.'),
      h('div', { class: 'list rest-list mt' },
        rec ? h('a', { class: 'li', href: `#/session/${encodeURIComponent(rec.id)}` },
          h('span', { class: 'badge recov' }, icon('heart', 18)),
          h('span', { class: 'li-main' }, h('div', { class: 'li-title' }, rec.title || 'Mobility flow'), h('div', { class: 'li-sub' }, `${rec.estMin || 15} min · hips, T-spine, shoulders`)),
          icon('chevR', 18)) : null,
        h('div', { class: 'li' },
          h('span', { class: 'badge recov' }, icon('run', 18)),
          h('span', { class: 'li-main' }, h('div', { class: 'li-title' }, 'Easy walk'), h('div', { class: 'li-sub' }, '30–45 min outdoors, nasal breathing, Zone 1'))),
        h('a', { class: 'li', href: '#/train' },
          h('span', { class: 'badge' }, icon('calendar', 18)),
          h('span', { class: 'li-main' }, h('div', { class: 'li-title' }, 'Want to train anyway?'), h('div', { class: 'li-sub' }, 'Pick a session from Train')),
          icon('chevR', 18))),
      resumeBtn ? h('div', { class: 'mt' }, resumeBtn) : null);
  }

  // Planned session with readiness scaling preview
  const score = s.readiness[today]?.score;
  const scaled = Number.isFinite(score) ? safe(() => coach.scaleWorkout(workout, score), null) : null;
  const w = scaled?.workout || workout;
  const changes = scaled?.changes || [];
  const tm = TYPE_META[w.type] || TYPE_META.strength;
  const blocks = (w.blocks || []).filter((b) => b.kind !== 'warmup' && b.kind !== 'cooldown');
  return h('section', { class: `card hero session-card type-${w.type || 'strength'}` },
    h('div', { class: 'row between' },
      h('div', { class: 'row' }, h('span', { class: 'pill accent' }, icon(tm.icon, 13), tm.label), w.phase ? h('span', { class: `pill ${w.phase}` }, w.phase) : null),
      h('span', { class: 'muted small num' }, `~${w.estMin || 45} min`)),
    h('h2', { class: 'session-title' }, w.title || 'Today’s session'),
    w.summary ? h('p', { class: 'small dim' }, w.summary) : null,
    blocks.length ? h('ol', { class: 'block-peek' },
      blocks.slice(0, 4).map((b) => h('li', null, h('span', { class: 'bk' }, blockKindLabel(b.kind)), h('span', { class: 'bt' }, b.title || '')))) : null,
    (w.equipment || []).length ? h('div', { class: 'chips mt' }, w.equipment.slice(0, 5).map((e) => h('span', { class: 'chip sm' }, e))) : null,
    changes.length ? h('div', { class: 'callout scaled mt' },
      h('div', { class: 'row' }, icon('zap', 16), h('strong', null, `Auto-scaled for readiness ${Math.round(score)}`)),
      h('ul', null, changes.map((c) => h('li', null, c)))) : !Number.isFinite(score) ? h('p', { class: 'xs muted mt' }, 'Do your check-in above and FORGE will scale this session to how you feel.') : null,
    h('div', { class: 'stack sm mt' },
      resumeBtn || h('a', { class: 'btn primary xl block start-btn', href: `#/workout/${encodeURIComponent(w.id)}` }, icon('play', 20), 'Start session'),
      h('a', { class: 'link-btn center', href: `#/session/${encodeURIComponent(w.id)}` }, 'Session details')));
}

function ringsRow(s, today) {
  const units = s.profile.units;
  const wfd = s.plan ? safe(() => program.workoutForDate(s.plan, today), null) : null;
  const isTraining = !!wfd?.workout;
  const t = safe(() => nutrition.dayTargets(s.targets, isTraining), null) || s.targets;
  const tot = sel.totalsFor(s, today);
  const water = sel.waterFor(s, today);
  const done = sel.sessionsOn(s, today).length > 0;
  const trainingVal = done ? 1 : s.activeWorkout ? 0.5 : 0;
  const items = [
    { k: 'Training', icon: isTraining || done ? 'bell' : 'heart', color: 'var(--go)', value: isTraining || done ? trainingVal : 1, max: 1,
      main: done ? 'Done' : isTraining ? (s.activeWorkout ? 'Live' : 'To do') : 'Rest', sub: done ? 'session ✓' : isTraining ? '1 session' : 'recover', href: '#/train' },
    { k: 'Calories', icon: 'flame', color: 'var(--accent)', value: tot.kcal, max: t.kcal, main: num(tot.kcal), sub: `/ ${num(t.kcal)}`, href: '#/fuel' },
    { k: 'Protein', icon: 'zap', color: 'var(--protein)', value: tot.p, max: t.protein, main: num(tot.p), sub: `/ ${num(t.protein)} g`, href: '#/fuel' },
    { k: 'Water', icon: 'drop', color: 'var(--water)', value: water, max: t.waterMl, main: units === 'metric' ? num(water / 1000, 1) : num(water / 29.5735, 0),
      sub: units === 'metric' ? `/ ${num(t.waterMl / 1000, 1)} L` : `/ ${num(t.waterMl / 29.5735, 0)} oz`, href: '#/fuel' },
  ];
  return h('section', { class: 'card rings-card', 'aria-label': 'Daily rings' },
    h('div', { class: 'rings-row' },
      items.map((it) => h('a', { class: 'ring-item', href: it.href, 'aria-label': `${it.k}: ${it.main} ${it.sub}` },
        h('div', { class: 'ring-ico' }, ring({ value: it.value, max: it.max || 1, size: 66, stroke: 7, color: it.color }), h('span', { class: 'ring-glyph', style: { color: it.color } }, icon(it.icon, 20))),
        h('div', { class: 'ring-v num' }, it.main),
        h('div', { class: 'ring-k' }, it.sub ? it.sub : it.k),
        h('div', { class: 'ring-name' }, it.k)))));
}

function quickActions() {
  const qa = (ic, label, on, cls = '') => h('button', { type: 'button', class: 'qa ' + cls, on: { click: on } }, h('span', { class: 'qa-ico' }, icon(ic, 22)), h('span', null, label));
  return h('section', { class: 'qa-row', 'aria-label': 'Quick actions' },
    qa('fuel', 'Log food', () => navigate('#/fuel?add=auto'), 'qa-food'),
    qa('drop', '+250 ml', () => addWater(250), 'qa-water'),
    qa('scale', 'Weight', () => openWeightSheet(), 'qa-weight'),
    qa('timer', 'Timer', () => navigate('#/timer'), 'qa-timer'));
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
      class: `wk-day ${status}` + (d.date === today ? ' is-today' : ''), href: d.workoutId ? `#/session/${encodeURIComponent(d.workoutId)}` : null,
      'aria-label': `${fmtDate(d.date)}: ${w?.title || 'Rest'} — ${status}`,
    },
    h('span', { class: 'wk-dow' }, label),
    h('span', { class: 'wk-dot' }, done ? icon('check', 14) : status === 'missed' ? icon('x', 12) : tm ? tm.short : '·'));
  });
  const st = safe(() => coach.streak(s.sessions, s.plan, today), null) || {};
  return h('section', { class: 'card week-card', 'aria-label': 'This week' },
    h('div', { class: 'row between' },
      h('div', null, h('div', { class: 'eyebrow' }, 'This week'),
        h('div', { class: 'week-count num' }, String(doneCount), h('small', null, ` / ${planned || '–'} sessions`))),
      h('div', { class: 'streak', 'aria-label': `Streak ${st.days || 0} days` },
        h('span', { class: 'streak-flame' + ((st.days || 0) > 0 ? ' lit' : '') }, icon('flame', 22)),
        h('div', null, h('div', { class: 'streak-n num' }, String(st.days || 0)), h('div', { class: 'xs muted' }, (st.days || 0) === 1 ? 'day streak' : 'day streak')),
        st.weeksOnPlan ? h('div', { class: 'streak-wk' }, h('div', { class: 'streak-n num' }, String(st.weeksOnPlan)), h('div', { class: 'xs muted' }, 'wks on plan')) : null)),
    h('div', { class: 'bar go thin mt', 'aria-hidden': 'true' }, h('i', { style: { width: `${planned ? Math.min(100, (doneCount / planned) * 100) : 0}%` } })),
    h('div', { class: 'wk-strip mt' }, cells));
}

function upNext(s, today) {
  if (!s.plan) return null;
  const out = [];
  for (const w of s.plan.weeks) for (const d of w.days) {
    if (d.date > today && d.workoutId && !d.rest && out.length < 2) out.push({ d, w });
  }
  if (!out.length) return null;
  return h('section', null,
    sectionHead('Up next', h('a', { class: 'link-btn', href: '#/train' }, 'Full plan')),
    h('div', { class: 'card flush' }, h('div', { class: 'list' },
      out.map(({ d }) => {
        const wo = safe(() => program.getWorkout(s.plan, d.workoutId), null);
        const tm = TYPE_META[wo?.type] || TYPE_META.strength;
        const inDays = daysBetween(today, d.date);
        return h('a', { class: 'li', href: `#/session/${encodeURIComponent(d.workoutId)}` },
          h('span', { class: `badge t-${wo?.type || 'strength'}` }, icon(tm.icon, 18)),
          h('span', { class: 'li-main' }, h('div', { class: 'li-title' }, wo?.title || 'Session'),
            h('div', { class: 'li-sub' }, `${inDays === 1 ? 'Tomorrow' : fmtDate(d.date)} · ${tm.label} · ~${wo?.estMin || 45} min`)),
          icon('chevR', 18));
      }))));
}

function tipCard(today) {
  return h('section', { class: 'card tip-card', 'aria-label': 'Coach tip of the day' },
    h('div', { class: 'row' }, h('span', { class: 'tip-ico' }, icon('book', 18)), h('div', { class: 'eyebrow' }, 'Coach tip')),
    h('p', { class: 'tip-text' }, tipForDate(today)));
}

export function render(root) {
  const ui = { editing: false, picks: null };
  const paint = () => {
    const s = store.get();
    const today = todayISO();
    const y = window.scrollY;
    clear(root).append(h('div', { class: 'today stack' },
      headerBlock(s, today),
      readinessCard(s, today, ui, paint),
      sessionCard(s, today),
      ringsRow(s, today),
      quickActions(),
      weekStrip(s, today),
      upNext(s, today),
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
