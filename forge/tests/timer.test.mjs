// node --test forge/tests/timer.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IntervalTimer, buildSegments, segmentsDuration, beep, speak, wakeLock } from '../js/engine/timer.js';

function clock(t0 = 1_000_000) {
  let t = t0;
  return { now: () => t, advance: (ms) => { t += ms; } };
}
const segs = (...secs) => secs.map((sec, i) => ({ label: 'S' + i, sec, kind: i % 2 ? 'rest' : 'work' }));
const mk = (segments, c, extra = {}) => new IntervalTimer(segments, { now: c.now, tickMs: 0, cues: false, ...extra });

test('runs through segments by wall-clock deltas and fires callbacks', () => {
  const c = clock();
  const seen = [];
  let done = 0;
  const t = mk(segs(10, 5, 10), c, { onSegment: (s) => seen.push(s.index), onDone: () => done++ });
  t.start();
  assert.deepEqual(seen, [0]);
  c.advance(4000); t.tick();
  assert.equal(t.state.index, 0);
  assert.equal(Math.round(t.state.segRemaining), 6);
  c.advance(6000); t.tick();
  assert.equal(t.state.index, 1);
  assert.deepEqual(seen, [0, 1]);
  c.advance(15_000); t.tick();
  assert.equal(done, 1);
  assert.equal(t.state.done, true);
  assert.equal(t.state.totalElapsed, 25);
});

test('does not drift: a single late tick catches up across several segments', () => {
  const c = clock();
  const t = mk(segs(10, 10, 10, 10), c);
  t.start();
  c.advance(25_500); t.tick();          // tab slept for 25.5 s
  assert.equal(t.state.index, 2);
  assert.ok(Math.abs(t.state.segElapsed - 5.5) < 1e-9);
  assert.ok(Math.abs(t.state.totalElapsed - 25.5) < 1e-9);
});

test('pause freezes time; resume continues where it left off', () => {
  const c = clock();
  const t = mk(segs(30), c);
  t.start();
  c.advance(10_000); t.tick();
  t.pause();
  assert.equal(t.state.paused, true);
  c.advance(60_000); t.tick();
  assert.equal(Math.round(t.state.segElapsed), 10);
  t.resume();
  c.advance(5_000); t.tick();
  assert.equal(Math.round(t.state.segElapsed), 15);
  assert.equal(t.state.running, true);
});

test('skip advances immediately and records actual time; back restarts / goes back', () => {
  const c = clock();
  const t = mk(segs(30, 10, 30), c);
  t.start();
  c.advance(12_000);
  t.skip();
  assert.equal(t.state.index, 1);
  assert.deepEqual(t.state.segLog, [{ index: 0, sec: 12 }]);
  c.advance(5_000); t.tick();
  t.back();                              // > 2 s in → restart current
  assert.equal(t.state.index, 1);
  assert.equal(Math.round(t.state.segElapsed), 0);
  t.back();                              // < 2 s in → previous segment
  assert.equal(t.state.index, 0);
  assert.equal(t.state.segElapsed, 0);
});

test('open-ended segments count up until skipped', () => {
  const c = clock();
  const t = mk([{ label: 'Run 400 m', sec: Infinity, kind: 'work' }, { label: 'Rest', sec: 60, kind: 'rest' }], c);
  t.start();
  c.advance(95_000); t.tick();
  assert.equal(t.state.index, 0);
  assert.equal(t.state.segRemaining, null);
  assert.equal(Math.round(t.state.segElapsed), 95);
  t.skip();
  assert.equal(t.state.index, 1);
  assert.equal(t.state.segLog[0].sec, 95);
});

test('adjust adds and removes time on the current segment', () => {
  const c = clock();
  const t = mk(segs(60), c);
  t.start();
  t.adjust(15);
  assert.equal(t.state.segRemaining, 75);
  t.adjust(-30);
  assert.equal(t.state.segRemaining, 45);
  t.adjust(-100);                        // floors at 1 s
  c.advance(1000); t.tick();
  assert.equal(t.state.done, true);
});

test('snapshot/restore resumes position including time away while running', () => {
  const c = clock();
  const a = mk(segs(60, 30, 60), c);
  a.start();
  c.advance(70_000); a.tick();           // 10 s into segment 1
  const snap = JSON.parse(JSON.stringify(a.snapshot()));
  a.stop();
  c.advance(5_000);                      // page reload took 5 s
  const b = mk(segs(60, 30, 60), c, { restore: snap });
  b.tick();
  assert.equal(b.state.index, 1);
  assert.equal(Math.round(b.state.segElapsed), 15);
  // paused snapshot does not accumulate time
  b.pause();
  const snap2 = b.snapshot();
  c.advance(100_000);
  const d = mk(segs(60, 30, 60), c, { restore: snap2 });
  assert.equal(d.state.paused, true);
  assert.equal(Math.round(d.state.segElapsed), 15);
});

test('3-2-1 cues fire once per second near the end (cues on, sound off in node)', () => {
  const c = clock();
  const t = new IntervalTimer(segs(10, 10), { now: c.now, tickMs: 0 });
  t.start();
  for (let i = 0; i < 40; i++) { c.advance(250); t.tick(); }
  assert.equal(t.state.index, 1);        // cues do not throw without WebAudio
});

test('buildSegments: emom', () => {
  const block = { kind: 'emom', minutes: 10, items: [{ exId: 'kb-swing', reps: 10 }, { exId: 'kb-goblet-squat', reps: 5 }] };
  const s = buildSegments(block);
  assert.equal(s[0].kind, 'prep');
  const work = s.filter((x) => x.kind === 'work');
  assert.equal(work.length, 10);
  assert.ok(work.every((x) => x.sec === 60));
  assert.equal(work[0].meta.items.length, 2);   // not alternating → all items each minute
  assert.equal(work[9].meta.round, 10);
  const alt = buildSegments({ ...block, alternate: true }, { prep: 0 });
  assert.equal(alt.length, 10);
  assert.equal(alt[0].meta.items[0].exId, 'kb-swing');
  assert.equal(alt[1].meta.items[0].exId, 'kb-goblet-squat');
  assert.equal(segmentsDuration(alt), 600);
});

test('buildSegments: amrap', () => {
  const s = buildSegments({ kind: 'amrap', durationSec: 720, items: [{ exId: 'a', reps: 5 }, { exId: 'b', reps: 10 }] }, { prep: 0 });
  assert.equal(s.length, 1);
  assert.equal(s[0].sec, 720);
  assert.equal(s[0].meta.amrap, true);
  assert.equal(s[0].meta.items.length, 2);
  const m = buildSegments({ kind: 'amrap', minutes: 8, items: [] }, { prep: 0 });
  assert.equal(m[0].sec, 480);
});

test('buildSegments: intervals cycle items with rest between rounds (no trailing rest)', () => {
  const s = buildSegments({ kind: 'intervals', rounds: 4, workSec: 40, restSec: 20, items: [{ exId: 'a' }, { exId: 'b' }] }, { prep: 0 });
  assert.equal(s.length, 7);
  assert.deepEqual(s.map((x) => x.kind), ['work', 'rest', 'work', 'rest', 'work', 'rest', 'work']);
  assert.deepEqual(s.filter((x) => x.kind === 'work').map((x) => x.meta.items[0].exId), ['a', 'b', 'a', 'b']);
  assert.equal(segmentsDuration(s), 4 * 40 + 3 * 20);
  // distance intervals without workSec are open-ended (tap when done)
  const d = buildSegments({ kind: 'intervals', rounds: 3, restSec: 90, items: [{ exId: 'run', distanceM: 400 }] }, { prep: 0 });
  assert.equal(d[0].open, true);
  assert.equal(d[1].sec, 90);
});

test('buildSegments: tabata defaults 20/10 x 8 and empty/unknown blocks', () => {
  const s = buildSegments({ kind: 'tabata', items: [{ exId: 'a' }] }, { prep: 0 });
  assert.equal(s.filter((x) => x.kind === 'work').length, 8);
  assert.equal(segmentsDuration(s), 8 * 20 + 7 * 10);
  assert.deepEqual(buildSegments(null), []);
  assert.deepEqual(buildSegments({ kind: 'warmup', items: [] }), []);
});

test('cue helpers are safe without browser APIs', () => {
  beep('go'); speak('hello');
  const release = wakeLock();
  assert.equal(typeof release, 'function');
  release();
});
