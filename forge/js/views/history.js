// FORGE — History (#/history, #/history/<sessionId>)
import { store, addDays, todayISO } from '../store.js';
import { h, icon, toast, sheet, confirmDialog, fmtBell, bellLb, fmtWeight, fmtDist, fmtDur, fmtDate, fmtPace, navigate, field, emptyState, clear, num } from '../ui.js';
import { typeBadge, typeMeta, safeEx, safeGetWorkout, rpePicker, backBar } from './session.js';
import { exerciseSheet } from './library.js';

const FILTERS = [
  ['all', 'All', () => true],
  ['kb', 'KB', (s) => s.type === 'strength' || s.type === 'conditioning' || (s.sets || []).some((x) => +x.kg > 0)],
  ['run', 'Run', (s) => s.type === 'run' || s.type === 'cardio' || (s.cardio || []).length > 0],
  ['hyrox', 'HYROX', (s) => s.type === 'hyrox' || s.type === 'hybrid'],
];
const ui = { filter: 'all' };

const mondayOf = (iso) => { const [y, m, d] = iso.split('-').map(Number); const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; return addDays(iso, -dow); };
const volumeOf = (s) => (s.sets || []).reduce((a, x) => a + (+x.kg || 0) * (+x.reps || 0), 0);
const distOf = (s) => (s.cardio || []).reduce((a, c) => a + (+c.distanceM || 0), 0) + (s.sets || []).reduce((a, x) => a + (/run|row|ski|bike/.test(String(x.exId)) ? +x.distanceM || 0 : 0), 0);

let from = '';
const q = () => (from ? '?from=' + from : '');

export function render(root, { args, query }) {
  from = query?.from === 'train' ? 'train' : '';
  const draw = () => { clear(root); args[0] ? renderDetail(root, args[0]) : renderList(root); };
  draw();
  return store.subscribe(draw);
}

function renderList(root) {
  const s = store.get(), units = s.profile.units;
  root.append(from === 'train' ? backBar('#/train', 'Train') : backBar('#/progress', 'Progress'));
  root.append(h('div', { class: 'page-head' }, h('div', null, h('div', { class: 'eyebrow' }, `${s.sessions.length} session${s.sessions.length === 1 ? '' : 's'} logged`), h('h1', null, 'History'))));
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Filter' }, FILTERS.map(([id, label]) =>
    h('button', { type: 'button', class: 'chip', 'aria-pressed': String(ui.filter === id), on: { click: () => { ui.filter = id; clear(root); renderList(root); } } }, label)));
  root.append(chips);

  const f = (FILTERS.find((x) => x[0] === ui.filter) || FILTERS[0])[2];
  const list = s.sessions.filter((x) => x && x.date).filter(f)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
  if (!list.length) {
    root.append(h('div', { class: 'card mt' }, s.sessions.length
      ? emptyState('search', 'Nothing in this filter', 'Try another filter.', h('button', { class: 'btn sm ghost', on: { click: () => { ui.filter = 'all'; clear(root); renderList(root); } } }, 'Show all'))
      : emptyState('list', 'No sessions yet', 'Finish a workout or log one from Train and it will show up here.', h('a', { class: 'btn primary', href: '#/train' }, 'Go to Train'))));
    return;
  }
  const groups = [];
  for (const x of list) {
    const wk = mondayOf(x.date);
    let g = groups.at(-1);
    if (!g || g.wk !== wk) groups.push((g = { wk, items: [] }));
    g.items.push(x);
  }
  const thisWk = mondayOf(todayISO());
  for (const g of groups) {
    const mins = g.items.reduce((a, x) => a + (+x.durationSec || 0), 0);
    const label = g.wk === thisWk ? 'This week' : g.wk === addDays(thisWk, -7) ? 'Last week' : `Week of ${fmtDate(g.wk, { month: 'short', day: 'numeric' })}`;
    root.append(h('div', { class: 'section-head tr-hgh' }, h('h2', null, label), h('span', { class: 'xs muted num' }, `${g.items.length} · ${fmtDur(mins, { long: true })}`)));
    root.append(h('div', { class: 'card flush' }, h('div', { class: 'list' }, g.items.map((x) => {
      const vol = volumeOf(x), dist = distOf(x);
      const sub = [fmtDate(x.date), x.durationSec ? fmtDur(x.durationSec, { long: true }) : null, vol ? `${fmtWeight(vol, units)} vol` : null, dist ? fmtDist(dist, units) : null].filter(Boolean).join(' · ');
      return h('a', { class: 'li', href: '#/history/' + encodeURIComponent(x.id) + q() },
        typeBadge(x.type, 36),
        h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, x.title || typeMeta(x.type).label), h('div', { class: 'li-sub' }, sub)),
        (x.prs || []).length ? h('span', { class: 'pill go', title: x.prs.join('\n') }, icon('trophy', 12), String(x.prs.length)) : null,
        h('span', { class: 'muted' }, icon('chevR', 16)));
    }))));
  }
}

function renderDetail(root, id) {
  const s = store.get(), units = s.profile.units;
  const x = s.sessions.find((y) => y.id === id);
  root.append(backBar('#/history' + q(), 'History'));
  if (!x) {
    root.append(emptyState('list', 'Session not found', 'It may have been deleted.', h('a', { class: 'btn primary', href: '#/history' + q() }, 'Back to history')));
    return;
  }
  const w = x.workoutId ? safeGetWorkout(s.plan, x.workoutId) : null;
  const vol = volumeOf(x), dist = distOf(x);
  const sets = x.sets || [];
  const reps = sets.reduce((a, y) => a + (+y.reps || 0), 0);

  root.append(h('div', { class: 'card hero' },
    h('div', { class: 'row gap top' }, typeBadge(x.type, 48),
      h('div', { class: 'grow' },
        h('div', { class: 'eyebrow' }, `${typeMeta(x.type).label} · ${fmtDate(x.date, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })}`),
        h('h1', { class: 'tr-stitle' }, x.title || 'Session'))),
    h('div', { class: 'tr-sstats' },
      stat(x.durationSec ? fmtDur(x.durationSec) : '–', 'Duration'),
      vol ? stat(fmtWeight(vol, units), 'Volume') : dist ? stat(fmtDist(dist, units), 'Distance') : stat(String(sets.length), 'Sets'),
      reps ? stat(num(reps), 'Reps') : stat(x.rpe ? String(x.rpe) : '–', 'RPE'),
      reps ? stat(x.rpe ? String(x.rpe) : '–', 'RPE') : null),
    w ? h('a', { class: 'link-btn tr-plink', href: '#/session/' + encodeURIComponent(w.id) }, icon('calendar', 14), ` Planned: ${w.title} →`) : null,
    x.readiness != null ? h('div', { class: 'xs muted mt' }, `Readiness that day: ${Math.round(x.readiness)}/100`) : null));

  if ((x.prs || []).length) {
    root.append(h('div', { class: 'callout go mt stack sm' }, h('div', { class: 'row' }, icon('trophy', 18), h('b', null, `${x.prs.length} personal record${x.prs.length > 1 ? 's' : ''}`)),
      h('ul', { class: 'tr-cues small' }, x.prs.map((p) => h('li', null, String(p))))));
  }

  // sets grouped by exercise
  if (sets.length) {
    const byEx = new Map();
    for (const st of sets) { if (!byEx.has(st.exId)) byEx.set(st.exId, []); byEx.get(st.exId).push(st); }
    root.append(h('div', { class: 'section-head' }, h('h2', null, 'Sets'), h('span', { class: 'xs muted' }, `${sets.length} sets · ${byEx.size} exercise${byEx.size === 1 ? '' : 's'}`)));
    const workStr = (st) => [st.reps ? `${st.reps} reps` : null, st.distanceM ? fmtDist(st.distanceM, units) : null, st.timeSec ? fmtDur(st.timeSec) : null].filter(Boolean).join(' · ') || '–';
    const entries = [...byEx.entries()];
    const tabled = entries.filter(([, list]) => list.length > 1 || list.some((st) => +st.kg > 0));
    const simple = entries.filter((e) => !tabled.includes(e));
    root.append(h('div', { class: 'stack' }, tabled.map(([exId, list]) => {
      const e = safeEx(exId);
      return h('div', { class: 'card tight' },
        h('button', { type: 'button', class: 'tr-exname tr-exh', on: { click: () => exerciseSheet(exId) } }, e.name, icon('info', 14)),
        h('table', { class: 'tr-table tr-sets' },
          h('thead', null, h('tr', null, h('th', null, 'Set'), h('th', null, 'Load'), h('th', { class: 'right' }, 'Work'), h('th', { class: 'right' }, 'RPE'))),
          h('tbody', null, list.map((st, i) => h('tr', null,
            h('td', { class: 'muted num' }, String(i + 1)),
            h('td', null, +st.kg > 0 ? h('span', null, h('b', { class: 'num' }, fmtBell(+st.kg)), ' ', h('small', { class: 'muted' }, bellLb(+st.kg))) : h('span', { class: 'muted' }, 'BW')),
            h('td', { class: 'right num' }, workStr(st)),
            h('td', { class: 'right num muted' }, st.rpe ? String(st.rpe) : '–'))))));
    }),
    simple.length ? h('div', { class: 'card flush' }, h('div', { class: 'list' }, simple.map(([exId, list]) => h('button', { type: 'button', class: 'li', on: { click: () => exerciseSheet(exId) } },
      h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, safeEx(exId).name)),
      h('span', { class: 'li-end num small muted' }, workStr(list[0])))))) : null));
  }

  if ((x.cardio || []).length) {
    root.append(h('div', { class: 'section-head' }, h('h2', null, 'Cardio')));
    root.append(h('div', { class: 'card flush' }, h('div', { class: 'list' }, x.cardio.map((c) => {
      const pace = c.distanceM > 0 && c.timeSec > 0 ? (c.timeSec / c.distanceM) * 1000 : null;
      const erg = c.mode === 'row' || c.mode === 'ski';
      return h('div', { class: 'li' },
        h('span', { class: 'badge' }, icon(c.mode === 'run' || c.mode === 'walk' ? 'run' : 'zap', 18)),
        h('div', { class: 'li-main' },
          h('div', { class: 'li-title' }, `${cap(c.mode)}${c.distanceM ? ' · ' + fmtDist(c.distanceM, erg ? 'metric' : units) : ''}`),
          h('div', { class: 'li-sub num' }, [c.timeSec ? fmtDur(c.timeSec) : null, pace ? (erg ? `${fmtDur(pace / 2)} /500 m` : fmtPace(pace, units)) : null, c.avgHr ? `${c.avgHr} bpm` : null].filter(Boolean).join(' · '))));
    }))));
  }

  if (!sets.length && !(x.cardio || []).length) {
    root.append(h('div', { class: 'callout info small mt' }, x.untracked ? 'Logged without set-by-set tracking.' : 'No sets or cardio recorded in this session.'));
  }

  root.append(h('div', { class: 'section-head' }, h('h2', null, 'Notes')));
  root.append(h('div', { class: 'card' }, x.notes ? h('p', { class: 'tr-notes' }, x.notes) : h('p', { class: 'muted small' }, 'No notes. Tap Edit to add how it felt.'),
    h('div', { class: 'xs muted mt' }, `Session RPE: ${x.rpe || '–'}`)));

  root.append(h('div', { class: 'row gap mt-lg' },
    h('button', { class: 'btn ghost grow', on: { click: () => editSheet(x) } }, icon('edit', 18), 'Edit RPE & notes'),
    h('button', {
      class: 'btn ghost grow tr-del', on: {
        click: async () => {
          const ok = await confirmDialog(`Delete “${x.title || 'this session'}” from ${fmtDate(x.date)}? This can't be undone.`, { ok: 'Delete', danger: true });
          if (!ok) return;
          const copy = structuredClone(x);
          navigate('#/history' + q());
          store.update((d) => { d.sessions = d.sessions.filter((y) => y.id !== x.id); });
          toast('Session deleted', { action: { label: 'Undo', fn: () => store.update((d) => { d.sessions.push(copy); d.sessions.sort((a, b) => String(a.date).localeCompare(String(b.date))); }) } });
        },
      },
    }, icon('trash', 18), 'Delete')));
}

function editSheet(x) {
  let rpe = +x.rpe || null;
  const notes = h('textarea', { rows: 4, placeholder: 'How did it feel?' });
  notes.value = x.notes || '';
  sheet({
    title: 'Edit session',
    content: ({ close }) => h('div', { class: 'stack' },
      field('Session RPE', rpePicker(rpe, (v) => (rpe = v))),
      field('Notes', notes),
      h('button', {
        class: 'btn primary block xl', on: {
          click: () => {
            store.update((d) => { const y = d.sessions.find((z) => z.id === x.id); if (y) { y.rpe = rpe; y.notes = notes.value.trim(); } });
            close();
            toast('Saved ✓', { kind: 'go' });
          },
        },
      }, 'Save')),
  });
}

const cap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
function stat(v, k) { return h('div', { class: 'stat' }, h('div', { class: 'v' }, v), h('div', { class: 'k' }, k)); }
