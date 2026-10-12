// FORGE Progress — trends, PRs, HYROX readiness and adherence (docs/PROMPT.md §3.5).
import { store, sel, todayISO, addDays, daysBetween } from '../store.js';
import { h, clear, icon, seg, num, fmtDur, fmtDate, fmtWeight, fmtBell, bellLb, fmtDist, fmtPace,
  toDisplayWeight, emptyState, sectionHead, M_PER_MI, KG_PER_LB } from '../ui.js';
import { lineChart, barChart, heatmap, gauge, ring } from '../charts.js';
import * as coach from '../engine/coach.js';
import * as hyrox from '../engine/hyrox.js';
import * as nutrition from '../engine/nutrition.js';
import { getExercise } from '../data/exercises.js';
import { openWeightSheet, weekStart } from './today.js';

const RANGES = { '4w': 28, '12w': 84, all: null };
const safe = (fn, fallback = null) => { try { return fn(); } catch (e) { console.warn('FORGE progress:', e); return fallback; } };
let rangeKey = '12w';
let metricKey = 'count';
let adhDays = 7;

// ---------- pure helpers ----------
export function ema(points, span = 7) {
  const a = 2 / (span + 1);
  let prev = null;
  return points.map((p) => { prev = prev == null ? p.y : prev + a * (p.y - prev); return { x: p.x, y: prev }; });
}

const signed = (v, d) => (v > 0 ? '+' : v < 0 ? '−' : '') + num(Math.abs(v), d);
const isRunMode = (m) => /run|jog|tread/i.test(m || 'run');

function localWeekSummary(sessions, start) {
  const end = addDays(start, 7);
  const out = { count: 0, minutes: 0, kbVolumeKg: 0, runM: 0, cardioM: 0 };
  for (const s of sessions) {
    if (!(s.date >= start && s.date < end)) continue;
    out.count++;
    out.minutes += (s.durationSec || 0) / 60;
    for (const x of s.sets || []) out.kbVolumeKg += (+x.kg || 0) * (+x.reps || 0);
    for (const c of s.cardio || []) { out.cardioM += +c.distanceM || 0; if (isRunMode(c.mode)) out.runM += +c.distanceM || 0; }
  }
  return out;
}

export function computePRs(sessions) {
  const heaviest = new Map(); // exId -> {kg, reps, date}
  let mostSwings = null, best1k = null, best5k = null;
  const considerRun = (dist, sec, date) => {
    if (!(dist > 0 && sec > 0)) return;
    if (dist >= 1000 && dist <= 1100) { const t = sec * (1000 / dist); if (!best1k || t < best1k.sec) best1k = { sec: t, date }; }
    if (dist >= 5000 && dist <= 5500) { const t = sec * (5000 / dist); if (!best5k || t < best5k.sec) best5k = { sec: t, date }; }
  };
  for (const s of sessions) {
    let swings = 0;
    for (const x of s.sets || []) {
      const kg = +x.kg || 0;
      if (kg > 0 && x.exId && (+x.reps || 0) > 0) {
        const cur = heaviest.get(x.exId);
        if (!cur || kg > cur.kg || (kg === cur.kg && x.reps > cur.reps)) heaviest.set(x.exId, { kg, reps: +x.reps, date: s.date });
      }
      if (/swing/i.test(x.exId || '')) swings += +x.reps || 0;
      if (/run/i.test(x.exId || '')) considerRun(+x.distanceM, +x.timeSec, s.date);
    }
    if (swings && (!mostSwings || swings > mostSwings.reps)) mostSwings = { reps: swings, date: s.date };
    for (const c of s.cardio || []) if (isRunMode(c.mode)) considerRun(+c.distanceM, +c.timeSec, s.date);
  }
  const lifts = [...heaviest.entries()].map(([exId, v]) => ({ exId, ...v })).sort((a, b) => b.kg - a.kg);
  return { lifts, mostSwings, best1k, best5k };
}

function xLabelsFor(startISO, days, n = 4) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const x = Math.round((days * i) / (n - 1));
    out.push({ x, label: fmtDate(addDays(startISO, x), { month: 'short', day: 'numeric' }) });
  }
  return out;
}

// ---------- sections ----------
function weightSection(s, today, startISO, days) {
  const units = s.profile.units;
  const all = [...s.bodyweight].sort((a, b) => a.date.localeCompare(b.date));
  const head = sectionHead('Body weight', h('button', { type: 'button', class: 'btn sm subtle', on: { click: openWeightSheet } }, icon('plus', 16), 'Log'));
  if (!all.length) {
    return h('section', null, head, h('div', { class: 'card' }, emptyState('scale', 'No weigh-ins yet', 'Log your weight a few mornings a week to see your true trend.',
      h('button', { type: 'button', class: 'btn ghost sm', on: { click: openWeightSheet } }, 'Log weight'))));
  }
  const toY = (kg) => toDisplayWeight(kg, units);
  const pts = all.map((b) => ({ x: daysBetween(startISO, b.date), y: toY(b.kg), date: b.date }));
  const smooth = ema(pts);
  const inRange = (p) => p.x >= 0 && p.x <= days;
  const raw = pts.filter(inRange), trend = smooth.filter(inRange);
  const goalKg = +s.profile.goalWeightKg || null;
  const latestTrend = smooth.at(-1).y;
  const firstInRange = trend[0]?.y ?? latestTrend;
  const delta = latestTrend - firstInRange;
  const span = Math.max(1, (trend.at(-1)?.x ?? 0) - (trend[0]?.x ?? 0));
  const perWeek = trend.length > 1 ? (delta / span) * 7 : null;
  const u = units === 'metric' ? 'kg' : 'lb';
  const chart = all.length < 3
    ? h('div', { class: 'chart-empty center' }, h('p', { class: 'small' }, `Log ${3 - all.length} more weigh-in${3 - all.length === 1 ? '' : 's'} to see your trend.`), h('p', { class: 'xs muted' }, 'Weigh in a few mornings a week, after the bathroom, before food.'))
    : raw.length
    ? lineChart({
      series: [{ points: raw, color: 'var(--muted)', width: 0.001, dots: true, dotOpacity: 0.55 }, { points: trend, color: 'var(--accent)', width: 2.6 }],
      xLabels: xLabelsFor(startISO, days), yFmt: (v) => num(v, 0), goal: goalKg ? toY(goalKg) : undefined, height: 170,
      ariaLabel: `Body weight trend, latest ${num(latestTrend, 1)} ${u}`,
    })
    : h('p', { class: 'muted small center chart-empty' }, 'No weigh-ins in this range.');
  return h('section', null, head,
    h('div', { class: 'card' },
      h('div', { class: 'grid3' },
        h('div', { class: 'stat' }, h('span', { class: 'v' }, num(latestTrend, 1), h('small', null, u)), h('span', { class: 'k' }, 'Trend weight')),
        h('div', { class: 'stat' }, h('span', { class: 'v ' + (delta < 0 ? 'go' : delta > 0 ? 'accent' : '') }, signed(delta, 1), h('small', null, u)), h('span', { class: 'k' }, 'This range')),
        h('div', { class: 'stat' }, h('span', { class: 'v' }, perWeek == null ? '–' : signed(perWeek, 2)), h('span', { class: 'k' }, `${u} / week`))),
      h('div', { class: 'chart-wrap mt' }, chart),
      h('div', { class: 'legend' },
        h('span', null, h('i', { class: 'lg-dot', style: { background: 'var(--muted)' } }), 'Daily'),
        h('span', null, h('i', { class: 'lg-line', style: { background: 'var(--accent)' } }), '7-day trend'),
        goalKg ? h('span', null, h('i', { class: 'lg-line dashed', style: { borderColor: 'var(--go)' } }), `Goal ${fmtWeight(goalKg, units, 1)}`) : h('a', { href: '#/me', class: 'muted' }, 'Set a goal weight in Me'))));
}

function trainingSection(s, today, startISO, days, repaint) {
  const units = s.profile.units;
  const nWeeks = Math.max(4, Math.min(26, Math.ceil(days / 7)));
  const thisMon = weekStart(today);
  const weeks = Array.from({ length: nWeeks }, (_, i) => addDays(thisMon, -7 * (nWeeks - 1 - i)));
  const summaries = weeks.map((w) => safe(() => coach.weekSummary(s.sessions, w), null) || localWeekSummary(s.sessions, w));
  const totals = summaries.reduce((a, x) => ({ count: a.count + (x.count || 0), minutes: a.minutes + (x.minutes || 0), kb: a.kb + (x.kbVolumeKg || 0), run: a.run + (x.runM || 0) }), { count: 0, minutes: 0, kb: 0, run: 0 });
  const head = sectionHead('Training', h('a', { class: 'link-btn', href: '#/history' }, 'History'));
  if (!s.sessions.length) {
    return h('section', null, head, h('div', { class: 'card' }, emptyState('bell', 'No sessions logged yet', 'Finish your first workout and your weekly volume, minutes and run distance show up here.',
      h('a', { class: 'btn ghost sm', href: '#/today' }, 'Go to today’s session'))));
  }
  const METRICS = {
    count: { label: 'Sessions', get: (x) => x.count || 0, fmt: (v) => num(v), color: 'var(--accent)' },
    minutes: { label: 'Minutes', get: (x) => Math.round(x.minutes || 0), fmt: (v) => num(v), color: 'var(--info)' },
    kb: { label: 'Volume', get: (x) => (units === 'metric' ? x.kbVolumeKg || 0 : (x.kbVolumeKg || 0) / KG_PER_LB) / 1000, fmt: (v) => num(v, v < 10 ? 1 : 0), color: 'var(--build)', unit: units === 'metric' ? 't' : 'k lb' },
    run: { label: 'Run', get: (x) => (x.runM || 0) / (units === 'metric' ? 1000 : M_PER_MI), fmt: (v) => num(v, v < 10 ? 1 : 0), color: 'var(--go)', unit: units === 'metric' ? 'km' : 'mi' },
  };
  const m = METRICS[metricKey] || METRICS.count;
  const every = nWeeks > 13 ? 4 : nWeeks > 6 ? 2 : 1;
  const bars = summaries.map((x, i) => ({
    label: (nWeeks - 1 - i) % every === 0 ? (i === nWeeks - 1 ? 'Now' : fmtDate(weeks[i], { month: 'numeric', day: 'numeric' })) : '',
    value: m.get(x), color: i === nWeeks - 1 ? 'var(--accent)' : 'var(--text-2)',
  }));
  const planned = s.profile.daysPerWeek;
  return h('section', null, head,
    h('div', { class: 'card' },
      h('div', { class: 'grid4 train-totals' },
        h('div', { class: 'stat' }, h('span', { class: 'v' }, num(totals.count)), h('span', { class: 'k' }, 'sessions')),
        h('div', { class: 'stat' }, h('span', { class: 'v' }, num(totals.minutes / 60, 1)), h('span', { class: 'k' }, 'hours')),
        h('div', { class: 'stat' }, h('span', { class: 'v' }, num(METRICS.kb.get({ kbVolumeKg: totals.kb }), 1)), h('span', { class: 'k' }, `${METRICS.kb.unit} moved`)),
        h('div', { class: 'stat' }, h('span', { class: 'v' }, num(METRICS.run.get({ runM: totals.run }), 1)), h('span', { class: 'k' }, `${METRICS.run.unit} run`))),
      h('div', { class: 'mt' }, seg(Object.entries(METRICS).map(([k, v]) => [k, v.label]), metricKey, (v) => { metricKey = v; repaint(); }, { label: 'Training metric' })),
      h('div', { class: 'chart-wrap mt' }, barChart({ bars, height: 150, yFmt: m.fmt, target: metricKey === 'count' ? planned : undefined, ariaLabel: `${m.label} per week` })),
      h('p', { class: 'xs muted' }, `${m.label}${m.unit ? ` (${m.unit})` : ''} per week, Monday start.${metricKey === 'count' ? ` Dashed line = plan (${planned}/wk).` : ''} Current week highlighted.`)));
}

function loadSection(s, today) {
  const tl = safe(() => coach.trainingLoad(s.sessions, today), null);
  if (!tl) return null;
  const ratio = Number.isFinite(tl.ratio) ? tl.ratio : 0;
  const desc = {
    low: ['Detraining zone', 'Your recent load is below your norm. Fine for a taper or deload — otherwise get the planned sessions in.'],
    optimal: ['Sweet spot', 'Acute load matches what you’re built for. This is where fitness grows with low injury risk.'],
    high: ['Pushing it', 'Load is climbing faster than your base. Prioritise sleep and keep easy days easy.'],
    spike: ['Spike — back off', 'A sharp jump in load raises injury risk. Swap the next hard day for Zone 2 or recovery.'],
  }[tl.chronic > 0 ? tl.status : 'none'] || ['Building data', 'Log a couple of weeks of training to see your acute:chronic ratio.'];
  const colors = { low: 'var(--info)', optimal: 'var(--go)', high: 'var(--warn)', spike: 'var(--danger)' };
  return h('div', { class: 'card load-card' },
    h('div', { class: 'eyebrow' }, 'Training load · ACWR'),
    h('div', { class: 'row gap load-row' },
      h('div', { class: 'gauge-wrap' }, gauge({ value: Math.min(2, ratio), max: 2, size: 168, label: s.sessions.length ? num(ratio, 2) : '–', sub: 'acute : chronic',
      })),
      h('div', { class: 'grow' },
        h('div', { class: 'card-title', style: { color: (tl.chronic > 0 && colors[tl.status]) || 'var(--text)' } }, desc[0]),
        h('p', { class: 'small dim' }, desc[1]),
        h('p', { class: 'xs muted mt' }, `7-day ${num(tl.acute)} · 28-day avg ${num(tl.chronic)}`))));
}

function prSection(s) {
  const units = s.profile.units;
  const pr = computePRs(s.sessions);
  const recent = s.sessions.filter((x) => x.prs?.length).slice(-5).reverse();
  const tiles = [];
  for (const l of pr.lifts.slice(0, 6)) {
    tiles.push(h('div', { class: 'pr-tile' },
      h('div', { class: 'pr-v' }, fmtBell(l.kg), h('small', null, ` × ${l.reps}`)),
      h('div', { class: 'pr-k' }, safe(() => getExercise(l.exId)?.name, null) || l.exId),
      h('div', { class: 'pr-d' }, `${bellLb(l.kg)} · ${fmtDate(l.date, { month: 'short', day: 'numeric' })}`)));
  }
  const special = [
    pr.mostSwings && ['Most swings', `${num(pr.mostSwings.reps)}`, 'in one session', pr.mostSwings.date],
    pr.best1k && ['Fastest 1 km', fmtDur(pr.best1k.sec), units === 'metric' ? '' : fmtPace(pr.best1k.sec, units), pr.best1k.date],
    pr.best5k && ['Fastest 5 km', fmtDur(pr.best5k.sec), fmtPace(pr.best5k.sec / 5, units), pr.best5k.date],
  ].filter(Boolean);
  for (const [k, v, sub, d] of special) {
    tiles.unshift(h('div', { class: 'pr-tile hot' }, h('div', { class: 'pr-v' }, v), h('div', { class: 'pr-k' }, k), h('div', { class: 'pr-d' }, [sub, fmtDate(d, { month: 'short', day: 'numeric' })].filter(Boolean).join(' · '))));
  }
  const head = sectionHead('Personal records');
  if (!tiles.length) {
    return h('section', null, head, h('div', { class: 'card' }, emptyState('trophy', 'No PRs yet', 'Heaviest bell per lift, most swings, fastest 1 km and 5 km — they land here automatically as you log.')));
  }
  return h('section', null, head,
    h('div', { class: 'pr-grid' }, tiles),
    recent.length ? h('div', { class: 'card tight mt' }, h('div', { class: 'eyebrow mb' }, 'Recent PRs'),
      h('ul', { class: 'pr-recent' }, recent.flatMap((x) => x.prs.map((p) => h('li', null, icon('trophy', 14), h('span', { class: 'grow' }, p), h('span', { class: 'xs muted' }, fmtDate(x.date, { month: 'short', day: 'numeric' }))))).slice(0, 8))) : null);
}

function hyroxSection(s, today) {
  const hr = safe(() => hyrox.hyroxReadiness(s, today), null);
  const pred = safe(() => hyrox.predictRace(s, today), null);
  if (!hr && !pred) return null;
  // predicted finish trend: recompute with sessions known at the end of each of the last 8 weeks
  const trend = [];
  if (s.sessions.length) {
    for (let i = 7; i >= 0; i--) {
      const end = addDays(today, -7 * i);
      const ss = s.sessions.filter((x) => x.date <= end);
      if (!ss.length) continue;
      const p = safe(() => hyrox.predictRace({ ...s, sessions: ss }, end), null);
      if (p?.totalSec) trend.push({ x: -7 * i, y: p.totalSec / 60 });
    }
  }
  const score = Math.round(hr?.score || 0);
  const color = score >= 75 ? 'var(--go)' : score >= 50 ? 'var(--build)' : 'var(--accent)';
  return h('section', null,
    sectionHead('HYROX', h('a', { class: 'link-btn', href: '#/hyrox' }, 'Race hub')),
    h('div', { class: 'card hero' },
      h('div', { class: 'row gap' },
        hr ? ring({ value: score, max: 100, size: 92, stroke: 9, color, label: String(score), sub: 'ready' }) : null,
        h('div', { class: 'grow' },
          h('div', { class: 'eyebrow' }, 'Predicted finish'),
          h('div', { class: 'pred-time num' }, pred?.totalSec ? fmtDur(pred.totalSec) : '–'),
          pred ? h('div', { class: 'row wrap' }, h('span', { class: 'pill ' + (pred.confidence === 'high' ? 'go' : pred.confidence === 'med' ? 'build' : '') }, `${pred.confidence || 'low'} confidence`),
            pred.runSec ? h('span', { class: 'xs muted' }, `Run ${fmtDur(pred.runSec)} · Stations ${fmtDur(pred.stationSec || 0)}`) : null) : null)),
      trend.length > 1 ? h('div', { class: 'chart-wrap mt' }, lineChart({
        series: [{ points: trend, color: 'var(--accent)', dots: true, area: true }], height: 110, yFmt: (v) => fmtDur(v * 60).replace(/:\d\d$/, ''),
        xLabels: [{ x: trend[0].x, label: `${-trend[0].x / 7}w ago` }, { x: 0, label: 'Now' }], ariaLabel: 'Predicted finish trend' }))
        : h('p', { class: 'xs muted mt' }, pred?.basis?.length ? `Based on: ${pred.basis.slice(0, 3).join(' · ')}` : 'Log benchmark runs and station work to sharpen your prediction and see the trend.'),
      (hr?.parts || []).length ? h('div', { class: 'hr-parts mt' },
        hr.parts.map((p) => h('div', { class: 'hr-part' },
          h('div', { class: 'row between small' }, h('span', null, p.label), h('span', { class: 'num muted' }, String(Math.round(p.score)))),
          h('div', { class: 'bar thin' }, h('i', { style: { width: `${Math.max(2, Math.min(100, p.score))}%`, background: p.score >= 70 ? 'var(--go)' : p.score >= 45 ? 'var(--build)' : 'var(--accent)' } })),
          p.tip ? h('div', { class: 'xs muted' }, p.tip) : null))) : null));
}

function adherenceSection(s, today, repaint) {
  const days = Array.from({ length: adhDays }, (_, i) => addDays(today, -i));
  let logged = 0, kcal = 0, prot = 0, tk = 0, tp = 0, inRange = 0;
  const trainingDates = new Set(s.sessions.map((x) => x.date));
  for (const d of days) {
    const list = s.foodLog[d];
    if (!list?.length) continue;
    logged++;
    const t = sel.totalsFor(s, d);
    const dt = safe(() => nutrition.dayTargets(s.targets, trainingDates.has(d)), null) || s.targets;
    kcal += t.kcal; prot += t.p; tk += dt.kcal; tp += dt.protein;
    if (Math.abs(t.kcal - dt.kcal) <= dt.kcal * 0.1) inRange++;
  }
  const head = sectionHead('Nutrition adherence', seg([[7, '7 days'], [30, '30 days']], adhDays, (v) => { adhDays = v; repaint(); }, { label: 'Adherence range' }));
  if (!logged) {
    return h('section', null, head, h('div', { class: 'card' }, emptyState('fuel', 'Nothing logged yet', `No food logged in the last ${adhDays} days. Log meals in Fuel to see how close you’re tracking to target.`,
      h('a', { class: 'btn ghost sm', href: '#/fuel?add=auto' }, 'Log food'))));
  }
  const avgK = kcal / logged, avgP = prot / logged, tgK = tk / logged, tgP = tp / logged;
  const row = (label, v, t, unit, color) => {
    const pct = t ? (v / t) * 100 : 0;
    return h('div', { class: 'adh-row' },
      h('div', { class: 'row between' }, h('span', { class: 'small' }, label), h('span', { class: 'num small' }, h('strong', null, num(v)), ` / ${num(t)} ${unit}`, h('span', { class: 'muted' }, ` · ${num(pct)}%`))),
      h('div', { class: 'bar' }, h('i', { style: { width: `${Math.min(100, pct)}%`, background: 'var(--text-2)' } })));
  };
  return h('section', null, head,
    h('div', { class: 'card stack' },
      h('div', { class: 'grid3' },
        h('div', { class: 'stat' }, h('span', { class: 'v' }, `${logged}`, h('small', null, `/${adhDays}`)), h('span', { class: 'k' }, 'days logged')),
        h('div', { class: 'stat' }, h('span', { class: 'v' }, num(inRange)), h('span', { class: 'k' }, 'within ±10 % kcal')),
        h('div', { class: 'stat' }, h('span', { class: 'v' }, num(avgP / Math.max(1, sel.latestWeight(s)), 1), h('small', null, 'g/kg')), h('span', { class: 'k' }, 'protein'))),
      row('Avg calories', avgK, tgK, 'kcal', 'var(--accent)'),
      row('Avg protein', avgP, tgP, 'g', 'var(--protein)'),
      h('p', { class: 'xs muted' }, 'Averages over days with food logged.')));
}

function heatmapSection(s) {
  const byDate = new Map();
  for (const x of s.sessions) byDate.set(x.date, (byDate.get(x.date) || 0) + Math.max(20, (x.durationSec || 0) / 60));
  const head = sectionHead('Activity', h('a', { class: 'link-btn', href: '#/history' }, 'All sessions'));
  const activeDays = byDate.size;
  return h('section', null, head,
    h('div', { class: 'card' },
      h('div', { class: 'heat-wrap' }, heatmap({ days: [...byDate].map(([date, min]) => ({ date, value: Math.min(1, min / 75) })), weeks: 18, cell: 13, gap: 3 })),
      h('div', { class: 'row between mt' },
        h('span', { class: 'xs muted' }, activeDays ? `${activeDays} active day${activeDays === 1 ? '' : 's'} logged` : 'Every session you finish lights up a square.'),
        h('span', { class: 'heat-scale xs muted' }, 'Less', h('i', { style: { opacity: 0.25 } }), h('i', { style: { opacity: 0.55 } }), h('i', null), 'More'))));
}

export function render(root) {
  const paint = () => {
    const s = store.get();
    const today = todayISO();
    const firstData = [s.bodyweight.map((b) => b.date), s.sessions.map((x) => x.date)].flat().sort()[0] || today;
    const days = RANGES[rangeKey] ?? Math.max(28, daysBetween(firstData, today));
    const startISO = addDays(today, -days);
    const y = window.scrollY;
    clear(root).append(h('div', { class: 'progress stack' },
      h('header', { class: 'page-head' }, h('h1', null, 'Progress'),
        h('div', { class: 'range-seg' }, seg([['4w', '4W'], ['12w', '12W'], ['all', 'All']], rangeKey, (v) => { rangeKey = v; paint(); }, { label: 'Range' }))),
      weightSection(s, today, startISO, days),
      trainingSection(s, today, startISO, days, paint),
      loadSection(s, today),
      prSection(s),
      hyroxSection(s, today),
      adherenceSection(s, today, paint),
      heatmapSection(s),
      h('a', { class: 'btn ghost block mt-lg', href: '#/history' }, icon('list', 18), 'Workout history')));
    window.scrollTo(0, y);
  };
  paint();
  return store.subscribe(() => paint());
}
