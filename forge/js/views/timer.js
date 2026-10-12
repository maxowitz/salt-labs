// FORGE free timers — #/timer : EMOM · AMRAP · Tabata · Intervals · Stopwatch
import { h, clear, icon, seg, stepper, fmtDur, haptic } from '../ui.js';
import { IntervalTimer, buildSegments, segmentsDuration, wakeLock, unlockAudio, speak } from '../engine/timer.js';
import { backBar } from './session.js';
import { timerFace, timerControls, roundCounter, phaseOf, faceTime, fmtClock } from './_timerui.js';

/** append that skips null/false and flattens arrays (native append would stringify them) */
const put = (el, ...kids) => { el.append(...kids.flat(Infinity).filter((k) => k != null && k !== false)); return el; };

const CFG_KEY = 'forge:timer-cfg';
const DEFAULTS = {
  mode: 'emom',
  emom: { minutes: 10, every: 60 },
  amrap: { minutes: 12 },
  tabata: { work: 20, rest: 10, rounds: 8 },
  intervals: { work: 40, rest: 20, rounds: 10 },
  prep: 10,
};
const MODES = [['emom', 'EMOM'], ['amrap', 'AMRAP'], ['tabata', 'Tabata'], ['intervals', 'Intervals'], ['stopwatch', 'Stopwatch']];
const BLURB = {
  emom: 'Every minute on the minute: do the work, rest what is left of the minute.',
  amrap: 'As many rounds as possible. Tap the counter after each round.',
  tabata: 'Classic 20 s hard / 10 s easy × 8. Adjust if you like.',
  intervals: 'Custom work / rest intervals for runs, ergs or bells.',
  stopwatch: 'Count up with laps — great for runs, carries and benchmarks.',
};

function loadCfg() {
  try {
    const c = JSON.parse(localStorage.getItem(CFG_KEY) || 'null');
    if (c && typeof c === 'object') return { ...DEFAULTS, ...c, emom: { ...DEFAULTS.emom, ...c.emom }, amrap: { ...DEFAULTS.amrap, ...c.amrap }, tabata: { ...DEFAULTS.tabata, ...c.tabata }, intervals: { ...DEFAULTS.intervals, ...c.intervals } };
  } catch {}
  return structuredClone(DEFAULTS);
}
function saveCfg(c) { try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch {} }

function blockFor(cfg) {
  switch (cfg.mode) {
    case 'emom': return { kind: 'emom', minutes: cfg.emom.minutes, workSec: cfg.emom.every, items: [] };
    case 'amrap': return { kind: 'amrap', durationSec: cfg.amrap.minutes * 60, items: [] };
    case 'tabata': return { kind: 'intervals', rounds: cfg.tabata.rounds, workSec: cfg.tabata.work, restSec: cfg.tabata.rest, items: [] };
    case 'intervals': return { kind: 'intervals', rounds: cfg.intervals.rounds, workSec: cfg.intervals.work, restSec: cfg.intervals.rest, items: [] };
    default: return null;
  }
}
function segmentsFor(cfg) {
  if (cfg.mode === 'stopwatch') return [{ label: 'Stopwatch', sec: Infinity, open: true, kind: 'work', meta: { round: 1, rounds: 1 } }];
  return buildSegments(blockFor(cfg), { prep: cfg.prep });
}

export async function render(root) {
  const cfg = loadCfg();
  let timer = null, releaseWake = null, tick = null;
  const stopAll = () => {
    timer?.stop(); timer = null;
    clearInterval(tick); tick = null;
    releaseWake?.(); releaseWake = null;
    document.body.classList.remove('tm-running');
  };

  function setup() {
    stopAll();
    clear(root);
    const body = h('div', { class: 'stack' });
    const totalEl = h('div', { class: 'tm-total num' });
    const updTotal = () => {
      const s = segmentsFor(cfg);
      const t = segmentsDuration(s.filter((x) => x.kind !== 'prep'));
      totalEl.textContent = cfg.mode === 'stopwatch' ? 'Open-ended' : `Total ${fmtDur(t)}`;
      saveCfg(cfg);
    };
    const secFmt = (v) => fmtDur(v);
    const row = (label, ctl) => h('div', { class: 'tm-row' }, h('span', { class: 'field-label' }, label), ctl);
    const drawBody = () => {
      clear(body);
      const m = cfg.mode;
      put(body, h('p', { class: 'muted small' }, BLURB[m]));
      const card = h('div', { class: 'card stack' });
      if (m === 'emom') {
        put(card, 
          row('Minutes', stepper(cfg.emom.minutes, { min: 1, max: 90, label: 'minutes', onChange: (v) => { cfg.emom.minutes = v; updTotal(); } })),
          row('Every', stepper(cfg.emom.every, { min: 15, max: 600, step: 15, label: 'interval length', fmt: secFmt, onChange: (v) => { cfg.emom.every = v; updTotal(); } })));
      } else if (m === 'amrap') {
        put(card, row('Minutes', stepper(cfg.amrap.minutes, { min: 1, max: 90, label: 'minutes', onChange: (v) => { cfg.amrap.minutes = v; updTotal(); } })));
      } else if (m === 'tabata' || m === 'intervals') {
        const c = cfg[m];
        put(card, 
          row('Work', stepper(c.work, { min: 5, max: 3600, step: 5, label: 'work', fmt: secFmt, onChange: (v) => { c.work = v; updTotal(); } })),
          row('Rest', stepper(c.rest, { min: 0, max: 1200, step: 5, label: 'rest', fmt: secFmt, onChange: (v) => { c.rest = v; updTotal(); } })),
          row('Rounds', stepper(c.rounds, { min: 1, max: 99, label: 'rounds', onChange: (v) => { c.rounds = v; updTotal(); } })));
      } else {
        put(card, h('div', { class: 'tm-sw-hint' }, icon('timer', 28), h('span', null, 'Start, tap Lap at each split, stop when done.')));
      }
      if (m !== 'stopwatch') {
        put(card, row('Get-ready countdown', seg([[0, 'Off'], [5, '5 s'], [10, '10 s']], cfg.prep, (v) => { cfg.prep = v; updTotal(); }, { label: 'Get ready countdown' })));
      }
      put(body, card, totalEl);
      updTotal();
    };
    put(root, 
      backBar('#/train', 'Train'),
      h('div', { class: 'page-head' }, h('h1', null, 'Timers')),
      h('div', { class: 'tm-modes' }, seg(MODES, cfg.mode, (v) => { cfg.mode = v; drawBody(); }, { label: 'Timer type' })),
      body,
      h('button', { class: 'btn primary xl block tm-start', on: { click: () => { unlockAudio(); run(); } } }, icon('play'), 'Start'));
    drawBody();
  }

  function run() {
    stopAll();
    clear(root);
    document.body.classList.add('tm-running');
    releaseWake = wakeLock();
    const segs = segmentsFor(cfg);
    const mode = cfg.mode;
    const label = MODES.find((m) => m[0] === mode)[1];
    const face = timerFace({});
    const roundsEl = h('div', { class: 'tm-rounds num' });
    const laps = [];
    const lapsEl = h('div', { class: 'tm-laps' });
    let rc = null;

    timer = new IntervalTimer(segs, {
      onSegment: (s) => {
        const sg = s.segment;
        if (sg?.kind === 'work' && mode === 'emom') speak(`Minute ${sg.meta.round}`);
        else if (sg?.kind === 'work' && (mode === 'tabata' || mode === 'intervals')) speak(`Round ${sg.meta.round}`);
        else if (sg?.kind === 'rest') speak('Rest');
      },
      onDone: () => upd(),
    });
    const ctl = timerControls({
      onToggle: () => { haptic(); timer.toggle(); upd(); },
      onBack: () => { if (mode === 'stopwatch') return run(); timer.back(); upd(); },
      onSkip: () => { if (mode === 'stopwatch') return lap(); timer.skip(); upd(); },
      labels: mode === 'stopwatch' ? { skip: 'Lap' } : {},
    });
    if (mode === 'stopwatch') { ctl.skip.replaceChildren(icon('flag', 24)); ctl.back.setAttribute('aria-label', 'Reset'); }

    function lap() {
      if (!timer.started) return;
      const t = timer.state.segElapsed;
      const prev = laps.length ? laps[laps.length - 1].t : 0;
      laps.push({ t, split: t - prev });
      haptic();
      put(clear(lapsEl), h('div', { class: 'card flush' }, h('div', { class: 'list' }, laps.slice().reverse().map((l, i) => h('div', { class: 'li' },
        h('span', { class: 'badge num' }, String(laps.length - i)),
        h('div', { class: 'li-main num' }, fmtClock(l.split)),
        h('div', { class: 'li-end num muted' }, fmtClock(l.t)))))));
    }

    function upd() {
      const s = timer.state;
      const sg = s.segment;
      const phase = phaseOf(s);
      if (!s.started) face.update({ time: mode === 'stopwatch' ? 0 : segmentsDuration(segs.filter((x) => x.kind !== 'prep')), phase: 'idle', label, sub: 'tap play', countdown: mode !== 'stopwatch' });
      else if (s.done) face.update({ time: s.totalElapsed - (segs[0]?.kind === 'prep' ? segs[0].sec : 0), phase: 'done', label: 'Done', sub: rc ? `${rc.get()} rounds` : '', countdown: false });
      else {
        const lab = sg.kind === 'prep' ? 'Get ready' : sg.kind === 'rest' ? 'Rest' : mode === 'stopwatch' ? 'Elapsed' : mode === 'amrap' ? 'AMRAP' : 'Work';
        const sub = s.paused ? 'paused' : s.totalRemaining != null && sg.kind !== 'prep' ? `${fmtClock(s.totalRemaining, { countdown: true })} left` : '';
        face.update({ time: faceTime(s), progress: s.progress, phase, label: lab, sub, countdown: !s.open });
      }
      const r = sg?.meta?.rounds > 1 ? `${mode === 'emom' ? 'Minute' : 'Round'} ${Math.max(1, sg.meta.round)} / ${sg.meta.rounds}` : '';
      roundsEl.textContent = mode === 'amrap' || mode === 'stopwatch' ? '' : r;
      ctl.sync(s.running, { started: s.started, done: s.done });
    }

    if (mode === 'amrap') rc = roundCounter(0, () => {}, { label: 'Rounds' });
    put(root, h('div', { class: 'tm-run' },
      h('div', { class: 'row between' },
        h('button', { class: 'icon-btn filled', 'aria-label': 'Close timer', on: { click: () => setup() } }, icon('x')),
        h('span', { class: 'eyebrow' }, label),
        h('span', { style: { width: '44px' } })),
      roundsEl,
      h('div', { class: 'wo-stage' }, face.el),
      rc ? rc.el : null,
      ctl.el,
      mode === 'stopwatch' ? lapsEl : null,
      h('button', { class: 'btn ghost block', on: { click: () => run() } }, icon('repeat'), 'Restart')));
    upd();
    tick = setInterval(upd, 200);
  }

  setup();
  return () => stopAll();
}
