// FORGE store — local-first state with schema versioning, safe persistence and pub/sub.
// All values are metric (kg, m, sec, ml). See docs/PROMPT.md §6.2.
// Durability: every save goes to localStorage AND an IndexedDB mirror. On boot, hydrate() restores the
// newer of the two, so data survives a cleared/evicted/over-quota localStorage. Encrypted cloud backup
// lives in sync.js.
import { idbGet, idbSet } from './idb.js';

export const STORAGE_KEY = 'forge:v1';
export const SCHEMA_VERSION = 1;

export function todayISO(d = new Date()) {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
}

export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  const pa = a.split('-').map(Number), pb = b.split('-').map(Number);
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
}

export function uid(prefix = '') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function defaultState() {
  return {
    version: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    savedAt: 0,
    profile: {
      name: '', sex: 'm', age: 35, heightCm: 178, weightKg: 82, units: 'imperial',
      experience: 'intermediate',
      bells: [{ kg: 16, count: 2 }, { kg: 24, count: 2 }, { kg: 32, count: 1 }],
      equipment: { row: false, ski: false, bike: false, pullup: false, sandbag: false, wallball: false },
      daysPerWeek: 5, raceDate: null, division: 'open', goal: 'lose', activity: 'moderate',
      hrMax: null, fiveKSec: null, onboarded: false,
    },
    targets: { auto: true, kcal: 2400, protein: 170, carbs: 250, fat: 70, waterMl: 3200 },
    plan: null,
    sessions: [],
    activeWorkout: null,
    readiness: {},
    foodLog: {},
    customFoods: [],
    favorites: [],
    recentFoods: [],
    mealTemplates: [],
    water: {},
    bodyweight: [],
    settings: { theme: 'dark', sound: true, voice: true, haptics: true },
  };
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Deep-merge saved data over defaults so new fields appear and wrong types are repaired.
export function normalize(raw) {
  const def = defaultState();
  if (!isObj(raw)) return def;
  const out = { ...def };
  for (const k of Object.keys(def)) {
    const dv = def[k], rv = raw[k];
    if (rv === undefined) continue;
    if (Array.isArray(dv)) out[k] = Array.isArray(rv) ? rv : dv;
    else if (isObj(dv)) out[k] = isObj(rv) ? { ...dv, ...rv } : dv;
    else if (dv === null) out[k] = rv ?? null;
    else out[k] = typeof rv === typeof dv ? rv : dv;
  }
  if (isObj(raw.profile)) {
    out.profile.equipment = { ...def.profile.equipment, ...(isObj(raw.profile.equipment) ? raw.profile.equipment : {}) };
    if (!Array.isArray(out.profile.bells)) out.profile.bells = def.profile.bells;
    out.profile.bells = out.profile.bells
      .filter((b) => b && Number.isFinite(+b.kg) && +b.kg > 0)
      .map((b) => ({ kg: +b.kg, count: Math.max(1, Math.min(2, +b.count || 1)) }));
  }
  sanitizeDeep(out, def);
  out.version = SCHEMA_VERSION;
  return out;
}

// ---------- deep sanitising: anything malformed is repaired or dropped so no screen can crash on it ----------
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isISODate(v) {
  if (typeof v !== 'string' || !ISO_RE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
const str = (v, max = 200, dflt = '') => (typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? String(v) : dflt);
const fin = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };
const opt = (v, lo, hi) => (v == null || v === '' ? (v ?? null) : fin(v, lo, hi, null)); // optional numbers stay empty
const oneOf = (v, opts, dflt) => (opts.includes(v) ? v : dflt);
const objs = (v) => (Array.isArray(v) ? v.filter(isObj) : []);

function sanitizeDeep(out, def) {
  const p = out.profile, dp = def.profile;
  p.name = str(p.name, 60);
  p.sex = oneOf(p.sex, ['m', 'f'], dp.sex);
  p.units = oneOf(p.units, ['imperial', 'metric'], dp.units);
  p.experience = oneOf(p.experience, ['beginner', 'intermediate', 'advanced'], dp.experience);
  p.division = oneOf(p.division, ['open', 'pro', 'doubles'], dp.division);
  p.goal = oneOf(p.goal, ['lose', 'maintain', 'gain'], dp.goal);
  p.activity = typeof p.activity === 'string' ? p.activity : dp.activity;
  p.age = fin(p.age, 14, 99, dp.age);
  p.heightCm = fin(p.heightCm, 120, 230, dp.heightCm);
  p.weightKg = fin(p.weightKg, 30, 300, dp.weightKg);
  p.daysPerWeek = Math.round(fin(p.daysPerWeek, 3, 6, dp.daysPerWeek));
  p.raceDate = isISODate(p.raceDate) ? p.raceDate : null;
  p.hrMax = p.hrMax == null ? null : fin(p.hrMax, 120, 230, null);
  p.fiveKSec = p.fiveKSec == null ? null : fin(p.fiveKSec, 12 * 60, 60 * 60, null);
  p.onboarded = p.onboarded === true;
  for (const k of Object.keys(dp.equipment)) p.equipment[k] = p.equipment[k] === true;

  for (const k of ['kcal', 'protein', 'carbs', 'fat', 'waterMl']) out.targets[k] = fin(out.targets[k], 0, 20000, def.targets[k]);
  out.targets.auto = out.targets.auto !== false;

  out.sessions = objs(out.sessions).filter((x) => isISODate(x.date)).map((x, i) => ({
    ...x,
    id: str(x.id, 80) || 'sess-' + x.date + '-' + i,
    title: str(x.title, 120, 'Session'),
    type: str(x.type, 30, 'strength'),
    durationSec: fin(x.durationSec, 0, 24 * 3600, 0),
    sets: objs(x.sets).map((st) => ({ ...st, exId: str(st.exId, 80), kg: opt(st.kg, 0, 200), reps: opt(st.reps, 0, 1000), timeSec: opt(st.timeSec, 0, 24 * 3600), distanceM: opt(st.distanceM, 0, 300000) })),
    cardio: objs(x.cardio).map((c) => ({ ...c, mode: str(c.mode, 20, 'run'), distanceM: opt(c.distanceM, 0, 300000), timeSec: opt(c.timeSec, 0, 24 * 3600), avgHr: c.avgHr == null ? null : fin(c.avgHr, 30, 240, null) })),
    prs: Array.isArray(x.prs) ? x.prs.filter((t) => typeof t === 'string').map((t) => t.slice(0, 200)) : [],
    notes: str(x.notes, 2000),
    rpe: x.rpe == null ? null : fin(x.rpe, 1, 10, null),
  }));

  const foodLog = {};
  for (const [d, list] of Object.entries(out.foodLog)) {
    if (!isISODate(d) || !Array.isArray(list)) continue;
    foodLog[d] = objs(list).map((e, i) => ({
      ...e,
      id: str(e.id, 80) || 'f-' + d + '-' + i,
      meal: oneOf(e.meal, ['breakfast', 'lunch', 'dinner', 'snacks'], 'snacks'),
      name: str(e.name, 120, 'Food'),
      qty: fin(e.qty, 0, 10000, 1),
      grams: fin(e.grams, 0, 10000, 0),
      kcal: fin(e.kcal, 0, 10000, 0), p: fin(e.p, 0, 1000, 0), c: fin(e.c, 0, 1500, 0), f: fin(e.f, 0, 1000, 0), fiber: fin(e.fiber, 0, 300, 0),
    }));
  }
  out.foodLog = foodLog;

  const numMap = (m, lo, hi) => Object.fromEntries(Object.entries(isObj(m) ? m : {}).filter(([d]) => isISODate(d)).map(([d, v]) => [d, fin(v, lo, hi, 0)]));
  out.water = numMap(out.water, 0, 20000);
  out.readiness = Object.fromEntries(Object.entries(out.readiness).filter(([d, v]) => isISODate(d) && isObj(v)));
  out.bodyweight = objs(out.bodyweight).filter((b) => isISODate(b.date) && Number.isFinite(+b.kg) && +b.kg >= 25 && +b.kg <= 350).map((b) => ({ date: b.date, kg: +b.kg }));
  out.customFoods = objs(out.customFoods).filter((f) => typeof f.id === 'string' && isObj(f.per100)).map((f) => ({ ...f, name: str(f.name, 120, 'Custom food') }));
  out.mealTemplates = objs(out.mealTemplates).map((t) => ({ ...t, name: str(t.name, 80, 'Meal'), items: objs(t.items) }));
  out.favorites = out.favorites.filter((x) => typeof x === 'string');
  out.recentFoods = out.recentFoods.filter((x) => typeof x === 'string');

  if (out.plan) {
    out.plan.weeks = objs(out.plan.weeks).map((w, i) => ({ ...w, index: Number.isFinite(+w.index) ? +w.index : i + 1, days: objs(w.days).filter((d) => isISODate(d.date)) }));
    if (!isObj(out.plan.workouts)) out.plan.workouts = {};
    if (!out.plan.weeks.length) out.plan = null;
  }
  const aw = out.activeWorkout;
  if (aw && ((aw.workout != null && !isObj(aw.workout)) || (aw.workoutId != null && typeof aw.workoutId !== 'string'))) out.activeWorkout = null;

  const st = out.settings;
  st.theme = oneOf(st.theme, ['dark', 'light', 'system'], 'dark');
  for (const k of ['sound', 'voice', 'haptics']) st[k] = st[k] !== false;
  if (st.lock != null) {
    if (!isObj(st.lock)) delete st.lock;
    else if (st.lock.enabled && !(typeof st.lock.hash === 'string' && st.lock.hash && typeof st.lock.salt === 'string' && st.lock.salt)) {
      st.lock = { enabled: false, timeoutMin: st.lock.timeoutMin }; // broken lock: switch off, keep the preference
    }
  }
  out.savedAt = fin(out.savedAt, 0, 1e15, 0);
}

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

export function createStore(storage) {
  let backing = storage;
  if (!backing) {
    try { backing = globalThis.localStorage; backing.setItem('forge:probe', '1'); backing.removeItem('forge:probe'); }
    catch { backing = memoryStorage(); }
  }
  let state;
  let loadError = null;
  try {
    const txt = backing.getItem(STORAGE_KEY);
    state = normalize(txt ? JSON.parse(txt) : null);
  } catch (e) {
    loadError = e;
    try { backing.setItem(STORAGE_KEY + ':corrupt:' + Date.now(), backing.getItem(STORAGE_KEY) || ''); } catch {}
    state = defaultState();
  }
  const subs = new Set();
  const listeners = { saveError: new Set() };
  let idbTimer = null;
  let lastSaveOk = true;

  const notify = () => { for (const s of [...subs]) { try { s(state); } catch (e) { console.error(e); } } };

  function writeIdb() {
    clearTimeout(idbTimer);
    idbTimer = null;
    return idbSet('state', { savedAt: state.savedAt, json: JSON.stringify(state) }).catch((e) => console.warn('FORGE: IndexedDB save failed', e));
  }

  function persist() {
    state.savedAt = Date.now();
    let ok = true;
    try { backing.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch (e) { ok = false; console.warn('FORGE: localStorage save failed', e); }
    // IndexedDB mirror (debounced; flushed on pagehide/visibilitychange by flush())
    clearTimeout(idbTimer);
    idbTimer = setTimeout(writeIdb, 250);
    if (!ok && lastSaveOk) for (const fn of listeners.saveError) { try { fn(); } catch {} }
    lastSaveOk = ok;
    return ok;
  }

  return {
    loadError,
    get: () => state,
    get lastSavedAt() { return state.savedAt; },
    update(fn) {
      const draft = structuredClone(state);
      fn(draft);
      state = normalize(draft);
      persist();
      notify();
      return state;
    },
    replace(next) {
      state = normalize(next);
      persist();
      notify();
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    onSaveError(fn) { listeners.saveError.add(fn); return () => listeners.saveError.delete(fn); },
    /** Restore from the IndexedDB mirror when it is newer than (or localStorage lost) the current state. */
    async hydrate() {
      const rec = await idbGet('state');
      if (rec && typeof rec.json === 'string' && (rec.savedAt || 0) > (state.savedAt || 0)) {
        try {
          state = normalize(JSON.parse(rec.json));
          state.savedAt = rec.savedAt;
          try { backing.setItem(STORAGE_KEY, rec.json); } catch {}
          notify();
          return 'restored';
        } catch (e) { console.warn('FORGE: IndexedDB copy unreadable', e); }
      } else if (!rec && state.savedAt) {
        await writeIdb(); // first run with the mirror: seed it
      }
      return 'ok';
    },
    /** Write any pending IndexedDB save now (call when the page is being hidden). */
    flush() { if (idbTimer) return writeIdb(); return Promise.resolve(); },
    exportJSON: () => JSON.stringify(state, null, 2),
    importJSON(txt) {
      const parsed = JSON.parse(txt);
      if (!isObj(parsed) || !isObj(parsed.profile)) throw new Error('Not a FORGE backup file');
      // a backup never brings its own passcode lock: keep this device's lock (or none)
      const next = { ...parsed, settings: { ...(isObj(parsed.settings) ? parsed.settings : {}) } };
      delete next.settings.lock;
      if (state.settings.lock) next.settings.lock = state.settings.lock;
      this.replace(next);
    },
    reset() { state = defaultState(); persist(); notify(); },
  };
}

export const store = createStore();

// ---------- Selectors (pure) ----------
export const sel = {
  foodsFor: (s, date) => s.foodLog[date] || [],
  totalsFor(s, date) {
    const t = { kcal: 0, p: 0, c: 0, f: 0, fiber: 0 };
    for (const e of s.foodLog[date] || []) { t.kcal += +e.kcal || 0; t.p += +e.p || 0; t.c += +e.c || 0; t.f += +e.f || 0; t.fiber += +e.fiber || 0; }
    return t;
  },
  waterFor: (s, date) => s.water[date] || 0,
  sessionsOn: (s, date) => s.sessions.filter((x) => x.date === date),
  latestWeight(s) {
    const bw = [...s.bodyweight].sort((a, b) => a.date.localeCompare(b.date));
    return bw.length ? bw[bw.length - 1].kg : s.profile.weightKg;
  },
  dayPlan(s, date) {
    if (!s.plan) return null;
    for (const w of s.plan.weeks) for (const d of w.days) if (d.date === date) return { ...d, week: w };
    return null;
  },
};
