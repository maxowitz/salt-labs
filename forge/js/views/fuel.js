// FORGE Fuel — food log, macro rings, water, weekly adherence and adaptive targets (docs/PROMPT.md §3.4).
// Routes: #/fuel, #/fuel/<YYYY-MM-DD>, optional ?add=<breakfast|lunch|dinner|snacks|auto> opens the add sheet.
import { store, sel, todayISO, addDays, uid } from '../store.js';
import { h, clear, toast, sheet, num, fmtDate, icon, navigate, seg, field, sectionHead, haptic, clamp, fmtWeight } from '../ui.js';
import { ring, barChart, lineChart } from '../charts.js';
import { FOODS } from '../data/foods.js';
import { dayTargets, adaptiveTdee, scaleFood, searchFoods, computeTargets, macrosForKcal, fiberTarget, tdee as formulaTdee } from '../engine/nutrition.js';

const MEALS = [['breakfast', 'Breakfast'], ['lunch', 'Lunch'], ['dinner', 'Dinner'], ['snacks', 'Snacks']];
const MEAL_LABEL = Object.fromEntries(MEALS);
const ML_PER_OZ = 29.5735;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const OFF_TIMEOUT = 8000;
const RECENT_CAP = 30;

const validISO = (s) => ISO_RE.test(s || '') && !Number.isNaN(Date.parse(s));
const r0 = (v) => Math.round(+v || 0);
const r1 = (v) => Math.round((+v || 0) * 10) / 10;
const fmtG = (v) => num(v, Math.abs(v) < 10 && Math.abs(v % 1) > 0.05 ? 1 : 0);
const macroLine = (m) => `P ${r0(m.p)} · C ${r0(m.c)} · F ${r0(m.f)}`;
const sumEntries = (list) => list.reduce((t, e) => ({ kcal: t.kcal + (+e.kcal || 0), p: t.p + (+e.p || 0), c: t.c + (+e.c || 0), f: t.f + (+e.f || 0), fiber: t.fiber + (+e.fiber || 0) }), { kcal: 0, p: 0, c: 0, f: 0, fiber: 0 });

export function defaultMeal(d = new Date()) {
  const hr = d.getHours() + d.getMinutes() / 60;
  if (hr < 10.5) return 'breakfast';
  if (hr < 15) return 'lunch';
  if (hr >= 17 && hr < 21.5) return 'dinner';
  return 'snacks';
}

function allFoods(s) { return [...(s.customFoods || []), ...FOODS]; }
function foodMap(s) { const m = new Map(); for (const f of allFoods(s)) if (f?.id && !m.has(f.id)) m.set(f.id, f); return m; }

/** true = training, false = rest, null = unknown (no plan, nothing logged). */
function isTrainingDay(s, date) {
  if (sel.sessionsOn(s, date).length) return true;
  const dp = sel.dayPlan(s, date);
  if (dp) return !dp.rest && !!dp.workoutId;
  return null;
}

function servingText(food) {
  const g = +food.serving?.grams || 100;
  const lbl = food.serving?.label || '100 g';
  return /\bg\b/.test(lbl) && lbl.includes(String(Math.round(g))) ? lbl : `${lbl} · ${fmtG(g)} g`;
}

function entryAmount(e) {
  if (!e.grams && e.unit !== 'g') {
    const u = !e.unit || e.unit === 'quick add' ? 'Quick add' : e.unit;
    return e.qty && e.qty !== 1 ? `${fmtG(e.qty)} × ${u}` : u;
  }
  if (e.unit === 'g') return `${fmtG(e.qty)} g`;
  const q = +e.qty || 1;
  return `${q === 1 ? '' : fmtG(q) + ' × '}${e.unit || 'serving'} · ${fmtG(e.grams)} g`;
}

function entryName(food) { return food.brand ? `${food.name} · ${food.brand}` : food.name; }

/** Build a FoodEntry from a food and an amount ({mode:'serving'|'g', qty}). */
export function makeEntry(food, meal, mode, qty) {
  const sg = +food.serving?.grams || 100;
  const grams = mode === 'g' ? qty : qty * sg;
  const m = scaleFood(food, grams);
  return {
    id: uid('fe'), meal, foodId: food.id || null, name: entryName(food),
    qty: Math.round(qty * 100) / 100, unit: mode === 'g' ? 'g' : (food.serving?.label || 'serving'),
    grams: Math.round(grams * 10) / 10, ...m,
  };
}

function pushRecent(st, id) {
  if (!id) return;
  st.recentFoods = [id, ...(st.recentFoods || []).filter((x) => x !== id)].slice(0, RECENT_CAP);
}

// ---------------------------------------------------------------------------------------------
export function render(root, { args = [], query = {} } = {}) {
  const date = validISO(args[0]) ? args[0] : todayISO();
  const ctx = { date, sheets: new Set(), waterHist: [] };

  const paint = () => {
    const y = window.scrollY;
    const s = store.get();
    clear(root).append(
      header(s, ctx),
      summaryCard(s, ctx),
      ...MEALS.map(([id, label]) => mealCard(s, ctx, id, label)),
      waterCard(s, ctx),
      weeklyCard(s, ctx),
      adaptiveCard(s, ctx),
    );
    if (Math.abs(window.scrollY - y) > 2) window.scrollTo(0, y);
  };
  ctx.paint = paint;
  paint();
  const unsub = store.subscribe(() => paint());

  if (query.add) {
    const meal = MEAL_LABEL[query.add] ? query.add : defaultMeal();
    try { history.replaceState(null, '', location.pathname + location.search + `#/fuel${args[0] ? '/' + date : ''}`); } catch {}
    openAddSheet(ctx, meal);
  }
  return () => {
    unsub();
    for (const sh of [...ctx.sheets]) { try { sh.close(); } catch {} }
  };
}

function trackSheet(ctx, opts) {
  let ref;
  const onClose = opts.onClose;
  ref = sheet({ ...opts, onClose: () => { ctx.sheets.delete(ref); onClose?.(); } });
  ctx.sheets.add(ref);
  return ref;
}

// ---------------------------------------------------------------------------------------------
// Header + date switcher
function header(s, ctx) {
  const today = todayISO();
  const { date } = ctx;
  const go = (d) => navigate(d === today ? '#/fuel' : `#/fuel/${d}`);
  const rel = date === today ? 'Today' : date === addDays(today, -1) ? 'Yesterday' : date === addDays(today, 1) ? 'Tomorrow' : fmtDate(date);
  const picker = h('input', {
    type: 'date', class: 'fu-date-input', value: date, 'aria-label': 'Pick a date',
    on: {
      change: (e) => { if (validISO(e.target.value)) go(e.target.value); },
      click: (e) => { try { e.target.showPicker?.(); } catch {} },
    },
  });
  const t = isTrainingDay(s, date);
  return h('div', { class: 'fu-head' },
    h('div', { class: 'page-head fu-title' },
      h('h1', null, 'Fuel'),
      t == null ? h('span', { class: 'pill' }, 'No plan')
        : t ? h('span', { class: 'pill go', title: 'Training day: +10 % carbs' }, icon('zap', 13), 'Training day')
          : h('span', { class: 'pill recovery', title: 'Rest day: −10 % carbs' }, icon('moon', 13), 'Rest day')),
    h('div', { class: 'fu-dates' },
      h('button', { type: 'button', class: 'icon-btn filled', 'aria-label': 'Previous day', on: { click: () => go(addDays(date, -1)) } }, icon('chevL')),
      h('div', { class: 'fu-date' },
        h('span', { class: 'fu-date-main' }, icon('calendar', 16), rel),
        rel !== fmtDate(date) ? h('span', { class: 'fu-date-sub' }, fmtDate(date)) : null,
        picker),
      h('button', { type: 'button', class: 'icon-btn filled', 'aria-label': 'Next day', on: { click: () => go(addDays(date, 1)) } }, icon('chevR')),
      date !== today ? h('button', { type: 'button', class: 'btn sm subtle', on: { click: () => go(today) } }, 'Today') : null));
}

// ---------------------------------------------------------------------------------------------
// Summary
function summaryCard(s, ctx) {
  const t = dayTargets(s.targets, isTrainingDay(s, ctx.date));
  const tot = sel.totalsFor(s, ctx.date);
  const left = r0(t.kcal - tot.kcal);
  const over = left < 0;
  const fT = fiberTarget(t.kcal);
  const macro = (label, key, tKey, color) => {
    const v = tot[key], target = +t[tKey] || 0, rem = r0(target - v);
    const pct = target ? clamp((v / target) * 100, 0, 100) : 0;
    return h('div', { class: 'fu-macro', style: { '--c': color } },
      h('div', { class: 'row between' },
        h('span', { class: 'fu-macro-k' }, h('i', { class: 'dot', style: { background: color } }), label),
        h('span', { class: 'fu-macro-v tabular' }, h('b', null, r0(v)), ` / ${r0(target)} g`)),
      h('div', { class: 'bar thin', role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': String(r0(target)), 'aria-valuenow': String(r0(v)) },
        h('i', { style: { width: pct + '%', background: v > target * 1.1 ? 'var(--danger)' : color } })),
      h('span', { class: 'fu-macro-left' + (rem < 0 ? ' danger-text' : '') }, rem >= 0 ? `${rem} g left` : `${-rem} g over`));
  };
  return h('section', { class: 'card hero fu-summary', 'aria-label': 'Daily summary' },
    h('div', { class: 'fu-sum-top' },
      ring({ value: tot.kcal, max: t.kcal || 1, size: 136, stroke: 12, color: 'var(--accent)', label: num(Math.abs(left)), sub: over ? 'kcal over' : 'kcal left' }),
      h('div', { class: 'fu-sum-stats' },
        h('div', { class: 'stat' }, h('span', { class: 'v' }, num(tot.kcal)), h('span', { class: 'k' }, 'Eaten')),
        h('div', { class: 'stat' }, h('span', { class: 'v' }, num(t.kcal)), h('span', { class: 'k' },
          'Target', t.dayType === 'training' ? ' · train' : t.dayType === 'rest' ? ' · rest' : '')),
        h('div', { class: 'fu-fiber small' }, h('span', { class: 'muted' }, 'Fiber '), h('b', { class: 'tabular' }, r0(tot.fiber)), h('span', { class: 'muted' }, ` / ${fT} g`)))),
    h('div', { class: 'fu-macros' },
      macro('Protein', 'p', 'protein', 'var(--protein)'),
      macro('Carbs', 'c', 'carbs', 'var(--carbs)'),
      macro('Fat', 'f', 'fat', 'var(--fat)')));
}

// ---------------------------------------------------------------------------------------------
// Meals
function mealCard(s, ctx, meal, label) {
  const list = sel.foodsFor(s, ctx.date).filter((e) => e.meal === meal);
  const tot = sumEntries(list);
  const yList = sel.foodsFor(s, addDays(ctx.date, -1)).filter((e) => e.meal === meal);
  return h('section', { class: 'card flush fu-meal', 'aria-label': label },
    h('div', { class: 'fu-meal-head' },
      h('div', null, h('h3', null, label), list.length ? h('div', { class: 'xs muted tabular' }, macroLine(tot)) : null),
      h('div', { class: 'fu-meal-kcal tabular' }, list.length ? [num(tot.kcal), h('small', null, ' kcal')] : null)),
    list.length ? h('div', { class: 'list' }, list.map((e) => h('button', {
      type: 'button', class: 'li fu-entry', 'aria-label': `Edit ${e.name}`, on: { click: () => openEditSheet(ctx, e) },
    },
    h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, e.name), h('div', { class: 'li-sub' }, entryAmount(e))),
    h('div', { class: 'li-end' }, h('div', { class: 'fu-kcal' }, num(e.kcal)), h('div', { class: 'xs muted' }, macroLine(e)))))) : null,
    h('div', { class: 'fu-meal-actions' },
      h('button', { type: 'button', class: 'btn sm primary', on: { click: () => openAddSheet(ctx, meal) } }, icon('plus', 16), 'Add'),
      yList.length ? h('button', { type: 'button', class: 'btn sm subtle', on: { click: () => copyMeal(ctx, meal, yList) }, title: `Copy ${yList.length} item(s) from yesterday` },
        icon('copy', 16), `Copy yesterday`) : null,
      list.length ? h('button', { type: 'button', class: 'btn sm subtle', on: { click: () => saveTemplate(ctx, meal, list) } }, icon('star', 16), 'Save meal') : null));
}

function copyMeal(ctx, meal, items) {
  const ids = [];
  store.update((st) => {
    const arr = st.foodLog[ctx.date] || (st.foodLog[ctx.date] = []);
    for (const it of items) { const id = uid('fe'); ids.push(id); arr.push({ ...it, id, meal }); }
  });
  haptic();
  toast(`Copied ${items.length} item${items.length > 1 ? 's' : ''} to ${MEAL_LABEL[meal]}`, { action: { label: 'Undo', fn: () => removeEntries(ctx.date, ids) } });
}

function removeEntries(date, ids) {
  const set = new Set(ids);
  store.update((st) => { st.foodLog[date] = (st.foodLog[date] || []).filter((e) => !set.has(e.id)); if (!st.foodLog[date].length) delete st.foodLog[date]; });
}

function addEntries(date, entries, { toastMsg } = {}) {
  store.update((st) => {
    const arr = st.foodLog[date] || (st.foodLog[date] = []);
    for (const e of entries) { arr.push(e); pushRecent(st, e.foodId && !String(e.foodId).startsWith('tmp-') ? e.foodId : null); }
  });
  haptic();
  if (toastMsg) toast(toastMsg, { action: { label: 'Undo', fn: () => removeEntries(date, entries.map((e) => e.id)) } });
}

function saveTemplate(ctx, meal, list) {
  const def = `${MEAL_LABEL[meal]} · ${fmtDate(ctx.date, { month: 'short', day: 'numeric' })}`;
  const input = h('input', { type: 'text', value: def, maxlength: '60', 'aria-label': 'Meal name', autofocus: true });
  const sh = trackSheet(ctx, {
    title: 'Save as meal',
    content: ({ close }) => h('form', { class: 'stack', on: { submit: (e) => {
      e.preventDefault();
      const name = input.value.trim() || def;
      const items = list.map(({ id, meal: _m, ...rest }) => rest);
      store.update((st) => { st.mealTemplates = [{ id: uid('mt'), name, items }, ...(st.mealTemplates || [])]; });
      toast(`Saved “${name}” to Meals`, { kind: 'go' });
      close();
    } } },
    field('Name', input),
    h('p', { class: 'small muted' }, `${list.length} item${list.length > 1 ? 's' : ''} · ${num(sumEntries(list).kcal)} kcal. Find it under the Meals tab when adding food.`),
    h('button', { type: 'submit', class: 'btn primary block' }, 'Save meal')),
  });
  setTimeout(() => { input.focus(); input.select(); }, 60);
  return sh;
}

// ---------------------------------------------------------------------------------------------
// Amount editor shared by the detail panel and the edit sheet
function amountEditor({ servingGrams, servingLabel, mode, qty, onChange }) {
  const st = { mode: servingGrams ? mode : 'g', qty };
  const grams = () => (st.mode === 'g' ? st.qty : st.qty * servingGrams);
  const input = h('input', {
    type: 'number', inputmode: 'decimal', min: '0', step: 'any', class: 'fu-amt-input', value: String(st.qty), 'aria-label': 'Amount',
    on: { input: (e) => { const v = parseFloat(e.target.value); st.qty = Number.isFinite(v) && v >= 0 ? v : 0; emit(); } },
  });
  const unitEl = h('span', { class: 'fu-amt-unit' });
  const presetsEl = h('div', { class: 'chips' });
  const emit = () => onChange({ mode: st.mode, qty: st.qty, grams: grams() });
  const setQty = (v) => { st.qty = Math.max(0, Math.round(v * 100) / 100); input.value = String(st.qty); emit(); };
  const step = () => (st.mode === 'g' ? (st.qty >= 100 ? 25 : 10) : 0.25);
  const paintPresets = () => {
    clear(presetsEl);
    unitEl.textContent = st.mode === 'g' ? 'g' : (st.qty === 1 ? servingLabel : `× ${servingLabel}`);
    const vals = st.mode === 'g' ? [50, 100, 150, 200, 250] : [0.5, 1, 1.5, 2, 3];
    for (const v of vals) presetsEl.append(h('button', { type: 'button', class: 'chip' + (v === st.qty ? ' on' : ''), on: { click: () => { setQty(v); paintPresets(); } } },
      st.mode === 'g' ? `${v} g` : v === 0.5 ? '½' : v === 1.5 ? '1½' : String(v)));
  };
  input.addEventListener('input', () => paintPresets());
  const segEl = servingGrams ? seg([['serving', `Servings (${servingLabel})`], ['g', 'Grams']], st.mode, (m) => {
    if (m === st.mode) return;
    const g = grams();
    st.mode = m;
    st.qty = m === 'g' ? Math.round(g) : Math.round((g / servingGrams) * 100) / 100;
    input.value = String(st.qty);
    paintPresets(); emit();
  }, { label: 'Amount unit' }) : null;
  paintPresets();
  const el = h('div', { class: 'stack fu-amt' },
    segEl,
    h('div', { class: 'fu-amt-row' },
      h('button', { type: 'button', class: 'icon-btn filled', 'aria-label': 'Less', on: { click: () => { haptic(); setQty(st.qty - step()); paintPresets(); } } }, icon('minus')),
      h('label', { class: 'fu-amt-field' }, input, unitEl),
      h('button', { type: 'button', class: 'icon-btn filled', 'aria-label': 'More', on: { click: () => { haptic(); setQty(st.qty + step()); paintPresets(); } } }, icon('plus'))),
    presetsEl);
  return { el, input, get: () => ({ mode: st.mode, qty: st.qty, grams: grams() }) };
}

function macroPanel() {
  const cell = (k, cls) => { const v = h('b', { class: 'tabular' }); return [h('div', { class: 'fu-mp-cell ' + cls }, v, h('span', null, k)), v]; };
  const [kC, kV] = cell('kcal', 'kcal'), [pC, pV] = cell('protein', 'p'), [cC, cV] = cell('carbs', 'c'), [fC, fV] = cell('fat', 'f'), [fiC, fiV] = cell('fiber', 'fib');
  const el = h('div', { class: 'fu-mp', 'aria-live': 'polite' }, kC, pC, cC, fC, fiC);
  const set = (m) => { kV.textContent = num(m.kcal); pV.textContent = fmtG(r1(m.p)) + 'g'; cV.textContent = fmtG(r1(m.c)) + 'g'; fV.textContent = fmtG(r1(m.f)) + 'g'; fiV.textContent = fmtG(r1(m.fiber)) + 'g'; };
  return { el, set };
}

// ---------------------------------------------------------------------------------------------
// Edit an existing entry
function openEditSheet(ctx, entry) {
  const s = store.get();
  const food = entry.foodId ? foodMap(s).get(entry.foodId) : null;
  const isQuick = !entry.grams && entry.unit !== 'g';
  let meal = entry.meal;
  let next = null; // computed macros

  const content = ({ close }) => {
    const mp = macroPanel();
    let body;
    if (isQuick) {
      const f = {};
      const numIn = (k, label, v) => (f[k] = h('input', { type: 'number', inputmode: 'decimal', min: '0', step: 'any', value: String(r1(v)), 'aria-label': label, on: { input: upd } }));
      function upd() {
        const g = (k) => Math.max(0, parseFloat(f[k].value) || 0);
        next = { kcal: r0(g('kcal')), p: r1(g('p')), c: r1(g('c')), f: r1(g('f')), fiber: r1(g('fiber')), name: f.name.value.trim() || 'Quick add' };
        mp.set(next);
      }
      f.name = h('input', { type: 'text', value: entry.name, maxlength: '80', 'aria-label': 'Name', on: { input: upd } });
      body = h('div', { class: 'stack' }, field('Name', f.name),
        h('div', { class: 'grid2' }, field('Calories', numIn('kcal', 'Calories', entry.kcal)), field('Protein (g)', numIn('p', 'Protein', entry.p)),
          field('Carbs (g)', numIn('c', 'Carbs', entry.c)), field('Fat (g)', numIn('f', 'Fat', entry.f))), (numIn('fiber', 'Fiber', entry.fiber || 0), null));
      upd();
    } else {
      const basis = food ? food.per100 : (entry.grams > 0 ? { kcal: entry.kcal / entry.grams * 100, p: entry.p / entry.grams * 100, c: entry.c / entry.grams * 100, f: entry.f / entry.grams * 100, fiber: (entry.fiber || 0) / entry.grams * 100 } : { kcal: 0, p: 0, c: 0, f: 0, fiber: 0 });
      const servingGrams = food?.serving?.grams || (entry.unit !== 'g' && entry.qty ? entry.grams / entry.qty : null);
      const servingLabel = food?.serving?.label || (entry.unit !== 'g' ? entry.unit : 'serving');
      const amt = amountEditor({
        servingGrams, servingLabel, mode: entry.unit === 'g' ? 'g' : 'serving', qty: +entry.qty || 1,
        onChange: ({ mode, qty, grams }) => {
          next = { ...scaleFood({ per100: basis }, grams), qty: Math.round(qty * 100) / 100, unit: mode === 'g' ? 'g' : servingLabel, grams: Math.round(grams * 10) / 10 };
          mp.set(next);
        },
      });
      const a = amt.get();
      next = { ...scaleFood({ per100: basis }, a.grams), qty: a.qty, unit: a.mode === 'g' ? 'g' : servingLabel, grams: Math.round(a.grams * 10) / 10 };
      mp.set(next);
      body = amt.el;
    }
    return h('div', { class: 'stack' },
      h('p', { class: 'small muted' }, `${MEAL_LABEL[entry.meal]} · ${fmtDate(ctx.date)}`),
      body,
      mp.el,
      field('Meal', seg(MEALS, meal, (m) => { meal = m; }, { label: 'Meal' })),
      h('button', { type: 'button', class: 'btn primary block', on: { click: () => {
        if (!next) return close();
        store.update((st) => {
          const arr = st.foodLog[ctx.date] || [];
          const i = arr.findIndex((e) => e.id === entry.id);
          if (i >= 0) arr[i] = { ...arr[i], ...next, meal };
        });
        toast('Updated', { kind: 'go', ms: 1200 });
        close();
      } } }, icon('check', 18), 'Save'),
      h('button', { type: 'button', class: 'btn ghost block fu-del', on: { click: () => { close(); deleteEntry(ctx, entry); } } }, icon('trash', 18), 'Delete'));
  };
  trackSheet(ctx, { title: entry.name, content });
}

function deleteEntry(ctx, entry) {
  let idx = -1;
  store.update((st) => {
    const arr = st.foodLog[ctx.date] || [];
    idx = arr.findIndex((e) => e.id === entry.id);
    if (idx >= 0) arr.splice(idx, 1);
    if (!arr.length) delete st.foodLog[ctx.date];
  });
  haptic(20);
  toast(`Deleted ${entry.name}`, { action: { label: 'Undo', fn: () => store.update((st) => {
    const arr = st.foodLog[ctx.date] || (st.foodLog[ctx.date] = []);
    arr.splice(Math.max(0, Math.min(idx, arr.length)), 0, entry);
  }) }, ms: 5000 });
}

// ---------------------------------------------------------------------------------------------
// Add-food sheet (full height) with internal pages: browse | detail | quick | create | barcode | template
function openAddSheet(ctx, initialMeal) {
  const st = { meal: initialMeal, q: '', tab: 'recent', online: null, onlineState: 'idle', pageStack: [] };
  const body = h('div', { class: 'fu-add' });
  const cleanups = new Set();
  const runCleanups = () => { for (const fn of [...cleanups]) { try { fn(); } catch {} } cleanups.clear(); };
  const sh = trackSheet(ctx, { title: `Add to ${MEAL_LABEL[st.meal]}`, content: body, full: true, onClose: () => { runCleanups(); try { onlineCtrl?.abort(); } catch {} } });
  const titleEl = sh.panel.querySelector('.sheet-title');
  const setTitle = (t) => { titleEl.textContent = t; };
  const mealTitle = () => setTitle(`Add to ${MEAL_LABEL[st.meal]}`);

  const show = (el, title) => { runCleanups(); clear(body).append(el); sh.body.scrollTop = 0; if (title) setTitle(title); else mealTitle(); };
  const back = () => browse();
  const backBtn = (label = 'Back') => h('button', { type: 'button', class: 'link-btn fu-back', on: { click: back } }, icon('chevL', 18), label);

  const logFood = (food, mode, qty, { saveOff = false, multi = true } = {}) => {
    let f = food;
    if (food.source === 'off' && saveOff) f = saveCustomFood(food);
    const e = makeEntry(f, st.meal, mode, qty);
    if (food.source === 'off' && !saveOff) e.foodId = null;
    addEntries(ctx.date, [e], { toastMsg: `Added ${f.name} to ${MEAL_LABEL[st.meal]}` });
    return e;
  };

  // ---------- browse ----------
  let searchInput, listEl;
  function browse() {
    searchInput = h('input', {
      type: 'search', placeholder: `Search ${FOODS.length}+ foods`, value: st.q, autocomplete: 'off', enterkeyhint: 'search', 'aria-label': 'Search foods',
      on: { input: (e) => { st.q = e.target.value; st.online = null; st.onlineState = 'idle'; paintList(); } },
    });
    listEl = h('div', { class: 'fu-results' });
    const el = h('div', { class: 'stack' },
      seg(MEALS.map(([v, l]) => [v, l === 'Breakfast' ? 'Bkfst' : l]), st.meal, (m) => { st.meal = m; mealTitle(); paintList(); }, { label: 'Meal' }),
      h('div', { class: 'row' },
        h('label', { class: 'search grow' }, icon('search', 18), searchInput,
          h('button', { type: 'button', class: 'icon-btn fu-clear', 'aria-label': 'Clear search', on: { click: () => { st.q = ''; searchInput.value = ''; paintList(); searchInput.focus(); } } }, icon('x', 16))),
        h('button', { type: 'button', class: 'icon-btn filled', 'aria-label': 'Scan barcode', on: { click: () => barcodePage() } }, icon('barcode'))),
      h('div', { class: 'chips scroll fu-actions' },
        h('button', { type: 'button', class: 'chip', on: { click: () => quickPage() } }, icon('zap', 15), 'Quick add'),
        h('button', { type: 'button', class: 'chip', on: { click: () => createPage() } }, icon('plus', 15), 'Create food'),
        h('button', { type: 'button', class: 'chip', on: { click: () => barcodePage() } }, icon('barcode', 15), 'Scan barcode')),
      listEl);
    show(el);
    paintList();
    setTimeout(() => searchInput?.focus({ preventScroll: true }), 80);
  }

  function foodRow(food) {
    const sv = scaleFood(food, food.serving?.grams || 100);
    const addBtn = h('button', {
      type: 'button', class: 'icon-btn fu-plus', 'aria-label': `Add ${food.serving?.label || 'serving'} of ${food.name}`,
      on: { click: (ev) => {
        ev.stopPropagation();
        logFood(food, 'serving', 1, { saveOff: true });
        addBtn.classList.add('done'); clear(addBtn).append(icon('check'));
        setTimeout(() => { addBtn.classList.remove('done'); clear(addBtn).append(icon('plus')); }, 1100);
      } },
    }, icon('plus'));
    return h('div', { class: 'li fu-food' },
      h('button', { type: 'button', class: 'fu-food-main', on: { click: () => detailPage(food) } },
        h('div', { class: 'li-title' }, food.name, food.brand ? h('span', { class: 'muted fu-brand' }, ` · ${food.brand}`) : null),
        h('div', { class: 'li-sub' }, `${servingText(food)} · `, h('b', null, `${num(sv.kcal)} kcal`), ` · ${macroLine(sv)}`)),
      addBtn);
  }

  function paintList() {
    if (!listEl) return;
    const s = store.get();
    clear(listEl);
    const map = foodMap(s);
    if (st.q.trim()) {
      const res = searchFoods(st.q, allFoods(s), { recent: s.recentFoods, favorites: s.favorites, limit: 60 });
      if (res.length) listEl.append(h('div', { class: 'list card flush' }, res.map((f) => foodRow(f))));
      else listEl.append(h('div', { class: 'empty' }, h('h3', null, 'No matches'), h('p', { class: 'small muted' }, 'Try fewer words, search online, or create it.')));
      if (res.length < 6) listEl.append(onlineBlock());
      listEl.append(h('div', { class: 'row wrap fu-cta' },
        h('button', { type: 'button', class: 'btn sm subtle', on: { click: () => createPage({ name: st.q.trim() }) } }, icon('plus', 16), `Create “${st.q.trim().slice(0, 24)}”`),
        h('button', { type: 'button', class: 'btn sm subtle', on: { click: () => quickPage({ name: st.q.trim() }) } }, icon('zap', 16), 'Quick add')));
      return;
    }
    const tabs = seg([['recent', 'Recent'], ['fav', 'Favourites'], ['mine', 'My Foods'], ['meals', 'Meals']], st.tab, (t) => { st.tab = t; paintList(); }, { label: 'Food lists' });
    tabs.classList.add('fu-tabs');
    listEl.append(tabs);
    let rows = [];
    let empty;
    if (st.tab === 'recent') {
      rows = (s.recentFoods || []).map((id) => map.get(id)).filter(Boolean);
      empty = ['Nothing recent yet', 'Foods you log show up here for one-tap re-logging. Try searching “chicken”, “oats” or “banana”.'];
    } else if (st.tab === 'fav') {
      rows = (s.favorites || []).map((id) => map.get(id)).filter(Boolean);
      empty = ['No favourites', 'Tap a food, then the star, to pin it here.'];
    } else if (st.tab === 'mine') {
      rows = s.customFoods || [];
      empty = ['No custom foods', 'Create a food from its label, or scan a barcode.'];
    }
    if (st.tab === 'meals') {
      const tpls = s.mealTemplates || [];
      if (!tpls.length) listEl.append(h('div', { class: 'empty' }, icon('list', 28), h('h3', null, 'No saved meals'), h('p', { class: 'small muted' }, 'Log a meal, then tap “Save meal” on it to reuse it in one tap.')));
      else listEl.append(h('div', { class: 'list card flush' }, tpls.map((t) => templateRow(t))));
      return;
    }
    if (!rows.length) {
      listEl.append(h('div', { class: 'empty' }, icon(st.tab === 'fav' ? 'star' : st.tab === 'mine' ? 'edit' : 'repeat', 28), h('h3', null, empty[0]), h('p', { class: 'small muted' }, empty[1]),
        st.tab === 'mine' ? h('button', { type: 'button', class: 'btn sm primary', on: { click: () => createPage() } }, icon('plus', 16), 'Create food') : null));
      if (st.tab === 'recent') listEl.append(sectionHead('Athlete staples'), h('div', { class: 'list card flush' },
        ['chicken-breast-cooked', 'white-rice-cooked', 'egg-whole', 'greek-yogurt-nonfat', 'oats-rolled-dry', 'banana', 'whey-protein', 'sweet-potato-baked']
          .map((id) => map.get(id)).filter(Boolean).map((f) => foodRow(f))));
      return;
    }
    listEl.append(h('div', { class: 'list card flush' }, rows.map((f) => foodRow(f))));
  }

  function templateRow(t) {
    const tot = sumEntries(t.items || []);
    return h('div', { class: 'li fu-food' },
      h('button', { type: 'button', class: 'fu-food-main', on: { click: () => templatePage(t) } },
        h('div', { class: 'li-title' }, t.name),
        h('div', { class: 'li-sub' }, `${(t.items || []).length} items · `, h('b', null, `${num(tot.kcal)} kcal`), ` · ${macroLine(tot)}`)),
      h('button', { type: 'button', class: 'icon-btn fu-plus', 'aria-label': `Add meal ${t.name}`, on: { click: () => addTemplate(t) } }, icon('plus')));
  }

  function addTemplate(t) {
    const entries = (t.items || []).map((it) => ({ ...it, id: uid('fe'), meal: st.meal }));
    if (!entries.length) return;
    addEntries(ctx.date, entries, { toastMsg: `Added “${t.name}” to ${MEAL_LABEL[st.meal]}` });
  }

  function templatePage(t) {
    const tot = sumEntries(t.items || []);
    show(h('div', { class: 'stack' }, backBtn(),
      h('h2', null, t.name),
      h('p', { class: 'small muted tabular' }, `${num(tot.kcal)} kcal · ${macroLine(tot)}`),
      h('div', { class: 'list card flush' }, (t.items || []).map((it) => h('div', { class: 'li' },
        h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, it.name), h('div', { class: 'li-sub' }, entryAmount(it))),
        h('div', { class: 'li-end tabular' }, num(it.kcal))))),
      h('button', { type: 'button', class: 'btn primary block', on: { click: () => { addTemplate(t); sh.close(); } } }, icon('plus', 18), `Add all to ${MEAL_LABEL[st.meal]}`),
      h('button', { type: 'button', class: 'btn ghost block fu-del', on: { click: () => {
        store.update((s2) => { s2.mealTemplates = (s2.mealTemplates || []).filter((x) => x.id !== t.id); });
        toast(`Deleted “${t.name}”`, { action: { label: 'Undo', fn: () => store.update((s2) => { s2.mealTemplates = [t, ...(s2.mealTemplates || [])]; }) } });
        st.tab = 'meals'; browse();
      } } }, icon('trash', 18), 'Delete saved meal')), 'Saved meal');
  }

  // ---------- detail ----------
  function detailPage(food, { fromOff = false, isNewOff = false } = {}) {
    const s = store.get();
    const known = foodMap(s).has(food.id);
    const isCustom = (s.customFoods || []).some((f) => f.id === food.id);
    const mp = macroPanel();
    let cur = { mode: 'serving', qty: 1, grams: food.serving?.grams || 100 };
    const amt = amountEditor({
      servingGrams: food.serving?.grams || 100, servingLabel: food.serving?.label || 'serving', mode: 'serving', qty: 1,
      onChange: (v) => { cur = v; mp.set(scaleFood(food, v.grams)); addBtn.disabled = !(v.grams > 0); },
    });
    mp.set(scaleFood(food, cur.grams));
    let fav = (s.favorites || []).includes(food.id);
    const star = h('button', { type: 'button', class: 'icon-btn' + (fav ? ' on' : ''), 'aria-pressed': String(fav), 'aria-label': fav ? 'Remove from favourites' : 'Add to favourites',
      on: { click: () => {
        if (food.source === 'off' && !(store.get().customFoods || []).some((f) => f.id === food.id)) saveCustomFood(food);
        fav = !fav;
        store.update((s2) => { s2.favorites = fav ? [food.id, ...(s2.favorites || []).filter((x) => x !== food.id)] : (s2.favorites || []).filter((x) => x !== food.id); });
        star.classList.toggle('on', fav); star.setAttribute('aria-pressed', String(fav));
        star.setAttribute('aria-label', fav ? 'Remove from favourites' : 'Add to favourites');
        haptic();
      } } }, icon('star'));
    const saveBox = fromOff && !known ? h('input', { type: 'checkbox', checked: true, id: 'fu-save-off' }) : null;
    const mealSeg = seg(MEALS, st.meal, (m) => { st.meal = m; addBtn.lastChild.textContent = `Add to ${MEAL_LABEL[m]}`; }, { label: 'Meal' });
    const addBtn = h('button', { type: 'button', class: 'btn primary block xl', on: { click: () => {
      if (!(cur.grams > 0)) return;
      logFood(food, cur.mode, cur.qty, { saveOff: saveBox ? saveBox.checked : true });
      back();
    } } }, icon('plus', 18), h('span', null, `Add to ${MEAL_LABEL[st.meal]}`));
    const p = food.per100 || {};
    show(h('div', { class: 'stack' },
      h('div', { class: 'row between' }, backBtn(), star),
      h('div', null, h('h2', { class: 'fu-detail-name' }, food.name), food.brand ? h('div', { class: 'muted small' }, food.brand) : null,
        isNewOff ? h('span', { class: 'pill accent mt' }, 'Open Food Facts') : null),
      amt.el,
      mp.el,
      h('p', { class: 'xs muted tabular' }, `Per 100 g: ${num(p.kcal)} kcal · P ${r1(p.p)} · C ${r1(p.c)} · F ${r1(p.f)} · fiber ${r1(p.fiber)}`),
      field('Meal', mealSeg),
      saveBox ? h('label', { class: 'switch fu-save', for: 'fu-save-off' }, h('span', null, 'Save to My Foods'), saveBox) : null,
      addBtn,
      isCustom ? h('button', { type: 'button', class: 'btn ghost block fu-del', on: { click: () => {
        const snapshot = (store.get().customFoods || []).find((f) => f.id === food.id);
        store.update((s2) => { s2.customFoods = (s2.customFoods || []).filter((f) => f.id !== food.id); s2.favorites = (s2.favorites || []).filter((x) => x !== food.id); });
        toast(`Removed ${food.name} from My Foods`, { action: { label: 'Undo', fn: () => store.update((s2) => { s2.customFoods = [snapshot, ...(s2.customFoods || [])]; }) } });
        back();
      } } }, icon('trash', 18), 'Delete from My Foods') : null), 'Food details');
    setTimeout(() => { amt.input.focus({ preventScroll: true }); amt.input.select?.(); }, 60);
  }

  // ---------- quick add ----------
  function quickPage(pre = {}) {
    const f = {};
    const numIn = (k, label) => (f[k] = h('input', { type: 'number', inputmode: 'decimal', min: '0', step: 'any', placeholder: '0', 'aria-label': label, on: { input: upd } }));
    const hint = h('p', { class: 'xs muted' });
    function upd() {
      const p = +f.p.value || 0, c = +f.c.value || 0, fa = +f.f.value || 0;
      const calc = Math.round(p * 4 + c * 4 + fa * 9);
      hint.textContent = calc ? `Macros add up to ${num(calc)} kcal${f.kcal.value ? '' : ' — used if calories are left blank'}.` : 'Calories required, or fill in macros and we’ll calculate them.';
    }
    f.name = h('input', { type: 'text', placeholder: 'Quick add', value: pre.name || '', maxlength: '80', 'aria-label': 'Name' });
    const el = h('form', { class: 'stack', on: { submit: (e) => {
      e.preventDefault();
      const p = Math.max(0, +f.p.value || 0), c = Math.max(0, +f.c.value || 0), fa = Math.max(0, +f.f.value || 0);
      const kcal = Math.max(0, +f.kcal.value || Math.round(p * 4 + c * 4 + fa * 9));
      if (!kcal) { toast('Enter calories or macros', { kind: 'danger' }); f.kcal.focus(); return; }
      const e2 = { id: uid('fe'), meal: st.meal, foodId: null, name: f.name.value.trim() || 'Quick add', qty: 1, unit: 'quick add', grams: 0, kcal: Math.round(kcal), p: r1(p), c: r1(c), f: r1(fa), fiber: 0 };
      addEntries(ctx.date, [e2], { toastMsg: `Added ${num(e2.kcal)} kcal to ${MEAL_LABEL[st.meal]}` });
      back();
    } } },
    backBtn(),
    field('Calories', h('div', { class: 'input-unit' }, numIn('kcal', 'Calories'), h('span', null, 'kcal'))),
    h('div', { class: 'grid3' },
      field('Protein', h('div', { class: 'input-unit' }, numIn('p', 'Protein grams'), h('span', null, 'g'))),
      field('Carbs', h('div', { class: 'input-unit' }, numIn('c', 'Carb grams'), h('span', null, 'g'))),
      field('Fat', h('div', { class: 'input-unit' }, numIn('f', 'Fat grams'), h('span', null, 'g')))),
    hint,
    field('Name (optional)', f.name),
    field('Meal', seg(MEALS, st.meal, (m) => { st.meal = m; }, { label: 'Meal' })),
    h('button', { type: 'submit', class: 'btn primary block xl' }, icon('zap', 18), 'Quick add'));
    upd();
    show(el, 'Quick add');
    setTimeout(() => f.kcal.focus({ preventScroll: true }), 60);
  }

  // ---------- create food ----------
  function createPage(pre = {}) {
    const f = {};
    const txt = (k, label, v = '', ph = '') => (f[k] = h('input', { type: 'text', value: v, placeholder: ph, maxlength: '80', 'aria-label': label }));
    const numIn = (k, label, v = '') => (f[k] = h('input', { type: 'number', inputmode: 'decimal', min: '0', step: 'any', value: v === '' ? '' : String(v), placeholder: '0', 'aria-label': label }));
    const el = h('form', { class: 'stack', on: { submit: (e) => {
      e.preventDefault();
      const name = f.name.value.trim();
      const grams = +f.grams.value;
      const vals = Object.fromEntries(['kcal', 'p', 'c', 'fiber', 'fat'].map((k) => [k, Math.max(0, +f[k].value || 0)]));
      if (!name) { toast('Give the food a name', { kind: 'danger' }); f.name.focus(); return; }
      if (!(grams > 0 && grams <= 5000)) { toast('Serving size must be in grams (1–5000)', { kind: 'danger' }); f.grams.focus(); return; }
      if (!vals.kcal) vals.kcal = Math.round(vals.p * 4 + vals.c * 4 + vals.fat * 9);
      if (!vals.kcal) { toast('Enter calories per serving', { kind: 'danger' }); f.kcal.focus(); return; }
      const k = 100 / grams;
      const food = {
        id: uid('cf-'), name, brand: f.brand.value.trim() || undefined,
        serving: { label: f.label.value.trim() || '1 serving', grams },
        per100: { kcal: r1(vals.kcal * k), p: r1(vals.p * k), c: r1(vals.c * k), f: r1(vals.fat * k), fiber: r1(vals.fiber * k) },
        tags: ['custom'], ...(pre.barcode || f.barcode.value.trim() ? { barcode: (pre.barcode || f.barcode.value.trim()).replace(/\D/g, '') } : {}),
      };
      store.update((s2) => { s2.customFoods = [food, ...(s2.customFoods || [])]; });
      toast(`Saved ${name} to My Foods`, { kind: 'go' });
      detailPage(food);
    } } },
    backBtn(),
    field('Name', txt('name', 'Food name', pre.name || '', 'e.g. Mum’s lasagne')),
    field('Brand (optional)', txt('brand', 'Brand', pre.brand || '')),
    h('div', { class: 'grid2' },
      field('Serving label', txt('label', 'Serving label', pre.label || '1 serving', '1 bar, 1 cup…')),
      field('Serving size', h('div', { class: 'input-unit' }, numIn('grams', 'Serving grams', pre.grams ?? ''), h('span', null, 'g')))),
    h('h4', null, 'Per serving'),
    h('div', { class: 'grid2' },
      field('Calories', h('div', { class: 'input-unit' }, numIn('kcal', 'Calories per serving'), h('span', null, 'kcal'))),
      field('Protein', h('div', { class: 'input-unit' }, numIn('p', 'Protein per serving'), h('span', null, 'g'))),
      field('Carbs', h('div', { class: 'input-unit' }, numIn('c', 'Carbs per serving'), h('span', null, 'g'))),
      field('Fat', h('div', { class: 'input-unit' }, numIn('fat', 'Fat per serving'), h('span', null, 'g'))),
      field('Fiber', h('div', { class: 'input-unit' }, numIn('fiber', 'Fiber per serving'), h('span', null, 'g'))),
      field('Barcode (optional)', h('input', { type: 'text', inputmode: 'numeric', value: pre.barcode || '', maxlength: '14', 'aria-label': 'Barcode', on: { input: (e) => { e.target.value = e.target.value.replace(/\D/g, ''); } } }))),
    h('button', { type: 'submit', class: 'btn primary block xl' }, icon('check', 18), 'Save food'));
    f.barcode = el.querySelector('input[aria-label="Barcode"]');
    show(el, 'Create food');
    setTimeout(() => (pre.name ? f.grams : f.name).focus({ preventScroll: true }), 60);
  }

  // ---------- barcode ----------
  function barcodePage() {
    const status = h('p', { class: 'small fu-status', role: 'status' });
    const code = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: 'e.g. 5000159484695', maxlength: '14', 'aria-label': 'Barcode number',
      on: { input: (e) => { e.target.value = e.target.value.replace(/\D/g, ''); } } });
    const resultEl = h('div');
    let stream = null, timer = null, alive = true, ctrl = null;
    const stopCam = () => {
      alive = false; clearTimeout(timer); timer = null;
      try { stream?.getTracks().forEach((t) => t.stop()); } catch {}
      stream = null;
      if (video) { video.srcObject = null; }
      camBox?.classList.remove('live');
    };
    const abort = () => { try { ctrl?.abort(); } catch {} };
    cleanups.add(stopCam); cleanups.add(abort);

    const lookup = async (raw) => {
      const c = String(raw || '').replace(/\D/g, '');
      if (c.length < 6) { status.textContent = 'Enter the 8–13 digit number under the barcode.'; return; }
      stopCam();
      clear(resultEl);
      const local = (store.get().customFoods || []).find((f) => f.barcode === c || f.id === 'off-' + c);
      if (local) { detailPage(local); return; }
      status.textContent = `Looking up ${c}…`;
      abort(); ctrl = new AbortController();
      try {
        const data = await fetchJSON(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(c)}.json?fields=product_name,brands,nutriments,serving_quantity,serving_size`, ctrl);
        const food = data && data.status !== 0 && data.product ? parseOffProduct(data.product, c) : null;
        if (!food) {
          status.textContent = `No nutrition data found for ${c}.`;
          resultEl.append(h('button', { type: 'button', class: 'btn subtle block', on: { click: () => createPage({ barcode: c }) } }, icon('plus', 18), 'Create it from the label'));
          return;
        }
        detailPage(food, { fromOff: true, isNewOff: true });
      } catch (err) {
        if (err?.name === 'AbortError' && !ctrl.timedOut) return;
        status.textContent = navigator.onLine === false ? 'You’re offline — barcode lookup needs a connection.' : 'Couldn’t reach Open Food Facts. Check your connection and try again.';
        resultEl.append(h('div', { class: 'row gap' },
          h('button', { type: 'button', class: 'btn subtle grow', on: { click: () => lookup(c) } }, icon('repeat', 16), 'Retry'),
          h('button', { type: 'button', class: 'btn subtle grow', on: { click: () => createPage({ barcode: c }) } }, icon('plus', 16), 'Enter manually')));
      }
    };

    const hasDetector = typeof window !== 'undefined' && 'BarcodeDetector' in window;
    let video = null, camBox = null;
    if (hasDetector) {
      video = h('video', { playsinline: true, muted: true, autoplay: true, 'aria-label': 'Camera preview' });
      camBox = h('div', { class: 'fu-cam' }, video, h('div', { class: 'fu-cam-frame', 'aria-hidden': 'true' }));
    }
    const startCam = async () => {
      if (!hasDetector) return;
      alive = true;
      try {
        let formats = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
        try { const sup = await window.BarcodeDetector.getSupportedFormats(); formats = formats.filter((f) => sup.includes(f)); } catch {}
        const det = new window.BarcodeDetector(formats.length ? { formats } : undefined);
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (!alive) { stopCam(); return; }
        video.srcObject = stream;
        await video.play().catch(() => {});
        camBox.classList.add('live');
        status.textContent = 'Point the camera at a barcode.';
        const tick = async () => {
          if (!alive) return;
          try {
            const codes = await det.detect(video);
            const hit = codes.find((x) => /^\d{6,14}$/.test(x.rawValue || ''));
            if (hit) { haptic(30); code.value = hit.rawValue; lookup(hit.rawValue); return; }
          } catch {}
          timer = setTimeout(tick, 250);
        };
        tick();
      } catch (err) {
        stopCam();
        status.textContent = err?.name === 'NotAllowedError' ? 'Camera permission denied — type the barcode number instead.' : 'Camera unavailable — type the barcode number instead.';
      }
    };

    const el = h('div', { class: 'stack' },
      backBtn(),
      camBox,
      hasDetector ? null : h('p', { class: 'small muted' }, 'Camera scanning isn’t supported in this browser — type the number under the barcode.'),
      h('form', { class: 'row', on: { submit: (e) => { e.preventDefault(); lookup(code.value); } } },
        h('label', { class: 'grow' }, h('span', { class: 'sr-only' }, 'Barcode number'), code),
        h('button', { type: 'submit', class: 'btn primary' }, 'Look up')),
      status, resultEl,
      h('p', { class: 'xs muted' }, 'Lookups use the free Open Food Facts database. Data is community-sourced — check it against the label.'));
    show(el, 'Scan barcode');
    if (hasDetector) startCam(); else setTimeout(() => code.focus(), 60);
  }

  // ---------- online search ----------
  function onlineBlock() {
    const wrap = h('div', { class: 'fu-online' });
    const q = st.q.trim();
    if (st.onlineState === 'idle') {
      wrap.append(h('button', { type: 'button', class: 'btn subtle block', on: { click: () => runOnline(q) } }, icon('search', 16), `Search online for “${q.slice(0, 30)}”`));
    } else if (st.onlineState === 'loading') {
      wrap.append(h('p', { class: 'small muted', role: 'status' }, 'Searching Open Food Facts…'));
    } else if (st.onlineState === 'error') {
      wrap.append(h('p', { class: 'small danger-text', role: 'status' }, navigator.onLine === false ? 'You’re offline.' : 'Online search failed.'),
        h('button', { type: 'button', class: 'btn sm subtle', on: { click: () => runOnline(q) } }, 'Retry'));
    } else if (st.online) {
      wrap.append(sectionHead('Open Food Facts'));
      if (!st.online.length) wrap.append(h('p', { class: 'small muted' }, 'No online matches with nutrition data.'));
      else wrap.append(h('div', { class: 'list card flush' }, st.online.map((f) => {
        const sv = scaleFood(f, f.serving.grams);
        return h('button', { type: 'button', class: 'li', on: { click: () => detailPage(f, { fromOff: true, isNewOff: true }) } },
          h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, f.name), h('div', { class: 'li-sub' }, `${f.brand ? f.brand + ' · ' : ''}${servingText(f)} · ${num(sv.kcal)} kcal`)),
          icon('chevR', 18));
      })));
    }
    return wrap;
  }

  let onlineCtrl = null;
  async function runOnline(q) {
    if (!q) return;
    try { onlineCtrl?.abort(); } catch {}
    onlineCtrl = new AbortController();
    const ctrl = onlineCtrl;
    st.onlineState = 'loading'; paintList();
    try {
      const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=24&fields=code,product_name,brands,nutriments,serving_quantity,serving_size`;
      const data = await fetchJSON(url, ctrl);
      if (st.q.trim() !== q) return;
      st.online = (Array.isArray(data?.products) ? data.products : []).map((p) => parseOffProduct(p, String(p.code || ''))).filter(Boolean).slice(0, 20);
      st.onlineState = 'done';
    } catch (err) {
      if (err?.name === 'AbortError' && !ctrl.timedOut) return;
      st.onlineState = 'error';
    }
    if (st.q.trim() === q) paintList();
  }
  browse();
  return sh;
}

function saveCustomFood(food) {
  const existing = (store.get().customFoods || []).find((f) => f.id === food.id);
  if (existing) return existing;
  const clean = { id: food.id, name: food.name, ...(food.brand ? { brand: food.brand } : {}), serving: { ...food.serving }, per100: { ...food.per100 }, tags: [...(food.tags || [])], ...(food.barcode ? { barcode: food.barcode } : {}), ...(food.source ? { source: food.source } : {}) };
  store.update((st) => { st.customFoods = [clean, ...(st.customFoods || [])]; });
  return clean;
}

// ---------------------------------------------------------------------------------------------
// Open Food Facts (untrusted remote data — only ever rendered as text)
async function fetchJSON(url, ctrl) {
  const t = setTimeout(() => { ctrl.timedOut = true; ctrl.abort(); }, OFF_TIMEOUT);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) { if (res.status === 404) return null; throw new Error('HTTP ' + res.status); }
    return await res.json();
  } finally { clearTimeout(t); }
}

const cleanText = (v, max = 80) => String(v ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const nz = (v, max) => { const x = parseFloat(v); return Number.isFinite(x) && x >= 0 ? Math.min(max, x) : 0; };

export function parseOffProduct(p, code) {
  if (!p || typeof p !== 'object') return null;
  const n = p.nutriments || {};
  const name = cleanText(p.product_name);
  let kcal = parseFloat(n['energy-kcal_100g']);
  if (!Number.isFinite(kcal)) { const kj = parseFloat(n['energy-kj_100g'] ?? n.energy_100g); if (Number.isFinite(kj)) kcal = kj / 4.184; }
  if (!name || !Number.isFinite(kcal) || kcal < 0 || kcal > 950) return null;
  const sq = parseFloat(p.serving_quantity);
  const grams = Number.isFinite(sq) && sq > 0 && sq <= 2000 ? Math.round(sq * 10) / 10 : 100;
  const label = grams === 100 && !(sq > 0) ? '100 g' : (cleanText(p.serving_size, 40) || `${grams} g`);
  const c = String(code || '').replace(/\D/g, '').slice(0, 14);
  return {
    id: c ? 'off-' + c : 'off-' + cleanText(name, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name, brand: cleanText(String(p.brands || '').split(',')[0], 40) || undefined,
    serving: { label, grams },
    per100: { kcal: Math.round(kcal), p: r1(nz(n.proteins_100g, 100)), c: r1(nz(n.carbohydrates_100g, 100)), f: r1(nz(n.fat_100g, 100)), fiber: r1(nz(n.fiber_100g, 100)) },
    tags: ['off'], ...(c ? { barcode: c } : {}), source: 'off',
  };
}

// ---------------------------------------------------------------------------------------------
// Water
function waterCard(s, ctx) {
  const imperial = s.profile.units !== 'metric';
  const ml = sel.waterFor(s, ctx.date);
  const target = Math.max(250, +s.targets.waterMl || 3000);
  const fmt = (v) => (imperial ? `${num(v / ML_PER_OZ)} oz` : v >= 1000 ? `${num(v / 1000, 2)} L` : `${num(v)} ml`);
  const glassMl = imperial ? 8 * ML_PER_OZ : 250;
  const nGlasses = Math.min(16, Math.ceil(target / glassMl));
  const filled = ml / glassMl;
  const glasses = h('div', { class: 'fu-glasses', 'aria-hidden': 'true' },
    Array.from({ length: nGlasses }, (_, i) => h('span', { class: 'fu-glass' }, h('i', { style: { height: `${clamp(filled - i, 0, 1) * 100}%` } }))));
  const add = (delta) => {
    store.update((st) => { st.water[ctx.date] = Math.max(0, Math.round((st.water[ctx.date] || 0) + delta)); });
    ctx.waterHist.push(delta);
    haptic();
  };
  const undo = () => {
    const d = ctx.waterHist.pop();
    if (d == null) return;
    store.update((st) => { st.water[ctx.date] = Math.max(0, Math.round((st.water[ctx.date] || 0) - d)); if (!st.water[ctx.date]) delete st.water[ctx.date]; });
  };
  const small = imperial ? 8 * ML_PER_OZ : 250, big = imperial ? 16 * ML_PER_OZ : 500;
  const pct = Math.round((ml / target) * 100);
  return h('section', { class: 'card fu-water', 'aria-label': 'Water' },
    h('div', { class: 'row between' },
      h('div', { class: 'row' }, h('span', { class: 'fu-ico water' }, icon('drop', 18)), h('h3', null, 'Water')),
      h('div', { class: 'tabular' }, h('b', { class: 'big' }, fmt(ml)), h('span', { class: 'muted small' }, ` / ${fmt(target)}`))),
    glasses,
    h('div', { class: 'bar thin', role: 'progressbar', 'aria-label': 'Water progress', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100' },
      h('i', { style: { width: clamp(pct, 0, 100) + '%', background: 'var(--water)' } })),
    h('div', { class: 'row fu-water-btns' },
      h('button', { type: 'button', class: 'btn sm subtle grow', on: { click: () => add(small) } }, icon('plus', 15), imperial ? '8 oz' : '250 ml'),
      h('button', { type: 'button', class: 'btn sm subtle grow', on: { click: () => add(big) } }, icon('plus', 15), imperial ? '16 oz' : '500 ml'),
      h('button', { type: 'button', class: 'btn sm subtle grow', on: { click: () => customWater(ctx, imperial, add) } }, 'Custom'),
      h('button', { type: 'button', class: 'icon-btn filled', 'aria-label': 'Undo last water', disabled: !ctx.waterHist.length, on: { click: undo } }, icon('repeat', 18))));
}

function customWater(ctx, imperial, add) {
  const input = h('input', { type: 'number', inputmode: 'decimal', min: '0', step: 'any', placeholder: imperial ? '12' : '330', 'aria-label': 'Amount' });
  const unit = imperial ? 'oz' : 'ml';
  const val = () => { const v = parseFloat(input.value); return Number.isFinite(v) && v > 0 ? (imperial ? v * ML_PER_OZ : v) : 0; };
  trackSheet(ctx, {
    title: 'Log water',
    content: ({ close }) => h('form', { class: 'stack', on: { submit: (e) => { e.preventDefault(); const v = val(); if (v) { add(v); close(); } } } },
      field(`Amount (${unit})`, h('div', { class: 'input-unit' }, input, h('span', null, unit))),
      h('div', { class: 'row gap' },
        h('button', { type: 'button', class: 'btn ghost grow', on: { click: () => { const v = val(); if (v) { add(-v); close(); } } } }, icon('minus', 16), 'Remove'),
        h('button', { type: 'submit', class: 'btn primary grow' }, icon('plus', 16), 'Add'))),
  });
  setTimeout(() => input.focus(), 60);
}

// ---------------------------------------------------------------------------------------------
// Weekly strip
function weeklyCard(s, ctx) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(ctx.date, i - 6));
  const base = +s.targets.kcal || 0;
  let pSum = 0, kSum = 0, logged = 0;
  const bars = days.map((d) => {
    const t = sel.totalsFor(s, d);
    const dt = dayTargets(s.targets, isTrainingDay(s, d));
    if (t.kcal > 0) { logged++; pSum += t.p; kSum += t.kcal; }
    const ok = dt.kcal && Math.abs(t.kcal - dt.kcal) <= dt.kcal * 0.1;
    return { label: fmtDate(d, { weekday: 'narrow' }), value: t.kcal, color: !t.kcal ? 'var(--surface-3)' : ok ? 'var(--go)' : t.kcal > dt.kcal ? 'var(--warn)' : 'var(--accent)', dim: d !== ctx.date && !t.kcal };
  });
  const avgP = logged ? pSum / logged : 0, avgK = logged ? kSum / logged : 0;
  return h('section', { 'aria-label': 'Last 7 days' },
    sectionHead('Last 7 days'),
    h('div', { class: 'card' },
      barChart({ bars, height: 130, target: base, yFmt: (v) => (v >= 1000 ? `${r1(v / 1000)}k` : String(r0(v))), ariaLabel: `Calories for the 7 days ending ${fmtDate(ctx.date)} against a ${num(base)} kcal target` }),
      h('div', { class: 'fu-legend xs muted' },
        h('span', null, h('i', { class: 'dot', style: { background: 'var(--go)' } }), 'within 10 %'),
        h('span', null, h('i', { class: 'dot', style: { background: 'var(--accent)' } }), 'under'),
        h('span', null, h('i', { class: 'dot', style: { background: 'var(--warn)' } }), 'over')),
      h('div', { class: 'grid3 mt' },
        h('div', { class: 'stat' }, h('span', { class: 'v' }, logged ? num(avgK) : '–'), h('span', { class: 'k' }, 'Avg kcal')),
        h('div', { class: 'stat' }, h('span', { class: 'v', style: { color: 'var(--protein)' } }, logged ? num(avgP) : '–', h('small', null, `/${num(s.targets.protein)} g`)), h('span', { class: 'k' }, 'Avg protein')),
        h('div', { class: 'stat' }, h('span', { class: 'v' }, `${logged}`, h('small', null, '/7')), h('span', { class: 'k' }, 'Days logged')))));
}

// ---------------------------------------------------------------------------------------------
// Adaptive targets
// Apply semantics: applying a suggestion writes kcal + macros (protein/fat by the §5 rules, carbs remainder)
// into store.targets and sets targets.auto = false with targets.source = 'adaptive' and
// targets.adaptive = {tdee, appliedAt, confidence}. auto must go false: Today/Me recompute "auto" targets
// from the formula on every weigh-in/profile edit, which would silently undo the data-driven calibration.
// "Back to formula" restores computeTargets(profile) with auto = true. Suggestions are offered at most
// weekly (7 days after the last apply), matching a MacroFactor-style weekly check-in.
function adaptiveCard(s, ctx) {
  const today = todayISO();
  const res = adaptiveTdee(s, today);
  const imperial = s.profile.units !== 'metric';
  const t = s.targets;
  const applied = t.source === 'adaptive' && !t.auto && t.adaptive?.appliedAt;
  const sinceApply = applied ? Math.round((Date.parse(today) - Date.parse(t.adaptive.appliedAt)) / 86400000) : Infinity;
  const coolDown = sinceApply < 7;
  const children = [];
  const logWeightBtn = h('button', { type: 'button', class: 'btn sm subtle', on: { click: () => openWeight() } }, icon('scale', 16), 'Log weight');

  if (!res.tdee) {
    const prog = clamp(res.days / 14, 0, 1);
    children.push(
      h('p', { class: 'small dim' }, 'FORGE estimates your real maintenance calories from your weight trend and what you eat — then suggests a new target each week.'),
      h('div', { class: 'row between xs muted mt' }, h('span', null, res.reason || 'Collecting data…'), h('span', { class: 'tabular' }, `${Math.min(14, res.days)}/14 days`)),
      h('div', { class: 'bar thin mt' }, h('i', { style: { width: prog * 100 + '%' } })),
      h('div', { class: 'row gap mt' }, logWeightBtn, h('span', { class: 'xs muted' }, `${res.weighIns} weigh-ins · ${res.intakeDays} food days`)));
  } else {
    const wk = res.weeklyChangeKg;
    const wkTxt = `${wk > 0 ? '+' : wk < 0 ? '−' : '±'}${fmtWeight(Math.abs(wk), imperial ? 'imperial' : 'metric', 1)}/wk`;
    children.push(
      h('div', { class: 'grid3' },
        h('div', { class: 'stat' }, h('span', { class: 'v accent' }, num(res.tdee)), h('span', { class: 'k' }, 'Est. TDEE')),
        h('div', { class: 'stat' }, h('span', { class: 'v' }, num(res.avgIntake)), h('span', { class: 'k' }, 'Avg intake')),
        h('div', { class: 'stat' }, h('span', { class: 'v' }, wkTxt), h('span', { class: 'k' }, 'Trend'))),
      res.trendKg.length > 2 ? h('div', { class: 'fu-trend' }, lineChart({
        series: [{ points: res.trendKg.map((p, i) => ({ x: i, y: imperial ? p.kg / 0.45359237 : p.kg })), color: 'var(--accent)', area: true }],
        height: 90, yTicks: 2, yFmt: (v) => num(v, 1), ariaLabel: 'Weight trend',
      })) : null,
      h('p', { class: 'xs muted' }, `Based on ${res.days} days · ${res.weighIns} weigh-ins · ${res.intakeDays} food days · formula estimate ${num(formulaTdee(s.profile))} kcal · confidence `,
        h('b', { class: res.confidence === 'high' ? 'go' : res.confidence === 'med' ? 'warn-text' : 'danger-text' }, res.confidence === 'med' ? 'medium' : res.confidence)),
      res.reason ? h('p', { class: 'xs warn-text' }, res.reason) : null);
    if (res.suggestion && !coolDown) {
      const sg = res.suggestion;
      children.push(h('div', { class: 'callout fu-suggest' },
        h('div', { class: 'row between top' },
          h('div', null, h('div', { class: 'eyebrow' }, 'Suggested daily target'),
            h('div', { class: 'big tabular' }, num(sg.kcal), h('small', { class: 'muted' }, ' kcal')),
            h('div', { class: 'xs muted tabular' }, `P ${sg.protein} g · C ${sg.carbs} g · F ${sg.fat} g · ${sg.delta > 0 ? '+' : '−'}${num(Math.abs(sg.delta))} vs now`)),
          h('button', { type: 'button', class: 'btn sm primary', on: { click: () => applySuggestion(res) } }, icon('check', 16), 'Apply'))));
    } else if (coolDown) {
      children.push(h('p', { class: 'small go' }, icon('check', 14), ` Adaptive target applied ${sinceApply === 0 ? 'today' : `${sinceApply} day${sinceApply > 1 ? 's' : ''} ago`}. Next check-in in ${7 - sinceApply} day${7 - sinceApply > 1 ? 's' : ''}.`));
    } else {
      children.push(h('p', { class: 'small go' }, icon('check', 14), ' Your current target matches your data — no change needed.'));
    }
    children.push(h('div', { class: 'row gap mt' }, logWeightBtn));
  }
  if (applied) {
    children.push(h('div', { class: 'row between xs muted mt fu-adapt-foot' },
      h('span', null, `Using adaptive target (${num(t.kcal)} kcal) since ${fmtDate(t.adaptive.appliedAt)}.`),
      h('button', { type: 'button', class: 'link-btn', on: { click: () => resetToFormula() } }, 'Back to formula')));
  }
  return h('section', { 'aria-label': 'Adaptive targets' },
    sectionHead('Adaptive targets', h('span', { class: 'pill' + (res.tdee ? ' go' : '') }, res.tdee ? 'Active' : 'Learning')),
    h('div', { class: 'card fu-adapt' }, children));
}

function applySuggestion(res) {
  const prev = { ...store.get().targets };
  const today = todayISO();
  store.update((st) => {
    const m = macrosForKcal(st.profile, res.suggestion.kcal);
    st.targets = { ...st.targets, kcal: m.kcal, protein: m.protein, carbs: m.carbs, fat: m.fat, auto: false, source: 'adaptive', adaptive: { tdee: res.tdee, appliedAt: today, confidence: res.confidence } };
  });
  haptic(20);
  toast(`Target set to ${num(res.suggestion.kcal)} kcal`, { kind: 'go', action: { label: 'Undo', fn: () => store.update((st) => { st.targets = prev; }) }, ms: 5000 });
}

function resetToFormula() {
  const prev = { ...store.get().targets };
  store.update((st) => {
    const c = computeTargets(st.profile);
    st.targets = { ...c, auto: true };
  });
  toast('Targets back to the formula', { action: { label: 'Undo', fn: () => store.update((st) => { st.targets = prev; }) } });
}

async function openWeight() {
  try {
    const m = await import('./today.js');
    if (typeof m.openWeightSheet === 'function') { m.openWeightSheet(); return; }
  } catch (e) { console.warn('weight sheet unavailable', e); }
  navigate('#/progress');
}
