// FORGE — HYROX hub (#/hyrox): race setup, predictor & pacing, readiness, station guide, benchmarks.
import { store, todayISO, uid, daysBetween } from '../store.js';
import { h, icon, toast, sheet, confirmDialog, fmtDur, fmtDate, fmtDist, fmtPace, navigate, field, emptyState, clear, parseDur, seg } from '../ui.js';
import { ring, stackBar } from '../charts.js';
import { STATIONS, predictRace, hyroxReadiness, paces } from '../engine/hyrox.js';
import { generatePlan, TEMPLATES } from '../engine/program.js';
import { EXERCISES } from '../data/exercises.js';
import { saveSession, safeEx, typeBadge } from './session.js';
import { exerciseSheet } from './library.js';

const DIVS = [['open', 'Open'], ['pro', 'Pro'], ['doubles', 'Doubles']];
const stations = () => (Array.isArray(STATIONS) ? STATIONS : []);

export function stationExId(st) {
  if (st.exId) return st.exId;
  const ex = (Array.isArray(EXERCISES) ? EXERCISES : []);
  return (ex.find((e) => e.hyrox === st.id && e.category === 'hyrox') || ex.find((e) => e.id === st.id) || ex.find((e) => e.hyrox === st.id) || { id: st.id }).id;
}

function specFor(st, profile) {
  const div = profile.division === 'pro' ? 'pro' : 'open';
  const sx = profile.sex === 'f' ? 'w' : 'm';
  const v = st.spec?.[`${div}_${sx}`];
  if (v == null || v === '') return null;
  if (typeof v === 'number') return `${v} kg`;
  if (typeof v === 'object') return Object.entries(v).map(([k, x]) => `${k} ${x}`).join(' · ');
  return String(v);
}
function workFor(st, units) {
  if (st.reps) return `${st.reps} reps`;
  if (st.distanceM) return fmtDist(st.distanceM, /ski|row/i.test(st.id + st.name) ? 'metric' : units);
  return '';
}

function bestStationTimes(sessions, st) {
  const ids = new Set([st.id, stationExId(st)]);
  let best = null;
  for (const s of sessions) for (const x of s.sets || []) {
    if (ids.has(x.exId) && +x.timeSec > 0 && (!best || +x.timeSec < best.timeSec)) best = { timeSec: +x.timeSec, date: s.date, id: s.id };
  }
  return best;
}

export function render(root) {
  const draw = () => {
    const s = store.get();
    clear(root);
    const p = s.profile, today = todayISO();
    const plan = s.plan;
    const raceDate = p.raceDate || plan?.raceDate || null;
    const dtr = raceDate ? daysBetween(today, raceDate) : null;

    root.append(h('div', { class: 'tr-topbar' }, h('a', { class: 'tr-back', href: '#/train' }, icon('chevL', 20), 'Train')));
    root.append(h('div', { class: 'page-head' }, h('div', null, h('div', { class: 'eyebrow' }, 'Race prep'), h('h1', null, 'HYROX'))));

    // ---- countdown & setup
    const dateIn = h('input', { type: 'date', value: raceDate || '', min: today, 'aria-label': 'Race date' });
    dateIn.addEventListener('change', async () => {
      const v = dateIn.value;
      if (!v || v === raceDate) return;
      if (v < today) { toast('Pick a date in the future', { kind: 'danger' }); dateIn.value = raceDate || ''; return; }
      store.update((d) => { d.profile.raceDate = v; });
      if (store.get().plan) {
        const ok = await confirmDialog(`Race moved to ${fmtDate(v)}. Rebuild your training plan to peak on the new date? Logged sessions are kept.`, { ok: 'Rebuild plan' });
        if (ok) regenPlan();
        else toast('Race date saved — plan unchanged');
      } else toast('Race date saved');
    });
    root.append(h('div', { class: 'card hero tr-race' },
      h('div', { class: 'row between top' },
        h('div', null,
          h('div', { class: 'eyebrow' }, 'Race day'),
          h('div', { class: 'tr-cd num' }, dtr == null ? '—' : dtr > 0 ? String(dtr) : dtr === 0 ? '0' : '✓'),
          h('div', { class: 'small muted' }, dtr == null ? 'Set your race date' : dtr > 0 ? `day${dtr === 1 ? '' : 's'} to go · ${fmtDate(raceDate, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}` : dtr === 0 ? 'It’s race day. Go get it.' : 'Race complete — set your next one')),
        h('span', { class: 'tr-tbadge t-hyrox', style: { width: '52px', height: '52px' } }, icon('flag', 26))),
      h('div', { class: 'stack mt' },
        field('Division', seg(DIVS, p.division || 'open', (v) => { store.update((d) => { d.profile.division = v; }); toast(`Division: ${DIVS.find((x) => x[0] === v)[1]}`); }, { label: 'Division' })),
        field('Race date', dateIn)),
      p.division === 'doubles' ? h('p', { class: 'xs muted mt' }, 'Doubles: run all 8 km together, split station work with your partner as you like. Open weights apply.') : null));

    // ---- prediction
    let pred = null;
    try { pred = predictRace(s, today); } catch (e) { console.warn('predictRace', e); }
    root.append(h('div', { class: 'section-head' }, h('h2', null, 'Predicted finish'), pred ? h('span', { class: `pill ${pred.confidence === 'high' ? 'go' : pred.confidence === 'med' ? 'accent' : ''}` }, `${pred.confidence || 'low'} confidence`) : null));
    if (!pred || !Number.isFinite(+pred.totalSec)) {
      root.append(h('div', { class: 'card' }, emptyState('target', 'Not enough data yet', 'Log a 5 km time in Me or a few station benchmarks below to unlock your prediction.',
        h('button', { class: 'btn primary sm', on: { click: () => benchmarkSheet() } }, 'Log a benchmark'))));
    } else {
      const splits = pred.splits || [];
      let clock = 0;
      const runSplits = splits.filter((x) => /run/i.test(x.name));
      root.append(h('div', { class: 'card stack' },
        h('div', { class: 'row between' },
          h('div', null, h('div', { class: 'tr-pred num' }, fmtDur(pred.totalSec)), h('div', { class: 'xs muted' }, `${(DIVS.find((x) => x[0] === p.division) || DIVS[0])[1]} · ${p.sex === 'f' ? 'Women' : 'Men'}`)),
          h('div', { class: 'tr-legend xs' },
            legend('var(--base)', 'Running', pred.runSec), legend('var(--accent)', 'Stations', pred.stationSec), legend('var(--taper)', 'Roxzone', pred.roxzoneSec))),
        stackBar([{ value: pred.runSec, color: 'var(--base)', label: 'Running' }, { value: pred.stationSec, color: 'var(--accent)', label: 'Stations' }, { value: pred.roxzoneSec, color: 'var(--taper)', label: 'Roxzone' }], { height: 12 }),
        (pred.basis || []).length ? h('ul', { class: 'tr-basis xs muted' }, pred.basis.map((b) => h('li', null, b))) : null));

      // pacing plan
      const runAvg = runSplits.length ? runSplits.reduce((a, x) => a + x.sec, 0) / runSplits.length : pred.runSec / 8;
      let pz = null;
      try { pz = p.fiveKSec ? paces(p.fiveKSec) : null; } catch {}
      root.append(h('div', { class: 'section-head' }, h('h2', null, 'Pacing plan'), h('span', { class: 'xs muted' }, 'target · race clock')));
      root.append(h('div', { class: 'card tight' },
        h('div', { class: 'callout info small mb' }, h('b', null, `Run ${fmtPace(runAvg, p.units)}`), ` (${fmtDur(runAvg)} per 1 km). Go out no faster than this on run 1 — the first km always feels easy.`, pz?.race ? ` Your 5 km-derived race pace: ${fmtPace(Array.isArray(pz.race) ? pz.race[0] : pz.race, p.units)}.` : ''),
        h('table', { class: 'tr-table' },
          h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Segment'), h('th', { class: 'right' }, 'Target'), h('th', { class: 'right' }, 'Clock'))),
          h('tbody', null, splits.map((x, i) => {
            clock += +x.sec || 0;
            const isRun = /run/i.test(x.name), isRox = /rox/i.test(x.name);
            return h('tr', { class: isRun ? 'run' : isRox ? 'rox' : 'st' },
              h('td', { class: 'muted' }, String(i + 1)),
              h('td', null, h('span', { class: `dot ${isRun ? 'd-run' : isRox ? 'd-rox' : 'd-st'}` }), ' ', x.name),
              h('td', { class: 'right num' }, fmtDur(x.sec)),
              h('td', { class: 'right num muted' }, fmtDur(clock)));
          })),
          h('tfoot', null, h('tr', null, h('td', null), h('td', null, 'Finish'), h('td', null), h('td', { class: 'right num' }, fmtDur(pred.totalSec)))))));
    }

    // ---- readiness
    let rd = null;
    try { rd = hyroxReadiness(s, today); } catch (e) { console.warn('hyroxReadiness', e); }
    root.append(h('div', { class: 'section-head' }, h('h2', null, 'HYROX readiness')));
    if (!rd) root.append(h('div', { class: 'card' }, emptyState('target', 'Readiness unavailable', 'Train and log a few sessions to see how race-ready you are.')));
    else {
      const sc = Math.round(+rd.score || 0);
      root.append(h('div', { class: 'card' },
        h('div', { class: 'row gap' },
          ring({ value: sc, max: 100, size: 96, stroke: 10, color: sc >= 70 ? 'var(--go)' : sc >= 45 ? 'var(--build)' : 'var(--peak)', label: String(sc), sub: '/ 100' }),
          h('div', { class: 'grow small dim' }, sc >= 70 ? 'Race-ready foundations — sharpen pacing and transitions.' : sc >= 45 ? 'Getting there. Close the gaps below to raise your floor.' : 'Early days — consistency in the plan will move this fast.')),
        h('div', { class: 'stack mt' }, (rd.parts || []).map((pt) => {
          const v = Math.round(+pt.score || 0);
          return h('div', { class: 'tr-rpart' },
            h('div', { class: 'row between small' }, h('b', null, pt.label), h('span', { class: 'num muted' }, String(v))),
            h('div', { class: 'bar thin' + (v >= 70 ? ' go' : '') }, h('i', { style: { width: Math.max(2, Math.min(100, v)) + '%' } })),
            pt.tip ? h('div', { class: 'xs muted' }, pt.tip) : null);
        }))));
    }

    // ---- station guide
    root.append(h('div', { class: 'section-head' }, h('h2', null, 'Station guide'), h('button', { class: 'link-btn', on: { click: () => benchmarkSheet() } }, '+ Log time')));
    if (!stations().length) root.append(h('div', { class: 'card' }, emptyState('flag', 'Stations unavailable', '')));
    root.append(h('div', { class: 'stack' }, stations().map((st, i) => stationCard(st, i, s))));

    // ---- benchmarks
    const temps = (Array.isArray(TEMPLATES) ? TEMPLATES : []).filter((t) => /bench|test|sim|trial/i.test(t.id + ' ' + t.title) || t.type === 'hyrox');
    root.append(h('div', { class: 'section-head' }, h('h2', null, 'Benchmarks & simulations')));
    root.append(h('div', { class: 'card flush' }, h('div', { class: 'list' },
      temps.map((t) => h('a', { class: 'li', href: '#/session/' + encodeURIComponent(t.id) }, typeBadge(t.type, 36),
        h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, t.title), h('div', { class: 'li-sub' }, [t.estMin ? `${t.estMin} min` : null, t.summary].filter(Boolean).join(' · '))), icon('chevR', 16))),
      h('button', { class: 'li', type: 'button', on: { click: () => benchmarkSheet() } },
        h('span', { class: 'badge tr-hx' }, icon('timer', 18)),
        h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, 'Log a station benchmark'), h('div', { class: 'li-sub' }, 'Time a station (or a 1 km run) to sharpen your prediction')),
        icon('plus', 18)))));

    const logged = s.sessions.filter((x) => x.type === 'hyrox').slice(-5).reverse();
    if (logged.length) {
      root.append(h('h4', { class: 'tr-gh mt' }, 'Recent HYROX logs'), h('div', { class: 'card flush' }, h('div', { class: 'list' }, logged.map((x) => h('a', { class: 'li', href: '#/history/' + encodeURIComponent(x.id) },
        h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, x.title || 'HYROX'), h('div', { class: 'li-sub' }, fmtDate(x.date))),
        h('span', { class: 'li-end num' }, x.durationSec ? fmtDur(x.durationSec) : ''), (x.prs || []).length ? h('span', { class: 'pill go' }, 'PR') : null)))));
    }
  };
  draw();
  return store.subscribe(draw);
}

function legend(color, label, sec) {
  return h('div', { class: 'row', style: { gap: '6px' } }, h('span', { class: 'dot', style: { background: color } }), h('span', { class: 'muted' }, label), h('b', { class: 'num' }, Number.isFinite(+sec) ? fmtDur(sec) : '–'));
}

function stationCard(st, i, s) {
  const p = s.profile;
  const spec = specFor(st, p);
  const best = bestStationTimes(s.sessions, st);
  const subs = (st.subs || []).map((id) => safeEx(id));
  const stEx = stationExId(st);
  return h('div', { class: 'card tr-station' },
    h('div', { class: 'row gap top' },
      h('span', { class: 'tr-stnum num' }, String(i + 1)),
      h('div', { class: 'grow' },
        h('div', { class: 'eyebrow' }, `1 km run → station ${i + 1}`),
        h('h3', null, st.name),
        h('div', { class: 'row wrap mt', style: { gap: '6px' } },
          workFor(st, p.units) ? h('span', { class: 'pill accent' }, workFor(st, p.units)) : null,
          spec ? h('span', { class: 'pill' }, spec) : null,
          best ? h('a', { class: 'pill go', href: '#/history/' + encodeURIComponent(best.id) }, icon('trophy', 12), fmtDur(best.timeSec)) : null))),
    (st.tips || []).length ? h('ul', { class: 'tr-cues small mt' }, st.tips.map((t) => h('li', null, String(t)))) : null,
    subs.length ? h('div', { class: 'mt' },
      h('div', { class: 'xs muted tr-subh' }, 'At home — kettlebell substitutes'),
      h('div', { class: 'chips' }, subs.map((e) => h('button', { type: 'button', class: 'chip', on: { click: () => exerciseSheet(e.id) } }, icon('bell', 14), e.name)))) : null,
    h('div', { class: 'row gap mt' },
      h('a', { class: 'btn ghost sm grow', href: '#/library/' + encodeURIComponent(stEx) }, icon('book', 16), 'Technique'),
      h('button', { class: 'btn subtle sm grow', on: { click: () => benchmarkSheet(st.id) } }, icon('timer', 16), 'Log time')));
}

function regenPlan() {
  try {
    const plan = generatePlan(store.get().profile, todayISO());
    store.update((d) => { d.plan = plan; });
    toast(`Plan rebuilt — ${plan.weeks.length} weeks`, { kind: 'go', action: { label: 'View', fn: () => navigate('#/train') } });
  } catch (e) {
    console.error(e);
    toast('Could not rebuild the plan', { kind: 'danger' });
  }
}

export function benchmarkSheet(presetId) {
  const s = store.get(), today = todayISO();
  const opts = [...stations().map((st) => [st.id, `${st.name}${workFor(st, s.profile.units) ? ' — ' + workFor(st, s.profile.units) : ''}`]), ['run1k', '1 km run (fresh)']];
  const sel = h('select', { 'aria-label': 'Station' }, opts.map(([v, l]) => h('option', { value: v }, l)));
  sel.value = presetId && opts.some((o) => o[0] === presetId) ? presetId : opts[0]?.[0] || 'run1k';
  const time = h('input', { type: 'text', inputmode: 'numeric', placeholder: 'mm:ss', autocomplete: 'off', 'aria-label': 'Time' });
  const date = h('input', { type: 'date', value: today, max: today });
  const notes = h('textarea', { rows: 2, placeholder: 'Bell used / substitution, how it felt… (optional)' });
  const hint = h('div', { class: 'xs muted' });
  const sync = () => {
    const st = stations().find((x) => x.id === sel.value);
    const b = st ? bestStationTimes(store.get().sessions, st) : null;
    hint.textContent = b ? `Current best: ${fmtDur(b.timeSec)} (${fmtDate(b.date)})` : 'No time logged yet for this one.';
  };
  sel.addEventListener('change', sync); sync();
  sheet({
    title: 'Log station benchmark',
    content: ({ close }) => h('div', { class: 'stack' },
      field('Station', sel), hint,
      h('div', { class: 'grid2' }, field('Time', time), field('Date', date)),
      field('Notes', notes),
      h('button', {
        class: 'btn primary block xl', on: {
          click: () => {
            const t = parseDur(time.value);
            if (!(t > 0)) { toast('Enter a time as mm:ss', { kind: 'danger' }); time.focus(); return; }
            const d = date.value || today;
            let sess;
            const base = { id: uid('s'), date: d, workoutId: null, startedAt: new Date(d + 'T12:00:00').toISOString(), durationSec: t, rpe: null, notes: notes.value.trim(), readiness: null, prs: [] };
            if (sel.value === 'run1k') {
              sess = { ...base, title: '1 km benchmark', type: 'run', sets: [], cardio: [{ mode: 'run', distanceM: 1000, timeSec: t, avgHr: null }] };
            } else {
              const st = stations().find((x) => x.id === sel.value);
              const mode = /ski/i.test(st.id) ? 'ski' : /row/i.test(st.id) ? 'row' : null;
              sess = {
                ...base, title: `${st.name} benchmark`, type: 'hyrox',
                sets: [{ exId: stationExId(st), kg: null, reps: st.reps || null, timeSec: t, distanceM: st.distanceM || null, rpe: null, block: 'station' }],
                cardio: mode ? [{ mode, distanceM: st.distanceM || 1000, timeSec: t, avgHr: null }] : [],
              };
            }
            sess = saveSession(sess);
            close();
            toast(sess.prs?.length ? `🏆 ${sess.prs[0]}` : `Logged ${fmtDur(t)} ✓`, { kind: 'go' });
          },
        },
      }, icon('check'), 'Save time')),
  });
}
