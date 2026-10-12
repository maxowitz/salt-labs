// FORGE timer engine — drift-free interval timer, audio/voice cues, wake lock, Block → segments.
// Node-import-safe: no DOM / Web API access at import time. See docs/PROMPT.md §6.5a.
import { store } from '../store.js';

const settings = () => {
  try { return store.get().settings || {}; } catch { return {}; }
};

// A segment with sec = Infinity (or null/0 and open:true) is open-ended: it counts up until skip().
const isOpen = (seg) => !seg || seg.open || !Number.isFinite(seg.sec) || seg.sec <= 0;

/**
 * IntervalTimer — walks a list of segments using wall-clock deltas (never drifts, survives tab sleep).
 *   new IntervalTimer(segments, { onTick, onSegment, onDone, now, tickMs, cues, restore })
 * - onTick(state) every tick; onSegment(state, prev) when a segment starts; onDone(state) at the end.
 * - cues (default true): 3-2-1 'tick' beeps before a timed segment ends, 'go'/'rest' at segment start, 'done' at end.
 * - now: injectable clock (ms) for tests. tickMs: 0 disables the internal interval (call tick() manually).
 * - restore: a snapshot() from a previous instance, to resume after reload.
 */
export class IntervalTimer {
  constructor(segments, { onTick, onSegment, onDone, now, tickMs = 200, cues = true, restore, doneBeep = 'done', doneSay = 'Done' } = {}) {
    this.doneBeep = doneBeep; this.doneSay = doneSay;
    this.segments = (segments || []).map((s) => ({ ...s }));
    this.onTick = onTick; this.onSegment = onSegment; this.onDone = onDone;
    this.now = now || (() => Date.now());
    this.tickMs = tickMs;
    this.cues = cues;
    this.idx = 0;
    this.segStart = null;   // ms timestamp at which the current segment's elapsed was 0
    this.pausedAt = null;   // ms timestamp when paused (null = not paused)
    this.started = false;
    this.done = false;
    this.lastCue = null;    // whole seconds remaining last cued
    this.handle = null;
    this.segLog = [];       // [{index, sec}] actual time spent in each completed segment
    if (restore) this._restore(restore);
  }

  _restore(snap) {
    this.idx = Math.max(0, Math.min(this.segments.length - 1, snap.index | 0));
    this.segLog = Array.isArray(snap.segLog) ? snap.segLog.slice() : [];
    this.done = !!snap.done;
    if (!snap.started || this.done) { this.started = !!snap.started; return; }
    this.started = true;
    const t = this.now();
    // snapshot stores segment-elapsed so it is independent of when it is restored
    const elapsedMs = Math.max(0, +snap.segElapsedMs || 0);
    const awayMs = snap.paused ? 0 : Math.max(0, t - (+snap.savedAt || t));
    this.segStart = t - elapsedMs - awayMs;
    this.pausedAt = snap.paused ? t : null;
    this.lastCue = null;
    if (!snap.paused) this._loop();
  }

  get running() { return this.started && !this.done && this.pausedAt == null; }
  get paused() { return this.started && !this.done && this.pausedAt != null; }

  get current() { return this.segments[this.idx] || null; }

  _segElapsedMs(t = this.now()) {
    if (!this.started || this.segStart == null) return 0;
    const ref = this.pausedAt != null ? this.pausedAt : t;
    return Math.max(0, ref - this.segStart);
  }

  get state() {
    const seg = this.current;
    const segElapsed = this._segElapsedMs() / 1000;
    const open = isOpen(seg);
    const segRemaining = open ? null : Math.max(0, seg.sec - segElapsed);
    let totalSec = 0, anyOpen = false;
    for (const s of this.segments) { if (isOpen(s)) anyOpen = true; else totalSec += s.sec; }
    // completed segments (actual time for skipped/open ones) + the running one
    const doneSec = this.segLog.reduce((acc, l) => acc + (l.index < this.idx || this.done ? +l.sec || 0 : 0), 0);
    const totalElapsed = doneSec + (this.done ? 0 : open ? segElapsed : Math.min(seg?.sec || 0, segElapsed));
    return {
      index: this.idx,
      count: this.segments.length,
      segment: seg,
      next: this.segments[this.idx + 1] || null,
      segElapsed,
      segRemaining,
      open,
      progress: open || !seg ? null : Math.min(1, segElapsed / seg.sec),
      totalSec: anyOpen ? null : totalSec,
      totalElapsed,
      totalRemaining: anyOpen ? null : this.done ? 0 : (segRemaining || 0) + this.segments.slice(this.idx + 1).reduce((acc, x) => acc + x.sec, 0),
      running: this.running,
      paused: this.paused,
      started: this.started,
      done: this.done,
      segLog: this.segLog,
    };
  }

  /** Serializable snapshot for persistence (see restore option). */
  snapshot() {
    return {
      index: this.idx, started: this.started, done: this.done, paused: this.paused,
      segElapsedMs: Math.round(this._segElapsedMs()), savedAt: this.now(), segLog: this.segLog.slice(),
    };
  }

  start() {
    if (this.done || !this.segments.length) { if (!this.segments.length) this._finish(); return this; }
    if (this.started) return this.resume();
    this.started = true;
    this.segStart = this.now();
    this.pausedAt = null;
    this._enter(null);
    this._loop();
    return this;
  }

  pause() {
    if (!this.running) return this;
    this.pausedAt = this.now();
    this._stopLoop();
    this._emitTick();
    return this;
  }

  resume() {
    if (!this.paused) return this;
    this.segStart += this.now() - this.pausedAt;
    this.pausedAt = null;
    this._loop();
    this._emitTick();
    return this;
  }

  toggle() { return this.running ? this.pause() : this.paused ? this.resume() : this.start(); }

  /** Jump to the next segment now (also the way to finish an open-ended segment). */
  skip() {
    if (!this.started) { this.start(); }
    if (this.done) return this;
    this._advance(this.now(), true);
    return this;
  }

  /** Restart the current segment, or go to the previous one if < 2 s in. */
  back() {
    if (!this.started || this.done) return this;
    const t = this.now();
    const prev = this.current;
    if (this._segElapsedMs(t) < 2000 && this.idx > 0) {
      this.idx -= 1;
      this.segLog = this.segLog.filter((l) => l.index < this.idx);
    }
    this.segStart = this.pausedAt != null ? this.pausedAt : t;
    this.lastCue = null;
    this._enter(prev);
    return this;
  }

  /** Add (or remove, with negative sec) time to the current timed segment. */
  adjust(sec) {
    const seg = this.current;
    if (!seg || isOpen(seg)) return this;
    seg.sec = Math.max(1, seg.sec + sec);
    this.lastCue = null;
    this._emitTick();
    if (this.started && this._segElapsedMs() >= seg.sec * 1000) this.tick();
    return this;
  }

  /** End now without completing remaining segments (current partial segment is not logged). Silent. */
  end() {
    if (this.done) return this;
    this.started = true;
    this.done = true;
    this._stopLoop();
    this._emitTick();
    return this;
  }

  stop() { this._stopLoop(); this.onTick = this.onSegment = this.onDone = null; return this; }

  /** Advance the clock: called by the internal interval, or manually in tests. */
  tick() {
    if (!this.running) return this;
    const t = this.now();
    let steps = 0;
    while (this.running) {
      const seg = this.current;
      if (isOpen(seg)) break;
      const el = t - this.segStart;
      if (el < seg.sec * 1000) break;
      this._advance(this.segStart + seg.sec * 1000, false, ++steps > 1 || t - (this.segStart + seg.sec * 1000) > 1500);
    }
    if (!this.running) return this;
    // 3-2-1 cues
    const st = this.state;
    if (this.cues && st.segRemaining != null && this.current.sec > 4) {
      const whole = Math.ceil(st.segRemaining);
      if (whole <= 3 && whole >= 1 && whole !== this.lastCue && st.segRemaining > 0.05) {
        this.lastCue = whole;
        beep('tick');
      }
    }
    this._emitTick();
    return this;
  }

  _advance(at, manual, silent = false) {
    const seg = this.current;
    const spent = Math.max(0, ((this.pausedAt != null ? this.pausedAt : at) - this.segStart) / 1000);
    this.segLog = this.segLog.filter((l) => l.index !== this.idx);
    this.segLog.push({ index: this.idx, sec: manual || isOpen(seg) ? Math.round(spent * 10) / 10 : seg.sec });
    if (this.idx >= this.segments.length - 1) { this._finish(silent); return; }
    const prev = seg;
    this.idx += 1;
    this.segStart = this.pausedAt != null ? this.pausedAt : at;
    this.lastCue = null;
    this._enter(prev, silent);
  }

  _enter(prev, silent = false) {
    const seg = this.current;
    if (this.cues && !silent && seg) {
      beep(seg.kind === 'rest' ? 'rest' : seg.kind === 'prep' ? 'tick' : 'go');
      if (seg.say) speak(seg.say);
    }
    try { this.onSegment?.(this.state, prev); } catch (e) { console.error(e); }
    this._emitTick();
  }

  _finish(silent = false) {
    this.done = true;
    this._stopLoop();
    if (this.cues && !silent) { if (this.doneBeep) beep(this.doneBeep); if (this.doneSay) speak(this.doneSay); }
    try { this.onDone?.(this.state); } catch (e) { console.error(e); }
    this._emitTick();
  }

  _emitTick() { try { this.onTick?.(this.state); } catch (e) { console.error(e); } }

  _loop() {
    this._stopLoop();
    if (this.tickMs > 0 && typeof setInterval === 'function') this.handle = setInterval(() => this.tick(), this.tickMs);
  }
  _stopLoop() { if (this.handle) clearInterval(this.handle); this.handle = null; }
}

// ---------- Audio ----------
let ctx = null;
function audio() {
  if (ctx) return ctx;
  // Creating a context before any user gesture only produces a suspended context and a console warning.
  const ua = globalThis.navigator?.userActivation;
  if (ua && !ua.hasBeenActive) return null;
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return null;
  try { ctx = new AC(); } catch { ctx = null; }
  return ctx;
}

/** Call from a user gesture (e.g. Start button) so iOS lets audio play later. */
export function unlockAudio() {
  const a = audio();
  if (a && a.state === 'suspended') a.resume().catch(() => {});
  try {
    if (a) { const b = a.createBuffer(1, 1, 22050); const s = a.createBufferSource(); s.buffer = b; s.connect(a.destination); s.start(0); }
  } catch {}
}

const TONES = {
  tick: [[880, 0, 0.09]],
  go: [[1320, 0, 0.32]],
  rest: [[660, 0, 0.16], [440, 0.18, 0.26]],
  done: [[880, 0, 0.14], [1100, 0.17, 0.14], [1320, 0.34, 0.42]],
};

export function beep(kind = 'tick') {
  if (settings().sound === false) return;
  const a = audio();
  if (!a) return;
  try {
    if (a.state === 'suspended') a.resume().catch(() => {});
    const t0 = a.currentTime + 0.01;
    for (const [freq, at, dur] of TONES[kind] || TONES.tick) {
      const o = a.createOscillator(), g = a.createGain();
      o.type = kind === 'tick' ? 'sine' : 'triangle';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0 + at);
      g.gain.exponentialRampToValueAtTime(0.5, t0 + at + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
      o.connect(g).connect(a.destination);
      o.start(t0 + at); o.stop(t0 + at + dur + 0.05);
    }
  } catch {}
  if (kind !== 'tick' && settings().haptics !== false) {
    try { globalThis.navigator?.vibrate?.(kind === 'done' ? [80, 60, 80, 60, 160] : kind === 'go' ? 120 : [60, 60, 60]); } catch {}
  }
}

export function speak(text) {
  if (!text || settings().voice === false) return;
  const synth = globalThis.speechSynthesis;
  const U = globalThis.SpeechSynthesisUtterance;
  if (!synth || !U) return;
  try {
    synth.cancel();
    const u = new U(String(text));
    u.rate = 1.05; u.pitch = 1; u.volume = 1;
    synth.speak(u);
  } catch {}
}

/** Keep the screen awake while active. Returns a release fn. Re-acquires after tab becomes visible. */
export function wakeLock() {
  const nav = globalThis.navigator;
  const doc = globalThis.document;
  if (!nav?.wakeLock?.request) return () => {};
  let sentinel = null, released = false;
  const acquire = async () => {
    if (released || doc?.visibilityState === 'hidden') return;
    try { sentinel = await nav.wakeLock.request('screen'); if (released) sentinel.release().catch(() => {}); } catch { sentinel = null; }
  };
  const onVis = () => { if (doc.visibilityState === 'visible' && (!sentinel || sentinel.released)) acquire(); };
  acquire();
  doc?.addEventListener?.('visibilitychange', onVis);
  return () => {
    released = true;
    doc?.removeEventListener?.('visibilitychange', onVis);
    try { sentinel?.release?.().catch(() => {}); } catch {}
    sentinel = null;
  };
}

// ---------- Block → segments ----------
const PREP_SEC = 10;
const nItems = (b) => (Array.isArray(b?.items) ? b.items : []);

/**
 * buildSegments(block, {prep}) → [{label, sec, kind:'work'|'rest'|'prep', meta}]
 * meta: {round, rounds, items:[Item], itemIndex?, blockKind}
 * Supports emom, amrap, intervals, tabata, circuit, cardio/station (per item), warmup/cooldown (timed items).
 * Open-ended segments (sec: Infinity, open: true) count up until skipped (e.g. a 400 m rep or a circuit station by reps).
 */
export function buildSegments(block, { prep = PREP_SEC } = {}) {
  if (!block) return [];
  const items = nItems(block);
  const kind = block.kind;
  const segs = [];
  const add = (label, sec, k, meta = {}) => {
    const open = !(Number.isFinite(sec) && sec > 0);
    segs.push({ label, sec: open ? Infinity : Math.round(sec), kind: k, open: open || undefined, meta: { blockKind: kind, ...meta } });
  };
  if (prep > 0) add('Get ready', prep, 'prep', { round: 0, rounds: 0, items: items.slice(0, 1) });

  if (kind === 'emom') {
    const every = +block.workSec > 0 ? +block.workSec : 60;
    const total = +block.minutes > 0 ? Math.round((block.minutes * 60) / every) : +block.rounds > 0 ? +block.rounds : 10;
    for (let r = 0; r < total; r++) {
      const its = block.alternate && items.length ? [items[r % items.length]] : items;
      add(`Minute ${r + 1}`, every, 'work', { round: r + 1, rounds: total, items: its, itemIndex: block.alternate ? r % (items.length || 1) : null });
    }
  } else if (kind === 'amrap') {
    const sec = +block.durationSec > 0 ? +block.durationSec : +block.minutes > 0 ? block.minutes * 60 : 600;
    add('AMRAP', sec, 'work', { round: 1, rounds: 1, items, amrap: true });
  } else if (kind === 'intervals' || kind === 'tabata') {
    const tabata = kind === 'tabata';
    const rounds = +block.rounds > 0 ? +block.rounds : tabata ? 8 : 6;
    const work = +block.workSec > 0 ? +block.workSec : tabata ? 20 : null;
    const rest = +block.restSec >= 0 && block.restSec != null ? +block.restSec : tabata ? 10 : 60;
    for (let r = 0; r < rounds; r++) {
      const ii = items.length ? r % items.length : null;
      const it = ii == null ? [] : [items[ii]];
      add(`Round ${r + 1}`, work ?? (it[0]?.timeSec || null), 'work', { round: r + 1, rounds, items: it, itemIndex: ii });
      if (r < rounds - 1 && rest > 0) add('Rest', rest, 'rest', { round: r + 1, rounds, items: items.length ? [items[(r + 1) % items.length]] : [], upcoming: true });
    }
  } else if (kind === 'circuit') {
    const rounds = +block.rounds > 0 ? +block.rounds : 3;
    const rest = +block.restSec > 0 ? +block.restSec : 0;
    for (let r = 0; r < rounds; r++) {
      items.forEach((it, i) => {
        add(`Round ${r + 1}`, it.timeSec || null, 'work', { round: r + 1, rounds, items: [it], itemIndex: i });
        if (it.restSec > 0 && i < items.length - 1) add('Rest', it.restSec, 'rest', { round: r + 1, rounds, items: [items[i + 1]], upcoming: true });
      });
      if (r < rounds - 1 && rest > 0) add('Rest', rest, 'rest', { round: r + 1, rounds, items: items.slice(0, 1), upcoming: true, betweenRounds: true });
    }
  } else if (kind === 'cardio' || kind === 'station') {
    items.forEach((it, i) => {
      const timed = it.timeSec > 0 && !(it.distanceM > 0);
      add(it.note || 'Go', timed ? it.timeSec : null, 'work', { round: i + 1, rounds: items.length, items: [it], itemIndex: i });
      if (it.restSec > 0 && i < items.length - 1) add('Rest', it.restSec, 'rest', { round: i + 1, rounds: items.length, items: [items[i + 1]], upcoming: true });
    });
  } else {
    // warmup / cooldown / strength fallback: each item once, timed if timeSec
    items.forEach((it, i) => add('Next', it.timeSec || null, 'work', { round: i + 1, rounds: items.length, items: [it], itemIndex: i }));
  }
  if (segs.length === 1 && segs[0].kind === 'prep') return [];
  return segs;
}

/** Total planned seconds of a segment list (open segments count 0). */
export function segmentsDuration(segs) {
  return (segs || []).reduce((a, s) => a + (Number.isFinite(s.sec) ? s.sec : 0), 0);
}
