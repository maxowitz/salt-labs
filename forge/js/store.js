// FORGE store — local-first state with schema versioning, safe persistence and pub/sub.
// All values are metric (kg, m, sec, ml). See docs/PROMPT.md §6.2.

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
  out.sessions = out.sessions.filter(isObj);
  out.bodyweight = out.bodyweight.filter((b) => isObj(b) && b.date && Number.isFinite(+b.kg));
  for (const k of ['foodLog', 'water', 'readiness']) if (!isObj(out[k])) out[k] = {};
  for (const [d, list] of Object.entries(out.foodLog)) if (!Array.isArray(list)) delete out.foodLog[d];
  if (out.plan && (!isObj(out.plan) || !Array.isArray(out.plan.weeks))) out.plan = null;
  if (out.activeWorkout && !isObj(out.activeWorkout)) out.activeWorkout = null;
  out.version = SCHEMA_VERSION;
  return out;
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

  function persist() {
    try { backing.setItem(STORAGE_KEY, JSON.stringify(state)); return true; }
    catch (e) { console.warn('FORGE: save failed', e); return false; }
  }

  return {
    loadError,
    get: () => state,
    update(fn) {
      const draft = structuredClone(state);
      fn(draft);
      state = normalize(draft);
      persist();
      for (const s of [...subs]) { try { s(state); } catch (e) { console.error(e); } }
      return state;
    },
    replace(next) {
      state = normalize(next);
      persist();
      for (const s of [...subs]) { try { s(state); } catch (e) { console.error(e); } }
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    exportJSON: () => JSON.stringify(state, null, 2),
    importJSON(txt) {
      const parsed = JSON.parse(txt);
      if (!isObj(parsed) || !isObj(parsed.profile)) throw new Error('Not a FORGE backup file');
      this.replace(parsed);
    },
    reset() { state = defaultState(); persist(); for (const s of [...subs]) s(state); },
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
