// FORGE — Exercise library (#/library, #/library/<exId>) + exerciseSheet() used across Train views.
import { store } from '../store.js';
import { h, icon, sheet, fmtBell, bellLb, fmtWeight, fmtDist, fmtDur, fmtDate, navigate, emptyState, clear, num } from '../ui.js';
import { lineChart } from '../charts.js';
import { EXERCISES, getExercise } from '../data/exercises.js';
import { suggestWeight, lastPerformance, setVolumeKg } from '../engine/coach.js';
import { STATIONS } from '../engine/hyrox.js';

// numbered section rules (DESIGN §5.2) — counter reset at the start of each page draw
let IX = 0;
const ix = () => h('span', { class: 'ix', 'aria-hidden': 'true' }, String(++IX).padStart(2, '0'));


export const CATS = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'kb', label: 'Kettlebell', match: (e) => e.category === 'kb' },
  { id: 'cardio', label: 'Run & Erg', match: (e) => e.category === 'run' || e.category === 'erg' },
  { id: 'bodyweight', label: 'Bodyweight', match: (e) => e.category === 'bodyweight' },
  { id: 'hyrox', label: 'HYROX', match: (e) => e.category === 'hyrox' || !!e.hyrox },
  { id: 'mobility', label: 'Mobility', match: (e) => e.category === 'mobility' },
];
const CAT_ICON = { kb: 'bell', run: 'run', erg: 'zap', bodyweight: 'user', hyrox: 'flag', mobility: 'heart' };
const CAT_LABEL = { kb: 'Kettlebell', run: 'Run', erg: 'Erg', bodyweight: 'Bodyweight', hyrox: 'HYROX', mobility: 'Mobility' };
const PATTERNS = ['hinge', 'squat', 'press', 'pull', 'carry', 'lunge', 'core', 'ballistic', 'cardio', 'mobility'];
const cap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);

function ex(id) {
  try { return getExercise(id) || null; } catch { return null; }
}
const allExercises = () => (Array.isArray(EXERCISES) ? EXERCISES : []);
export const catIcon = (c) => CAT_ICON[c] || 'bell';
const CAT_CODE = { kb: 'KB', run: 'RUN', erg: 'ERG', bodyweight: 'BW', hyrox: 'HRX', mobility: 'MOB' };
const catCode = (c) => CAT_CODE[c] || String(c || 'EX').slice(0, 3).toUpperCase();

function stationFor(e) {
  if (!e?.hyrox) return null;
  return (Array.isArray(STATIONS) ? STATIONS : []).find((s) => s.id === e.hyrox) || null;
}

/** Per-session performance history for an exercise (oldest → newest). */
export function exerciseHistory(exId, sessions) {
  const out = [];
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s || typeof s.date !== 'string') continue;
    const sets = (Array.isArray(s.sets) ? s.sets : []).filter((x) => x && x.exId === exId);
    if (!sets.length) continue;
    const kgs = sets.map((x) => +x.kg || 0);
    const topKg = Math.max(...kgs);
    const top = sets.find((x) => (+x.kg || 0) === topKg) || sets[0];
    out.push({
      sessionId: s.id, date: s.date, title: s.title, sets: sets.length,
      topKg, repsAtTop: +top.reps || 0, totalReps: sets.reduce((a, x) => a + (+x.reps || 0), 0),
      bestTime: Math.min(...sets.map((x) => +x.timeSec || Infinity)), distM: sets.reduce((a, x) => a + (+x.distanceM || 0), 0),
      volume: sets.reduce((a, x) => a + (setVolumeKg(x) || 0), 0),
    });
  }
  return out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function perfText(p, units) {
  const parts = [];
  if (p.topKg) parts.push(`${fmtBell(p.topKg)} × ${p.repsAtTop || '–'}`);
  if (p.sets > 1) parts.push(`${p.sets} sets`);
  if (p.totalReps && p.sets > 1) parts.push(`${p.totalReps} reps`);
  if (!p.topKg && p.totalReps && p.sets <= 1) parts.push(`${p.totalReps} reps`);
  if (p.distM) parts.push(fmtDist(p.distM, units));
  if (Number.isFinite(p.bestTime)) parts.push(fmtDur(p.bestTime));
  return parts.join(' · ') || 'Logged';
}

/** Bottom sheet with technique for one exercise. */
export function exerciseSheet(exId) {
  const e = ex(exId) || { id: exId, name: String(exId), cues: [] };
  const s = store.get();
  let sug = null;
  try { if (e.category === 'kb') sug = suggestWeight(exId, s.profile, s.sessions); } catch {}
  let last = null;
  try { last = lastPerformance(exId, s.sessions); } catch {}
  sheet({
    title: e.name,
    content: ({ close }) => h('div', { class: 'stack' },
      h('div', { class: 'chips' }, metaPills(e)),
      sug || last ? h('div', { class: 'grid2' },
        sug ? h('div', { class: 'stat-card' }, h('div', { class: 'eyebrow' }, 'Suggested bell'), h('div', { class: 'big num' }, (e.double ? '2 × ' : '') + fmtBell(sug)), h('div', { class: 'xs muted' }, bellLb(sug))) : null,
        last ? h('div', { class: 'stat-card' }, h('div', { class: 'eyebrow' }, 'Last time'), h('div', { class: 'big num' }, lastText(last, s.profile.units)), h('div', { class: 'xs muted' }, fmtDate(last.date))) : null) : null,
      listBlock('Cues', e.cues, 'ol'),
      listBlock('Common faults', e.faults, 'ul', 'tr-faults'),
      (e.muscles || []).length ? h('p', { class: 'small dim' }, h('b', null, 'Muscles: '), e.muscles.join(', ')) : null,
      h('button', { class: 'btn ghost block', on: { click: () => { close(); setTimeout(() => navigate('#/library/' + encodeURIComponent(exId)), 0); } } }, 'Open in library')),
  });
}

function lastText(l, units) {
  if (l.kg && l.reps) return `${fmtBell(l.kg)} × ${l.reps}`;
  if (l.kg) return fmtBell(l.kg);
  if (l.reps) return `${l.reps} reps`;
  if (l.distanceM) return fmtDist(l.distanceM, units);
  if (l.timeSec) return fmtDur(l.timeSec);
  return '–';
}

function metaPills(e) {
  return [
    e.category ? h('span', { class: 'pill' }, CAT_LABEL[e.category] || cap(e.category)) : null,
    e.pattern && cap(e.pattern).toLowerCase() !== String(CAT_LABEL[e.category] || e.category || '').toLowerCase() ? h('span', { class: 'pill' }, cap(e.pattern)) : null,
    e.double ? h('span', { class: 'pill' }, 'Double bell') : null,
    e.unilateral ? h('span', { class: 'pill' }, 'Unilateral') : null,
    e.hyrox ? h('span', { class: 'pill' }, 'HYROX') : null,
  ];
}

function listBlock(title, arr, tag = 'ul', cls = '', numbered = false) {
  if (!Array.isArray(arr) || !arr.length) return null;
  return h('div', { class: 'stack sm' }, numbered ? h('div', { class: 'section-head' }, ix(), h('h2', null, title)) : h('h4', null, title), h(tag, { class: 'tr-cues ' + cls }, arr.map((c) => h('li', null, String(c)))));
}

// ---------------------------------------------------------------- list view state (kept between visits)
const ui = { q: '', cat: 'all', pattern: '' };

export function render(root, { args }) {
  if (args[0]) return renderDetail(root, args[0]);
  return renderList(root);
}

function renderList(root) {
  const list = h('div', { class: 'card flush' });
  const count = h('div', { class: 'xs muted tr-count', 'aria-live': 'polite' });
  const input = h('input', { type: 'search', placeholder: 'Search exercises, muscles…', value: ui.q, 'aria-label': 'Search exercises', autocomplete: 'off' });
  input.addEventListener('input', () => { ui.q = input.value; paint(); });
  const chips = h('div', { class: 'chips scroll', role: 'group', 'aria-label': 'Category' });
  const pats = h('div', { class: 'chips scroll tr-pats', role: 'group', 'aria-label': 'Movement pattern' });

  const paintChips = () => {
    clear(chips);
    for (const c of CATS) chips.append(h('button', { type: 'button', class: 'chip', 'aria-pressed': String(ui.cat === c.id), on: { click: () => { ui.cat = c.id; paintChips(); paint(); } } }, c.label));
    clear(pats);
    const present = new Set(allExercises().map((e) => e.pattern).filter(Boolean));
    for (const p of PATTERNS.filter((x) => present.has(x))) {
      pats.append(h('button', { type: 'button', class: 'chip sm tr-pchip', 'aria-pressed': String(ui.pattern === p), on: { click: () => { ui.pattern = ui.pattern === p ? '' : p; paintChips(); paint(); } } }, cap(p)));
    }
  };

  const paint = () => {
    const q = ui.q.trim().toLowerCase();
    const cat = CATS.find((c) => c.id === ui.cat) || CATS[0];
    const rows = allExercises().filter((e) => cat.match(e) && (!ui.pattern || e.pattern === ui.pattern) && (!q ||
      String(e.name).toLowerCase().includes(q) || (e.muscles || []).some((m) => String(m).toLowerCase().includes(q)) || String(e.pattern || '').includes(q)))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    clear(list);
    count.textContent = `${rows.length} exercise${rows.length === 1 ? '' : 's'}`;
    if (!rows.length) {
      list.append(emptyState('search', 'No exercises match', 'Try a different word or clear the filters.',
        h('button', { class: 'btn sm ghost', on: { click: () => { ui.q = ''; ui.cat = 'all'; ui.pattern = ''; input.value = ''; paintChips(); paint(); } } }, 'Clear filters')));
      return;
    }
    list.append(h('div', { class: 'list' }, rows.map((e) => h('a', { class: 'li', href: '#/library/' + encodeURIComponent(e.id) },
      h('span', { class: `tr-cbadge c-${e.category}` }, catCode(e.category)),
      h('div', { class: 'li-main' },
        h('div', { class: 'li-title' }, e.name),
        h('div', { class: 'li-sub' }, [cap(e.pattern), (e.muscles || []).slice(0, 3).join(', ')].filter(Boolean).join(' · '))),
      e.hyrox ? h('span', { class: 'pill' }, 'HYROX') : null,
      h('span', { class: 'muted' }, icon('chevR', 16))))));
  };

  root.append(
    h('div', { class: 'tr-topbar' }, h('a', { class: 'tr-back', href: '#/train' }, icon('chevL', 20), 'Train')),
    h('div', { class: 'page-head' }, h('div', null, h('div', { class: 'eyebrow' }, 'Technique'), h('h1', null, 'Library'))),
    h('div', { class: 'stack' },
      h('label', { class: 'search' }, icon('search', 18), input),
      chips, pats, count, list));
  paintChips();
  paint();
}

function renderDetail(root, exId) {
  const draw = () => {
    IX = 0;
    clear(root);
    const s = store.get();
    const e = ex(exId);
    root.append(h('div', { class: 'tr-topbar' }, h('a', { class: 'tr-back', href: '#/library' }, icon('chevL', 20), 'Library')));
    const known = allExercises().some((x) => x.id === exId);
    if (!e || (!known && !(e.cues || []).length && !s.sessions.some((x) => Array.isArray(x?.sets) && x.sets.some((st) => st?.exId === exId)))) {
      root.append(emptyState('book', 'Exercise not found', 'It may have been renamed or removed.', h('a', { class: 'btn primary', href: '#/library' }, 'Browse library')));
      return;
    }
    const units = s.profile.units;
    let sug = null;
    try { if (e.category === 'kb') sug = suggestWeight(exId, s.profile, s.sessions); } catch {}
    const hist = exerciseHistory(exId, s.sessions);
    const station = stationFor(e);

    root.append(h('div', { class: 'card hero' },
      h('div', { class: 'row gap top' },
        h('span', { class: `tr-cbadge lg c-${e.category}` }, catCode(e.category)),
        h('div', { class: 'grow' }, h('h1', { class: 'tr-stitle' }, e.name), h('div', { class: 'chips mt' }, metaPills(e)))),
      (e.muscles || []).length ? h('p', { class: 'small dim mt' }, h('b', null, 'Muscles: '), e.muscles.join(', ')) : null));

    // suggested bell + best
    const best = hist.length ? hist.reduce((a, b) => (b.topKg > a.topKg || (b.topKg === a.topKg && b.repsAtTop > a.repsAtTop) ? b : a)) : null;
    if (sug || best) {
      root.append(h('div', { class: 'grid2 mt' },
        sug ? h('div', { class: 'stat-card' }, h('div', { class: 'eyebrow' }, 'Suggested bell'),
          h('div', { class: 'big num' }, (e.double ? '2 × ' : '') + fmtBell(sug)), h('div', { class: 'xs muted' }, `${bellLb(sug)} · from your bells & history`)) : null,
        best ? h('div', { class: 'stat-card' }, h('div', { class: 'eyebrow' }, 'Your best'),
          h('div', { class: 'big num' }, best.topKg ? `${fmtBell(best.topKg)} × ${best.repsAtTop}` : perfText(best, units)),
          h('div', { class: 'xs muted' }, best.topKg ? `${bellLb(best.topKg)} · ${fmtDate(best.date)}` : fmtDate(best.date))) : null));
    }

    root.append(h('div', { class: 'card mt stack tr-cuecard' },
      listBlock('Coaching cues', e.cues, 'ol', '', true) || h('p', { class: 'muted small' }, 'No cues recorded for this movement yet.'),
      listBlock('Common faults', e.faults, 'ul', 'tr-faults', true)));

    const reg = e.regression ? ex(e.regression) : null, prog = e.progression ? ex(e.progression) : null;
    if (reg || prog || station) {
      root.append(h('div', { class: 'card flush mt' }, h('div', { class: 'list' },
        reg ? h('a', { class: 'li', href: '#/library/' + encodeURIComponent(reg.id) }, h('span', { class: 'badge' }, 'EASY'), h('div', { class: 'li-main' }, h('div', { class: 'li-sub' }, 'Regression — easier'), h('div', { class: 'li-title' }, reg.name)), icon('chevR', 16)) : null,
        prog ? h('a', { class: 'li', href: '#/library/' + encodeURIComponent(prog.id) }, h('span', { class: 'badge' }, 'HARD'), h('div', { class: 'li-main' }, h('div', { class: 'li-sub' }, 'Progression — harder'), h('div', { class: 'li-title' }, prog.name)), icon('chevR', 16)) : null,
        station ? h('a', { class: 'li', href: '#/hyrox' }, h('span', { class: 'badge tr-hx' }, 'HRX'), h('div', { class: 'li-main' }, h('div', { class: 'li-sub' }, 'HYROX station'), h('div', { class: 'li-title' }, station.name)), icon('chevR', 16)) : null)));
    }

    // history
    root.append(h('div', { class: 'section-head' }, ix(), h('h2', null, 'Your history'), hist.length ? h('span', { class: 'xs muted' }, `${hist.length} session${hist.length === 1 ? '' : 's'}`) : null));
    if (!hist.length) {
      root.append(h('div', { class: 'card' }, emptyState('chart', 'No sets logged yet', 'Log this movement in a workout and your bests, recent performances and trend appear here.')));
      return;
    }
    const withKg = hist.filter((p) => p.topKg > 0);
    if (withKg.length >= 2) {
      const pts = withKg.map((p) => ({ x: dayNum(p.date), y: p.topKg }));
      root.append(h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('div', { class: 'eyebrow' }, 'Top bell per session'), h('span', { class: 'xs muted' }, 'kg')),
        lineChart({ series: [{ points: pts, color: 'var(--text)', dots: true }], height: 150, yFmt: (v) => num(v, 0),
          xLabels: [{ x: pts[0].x, label: fmtDate(withKg[0].date, { month: 'short', day: 'numeric' }) }, { x: pts.at(-1).x, label: fmtDate(withKg.at(-1).date, { month: 'short', day: 'numeric' }) }],
          ariaLabel: `Top kettlebell weight over time for ${e.name}` })));
    }
    root.append(h('div', { class: 'card flush mt' }, h('div', { class: 'list' }, hist.slice(-5).reverse().map((p) => h('a', { class: 'li', href: '#/history/' + encodeURIComponent(p.sessionId) },
      h('div', { class: 'li-main' }, h('div', { class: 'li-title num' }, perfText(p, units)), h('div', { class: 'li-sub' }, `${fmtDate(p.date)} · ${p.title || 'Session'}`)),
      p.volume ? h('span', { class: 'li-end xs muted' }, `${fmtWeight(p.volume, units)} vol`) : null, icon('chevR', 16))))));
  };
  draw();
  return store.subscribe(draw);
}

const dayNum = (iso) => { const [y, m, d] = String(iso).split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
