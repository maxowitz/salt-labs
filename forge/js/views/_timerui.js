// Shared big-timer UI pieces for the workout player (#/workout) and free timers (#/timer).
import { h, icon } from '../ui.js';

/** Countdown-friendly clock: ceil for countdowns so "0:01" shows until the very end. */
export function fmtClock(sec, { countdown = false } = {}) {
  if (sec == null || !Number.isFinite(+sec)) return '–:––';
  let s = countdown ? Math.ceil(Math.max(0, sec) - 1e-6) : Math.floor(Math.max(0, sec));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return hh ? `${hh}:${p(mm)}:${p(ss)}` : `${mm}:${p(ss)}`;
}

const PHASE = { work: 'Work', rest: 'Rest', prep: 'Get ready' };

/**
 * Instrument timer face: a 60-tick bezel (docs/DESIGN.md §5.9).
 * update({time, progress, phase, label, sub, countdown}) — cheap, call every tick (only changed ticks are touched).
 * progress = fraction of the segment elapsed (0..1): elapsed ticks go dim, remaining stay ink, the current tick is accent.
 * phase: 'work' | 'rest' | 'prep' | 'idle' | 'done' | 'open' ('open' sweeps the seconds of the current minute).
 */
export function timerFace({ size = 'lg' } = {}) {
  const NS = 'http://www.w3.org/2000/svg';
  const N = 60, CX = 50, CY = 50, R = 49;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'tf-ring tf-dial');
  const tickEls = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 - Math.PI / 2, maj = i % 5 === 0, len = maj ? 5.2 : 2.9;
    const ln = document.createElementNS(NS, 'line');
    ln.setAttribute('x1', (CX + Math.cos(a) * R).toFixed(2)); ln.setAttribute('y1', (CY + Math.sin(a) * R).toFixed(2));
    ln.setAttribute('x2', (CX + Math.cos(a) * (R - len)).toFixed(2)); ln.setAttribute('y2', (CY + Math.sin(a) * (R - len)).toFixed(2));
    ln.setAttribute('class', 'tf-tick' + (maj ? ' maj' : ''));
    svg.append(ln);
    tickEls.push(ln);
  }
  for (const [i, t] of [[0, '60'], [15, '15'], [30, '30'], [45, '45']]) {
    const a = (i / N) * Math.PI * 2 - Math.PI / 2, r = R - 10;
    const tx = document.createElementNS(NS, 'text');
    tx.setAttribute('x', (CX + Math.cos(a) * r).toFixed(2)); tx.setAttribute('y', (CY + Math.sin(a) * r + 1.3).toFixed(2));
    tx.setAttribute('text-anchor', 'middle'); tx.setAttribute('class', 'tf-num');
    tx.textContent = t;
    svg.append(tx);
  }
  const state = new Array(N).fill('');

  const phaseEl = h('div', { class: 'tf-phase' }, '');
  const timeEl = h('div', { class: 'tf-time', role: 'timer', 'aria-live': 'off' }, '0:00');
  const subEl = h('div', { class: 'tf-sub' }, '');
  const el = h('div', { class: 'tf tf-' + size + ' phase-idle' }, svg, h('div', { class: 'tf-center' }, phaseEl, timeEl, subEl));
  let lastPhase = null, lastTime = null;

  function paint(elapsedTicks, nowIdx) {
    for (let i = 0; i < N; i++) {
      const c = i === nowIdx ? 'now' : i < elapsedTicks ? 'off' : '';
      if (state[i] !== c) { state[i] = c; tickEls[i].classList.toggle('off', c === 'off'); tickEls[i].classList.toggle('now', c === 'now'); }
    }
  }

  function update({ time, progress = null, phase = 'work', label, sub, countdown = true }) {
    const t = fmtClock(time, { countdown });
    if (t !== lastTime) { timeEl.textContent = t; lastTime = t; timeEl.classList.toggle('long', t.length > 5); }
    if (phase !== lastPhase) {
      el.className = 'tf tf-' + size + ' phase-' + phase;
      lastPhase = phase;
    }
    phaseEl.textContent = label ?? PHASE[phase] ?? '';
    subEl.textContent = sub ?? '';
    if (phase === 'open') {
      const sec = Math.floor(Math.max(0, +time || 0)) % N;
      paint(sec, sec); // sweep: seconds of the current minute
    } else if (phase === 'idle') {
      paint(0, -1);
    } else if (phase === 'done') {
      paint(0, -1); // full bezel, coloured by .phase-done
    } else {
      const p = progress == null ? 0 : Math.max(0, Math.min(1, progress));
      const e = Math.floor(p * N + 1e-6);
      paint(e, p > 0 && p < 1 ? Math.min(N - 1, e) : -1);
    }
    const warn = countdown && phase !== 'idle' && phase !== 'done' && time != null && time <= 3.05 && time > 0;
    el.classList.toggle('warn', !!warn);
  }
  return { el, update };
}

/** Transport controls: back · play/pause · skip. Callbacks receive nothing; call sync(running) to refresh. */
export function timerControls({ onBack, onToggle, onSkip, labels = {} }) {
  const play = h('button', { class: 'tc-main', type: 'button', 'aria-label': 'Start', on: { click: () => onToggle?.() } }, icon('play', 34));
  const back = h('button', { class: 'tc-side', type: 'button', 'aria-label': labels.back || 'Back / restart interval', on: { click: () => onBack?.() } }, icon('back', 24));
  const skip = h('button', { class: 'tc-side', type: 'button', 'aria-label': labels.skip || 'Skip interval', on: { click: () => onSkip?.() } }, icon('skip', 24));
  const el = h('div', { class: 'tc' }, back, play, skip);
  let last = null;
  function sync(running, { started = true, done = false } = {}) {
    const key = `${running}|${started}|${done}`;
    if (key === last) return;
    last = key;
    play.replaceChildren(icon(running ? 'pause' : 'play', 34));
    play.setAttribute('aria-label', running ? 'Pause' : started ? 'Resume' : 'Start');
    play.classList.toggle('paused', !running && started && !done);
    back.disabled = !started || done;
    skip.disabled = done;
  }
  return { el, sync, play, back, skip };
}

/** Big tap counter (AMRAP rounds). */
export function roundCounter(value, onChange, { label = 'Rounds' } = {}) {
  let v = value || 0;
  const out = h('output', { class: 'rc-val', 'aria-live': 'polite' }, String(v));
  const set = (nv) => { v = Math.max(0, nv); out.textContent = String(v); onChange?.(v); };
  const el = h('div', { class: 'rc' },
    h('button', { class: 'rc-minus', type: 'button', 'aria-label': 'Remove a round', on: { click: () => set(v - 1) } }, icon('minus', 22)),
    h('button', { class: 'rc-plus', type: 'button', 'aria-label': 'Add a round', on: { click: () => { set(v + 1); try { navigator.vibrate?.(20); } catch {} } } },
      h('span', { class: 'rc-k' }, label), out, h('span', { class: 'rc-hint' }, 'tap +1')));
  return { el, get: () => v, set };
}

/** Segment-aware description used by both screens. */
export function phaseOf(state) {
  if (!state) return 'idle';
  if (state.done) return 'done';
  if (!state.started) return 'idle';
  const k = state.segment?.kind;
  if (state.open) return 'open';
  return k === 'rest' ? 'rest' : k === 'prep' ? 'prep' : 'work';
}

/** Value to show on the face for a state: remaining for timed segments, elapsed for open ones. */
export function faceTime(state) {
  if (!state) return 0;
  if (state.open) return state.segElapsed;
  return state.segRemaining ?? 0;
}
