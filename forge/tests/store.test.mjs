import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, normalize, defaultState, addDays, daysBetween, todayISO, STORAGE_KEY, sel } from '../js/store.js';

function mem(initial) {
  const m = new Map(initial ? [[STORAGE_KEY, initial]] : []);
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

test('fresh store has defaults and persists updates', () => {
  const backing = mem();
  const s = createStore(backing);
  assert.equal(s.get().profile.onboarded, false);
  s.update((d) => { d.profile.name = 'Max'; });
  assert.equal(JSON.parse(backing.getItem(STORAGE_KEY)).profile.name, 'Max');
  assert.equal(createStore(backing).get().profile.name, 'Max');
});

test('corrupt JSON falls back to defaults and keeps a backup copy', () => {
  const backing = mem('{not json');
  const s = createStore(backing);
  assert.ok(s.loadError);
  assert.equal(s.get().version, defaultState().version);
  assert.ok([...backing.m.keys()].some((k) => k.includes(':corrupt:')));
});

test('normalize repairs wrong types and keeps new defaults', () => {
  const n = normalize({ profile: { name: 'A', bells: [{ kg: '24', count: 5 }, { kg: -1 }], equipment: null }, sessions: 'x', foodLog: { '2026-01-01': 'bad', '2026-01-02': [] }, plan: { weeks: 'no' } });
  assert.equal(n.profile.name, 'A');
  assert.deepEqual(n.profile.bells, [{ kg: 24, count: 2 }]);
  assert.equal(n.profile.equipment.row, false);
  assert.deepEqual(n.sessions, []);
  assert.equal(n.foodLog['2026-01-01'], undefined);
  assert.deepEqual(n.foodLog['2026-01-02'], []);
  assert.equal(n.plan, null);
  assert.equal(n.settings.sound, true);
});

test('subscribers fire and import validates', () => {
  const s = createStore(mem());
  let calls = 0;
  const off = s.subscribe(() => calls++);
  s.update((d) => { d.water['2026-01-01'] = 500; });
  off();
  s.update((d) => { d.water['2026-01-01'] = 750; });
  assert.equal(calls, 1);
  assert.throws(() => s.importJSON('{"foo":1}'));
  s.importJSON(JSON.stringify({ profile: { name: 'B' } }));
  assert.equal(s.get().profile.name, 'B');
});

test('date helpers', () => {
  assert.equal(addDays('2026-02-27', 2), '2026-03-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(daysBetween('2026-01-01', '2026-03-01'), 59);
  assert.match(todayISO(), /^\d{4}-\d{2}-\d{2}$/);
});

test('selectors', () => {
  const st = defaultState();
  st.foodLog['2026-01-01'] = [{ kcal: 100, p: 10, c: 5, f: 2 }, { kcal: 50, p: 1, c: 10, f: 0, fiber: 3 }];
  assert.deepEqual(sel.totalsFor(st, '2026-01-01'), { kcal: 150, p: 11, c: 15, f: 2, fiber: 3 });
  st.bodyweight = [{ date: '2026-01-02', kg: 80 }, { date: '2026-01-01', kg: 81 }];
  assert.equal(sel.latestWeight(st), 80);
});
