// FORGE — Train (#/train, #/train/week/<n>): plan week view, phase timeline, more sessions, quick logging.
import { store, todayISO, uid, daysBetween } from '../store.js';
import {
  h, icon, toast, sheet, fmtDist, fmtDur, fmtDate, navigate, field, emptyState, clear, num, parseDur, seg, M_PER_MI,
} from '../ui.js';
import { generatePlan, TEMPLATES } from '../engine/program.js';
import { weekSummary } from '../engine/coach.js';
import {
  typeBadge, typeMeta, phaseLabel, phasePill, blockSummary, safeGetWorkout, saveSession, rpePicker, once, startWorkout, wouldScale,
} from './session.js';

function sortedDays(week) { return [...(week?.days || [])].sort((a, b) => String(a.date).localeCompare(String(b.date))); }

export function currentWeekIndex(plan, iso) {
  const ws = plan?.weeks || [];
  for (let i = 0; i < ws.length; i++) {
    const ds = sortedDays(ws[i]);
    if (ds.length && iso >= ds[0].date && iso <= ds.at(-1).date) return i;
  }
  const first = sortedDays(ws[0])[0];
  if (first && iso < first.date) return 0;
  return Math.max(0, ws.length - 1);
}

export function dayStatus(day, s, today) {
  const logged = s.sessions.find((x) => (day.workoutId && x.workoutId === day.workoutId) || x.date === day.date);
  if (logged) return { state: 'done', session: logged };
  if (day.rest || !day.workoutId) return { state: 'rest' };
  if (day.date < today) return { state: 'missed' };
  if (day.date === today) return { state: 'today' };
  return { state: 'planned' };
}

const ui = { selDate: null };

export function render(root, { args }) {
  const draw = () => {
    const s = store.get();
    clear(root);
    if (!s.plan || !(s.plan.weeks || []).length) { renderNoPlan(root, s); return; }
    renderPlan(root, s, args);
  };
  draw();
  const unsub = store.subscribe(draw);
  return () => unsub();
}

function header(s, extra) {
  return h('div', { class: 'page-head' },
    h('div', null, h('div', { class: 'eyebrow' }, s.profile.name ? `Let's work, ${s.profile.name}` : 'Training plan'), h('h1', null, 'Train')),
    extra || null);
}

function renderNoPlan(root, s) {
  root.append(header(s));
  if (s.activeWorkout) root.append(activeBanner(s));
  root.append(h('div', { class: 'card hero stack' },
    h('div', { class: 'row gap' }, h('span', { class: 'tr-tbadge t-hyrox', style: { width: '48px', height: '48px' } }, icon('calendar', 24)),
      h('div', { class: 'grow' }, h('h2', null, 'No training plan yet'), h('p', { class: 'small muted' }, 'Build a periodised Base → Build → Peak → Taper plan around your bells, cardio kit and race date.'))),
    h('button', {
      class: 'btn primary xl block', on: {
        click: (ev) => {
          ev.currentTarget.disabled = true;
          try {
            const plan = generatePlan(store.get().profile, todayISO());
            store.update((d) => { d.plan = plan; });
            toast(`Plan ready — ${plan.weeks.length} weeks to race day`, { kind: 'go' });
          } catch (e) {
            console.error(e);
            ev.currentTarget.disabled = false;
            toast('Could not build a plan — check your profile in Me', { kind: 'danger' });
          }
        },
      },
    }, icon('zap', 20), 'Generate my plan')));
  root.append(quickActions(s), moreSessions(s));
}

function activeBanner(s) {
  const w = safeGetWorkout(s.plan, s.activeWorkout.workoutId);
  return h('a', { class: 'card tr-live', href: '#/workout/' + encodeURIComponent(s.activeWorkout.workoutId) },
    h('span', { class: 'tr-live-dot', 'aria-hidden': 'true' }),
    h('div', { class: 'grow' }, h('div', { class: 'eyebrow go' }, 'In progress'), h('div', { class: 'tr-live-t' }, w?.title || 'Workout')),
    h('span', { class: 'btn go sm' }, icon('play', 16), 'Resume'));
}

function renderPlan(root, s, args) {
  const plan = s.plan, today = todayISO();
  const weeks = plan.weeks;
  const cur = currentWeekIndex(plan, today);
  let wi = cur;
  if (args[0] === 'week' && Number.isFinite(+args[1])) wi = Math.max(0, Math.min(weeks.length - 1, Math.round(+args[1]) - 1));
  const week = weeks[wi];
  const days = sortedDays(week);
  const raceDate = plan.raceDate || s.profile.raceDate;
  const dtr = raceDate ? daysBetween(today, raceDate) : null;
  const curPhase = weeks[cur]?.phase;

  root.append(header(s, h('a', { class: 'icon-btn filled', href: '#/history?from=train', 'aria-label': 'Training history' }, icon('list', 20))));

  // status pills
  root.append(h('div', { class: 'row wrap tr-pills' },
    phasePill(curPhase),
    h('span', { class: 'pill' }, `Week ${cur + 1} of ${weeks.length}`),
    dtr == null ? null : h('a', { class: 'pill', href: '#/hyrox' }, icon('flag', 12), dtr > 0 ? `${dtr} day${dtr === 1 ? '' : 's'} to race` : dtr === 0 ? 'Race day!' : 'Race complete')));

  if (s.activeWorkout) root.append(activeBanner(s));

  root.append(phaseTimeline(plan, wi, cur, today));

  // week nav
  const first = days[0]?.date, last = days.at(-1)?.date;
  root.append(h('div', { class: 'tr-weeknav' },
    h('a', { class: 'icon-btn filled' + (wi === 0 ? ' disabled' : ''), href: wi > 0 ? `#/train/week/${wi}` : null, 'aria-label': 'Previous week', 'aria-disabled': wi === 0 ? 'true' : null }, icon('chevL')),
    h('div', { class: 'grow center' },
      h('div', { class: 'tr-wk-t' }, `Week ${wi + 1}`, h('span', { class: 'muted' }, ` · ${phaseLabel(week.phase)}`), week.deload ? h('span', { class: 'pill recovery tr-dl' }, 'Deload') : null),
      h('div', { class: 'xs muted' }, first ? `${fmtDate(first, { month: 'short', day: 'numeric' })} – ${fmtDate(last, { month: 'short', day: 'numeric' })}` : '',
        wi !== cur ? h('a', { class: 'tr-thisweek', href: `#/train/week/${cur + 1}` }, ' · This week') : null)),
    h('a', { class: 'icon-btn filled' + (wi >= weeks.length - 1 ? ' disabled' : ''), href: wi < weeks.length - 1 ? `#/train/week/${wi + 2}` : null, 'aria-label': 'Next week', 'aria-disabled': wi >= weeks.length - 1 ? 'true' : null }, icon('chevR'))));

  if (week.focus) root.append(h('p', { class: 'small dim tr-focus' }, h('b', null, 'Focus: '), week.focus));

  // strip
  const statuses = days.map((d) => dayStatus(d, s, today));
  const listEl = h('div', { class: 'stack tr-days' });
  const strip = h('div', { class: 'tr-strip', role: 'list', 'aria-label': 'Days this week' }, days.map((d, i) => {
    const st = statuses[i];
    const w = d.workoutId ? safeGetWorkout(plan, d.workoutId) : null;
    return h('button', {
      type: 'button', role: 'listitem', class: `tr-day s-${st.state}${d.date === today ? ' is-today' : ''}${ui.selDate === d.date ? ' sel' : ''}`,
      'aria-label': `${fmtDate(d.date)} — ${w ? w.title : 'Rest'} — ${st.state}`,
      on: {
        click: () => {
          ui.selDate = d.date;
          for (const b of strip.children) b.classList.toggle('sel', b === strip.children[i]);
          const card = listEl.querySelector(`[data-date="${d.date}"]`);
          if (card) {
            card.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
            card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash');
          }
        },
      },
    },
    h('span', { class: 'tr-dow' }, fmtDate(d.date, { weekday: 'short' }).slice(0, 3)),
    h('span', { class: 'tr-dnum num' }, String(+d.date.slice(8))),
    h('span', { class: `tr-mark t-${w?.type || 'rest'}`, 'aria-hidden': 'true' }, st.state === 'done' ? icon('check', 12) : st.state === 'missed' ? icon('x', 11) : null));
  }));
  root.append(strip);

  // summary
  const planned = days.filter((d) => d.workoutId && !d.rest);
  const doneCount = planned.filter((d) => s.sessions.some((x) => x.workoutId === d.workoutId || x.date === d.date)).length;
  let sum = null;
  try { sum = weekSummary(s.sessions, first); } catch {}
  root.append(h('div', { class: 'tr-wsum' },
    h('div', { class: 'tr-wsum-bar' }, h('div', { class: 'bar go thin' }, h('i', { style: { width: `${planned.length ? (100 * doneCount) / planned.length : 0}%` } }))),
    h('div', { class: 'row between xs muted num' },
      h('span', null, h('b', { class: 'dim' }, `${doneCount}/${planned.length}`), ' sessions done'),
      sum ? h('span', null, [sum.minutes ? `${Math.round(sum.minutes)} min` : null, (sum.runM || sum.cardioM) ? fmtDist((sum.runM || 0) + (sum.cardioM || 0), s.profile.units) : null, sum.kbVolumeKg ? `${num(sum.kbVolumeKg / 1000, 1)} t moved` : null].filter(Boolean).join(' · ')) : null)));

  // day list
  days.forEach((d, i) => listEl.append(dayCard(d, statuses[i], s, today)));
  root.append(listEl);

  root.append(quickActions(s), moreSessions(s));
}

function phaseTimeline(plan, wi, cur, today) {
  const weeks = plan.weeks;
  const groups = [];
  weeks.forEach((w, i) => { const g = groups.at(-1); if (g && g.phase === w.phase) g.n++; else groups.push({ phase: w.phase, n: 1, start: i }); });
  const firstDay = sortedDays(weeks[0])[0]?.date, lastDay = sortedDays(weeks.at(-1)).at(-1)?.date;
  let pos = null;
  if (firstDay && lastDay) {
    const total = daysBetween(firstDay, lastDay) + 1;
    const off = daysBetween(firstDay, today);
    if (off >= 0 && off < total) pos = ((off + 0.5) / total) * 100;
  }
  return h('div', { class: 'card tight tr-tl' },
    h('div', { class: 'tr-tl-labels' }, groups.map((g) => h('span', { class: `tr-tl-lab ph-${g.phase}`, style: { flex: String(g.n) } }, g.n >= 2 ? phaseLabel(g.phase) : phaseLabel(g.phase).slice(0, 1)))),
    h('div', { class: 'tr-tl-bar' },
      weeks.map((w, i) => h('a', {
        class: `tr-tl-seg ph-${w.phase}${i < cur ? ' past' : ''}${i === wi ? ' view' : ''}${w.deload ? ' deload' : ''}`,
        href: `#/train/week/${i + 1}`, 'aria-label': `Week ${i + 1}: ${phaseLabel(w.phase)}${w.deload ? ' (deload)' : ''}`,
      })),
      pos != null ? h('span', { class: 'tr-tl-now', style: { left: pos + '%' }, title: 'Today' }) : null),
    h('div', { class: 'row between xs muted tr-tl-foot' },
      h('span', null, firstDay ? fmtDate(firstDay, { month: 'short', day: 'numeric' }) : ''),
      h('span', null, plan.raceDate ? h('span', null, icon('flag', 11), ' ', fmtDate(plan.raceDate, { month: 'short', day: 'numeric' })) : lastDay ? fmtDate(lastDay, { month: 'short', day: 'numeric' }) : '')));
}

function dayCard(d, st, s, today) {
  const w = d.workoutId ? safeGetWorkout(s.plan, d.workoutId) : null;
  const when = d.date === today ? 'Today' : d.date === addDay(today, 1) ? 'Tomorrow' : fmtDate(d.date, { weekday: 'long' });
  const dateLbl = fmtDate(d.date, { month: 'short', day: 'numeric' });
  if (!w) {
    const logged = st.state === 'done' ? st.session : null;
    return h('div', { class: `tr-rest${d.date === today ? ' is-today' : ''}`, 'data-date': d.date },
      h('div', { class: 'tr-when' }, h('b', null, when), h('span', { class: 'muted' }, ' · ' + dateLbl)),
      logged ? h('a', { class: 'tr-rest-log', href: '#/history/' + logged.id }, icon('check', 14), `Logged: ${logged.title || 'session'}`) :
        h('span', { class: 'muted small' }, 'Rest & recover', recoveryLink()));
  }
  const meta = typeMeta(w.type);
  const done = st.state === 'done';
  return h('div', { class: `tr-dcard-wrap${d.date === today ? ' is-today' : ''}`, 'data-date': d.date },
    h('div', { class: 'tr-when' }, h('b', null, when), h('span', { class: 'muted' }, ' · ' + dateLbl),
      done ? h('span', { class: 'pill go' }, icon('check', 12), 'Done') : st.state === 'missed' ? h('span', { class: 'pill danger' }, 'Missed') : null),
    h('div', { class: `card tr-dcard s-${st.state}` },
      h('a', { class: 'tr-dcard-link', href: '#/session/' + encodeURIComponent(w.id) },
        h('div', { class: 'row gap top' }, typeBadge(w.type, 42),
          h('div', { class: 'grow' },
            h('div', { class: 'tr-dc-title' }, w.title),
            h('div', { class: 'xs muted tr-dc-meta' }, [meta.label, w.estMin ? `${w.estMin} min` : null].filter(Boolean).join(' · ')),
            blockSummary(w) ? h('div', { class: 'small dim tr-dc-blocks' }, blockSummary(w)) : null),
          done ? h('span', { class: 'tr-donecheck', 'aria-label': 'Completed' }, icon('check', 18)) : h('span', { class: 'muted' }, icon('chevR', 18)))),
      d.date === today && !done ? h('div', { class: 'row gap tr-dc-actions' },
        h('button', { type: 'button', class: 'btn primary sm grow', on: { click: () => startWorkout(w.id, wouldScale(w)) } }, icon('play', 16), s.activeWorkout?.workoutId === w.id ? 'Resume' : 'Start'),
        h('a', { class: 'btn ghost sm', href: '#/session/' + encodeURIComponent(w.id) }, 'Details')) : null));
}

function recoveryLink() {
  const rec = (Array.isArray(TEMPLATES) ? TEMPLATES : []).find((t) => t.type === 'recovery');
  return rec ? h('a', { class: 'tr-reclink', href: '#/session/' + encodeURIComponent(rec.id) }, ` · ${rec.title} →`) : null;
}

const addDay = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

function quickActions(s) {
  const tile = (ic, label, sub, onClick, href) => h(href ? 'a' : 'button', { class: 'tr-qa', href: href || null, type: href ? null : 'button', on: onClick ? { click: onClick } : null },
    h('span', { class: 'tr-qa-ic' }, icon(ic, 20)), h('span', { class: 'tr-qa-l' }, label), h('span', { class: 'tr-qa-s' }, sub));
  return h('div', null,
    h('div', { class: 'section-head' }, h('h2', null, 'Quick actions')),
    h('div', { class: 'tr-qagrid' },
      tile('timer', 'Timers', 'Interval timers', null, '#/timer'),
      tile('book', 'Library', 'Technique & cues', null, '#/library'),
      tile('flag', 'HYROX', 'Stations & pacing', null, '#/hyrox'),
      tile('run', 'Log cardio', 'Run, row, ski, bike', () => logCardioSheet()),
      tile('edit', 'Log workout', 'Something you did', () => logPastSheet()),
      tile('list', 'History', `${s.sessions.length} logged`, null, '#/history?from=train')));
}

const TEMPLATE_GROUPS = [
  ['Benchmarks & tests', (t) => /bench|test|time.?trial|\btt\b/i.test(t.id + ' ' + t.title)],
  ['HYROX simulations', (t) => t.type === 'hyrox' || t.type === 'hybrid' || /sim/i.test(t.id)],
  ['Recovery', (t) => t.type === 'recovery'],
  ['Kettlebell & finishers', () => true],
];

function moreSessions() {
  const temps = Array.isArray(TEMPLATES) ? TEMPLATES : [];
  const free = temps.find((t) => /free/i.test(t.id));
  const rest = temps.filter((t) => t !== free);
  const groups = TEMPLATE_GROUPS.map(([label]) => ({ label, items: [] }));
  for (const t of rest) { const gi = TEMPLATE_GROUPS.findIndex(([, f]) => f(t)); groups[gi].items.push(t); }
  const row = (t) => h('a', { class: 'li', href: '#/session/' + encodeURIComponent(t.id) },
    typeBadge(t.type, 36),
    h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, t.title), h('div', { class: 'li-sub' }, [t.estMin ? `${t.estMin} min` : null, t.summary || blockSummary(t)].filter(Boolean).join(' · '))),
    icon('chevR', 16));
  return h('div', null,
    h('div', { class: 'section-head' }, h('h2', null, 'More sessions')),
    h('a', { class: 'card clickable tr-free', href: free ? '#/session/' + encodeURIComponent(free.id) : '#/workout/free' },
      h('span', { class: 'tr-qa-ic' }, icon('plus', 22)),
      h('div', { class: 'grow' }, h('div', { class: 'tr-dc-title' }, free?.title || 'Free workout'), h('div', { class: 'xs muted' }, 'Blank session — log anything as you go')),
      icon('chevR', 18)),
    temps.length ? groups.filter((g) => g.items.length).map((g) => h('div', { class: 'mt' }, h('h4', { class: 'tr-gh' }, g.label), h('div', { class: 'card flush' }, h('div', { class: 'list' }, g.items.map(row)))))
      : h('div', { class: 'card mt' }, emptyState('list', 'No extra sessions', 'Benchmarks and finishers will appear here.')));
}

// ---------------------------------------------------------------- sheets
const MODES = [['run', 'Run'], ['row', 'Row'], ['ski', 'Ski'], ['bike', 'Bike'], ['walk', 'Walk']];

export function logCardioSheet(preset = {}) {
  const s = store.get(), units = s.profile.units, today = todayISO();
  let mode = preset.mode || 'run', rpe = 5;
  const dUnit = units === 'metric' ? 'km' : 'mi';
  const dist = h('input', { type: 'number', inputmode: 'decimal', min: '0', step: '0.01', placeholder: '0.00', 'aria-label': `Distance in ${dUnit}` });
  const time = h('input', { type: 'text', inputmode: 'numeric', placeholder: 'mm:ss or h:mm:ss', 'aria-label': 'Time', autocomplete: 'off' });
  const hr = h('input', { type: 'number', inputmode: 'numeric', min: '40', max: '230', placeholder: 'bpm', 'aria-label': 'Average heart rate' });
  const date = h('input', { type: 'date', value: preset.date || today, max: today });
  const notes = h('textarea', { rows: 2, placeholder: 'Route, how it felt… (optional)' });
  const paceOut = h('div', { class: 'tr-pace num', 'aria-live': 'polite' });
  const linkSlot = h('div');
  let linkCb = null;
  const updatePace = () => {
    const m = (+dist.value || 0) * (units === 'metric' ? 1000 : M_PER_MI), t = parseDur(time.value);
    paceOut.textContent = m > 0 && t > 0 ? `Pace ${fmtDur((t / m) * (units === 'metric' ? 1000 : M_PER_MI))} /${dUnit}${mode === 'row' || mode === 'ski' ? ` · ${fmtDur((t / m) * 500)} /500 m` : ''}` : '';
  };
  const updateLink = () => {
    clear(linkSlot); linkCb = null;
    const st = store.get();
    const day = st.plan?.weeks?.flatMap((w) => w.days || []).find((d) => d.date === date.value && d.workoutId);
    const w = day ? safeGetWorkout(st.plan, day.workoutId) : null;
    if (w && (w.type === 'run' || (w.blocks || []).some((b) => b.kind === 'cardio')) && !st.sessions.some((x) => x.workoutId === w.id)) {
      linkCb = h('input', { type: 'checkbox', checked: true });
      linkCb.dataset.wid = w.id; linkCb.dataset.title = w.title; linkCb.dataset.type = w.type;
      linkSlot.append(h('label', { class: 'switch tr-link' }, h('span', { class: 'small' }, 'Counts as planned ', h('b', null, w.title)), linkCb));
    }
  };
  dist.addEventListener('input', updatePace); time.addEventListener('input', updatePace);
  date.addEventListener('change', updateLink);
  updateLink();

  sheet({
    title: 'Log cardio',
    content: ({ close }) => h('div', { class: 'stack' },
      seg(MODES, mode, (v) => { mode = v; updatePace(); }, { label: 'Mode' }),
      h('div', { class: 'grid2' },
        field(`Distance (${dUnit})`, h('div', { class: 'input-unit' }, dist, h('span', null, dUnit))),
        field('Time', time)),
      paceOut,
      h('div', { class: 'grid2' }, field('Avg HR (optional)', h('div', { class: 'input-unit' }, hr, h('span', null, 'bpm'))), field('Date', date)),
      linkSlot,
      field('Effort (RPE)', rpePicker(rpe, (v) => (rpe = v))),
      field('Notes', notes),
      h('button', {
        class: 'btn primary block xl', on: {
          click: once(() => {
            const distanceM = Math.round((+dist.value || 0) * (units === 'metric' ? 1000 : M_PER_MI));
            const timeSec = parseDur(time.value);
            if (!(distanceM > 0) && !(timeSec > 0)) { toast('Add a distance or a time', { kind: 'danger' }); dist.focus(); return false; }
            if (time.value && !(timeSec > 0)) { toast('Time looks off — use mm:ss', { kind: 'danger' }); time.focus(); return false; }
            const avgHr = +hr.value > 0 ? Math.round(+hr.value) : null;
            const label = MODES.find((m) => m[0] === mode)[1];
            const linked = linkCb?.checked ? linkCb.dataset : null;
            const d = date.value || today;
            const sess = saveSession({
              id: uid('s'), date: d, workoutId: linked ? linked.wid : null,
              title: linked ? linked.title : `${label}${distanceM ? ' ' + fmtDist(distanceM, units) : ''}`,
              type: mode === 'run' ? 'run' : 'cardio',
              startedAt: new Date(d + 'T' + new Date().toTimeString().slice(0, 8)).toISOString(),
              durationSec: timeSec || 0, sets: [], cardio: [{ mode, distanceM: distanceM || 0, timeSec: timeSec || 0, avgHr }],
              rpe, notes: notes.value.trim(), readiness: null, prs: [],
            });
            close();
            toast(sess.prs?.length ? `PR · ${sess.prs[0]}` : `${label} logged ✓`, { kind: 'go', action: { label: 'View', fn: () => navigate('#/history/' + sess.id) } });
          }),
        },
      }, icon('check'), 'Save')),
  });
}

export function logPastSheet() {
  const s = store.get(), today = todayISO();
  let rpe = 6, freeType = 'strength';
  const plan = s.plan;
  const doneIds = new Set(s.sessions.map((x) => x.workoutId).filter(Boolean));
  const planDays = (plan?.weeks || []).flatMap((w) => w.days || []).filter((d) => d.workoutId && d.date <= today)
    .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 21);
  const temps = Array.isArray(TEMPLATES) ? TEMPLATES.filter((t) => !/free/i.test(t.id)) : [];
  const sel = h('select', { 'aria-label': 'Workout' },
    h('option', { value: '' }, 'Other — enter a title'),
    planDays.length ? h('optgroup', { label: 'From your plan' }, planDays.map((d) => {
      const w = safeGetWorkout(plan, d.workoutId);
      return w ? h('option', { value: 'p:' + d.workoutId + ':' + d.date }, `${fmtDate(d.date, { weekday: 'short', month: 'short', day: 'numeric' })} — ${w.title}${doneIds.has(w.id) ? ' ✓' : ''}`) : null;
    })) : null,
    temps.length ? h('optgroup', { label: 'More sessions' }, temps.map((t) => h('option', { value: 't:' + t.id }, t.title))) : null);
  const firstOpen = planDays.find((d) => !doneIds.has(d.workoutId));
  if (firstOpen) sel.value = 'p:' + firstOpen.workoutId + ':' + firstOpen.date;
  const title = h('input', { type: 'text', placeholder: 'e.g. Swing & press complex', maxlength: '80' });
  const date = h('input', { type: 'date', value: today, max: today });
  const mins = h('input', { type: 'number', inputmode: 'numeric', min: '1', max: '600', value: '45' });
  const notes = h('textarea', { rows: 2, placeholder: 'What did you do? (optional)' });
  const freeBox = h('div', { class: 'stack' }, field('Title', title), field('Type', seg([['strength', 'Strength'], ['conditioning', 'Condit.'], ['hybrid', 'Hybrid'], ['recovery', 'Recovery']], freeType, (v) => (freeType = v), { label: 'Type' })));
  const sync = () => {
    const v = sel.value;
    freeBox.hidden = !!v;
    if (v.startsWith('p:')) {
      const [, wid, d] = v.split(':');
      const w = safeGetWorkout(plan, wid);
      date.value = d; if (w?.estMin) mins.value = String(w.estMin);
    } else if (v.startsWith('t:')) {
      const w = safeGetWorkout(plan, v.slice(2));
      if (w?.estMin) mins.value = String(w.estMin);
    }
  };
  sel.addEventListener('change', sync);
  sync();
  sheet({
    title: 'Log a workout',
    content: ({ close }) => h('div', { class: 'stack' },
      field('Workout', sel),
      freeBox,
      h('div', { class: 'grid2' }, field('Date', date), field('Duration (min)', mins)),
      field('How hard was it?', rpePicker(rpe, (v) => (rpe = v))),
      field('Notes', notes),
      h('button', {
        class: 'btn primary block xl', on: {
          click: once(() => {
            const v = sel.value;
            let wid = null, w = null;
            if (v.startsWith('p:')) wid = v.split(':')[1];
            else if (v.startsWith('t:')) wid = v.slice(2);
            if (wid) w = safeGetWorkout(plan, wid);
            const t = w ? w.title : title.value.trim();
            if (!t) { toast('Give it a title', { kind: 'danger' }); title.focus(); return false; }
            const d = date.value || today;
            const sess = saveSession({
              id: uid('s'), date: d, workoutId: w ? w.id : null, title: t, type: w ? (w.type || 'strength') : freeType,
              startedAt: new Date(d + 'T12:00:00').toISOString(), durationSec: Math.max(1, Math.min(600, +mins.value || 30)) * 60,
              sets: [], cardio: [], rpe, notes: notes.value.trim(), readiness: null, prs: [], untracked: true,
            });
            close();
            toast('Workout logged ✓', { kind: 'go', action: { label: 'View', fn: () => navigate('#/history/' + sess.id) } });
          }),
        },
      }, icon('check'), 'Save workout')),
  });
}

