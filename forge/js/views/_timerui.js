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
 * Big ring timer face. update({time, progress, phase, label, sub, countdown}) — cheap, call every tick.
 * phase: 'work' | 'rest' | 'prep' | 'idle' | 'done' | 'open'
 */
export function timerFace({ size = 'lg' } = {}) {
  const R = 46, C = 2 * Math.PI * R;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'tf-ring');
  const track = document.createElementNS(NS, 'circle');
  const arc = document.createElementNS(NS, 'circle');
  for (const c of [track, arc]) { c.setAttribute('cx', 50); c.setAttribute('cy', 50); c.setAttribute('r', R); c.setAttribute('fill', 'none'); }
  track.setAttribute('class', 'tf-track');
  arc.setAttribute('class', 'tf-arc');
  arc.setAttribute('stroke-dasharray', `${C} ${C}`);
  arc.setAttribute('transform', 'rotate(-90 50 50)');
  svg.append(track, arc);

  const phaseEl = h('div', { class: 'tf-phase' }, '');
  const timeEl = h('div', { class: 'tf-time', role: 'timer', 'aria-live': 'off' }, '0:00');
  const subEl = h('div', { class: 'tf-sub' }, '');
  const el = h('div', { class: 'tf tf-' + size + ' phase-idle' }, svg, h('div', { class: 'tf-center' }, phaseEl, timeEl, subEl));
  let lastPhase = null, lastTime = null;

  function update({ time, progress = null, phase = 'work', label, sub, countdown = true }) {
    const t = fmtClock(time, { countdown });
    if (t !== lastTime) { timeEl.textContent = t; lastTime = t; timeEl.classList.toggle('long', t.length > 5); }
    if (phase !== lastPhase) {
      el.className = 'tf tf-' + size + ' phase-' + phase;
      lastPhase = phase;
    }
    phaseEl.textContent = label ?? PHASE[phase] ?? '';
    subEl.textContent = sub ?? '';
    const p = progress == null ? (phase === 'open' ? 1 : 0) : Math.max(0, Math.min(1, progress));
    arc.setAttribute('stroke-dashoffset', String(C * p)); // ring empties as time runs down
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
