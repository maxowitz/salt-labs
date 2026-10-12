// FORGE Fuel — food log, macro rings, water, weekly adherence and adaptive targets (docs/PROMPT.md §3.4).
// Routes: #/fuel, #/fuel/<YYYY-MM-DD>, optional ?add=<breakfast|lunch|dinner|snacks|auto> opens the add sheet.
import { store, sel, todayISO, addDays, uid, isISODate } from '../store.js';
import { h, clear, toast, sheet, num, fmtDate, icon, navigate, seg, field, sectionHead, haptic, clamp, fmtWeight, fig, masthead } from '../ui.js';
import { barChart, lineChart, ticks } from '../charts.js';
import { FOODS } from '../data/foods.js';
import { dayTargetsFor, adaptiveTdee, scaleFood, searchFoods, computeTargets, macrosForKcal, fiberTarget, parseNum, sodiumSummary, energyAvailability, fuelingNote, maxGoalRate, goalKcal, validateQuickAdd, validateCustomFood, validateWaterMl, amountError } from '../engine/nutrition.js';

const MEALS = [['breakfast', 'Breakfast'], ['lunch', 'Lunch'], ['dinner', 'Dinner'], ['snacks', 'Snacks']];
const MEAL_LABEL = Object.fromEntries(MEALS);
const ML_PER_OZ = 29.5735;
const OFF_TIMEOUT = 8000;
const RECENT_CAP = 30;
const OZ_G = 28.3495;
const HH_UNITS = new Set(['cup', 'tbsp', 'tsp']);

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

// Like ui.field() but a <div role=group>: a <label> wrapper would forward clicks on a segmented control
// to its first button, so the meal picker could never leave "Breakfast".
function groupField(label, control) {
  return h('div', { class: 'field', role: 'group', 'aria-label': label }, h('span', { class: 'field-label' }, label), control);
}

// Deferred autofocus that never steals focus from a field the user is already typing in.
function softFocus(el, ms = 60, select = false) {
  setTimeout(() => {
    if (!el?.isConnected) return;
    const a = document.activeElement;
    if (a && a !== el && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
    el.focus({ preventScroll: true });
    if (select) { try { el.select(); } catch {} }
  }, ms);
}

function allFoods(s) { return [...(s.customFoods || []), ...FOODS]; }
function foodMap(s) { const m = new Map(); for (const f of allFoods(s)) if (f?.id && !m.has(f.id)) m.set(f.id, f); return m; }

function servingText(food) {
  const g = +food.serving?.grams || 100;
  const lbl = food.serving?.label || '100 g';
  return /\bg\b/.test(lbl) && lbl.includes(String(Math.round(g))) ? lbl : `${lbl} · ${fmtG(g)} g`;
}

function entryAmount(e) {
  if (!e.grams && !['g', 'oz'].includes(e.unit)) {
    const u = !e.unit || e.unit === 'quick add' ? 'Quick add' : e.unit;
    return e.qty && e.qty !== 1 ? `${fmtG(e.qty)} × ${u}` : u;
  }
  if (e.unit === 'g') return `${fmtG(e.qty)} g`;
  if (e.unit === 'oz' || HH_UNITS.has(e.unit)) return `${fmtG(e.qty)} ${e.unit} · ${fmtG(e.grams)} g`;
  const q = +e.qty || 1;
  return `${q === 1 ? '' : fmtG(q) + ' × '}${e.unit || 'serving'} · ${fmtG(e.grams)} g`;
}

/**
 * Portion units for a food (R1 P1-6): Servings, a household unit parsed from the serving label
 * ("½ cup" → cup, "2 tbsp" → tbsp), grams, and ounces for imperial users.
 * → [{id:'serving'|'hh'|'g'|'oz', seg, unit, gramsPer, step, presets}]
 */

function entryName(food) { return food.brand ? `${food.name} · ${food.brand}` : food.name; }

/** Build a FoodEntry from a food and an amount ({mode:'serving'|'g', qty}). */
export function makeEntry(food, meal, mode, qty, imperial = true) {
  const u = portionUnits(food, true).find((x) => x.id === mode) || portionUnits(food, imperial)[0];
  const grams = qty * u.gramsPer;
  const m = scaleFood(food, grams);
  return {
    id: uid('fe'), meal, foodId: food.id || null, name: entryName(food),
    qty: Math.round(qty * 100) / 100, unit: u.id === 'serving' ? (food.serving?.label || 'serving') : u.unit,
    grams: Math.round(grams * 10) / 10, ...m,
  };
}

function pushRecent(st, id) {
  if (!id) return;
  st.recentFoods = [id, ...(st.recentFoods || []).filter((x) => x !== id)].slice(0, RECENT_CAP);
}

/** Fuel-private settings bag (lastPortion per food, days flagged incomplete). Lives in settings.fuel. */

// ---------------------------------------------------------------------------------------------
export function render(root, { args = [], query = {} } = {}) {
  const badDate = args[0] != null && !isISODate(args[0]);
  const date = badDate ? todayISO() : args[0] || todayISO();
  if (badDate) {
    try { history.replaceState(null, '', location.pathname + location.search + '#/fuel'); } catch {}
    setTimeout(() => toast('That date doesn’t exist — showing today', { ms: 2200 }), 50);
  }
  const ctx = { date, sheets: new Set(), waterHist: [] };

  const paint = () => {
    const y = window.scrollY;
    const s = store.get();
    clear(root).append(
      header(s, ctx),
      summaryCard(s, ctx),
      ...MEALS.map(([id, label]) => mealCard(s, ctx, id, label)),
      dayTools(s, ctx),
      waterCard(s, ctx),
      weeklyCard(s, ctx),
      adaptiveCard(s, ctx),
    );
    if (Math.abs(window.scrollY - y) > 2) window.scrollTo(0, y);
  };
  ctx.paint = paint;
  paint();
  if (photoAvail == null) checkPhotoAvailable().then((ok) => { if (ok && root.isConnected) paint(); });
  const unsub = store.subscribe(() => paint());

  if (query.add) {
    const meal = MEAL_LABEL[query.add] ? query.add : defaultMeal();
    try { history.replaceState(null, '', location.pathname + location.search + `#/fuel${args[0] && !badDate ? '/' + date : ''}`); } catch {}
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
      change: (e) => { if (isISODate(e.target.value)) go(e.target.value); },
      click: (e) => { try { e.target.showPicker?.(); } catch {} },
    },
  });
  const t = targetsFor(s, date);
  const sessTitle = t.sessions?.length ? t.sessions.map((x) => x.title).join(' + ') : '';
  const badge = t.dayType == null ? h('span', { class: 'pill', title: 'No plan for this date — showing your weekly-average target' }, 'No plan')
    : t.dayType === 'training' ? h('span', { class: 'pill', title: `${sessTitle}: ~${num(t.trainingKcal)} kcal training energy` }, t.intensity === 'hard' ? 'Hard day' : 'Training day')
      : h('span', { class: 'pill', title: 'Rest day: fewer carbs, same protein' }, 'Rest day');
  return h('div', { class: 'fu-head' },
    masthead(fmtDate(today, { weekday: 'short', day: 'numeric', month: 'short' })),
    h('div', { class: 'page-head fu-title' }, h('h1', null, 'Fuel'), badge),
    h('div', { class: 'fu-dates' },
      h('button', { type: 'button', class: 'icon-btn filled', 'aria-label': 'Previous day', on: { click: () => go(addDays(date, -1)) } }, icon('chevL')),
      h('div', { class: 'fu-date' },
        h('span', { class: 'fu-date-main' }, rel),
        rel !== fmtDate(date) ? h('span', { class: 'fu-date-sub' }, fmtDate(date)) : null,
        picker),
      h('button', { type: 'button', class: 'icon-btn filled', 'aria-label': 'Next day', on: { click: () => go(addDays(date, 1)) } }, icon('chevR')),
      date !== today ? h('button', { type: 'button', class: 'btn sm subtle', on: { click: () => go(today) } }, 'Today') : null),
    h('div', { class: 'row fu-head-actions' },
      h('button', { type: 'button', class: 'btn sm subtle grow', on: { click: () => openAddSheet(ctx, defaultMeal()) } }, '+ Log food'),
      photoAvail === true ? h('button', { type: 'button', class: 'btn sm subtle grow fu-snap-btn', on: { click: () => openAddSheet(ctx, defaultMeal(), { photo: true }) } }, 'Snap meal') : null));
}

// ---------------------------------------------------------------------------------------------
// Summary
function summaryCard(s, ctx) {
  const t = targetsFor(s, ctx.date);
  const tot = totalsOf(sel.foodsFor(s, ctx.date));
  const left = r0(t.kcal - tot.kcal);
  const over = left < 0;
  const fT = t.fiber ?? fiberTarget(t.kcal);
  const macro = (label, key, tKey, color) => {
    const v = tot[key], target = +t[tKey] || 0, rem = r0(target - v);
    return h('div', { class: 'fu-macro lrow', style: { '--c': color } },
      h('span', { class: 'fu-macro-k' }, h('i', { class: 'swatch', style: { background: color } }), label),
      ticks({ value: v, max: target || 1, n: 41, color, label: `${label} ${r0(v)} of ${r0(target)} g` }),
      h('span', { class: 'fu-macro-v' }, fig(r0(v), `/${r0(target)} g`),
        h('span', { class: 'fu-macro-left' + (rem < 0 ? ' danger-text' : '') }, rem >= 0 ? `${rem} g left` : `${-rem} g over`)));
  };
  const extras = [
    h('span', null, 'fiber ', r0(tot.fiber), ` / ${fT} g`),
    tot.alc > 0 ? h('span', { title: 'Alcohol: 7 kcal per gram, not in P/C/F' }, `alcohol ${r0(tot.alc)} g`) : null,
    sodiumLine(sel.foodsFor(s, ctx.date)),
  ];
  const sessionNote = t.dayType === 'training' && t.sessions?.length
    ? h('p', { class: 'xs muted fu-sess-note' }, `${t.sessions.map((x) => `${x.title}${x.min ? ` · ${x.min} min` : ''}`).join(' + ')} — target includes ~${num(t.trainingKcal)} kcal of training${t.sessions[0].source === 'planned' ? ' (planned)' : ''}.`)
    : t.notes?.includes('taper-maintenance') ? h('p', { class: 'xs muted fu-sess-note' }, 'Taper: eating at maintenance to arrive fresh.')
      : t.notes?.includes('peak-deficit-eased') ? h('p', { class: 'xs muted fu-sess-note' }, 'Peak phase: deficit eased to 10 % to protect performance.') : null;
  const kt = t.kcal || 1;
  return h('section', { class: 'fu-summary', 'aria-label': 'Daily summary' },
    h('div', { class: 'fu-sum-top' },
      h('div', { class: 'fu-left' }, h('div', { class: 'lbl' + (over ? ' acc' : '') }, over ? 'Kcal over' : 'Kcal left'), h('div', { class: 'fig fu-left-n' + (over ? ' danger-text' : '') }, num(Math.abs(left)))),
      h('div', { class: 'fu-sum-stats' },
        h('div', { class: 'lbl' }, 'Eaten / target', t.dayType === 'training' ? ' · train' : t.dayType === 'rest' ? ' · rest' : ''),
        h('div', null, fig(num(tot.kcal), `/ ${num(t.kcal)}`)))),
    ticks({ value: tot.kcal, max: kt, n: 61, ruler: true, size: 'lg', label: `${num(tot.kcal)} of ${num(t.kcal)} kcal eaten` }),
    h('div', { class: 'fu-scale' }, h('span', { class: 'lbl' }, '0'), h('span', { class: 'lbl' }, num(Math.round(kt / 2))), h('span', { class: 'lbl' }, num(kt))),
    h('div', { class: 'fu-fiber data' }, extras),
    h('div', { class: 'fu-macros ledger' },
      macro('Protein', 'p', 'protein', 'var(--protein)'),
      macro('Carbs', 'c', 'carbs', 'var(--carbs)'),
      macro('Fat', 'f', 'fat', 'var(--fat)')),
    sessionNote,
    fuelNotes(s, ctx.date));
}

/** Sodium with honest coverage (R2 P1-3): a total only when ≥ 80 % of the day's kcal has sodium data. */
function sodiumLine(entries) {
  const na = sodiumSummary(entries);
  if (!na.known) return null;
  if (na.complete) return h('span', { title: `${na.known} of ${na.total} items have sodium data` }, `sodium ≈ ${num(na.mg)} mg`);
  return h('span', { title: 'Some foods have no sodium data, so the real total is higher' }, `sodium ≥ ${num(na.mg)} mg · incomplete (${na.known} of ${na.total} items)`);
}

/** Pre-session fuelling, hard-day carb shortfall and low energy availability (R2 P1-2, P2-4/5). */
function fuelNotes(s, date) {
  const lines = [];
  let fn = null, ea = null;
  try { fn = fuelingNote(s, date); } catch (e) { console.error(e); }
  try { ea = energyAvailability(s, date); } catch (e) { console.error(e); }
  if (fn?.pre) lines.push(h('li', null, h('span', { class: 'lbl' }, 'Before'), h('span', null, fn.pre)));
  if (fn?.during) lines.push(h('li', null, h('span', { class: 'lbl' }, 'During'), h('span', null, fn.during)));
  if (fn?.warn) lines.push(h('li', { class: 'warn' }, h('span', { class: 'lbl acc' }, 'Carbs'), h('span', null, fn.warn)));
  if (ea?.low) lines.push(h('li', { class: 'warn' }, h('span', { class: 'lbl acc' }, 'Energy'),
    h('span', null, `Today’s target leaves ≈ ${num(ea.ea, 0)} kcal per kg of fat-free mass after training — under 30 risks low energy availability (RED-S). `,
      s.profile.goal === 'lose' ? 'Consider a slower goal rate below.' : 'Make sure you eat to target today.')));
  if (!lines.length) return null;
  return h('ul', { class: 'fu-fuel-notes data', 'aria-label': 'Fuelling notes' }, lines);
}

// ---------------------------------------------------------------------------------------------
// Meals
function mealCard(s, ctx, meal, label) {
  const list = sel.foodsFor(s, ctx.date).filter((e) => e.meal === meal);
  const tot = sumEntries(list);
  const yList = sel.foodsFor(s, addDays(ctx.date, -1)).filter((e) => e.meal === meal);
  const mi = MEALS.findIndex(([id]) => id === meal);
  return h('section', { class: 'fu-meal' + (list.length ? '' : ' is-empty'), 'aria-label': label },
    h('div', { class: 'fu-meal-head section-head' },
      h('span', { class: 'ix', 'aria-hidden': 'true' }, String(mi + 1).padStart(2, '0')),
      h('h2', null, label),
      list.length ? h('span', { class: 'fu-meal-kcal lbl' }, `${num(tot.kcal)} kcal`) : null,
      h('button', { type: 'button', class: 'link-btn fu-add-btn', 'aria-label': `Add food to ${label}`, on: { click: () => openAddSheet(ctx, meal) } }, '+ Add')),
    list.length ? h('div', { class: 'data fu-meal-macros' }, macroLine(tot)) : null,
    list.length ? h('div', { class: 'list' }, list.map((e) => h('button', {
      type: 'button', class: 'li fu-entry', 'aria-label': `Edit ${e.name}`, on: { click: () => openEditSheet(ctx, e) },
    },
    h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, e.name, e.source === 'photo' ? h('span', { class: 'fu-src', title: 'Logged from a photo estimate' }, ' · photo') : null),
      h('div', { class: 'li-sub data' }, `${entryAmount(e)} · ${macroLine(e)}`)),
    h('div', { class: 'li-end' }, h('div', { class: 'fu-kcal fig' }, num(e.kcal)))))) : null,
    yList.length || list.length ? h('div', { class: 'fu-meal-actions' },
      yList.length ? h('button', { type: 'button', class: 'link-btn', on: { click: () => copyMeal(ctx, meal, yList) }, title: `Copy ${yList.length} item(s) from yesterday` }, 'Copy yesterday') : null,
      list.length ? h('button', { type: 'button', class: 'link-btn', on: { click: () => saveTemplate(ctx, meal, list) } }, 'Save meal') : null) : null);
}

/** Day tools under the meals: copy from another day (whole day or chosen meals), flag an incomplete day. */

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

function addEntries(date, entries, { toastMsg, portions } = {}) {
  store.update((st) => {
    const arr = st.foodLog[date] || (st.foodLog[date] = []);
    for (const e of entries) { arr.push(e); pushRecent(st, e.foodId || null); }
    // remember the portion per food so Recent / Favourites "+" re-logs the same amount (R1 P1-5)
    if (portions?.length) updateFuelMeta(st, (m) => { for (const p of portions) if (p.foodId) m.lastPortion[p.foodId] = { mode: p.mode, qty: p.qty }; });
  });
  haptic();
  if (toastMsg) toast(toastMsg, { action: { label: 'Undo', fn: () => removeEntries(date, entries.map((e) => e.id)) } });
}

function saveTemplate(ctx, meal, list) {
  const words = list.slice(0, 3).map((e) => String(e.name).split(/[,·(—]/)[0].trim().split(' ').slice(0, 2).join(' '));
  const def = (words.join(' + ') + (list.length > 3 ? ` +${list.length - 3}` : '')).slice(0, 60) || `${MEAL_LABEL[meal]} · ${fmtDate(ctx.date, { month: 'short', day: 'numeric' })}`;
  const input = h('input', { type: 'text', value: def, maxlength: '60', 'aria-label': 'Meal name' });
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
  softFocus(input, 60, true);
  return sh;
}

/** Amount editor over portionUnits(): seg of units, ± stepper, number field, presets. */

// ---------------------------------------------------------------------------------------------
// Amount editor shared by the detail panel and the edit sheet
function amountEditor({ units, mode, qty, onChange }) {
  const st = { u: units.find((x) => x.id === mode) || units[0], qty };
  const grams = () => st.qty * st.u.gramsPer;
  const input = h('input', {
    type: 'number', inputmode: 'decimal', min: '0', step: 'any', class: 'fu-amt-input', value: String(st.qty), 'aria-label': 'Amount',
    on: { input: (e) => { const v = parseFloat(e.target.value); st.qty = Number.isFinite(v) && v >= 0 ? v : 0; emit(); paintPresets(); } },
  });
  const unitEl = h('span', { class: 'fu-amt-unit' });
  const gEl = h('span', { class: 'fu-amt-g tabular' });
  const presetsEl = h('div', { class: 'chips' });
  const errEl = h('p', { class: 'fu-err', role: 'alert' });
  const validNow = () => amountError(grams(), rawOf(input));
  const emit = () => {
    gEl.textContent = st.u.id === 'g' ? '' : `= ${fmtG(Math.round(grams()))} g`;
    const err = validNow();
    errEl.textContent = err || '';
    fieldEl.classList.toggle('invalid', !!err);
    if (err) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    onChange({ mode: st.u.id, unit: st.u, qty: st.qty, grams: grams(), valid: !err, error: err });
  };
  const setQty = (v) => { st.qty = Math.max(0, Math.round(v * 100) / 100); input.value = String(st.qty); emit(); };
  const frac = (v) => ({ 0.25: '¼', 0.5: '½', 0.75: '¾', 1.5: '1½' }[v] || String(v));
  const paintPresets = () => {
    clear(presetsEl);
    unitEl.textContent = st.u.id === 'serving' ? (st.qty === 1 ? st.u.unit : `× ${st.u.unit}`) : st.u.unit;
    for (const v of st.u.presets) presetsEl.append(h('button', { type: 'button', class: 'chip' + (v === st.qty ? ' on' : ''), on: { click: () => { setQty(v); paintPresets(); } } },
      st.u.id === 'g' ? `${v} g` : st.u.id === 'oz' ? `${v} oz` : st.u.id === 'hh' ? `${frac(v)} ${st.u.unit}` : frac(v)));
  };
  const fieldEl = h('label', { class: 'fu-amt-field' }, input, unitEl, gEl);
  const segEl = units.length > 1 ? seg(units.map((u) => [u.id, u.seg]), st.u.id, (id) => {
    if (id === st.u.id) return;
    const g = grams();
    st.u = units.find((x) => x.id === id);
    const raw = g / st.u.gramsPer;
    st.qty = st.u.id === 'g' ? Math.round(raw) : st.u.id === 'oz' ? Math.round(raw * 2) / 2 : Math.round(raw * 100) / 100;
    input.value = String(st.qty);
    paintPresets(); emit();
  }, { label: 'Amount unit' }) : null;
  paintPresets();
  const el = h('div', { class: 'stack fu-amt' },
    segEl,
    h('div', { class: 'fu-amt-row' },
      h('button', { type: 'button', class: 'icon-btn filled', 'aria-label': 'Less', on: { click: () => { haptic(); setQty(st.qty - (st.u.id === 'g' && st.qty >= 100 ? 25 : st.u.step)); paintPresets(); } } }, icon('minus')),
      fieldEl,
      h('button', { type: 'button', class: 'icon-btn filled', 'aria-label': 'More', on: { click: () => { haptic(); setQty(st.qty + (st.u.id === 'g' && st.qty >= 100 ? 25 : st.u.step)); paintPresets(); } } }, icon('plus'))),
    errEl, presetsEl);
  queueMicrotask(emit);
  return { el, input, get: () => ({ mode: st.u.id, unit: st.u, qty: st.qty, grams: grams(), valid: !validNow(), error: validNow() }) };
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
  const isQuick = !entry.grams && !['g', 'oz'].includes(entry.unit);
  let meal = entry.meal;
  let next = null; // computed macros
  let nextValid = true;

  const content = ({ close }) => {
    const mp = macroPanel();
    let body;
    if (isQuick) {
      const f = {};
      const numIn = (k, label, v) => (f[k] = h('input', { type: 'number', inputmode: 'decimal', min: '0', step: 'any', value: String(r1(v)), 'aria-label': label, on: { input: upd } }));
      function upd() {
        const v = validateQuickAdd({ kcal: rawOf(f.kcal), p: rawOf(f.p), c: rawOf(f.c), f: rawOf(f.f) });
        quickErr.set(v.ok ? null : Object.values(v.errors)[0]);
        nextValid = v.ok;
        next = { kcal: v.value.kcal, p: r1(v.value.p), c: r1(v.value.c), f: r1(v.value.f), fiber: r1(entry.fiber || 0), name: f.name.value.trim() || 'Quick add' };
        mp.set(next);
      }
      f.name = h('input', { type: 'text', value: entry.name, maxlength: '80', 'aria-label': 'Name', on: { input: upd } });
      const quickErr = formError();
      body = h('div', { class: 'stack' }, field('Name', f.name),
        h('div', { class: 'grid2' }, field('Calories', numIn('kcal', 'Calories', entry.kcal)), field('Protein (g)', numIn('p', 'Protein', entry.p)),
          field('Carbs (g)', numIn('c', 'Carbs', entry.c)), field('Fat (g)', numIn('f', 'Fat', entry.f))), quickErr.el);
      upd();
    } else {
      const per = (k) => (entry.grams > 0 ? ((+entry[k] || 0) / entry.grams) * 100 : 0);
      const basis = food ? food.per100 : { kcal: per('kcal'), p: per('p'), c: per('c'), f: per('f'), fiber: per('fiber'), ...(entry.alc != null ? { alc: per('alc') } : {}), ...(entry.na != null ? { na: per('na') } : {}) };
      const pseudo = food || { serving: { label: entry.unit && unitIdOf(entry.unit) === 'serving' ? entry.unit : 'serving', grams: unitIdOf(entry.unit) === 'serving' && entry.qty ? entry.grams / entry.qty : 100 } };
      const units = portionUnits(pseudo, isImperial(s));
      if (entry.unit === 'oz' && !units.some((u) => u.id === 'oz')) units.splice(units.length - 1, 0, { id: 'oz', seg: 'oz', unit: 'oz', gramsPer: OZ_G, step: 0.5, presets: [2, 3, 4, 6, 8] });
      const toNext = ({ unit, qty, grams }) => ({ ...scaleFood({ per100: basis }, grams), qty: Math.round(qty * 100) / 100, unit: unit.id === 'serving' ? unit.unit : unit.unit, grams: Math.round(grams * 10) / 10 });
      const amt = amountEditor({ units, mode: unitIdOf(entry.unit), qty: +entry.qty || 1, onChange: (v) => { next = toNext(v); nextValid = v.valid; saveBtn.disabled = !v.valid; mp.set(next); } });
      next = toNext(amt.get());
      nextValid = amt.get().valid;
      mp.set(next);
      body = amt.el;
    }
    return h('div', { class: 'stack' },
      h('p', { class: 'small muted' }, `${MEAL_LABEL[entry.meal]} · ${fmtDate(ctx.date)}`),
      body,
      mp.el,
      groupField('Meal', seg(MEALS, meal, (m) => { meal = m; }, { label: 'Meal' })),
      saveBtn,
      h('button', { type: 'button', class: 'btn ghost block fu-del', on: { click: () => { close(); deleteEntry(ctx, entry); } } }, 'Delete'));
  };
  const saveBtn = h('button', { type: 'button', class: 'btn primary block', on: { click: () => {
        if (!next) return;
        if (!nextValid) { toast('Fix the amount first — nothing was saved', { kind: 'danger' }); return; }
        store.update((st) => {
          const arr = st.foodLog[ctx.date] || [];
          const i = arr.findIndex((e) => e.id === entry.id);
          if (i >= 0) arr[i] = { ...arr[i], ...next, meal };
          if (entry.foodId && !isQuick) updateFuelMeta(st, (m) => { m.lastPortion[entry.foodId] = { mode: unitIdOf(next.unit), qty: next.qty }; });
        });
        toast('Updated', { kind: 'go', ms: 1200 });
        sh.close();
      } } }, 'Save');
  const sh = trackSheet(ctx, { title: entry.name, content });
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
function openAddSheet(ctx, initialMeal, opts = {}) {
  const st = { meal: initialMeal, q: '', tab: 'recent', online: null, onlineState: 'idle', page: 'browse', multi: false, picked: new Map() };
  const body = h('div', { class: 'fu-add' });
  const cleanups = new Set();        // per-page (camera, fetches, photo URLs)
  const cleanupsSheet = new Set();   // whole-sheet (store subscription)
  const runCleanups = () => { for (const fn of [...cleanups]) { try { fn(); } catch {} } cleanups.clear(); };
  const sh = trackSheet(ctx, { title: `Add to ${MEAL_LABEL[st.meal]}`, content: body, full: true, onClose: () => {
    runCleanups(); try { onlineCtrl?.abort(); } catch {}
    for (const fn of cleanupsSheet) { try { fn(); } catch {} }
  } });
  const titleEl = sh.panel.querySelector('.sheet-title');
  const setTitle = (t) => { titleEl.textContent = t; };
  const mealTitle = () => setTitle(`Add to ${MEAL_LABEL[st.meal]}`);

  const show = (el, title, withRemaining = false) => { runCleanups(); clear(body).append(...(withRemaining ? [remBar, el] : [el])); sh.body.scrollTop = 0; if (title) setTitle(title); else mealTitle(); };
  const back = () => browse();
  const backBtn = (label = 'Back') => h('button', { type: 'button', class: 'link-btn fu-back', on: { click: back } }, icon('chevL', 18), label);

  const imperial = isImperial(store.get());

  // Remaining-today bar (R1 P1-7): live under the sheet title on browse/detail pages.
  const remBar = h('div', { class: 'fu-rem', 'aria-live': 'polite' });
  const paintRem = () => {
    const s = store.get();
    const t = targetsFor(s, ctx.date);
    const tot = totalsOf(sel.foodsFor(s, ctx.date));
    const cell = (k, v, cls) => h('span', { class: 'fu-rem-c ' + cls }, h('b', { class: 'tabular' + (v < 0 ? ' danger-text' : '') }, num(v)), h('span', null, k));
    clear(remBar).append(h('span', { class: 'fu-rem-k' }, 'Left'),
      cell('kcal', r0(t.kcal - tot.kcal), 'kcal'), cell('P', r0(t.protein - tot.p), 'p'), cell('C', r0(t.carbs - tot.c), 'c'), cell('F', r0(t.fat - tot.f), 'f'));
  };
  paintRem();
  const unsubRem = store.subscribe(() => paintRem());
  cleanupsSheet.add(unsubRem);

  const logFood = (food, mode, qty, { saveOff = false } = {}) => {
    let f = food;
    if (food.source === 'off' && saveOff) f = saveCustomFood(food);
    const e = makeEntry(f, st.meal, mode, qty, imperial);
    if (food.source === 'off' && !saveOff) e.foodId = null;
    addEntries(ctx.date, [e], { toastMsg: `Added ${f.name} to ${MEAL_LABEL[st.meal]}`, portions: e.foodId ? [{ foodId: e.foodId, mode, qty }] : [] });
    return e;
  };

  // ---------- browse ----------
  let searchInput, listEl, multiBar;
  function browse() {
    st.page = 'browse';
    searchInput = h('input', {
      type: 'search', placeholder: `Search ${FOODS.length}+ foods`, value: st.q, autocomplete: 'off', enterkeyhint: 'search', 'aria-label': 'Search foods',
      on: { input: (e) => { st.q = e.target.value; st.online = null; st.onlineState = 'idle'; paintList(); } },
    });
    listEl = h('div', { class: 'fu-results' });
    multiBar = h('div', { class: 'fu-multibar', hidden: true });
    // "Snap a photo" only when the FORGE server answers (static hosting has no photo API → no dead end)
    const photoSlot = h('div', { class: 'fu-photo-slot' });
    const fillPhoto = () => {
      clear(photoSlot);
      if (photoAvail === true) photoSlot.append(h('button', { type: 'button', class: 'fu-photo-entry', on: { click: () => photoPage() } },
        h('span', { class: 'fu-photo-ico' }, cameraIcon(22)),
        h('span', { class: 'fu-photo-txt' }, h('b', null, 'Snap a photo'), h('span', null, 'AI estimates what’s on the plate — you check portions')),
        icon('chevR', 18)));
    };
    fillPhoto();
    if (photoAvail == null) checkPhotoAvailable().then(() => { if (photoSlot.isConnected) fillPhoto(); });
    const selectChip = h('button', { type: 'button', class: 'chip', 'aria-pressed': String(st.multi), on: { click: () => {
      st.multi = !st.multi; st.picked.clear(); selectChip.setAttribute('aria-pressed', String(st.multi)); paintList(); paintMulti();
    } } }, 'Select several');
    const el = h('div', { class: 'stack' },
      seg(MEALS.map(([v, l]) => [v, l]), st.meal, (m) => { st.meal = m; mealTitle(); paintList(); paintMulti(); }, { label: 'Meal' }),
      h('div', { class: 'row' },
        h('label', { class: 'search grow' }, icon('search', 18), searchInput,
          h('button', { type: 'button', class: 'icon-btn fu-clear', 'aria-label': 'Clear search', on: { click: () => { st.q = ''; searchInput.value = ''; paintList(); searchInput.focus(); } } }, icon('x', 16))),
        h('button', { type: 'button', class: 'icon-btn filled', 'aria-label': 'Scan barcode', on: { click: () => barcodePage() } }, icon('barcode'))),
      photoSlot,
      h('div', { class: 'chips scroll fu-actions' },
        h('button', { type: 'button', class: 'chip', on: { click: () => quickPage() } }, 'Quick add'),
        selectChip,
        h('button', { type: 'button', class: 'chip', on: { click: () => createPage() } }, 'Create food'),
        h('button', { type: 'button', class: 'chip', on: { click: () => barcodePage() } }, 'Scan barcode')),
      listEl, multiBar);
    show(el, null, true);
    paintList(); paintMulti();
    softFocus(searchInput, 80);
  }

  function paintMulti() {
    if (!multiBar) return;
    multiBar.hidden = !st.multi;
    if (!st.multi) return;
    const s = store.get();
    const foods = [...st.picked.values()];
    const kcal = foods.reduce((a, f) => { const lp = lastPortionFor(s, f); return a + makeEntry(f, st.meal, lp.mode, lp.qty, imperial).kcal; }, 0);
    clear(multiBar).append(
      h('span', { class: 'small' }, foods.length ? `${foods.length} selected · ${num(kcal)} kcal` : 'Tick foods to add together'),
      h('button', { type: 'button', class: 'btn sm primary', disabled: !foods.length, on: { click: () => {
        const s2 = store.get();
        const parts = foods.map((f) => { const lp = lastPortionFor(s2, f); return { f, lp, e: makeEntry(f.source === 'off' ? saveCustomFood(f) : f, st.meal, lp.mode, lp.qty, imperial) }; });
        addEntries(ctx.date, parts.map((x) => x.e), { toastMsg: `Added ${parts.length} foods to ${MEAL_LABEL[st.meal]}`, portions: parts.map((x) => ({ foodId: x.e.foodId, mode: x.lp.mode, qty: x.lp.qty })) });
        st.picked.clear(); st.multi = false; browse();
      } } }, `Add to ${MEAL_LABEL[st.meal]}`));
  }

  function portionText(food) {
    const s = store.get();
    const lp = lastPortionFor(s, food);
    const e = makeEntry(food, st.meal, lp.mode, lp.qty, imperial);
    return { lp, e, text: lp.mode === 'serving' && lp.qty === 1 ? servingText(food) : entryAmount(e) };
  }

  function foodRow(food) {
    const { lp, e, text } = portionText(food);
    const sub = h('div', { class: 'li-sub' }, `${text} · `, h('b', null, `${num(e.kcal)} kcal`), ` · ${macroLine(e)}`);
    if (st.multi) {
      const on = st.picked.has(food.id);
      return h('button', { type: 'button', class: 'li fu-food fu-pick' + (on ? ' on' : ''), 'aria-pressed': String(on), on: { click: () => {
        if (st.picked.has(food.id)) st.picked.delete(food.id); else st.picked.set(food.id, food);
        paintList(); paintMulti();
      } } },
      h('span', { class: 'fu-check', 'aria-hidden': 'true' }, on ? icon('check', 16) : null),
      h('div', { class: 'fu-food-main' }, h('div', { class: 'li-title' }, food.name, food.brand ? h('span', { class: 'muted fu-brand' }, ` · ${food.brand}`) : null), sub));
    }
    const addBtn = h('button', {
      type: 'button', class: 'icon-btn fu-plus', 'aria-label': `Add ${text} of ${food.name}`,
      on: { click: (ev) => {
        ev.stopPropagation();
        logFood(food, lp.mode, lp.qty, { saveOff: true });
        addBtn.classList.add('done'); clear(addBtn).append(icon('check'));
        setTimeout(() => { addBtn.classList.remove('done'); clear(addBtn).append(icon('plus')); }, 1100);
      } },
    }, icon('plus'));
    return h('div', { class: 'li fu-food' },
      h('button', { type: 'button', class: 'fu-food-main', on: { click: () => detailPage(food) } },
        h('div', { class: 'li-title' }, food.name, food.brand ? h('span', { class: 'muted fu-brand' }, ` · ${food.brand}`) : null), sub),
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
        h('button', { type: 'button', class: 'btn sm subtle', on: { click: () => createPage({ name: st.q.trim() }) } }, `Create “${st.q.trim().slice(0, 24)}”`),
        h('button', { type: 'button', class: 'btn sm subtle', on: { click: () => quickPage({ name: st.q.trim() }) } }, 'Quick add')));
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
      rows = (s.customFoods || []).filter((f) => f.source !== 'photo');
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
        st.tab === 'mine' ? h('button', { type: 'button', class: 'btn sm primary', on: { click: () => createPage() } }, 'Create food') : null));
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
    st.page = 'template';
    const tot = sumEntries(t.items || []);
    show(h('div', { class: 'stack' }, backBtn(),
      h('h2', null, t.name),
      h('p', { class: 'small muted tabular' }, `${num(tot.kcal)} kcal · ${macroLine(tot)}`),
      h('div', { class: 'list card flush' }, (t.items || []).map((it) => h('div', { class: 'li' },
        h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, it.name), h('div', { class: 'li-sub' }, entryAmount(it))),
        h('div', { class: 'li-end tabular' }, num(it.kcal))))),
      h('button', { type: 'button', class: 'btn primary block', on: { click: () => { addTemplate(t); sh.close(); } } }, `Add all to ${MEAL_LABEL[st.meal]}`),
      h('button', { type: 'button', class: 'btn ghost block fu-del', on: { click: () => {
        store.update((s2) => { s2.mealTemplates = (s2.mealTemplates || []).filter((x) => x.id !== t.id); });
        toast(`Deleted “${t.name}”`, { action: { label: 'Undo', fn: () => store.update((s2) => { s2.mealTemplates = [t, ...(s2.mealTemplates || [])]; }) } });
        st.tab = 'meals'; browse();
      } } }, 'Delete saved meal')), 'Saved meal');
  }

  // ---------- detail ----------
  function detailPage(food, { fromOff = false, isNewOff = false } = {}) {
    st.page = 'detail';
    const s = store.get();
    const known = foodMap(s).has(food.id);
    const isCustom = (s.customFoods || []).some((f) => f.id === food.id);
    const mp = macroPanel();
    const after = h('p', { class: 'small fu-after tabular', 'aria-live': 'polite' });
    const lp = lastPortionFor(s, food);
    let cur = null;
    const paintAfter = (m) => {
      const s2 = store.get();
      const t = targetsFor(s2, ctx.date);
      const tot = totalsOf(sel.foodsFor(s2, ctx.date));
      const k = r0(t.kcal - tot.kcal - m.kcal), p = r0(t.protein - tot.p - m.p), c = r0(t.carbs - tot.c - m.c), f = r0(t.fat - tot.f - m.f);
      clear(after).append(h('span', { class: 'muted' }, 'After adding: '),
        h('b', { class: k < 0 ? 'danger-text' : '' }, `${num(Math.abs(k))} kcal ${k < 0 ? 'over' : 'left'}`),
        h('span', { class: 'muted' }, ` · P ${p} · C ${c} · F ${f} g left`));
    };
    const amt = amountEditor({
      units: portionUnits(food, imperial), mode: lp.mode, qty: lp.qty,
      onChange: (v) => { cur = v; const m = scaleFood(food, v.valid ? v.grams : 0); mp.set(m); paintAfter(m); addBtn.disabled = !v.valid; },
    });
    cur = amt.get();
    { const m = scaleFood(food, cur.grams); mp.set(m); paintAfter(m); }
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
      if (!cur.valid) return;
      logFood(food, cur.mode, cur.qty, { saveOff: saveBox ? saveBox.checked : true });
      back();
    } } }, h('span', null, `Add to ${MEAL_LABEL[st.meal]}`));
    const p = food.per100 || {};
    show(h('div', { class: 'stack' },
      h('div', { class: 'row between' }, backBtn(), star),
      h('div', null, h('h2', { class: 'fu-detail-name' }, food.name), food.brand ? h('div', { class: 'muted small' }, food.brand) : null,
        isNewOff ? h('span', { class: 'pill accent mt' }, 'Open Food Facts') : null),
      amt.el,
      mp.el,
      after,
      h('p', { class: 'xs muted tabular' }, `Per 100 g: ${num(p.kcal)} kcal · P ${r1(p.p)} · C ${r1(p.c)} · F ${r1(p.f)} · fiber ${r1(p.fiber)}`,
        p.alc != null ? ` · alcohol ${r1(p.alc)} g` : '', p.na != null ? ` · sodium ${num(p.na)} mg` : ''),
      groupField('Meal', mealSeg),
      saveBox ? h('label', { class: 'switch fu-save', for: 'fu-save-off' }, h('span', null, 'Save to My Foods'), saveBox) : null,
      addBtn,
      isCustom ? h('button', { type: 'button', class: 'btn ghost block fu-del', on: { click: () => {
        const snapshot = (store.get().customFoods || []).find((f) => f.id === food.id);
        store.update((s2) => { s2.customFoods = (s2.customFoods || []).filter((f) => f.id !== food.id); s2.favorites = (s2.favorites || []).filter((x) => x !== food.id); });
        toast(`Removed ${food.name} from My Foods`, { action: { label: 'Undo', fn: () => store.update((s2) => { s2.customFoods = [snapshot, ...(s2.customFoods || [])]; }) } });
        back();
      } } }, 'Delete from My Foods') : null), 'Food details', true);
    softFocus(amt.input, 60, true);
  }

  // ---------- quick add ----------
  function quickPage(pre = {}) {
    st.page = 'quickPage';
    const f = {};
    const numIn = (k, label, max) => (f[k] = h('input', { type: 'number', inputmode: 'decimal', min: '0', max, step: 'any', placeholder: '0', 'aria-label': label, on: { input: upd } }));
    const hint = h('p', { class: 'xs muted' });
    const fe = {};
    const formErr = formError();
    const mk = (k, label, unit, aria, max) => { const inp = numIn(k, aria, max); fe[k] = fieldErr(label, h('div', { class: 'input-unit' }, inp, h('span', null, unit)), inp); return fe[k].el; };
    function upd() {
      for (const k of ['kcal', 'p', 'c', 'f']) fe[k]?.set(null);
      formErr.set(null);
      const v = validateQuickAdd({ kcal: rawOf(f.kcal), p: rawOf(f.p), c: rawOf(f.c), f: rawOf(f.f) });
      const calc = Math.round(4 * v.value.p + 4 * v.value.c + 9 * v.value.f);
      hint.textContent = calc ? `Macros add up to ${num(calc)} kcal${f.kcal.value ? '' : ' — used if calories are left blank'}.` : 'Calories required, or fill in macros and we’ll calculate them.';
    }
    f.name = h('input', { type: 'text', placeholder: 'Quick add', value: pre.name || '', maxlength: '80', 'aria-label': 'Name' });
    const el = h('form', { class: 'stack', novalidate: true, on: { submit: (e) => {
      e.preventDefault();
      const v = validateQuickAdd({ kcal: rawOf(f.kcal), p: rawOf(f.p), c: rawOf(f.c), f: rawOf(f.f) });
      for (const k of ['kcal', 'p', 'c', 'f']) fe[k].set(v.errors[k]);
      formErr.set(v.errors.form);
      if (!v.ok) { (['kcal', 'p', 'c', 'f'].map((k) => v.errors[k] && f[k]).find(Boolean) || f.kcal).focus(); return; }
      const { kcal, p, c, f: fa } = v.value;
      const e2 = { id: uid('fe'), meal: st.meal, foodId: null, name: f.name.value.trim() || 'Quick add', qty: 1, unit: 'quick add', grams: 0, kcal, p: r1(p), c: r1(c), f: r1(fa), fiber: 0 };
      addEntries(ctx.date, [e2], { toastMsg: `Added ${num(e2.kcal)} kcal to ${MEAL_LABEL[st.meal]}` });
      back();
    } } },
    backBtn(),
    mk('kcal', 'Calories', 'kcal', 'Calories', '5000'),
    h('div', { class: 'grid3' }, mk('p', 'Protein', 'g', 'Protein grams', '500'), mk('c', 'Carbs', 'g', 'Carb grams', '500'), mk('f', 'Fat', 'g', 'Fat grams', '500')),
    hint, formErr.el,
    field('Name (optional)', f.name),
    groupField('Meal', seg(MEALS, st.meal, (m) => { st.meal = m; }, { label: 'Meal' })),
    h('button', { type: 'submit', class: 'btn primary block xl' }, 'Quick add'));
    upd();
    show(el, 'Quick add');
    softFocus(f.kcal, 60);
  }

  // ---------- create food ----------
  function createPage(pre = {}) {
    st.page = 'createPage';
    const f = {}, fe = {};
    const formErr = formError();
    const txt = (k, label, v = '', ph = '') => (f[k] = h('input', { type: 'text', value: v, placeholder: ph, maxlength: '80', 'aria-label': label }));
    const numIn = (k, label, v = '') => (f[k] = h('input', { type: 'number', inputmode: 'decimal', min: '0', step: 'any', value: v === '' ? '' : String(v), placeholder: '0', 'aria-label': label,
      on: { input: () => { fe[k]?.set(null); formErr.set(null); } } }));
    const nf = (k, label, unit, aria, v) => { const inp = numIn(k, aria, v); fe[k] = fieldErr(label, h('div', { class: 'input-unit' }, inp, h('span', null, unit)), inp); return fe[k].el; };
    const nameIn = txt('name', 'Food name', pre.name || '', 'e.g. Mum’s lasagne');
    fe.name = fieldErr('Name', nameIn, nameIn);
    nameIn.addEventListener('input', () => fe.name.set(null));
    const el = h('form', { class: 'stack', novalidate: true, on: { submit: (e) => {
      e.preventDefault();
      const name = f.name.value.trim();
      const v = validateCustomFood({ grams: rawOf(f.grams), kcal: rawOf(f.kcal), p: rawOf(f.p), c: rawOf(f.c), fat: rawOf(f.fat), fiber: rawOf(f.fiber) });
      fe.name.set(name ? null : 'Give the food a name');
      for (const k of ['grams', 'kcal', 'p', 'c', 'fat', 'fiber']) fe[k].set(v.errors[k]);
      formErr.set(v.errors.form);
      if (!name || !v.ok) { (!name ? f.name : ['grams', 'kcal', 'p', 'c', 'fat', 'fiber'].map((k) => v.errors[k] && f[k]).find(Boolean) || f.kcal).focus(); return; }
      const food = {
        id: uid('cf-'), name, brand: f.brand.value.trim() || undefined,
        serving: { label: f.label.value.trim() || '1 serving', grams: v.value.grams },
        per100: v.value.per100,
        tags: ['custom'], ...(pre.barcode || f.barcode.value.trim() ? { barcode: (pre.barcode || f.barcode.value.trim()).replace(/\D/g, '') } : {}),
      };
      store.update((s2) => { s2.customFoods = [food, ...(s2.customFoods || [])]; });
      toast(`Saved ${name} to My Foods`, { kind: 'go' });
      detailPage(food);
    } } },
    backBtn(),
    fe.name.el,
    field('Brand (optional)', txt('brand', 'Brand', pre.brand || '')),
    h('div', { class: 'grid2' },
      field('Serving label', txt('label', 'Serving label', pre.label || '1 serving', '1 bar, 1 cup…')),
      nf('grams', 'Serving size', 'g', 'Serving grams', pre.grams ?? '')),
    h('h4', null, 'Per serving'),
    h('div', { class: 'grid2' },
      nf('kcal', 'Calories', 'kcal', 'Calories per serving'),
      nf('p', 'Protein', 'g', 'Protein per serving'),
      nf('c', 'Carbs', 'g', 'Carbs per serving'),
      nf('fat', 'Fat', 'g', 'Fat per serving'),
      nf('fiber', 'Fiber', 'g', 'Fiber per serving'),
      field('Barcode (optional)', h('input', { type: 'text', inputmode: 'numeric', value: pre.barcode || '', maxlength: '14', 'aria-label': 'Barcode', on: { input: (e) => { e.target.value = e.target.value.replace(/\D/g, ''); } } }))),
    formErr.el,
    h('button', { type: 'submit', class: 'btn primary block xl' }, 'Save food'));
    f.barcode = el.querySelector('input[aria-label="Barcode"]');
    show(el, 'Create food');
    softFocus(pre.name ? f.grams : f.name, 60);
  }

  // ---------- barcode ----------
  function barcodePage() {
    st.page = 'barcodePage';
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
          resultEl.append(h('button', { type: 'button', class: 'btn subtle block', on: { click: () => createPage({ barcode: c }) } }, 'Create it from the label'));
          return;
        }
        detailPage(food, { fromOff: true, isNewOff: true });
      } catch (err) {
        if (err?.name === 'AbortError' && !ctrl.timedOut) return;
        status.textContent = navigator.onLine === false ? 'You’re offline — barcode lookup needs a connection.' : 'Couldn’t reach Open Food Facts. Check your connection and try again.';
        resultEl.append(h('div', { class: 'row gap' },
          h('button', { type: 'button', class: 'btn subtle grow', on: { click: () => lookup(c) } }, 'Retry'),
          h('button', { type: 'button', class: 'btn subtle grow', on: { click: () => createPage({ barcode: c }) } }, 'Enter manually')));
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
    cleanups.add(stopCam); cleanups.add(abort); // after show(): it runs and clears the previous page's cleanups
    if (hasDetector) startCam(); else softFocus(code, 60);
  }

  // ---------- online search ----------
  function onlineBlock() {
    const wrap = h('div', { class: 'fu-online' });
    const q = st.q.trim();
    if (st.onlineState === 'idle') {
      wrap.append(h('button', { type: 'button', class: 'btn subtle block', on: { click: () => runOnline(q) } }, `Search online for “${q.slice(0, 30)}”`));
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
  // ---------- photo → nutrition estimate ----------
  // Flow: pick → preview + hint → "Estimating…" → editable items → log. The photo only lives in memory
  // (downscaled JPEG from api.prepareImage, EXIF stripped); its object URL is revoked when the page is
  // left, the sheet closes, or the items are logged.
  function photoPage() {
    st.page = 'photoPage';
    const ph = { prepared: null, file: null, hint: '', items: [], notes: '', meal: st.meal };
    const revoke = () => { if (ph.prepared?.previewUrl) { try { URL.revokeObjectURL(ph.prepared.previewUrl); } catch {} } ph.prepared = null; ph.file = null; };
    let reqId = 0;
    const root = h('div', { class: 'stack fu-photo' });
    const fileInput = (capture) => {
      const inp = h('input', { type: 'file', accept: 'image/*', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true', ...(capture ? { capture: 'environment' } : {}),
        on: { change: (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onFile(f); } } });
      return inp;
    };
    const camIn = fileInput(true), libIn = fileInput(false);
    const honest = () => h('p', { class: 'xs muted fu-honest' }, 'AI estimate — check portions. Hidden oils, sauces and dressings are easy to miss.');

    function pickView(msg) {
      clear(root).append(backBtn(),
        h('div', { class: 'fu-photo-pick' },
          h('span', { class: 'fu-photo-ico lg' }, cameraIcon(28)),
          h('h3', null, 'Photograph your meal'),
          h('p', { class: 'small muted' }, 'Shoot from above with the whole plate in frame. A fork or hand helps with scale.'),
          msg ? h('p', { class: 'small danger-text', role: 'alert' }, msg) : null,
          h('div', { class: 'stack sm fu-photo-btns' },
            h('button', { type: 'button', class: 'btn primary block', on: { click: () => camIn.click() } }, 'Take photo'),
            h('button', { type: 'button', class: 'btn subtle block', on: { click: () => libIn.click() } }, 'Choose from library'))),
        camIn, libIn, honest());
      apiCall('apiAvailable').then((ok) => {
        if (ok === false && root.isConnected && !ph.prepared) root.querySelector('.fu-photo-pick')?.append(h('p', { class: 'xs warn-text' }, 'Photo estimates may not be set up on this server yet — you can still try.'));
      }).catch(() => {});
    }

    async function onFile(file) {
      revoke();
      clear(root).append(backBtn(), h('div', { class: 'fu-photo-prev skeleton' }), h('p', { class: 'small muted', role: 'status' }, 'Preparing photo…'), camIn, libIn);
      try {
        ph.file = file;
        ph.prepared = await apiCall('prepareImage', file);
        previewView();
      } catch (e) {
        ph.file = null;
        pickView(e?.message || 'Couldn’t read that image — try another photo.');
      }
    }

    const thumb = () => h('div', { class: 'fu-photo-prev' }, ph.prepared?.previewUrl ? h('img', { src: ph.prepared.previewUrl, alt: 'Your meal photo' }) : null);

    function previewView() {
      const hint = h('input', { type: 'text', maxlength: '140', value: ph.hint, placeholder: 'e.g. large bowl, cooked in olive oil', 'aria-label': 'Hint for the estimate',
        on: { input: (e) => { ph.hint = e.target.value; } } });
      clear(root).append(backBtn(), thumb(),
        h('div', { class: 'row gap' },
          h('button', { type: 'button', class: 'btn sm subtle grow', on: { click: () => camIn.click() } }, 'Retake'),
          h('button', { type: 'button', class: 'btn sm subtle grow', on: { click: () => libIn.click() } }, 'Library')),
        field('Anything we can’t see? (optional)', hint, 'Portion size, cooking fat, sauces, what’s inside a wrap…'),
        h('form', { on: { submit: (e) => { e.preventDefault(); estimate(); } } },
          h('button', { type: 'submit', class: 'btn primary block xl' }, 'Estimate nutrition')),
        camIn, libIn, honest());
    }

    async function estimate() {
      const my = ++reqId;
      clear(root).append(backBtn(), thumb(),
        h('div', { class: 'fu-photo-loading', role: 'status', 'aria-live': 'polite' },
          h('span', { class: 'fu-spinner', 'aria-hidden': 'true' }), h('b', null, 'Estimating…'), h('span', { class: 'small muted' }, 'Identifying foods and portions. Usually a few seconds.')),
        h('div', { class: 'stack sm' }, [0, 1, 2].map(() => h('div', { class: 'skeleton fu-sk-row' }))));
      try {
        // pass the prepared (downscaled, EXIF-free) image so it isn't decoded twice
        const res = await apiCall('analyzeFoodPhoto', ph.prepared || ph.file, { hint: ph.hint.trim() || undefined });
        if (my !== reqId || !root.isConnected) return;
        if (res && res.isFood === false) { errorView({ code: 'empty', message: 'That doesn’t look like food. Try a clearer shot of the plate — or log it by search.' }); return; }
        ph.notes = cleanText(res?.notes, 300);
        ph.items = (Array.isArray(res?.items) ? res.items : []).slice(0, 20).map(toItem).filter(Boolean);
        if (!ph.items.length) { errorView({ code: 'empty', message: 'No food recognised in that photo. Try a clearer, closer shot — or log it by search.' }); return; }
        resultsView();
      } catch (e) {
        if (my !== reqId || !root.isConnected) return;
        errorView(e);
      }
    }

    function toItem(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const name = cleanText(raw.name, 80);
      const grams = nz(raw.grams, 3000);
      if (!name || !(grams > 0)) return null;
      const est = { kcal: nz(raw.kcal, 9000), p: nz(raw.p, 1000), c: nz(raw.c, 1000), f: nz(raw.f, 1000), fiber: nz(raw.fiber, 300) };
      const per100 = Object.fromEntries(Object.entries(est).map(([k, v]) => [k, (v / grams) * 100]));
      const s2 = store.get();
      const map = foodMap(s2);
      let match = raw.foodId && map.get(String(raw.foodId)) || null;
      if (!match) match = matchFood(name, allFoods(s2));
      return { name, aiName: name, grams: Math.round(grams), aiPer100: per100, per100, include: true, useDb: false, match, oz: isImperial(s2),
        confidence: ['low', 'medium', 'high'].includes(raw.confidence) ? raw.confidence : 'low' };
    }

    function errorView(e) {
      const code = e?.code || 'failed';
      const copy = {
        offline: ['You’re offline', 'Photo estimates need a connection. Try again when you’re back online, or log by search for now.'],
        not_configured: ['Photo estimates aren’t set up', 'The FORGE server needs an ANTHROPIC_API_KEY environment variable to analyse photos. Everything else in Fuel works without it.'],
        rate_limited: ['Too many requests', 'The estimate service is busy. Wait a minute and try again.'],
        too_large: ['Photo too large', 'Try a different photo or a lower-resolution shot.'],
        unavailable: ['Service unavailable', 'The estimate service didn’t respond. Try again later.'],
        empty: ['Nothing recognised', e?.message],
      }[code] || ['Couldn’t estimate this photo', e?.message || 'Something went wrong. Try again.'];
      const retryable = !['not_configured', 'too_large'].includes(code);
      clear(root).append(backBtn(), ph.prepared ? thumb() : null,
        h('div', { class: 'callout ' + (code === 'not_configured' ? 'info' : 'danger'), role: 'alert' }, h('b', null, copy[0]), h('p', { class: 'small mt' }, copy[1])),
        h('div', { class: 'row gap' },
          retryable && ph.prepared ? h('button', { type: 'button', class: 'btn primary grow', on: { click: () => estimate() } }, 'Try again') : null,
          h('button', { type: 'button', class: 'btn subtle grow', on: { click: () => { revoke(); pickView(); } } }, 'New photo')),
        h('div', { class: 'row gap' },
          h('button', { type: 'button', class: 'btn sm ghost grow', on: { click: () => back() } }, 'Search instead'),
          h('button', { type: 'button', class: 'btn sm ghost grow', on: { click: () => quickPage() } }, 'Quick add')),
        camIn, libIn);
    }

    function itemMacros(it) { return scaleFood({ per100: it.per100 }, it.grams); }

    function resultsView() {
      const totalsEl = h('div', { class: 'fu-mp-wrap' });
      const addBtn = h('button', { type: 'button', class: 'btn primary block xl' });
      const mp = macroPanel();
      totalsEl.append(mp.el);
      const refresh = () => {
        const inc = ph.items.filter((i) => i.include && i.grams > 0);
        mp.set(inc.map(itemMacros).reduce((a, m) => ({ kcal: a.kcal + m.kcal, p: a.p + m.p, c: a.c + m.c, f: a.f + m.f, fiber: a.fiber + m.fiber }), { kcal: 0, p: 0, c: 0, f: 0, fiber: 0 }));
        clear(addBtn).append(h('span', null, inc.length ? `Add ${inc.length} item${inc.length > 1 ? 's' : ''} to ${MEAL_LABEL[ph.meal]}` : 'Nothing selected'));
        addBtn.disabled = !inc.length;
      };
      const rows = ph.items.map((it, idx) => itemRow(it, idx, refresh));
      const saveMealBox = h('input', { type: 'checkbox', id: 'fu-photo-savemeal' });
      addBtn.addEventListener('click', () => {
        const inc = ph.items.filter((i) => i.include && i.grams > 0);
        if (!inc.length) return;
        // Each item becomes a re-loggable food (R2 P2-3): the database match when chosen, else a small
        // "photo" food (hidden from My Foods) so it shows up in Recents with its portion.
        const photoFoods = [];
        const entries = inc.map((it) => {
          let foodId = it.useDb && it.match ? it.match.id : null;
          if (!foodId) {
            const pf = { id: uid('ph-'), name: it.name, serving: { label: `${Math.round(it.grams)} g portion`, grams: Math.round(it.grams) },
              per100: Object.fromEntries(Object.entries(it.per100).map(([k, v]) => [k, Math.round(v * 10) / 10])), tags: ['photo'], source: 'photo' };
            photoFoods.push(pf); foodId = pf.id;
          }
          const oz = it.oz;
          return { id: uid('fe'), meal: ph.meal, foodId, name: it.name, qty: oz ? Math.round((it.grams / OZ_G) * 10) / 10 : Math.round(it.grams), unit: oz ? 'oz' : 'g',
            grams: Math.round(it.grams * 10) / 10, ...itemMacros(it), source: 'photo' };
        });
        if (photoFoods.length) store.update((st2) => {
          // keep at most 60 photo foods (newest first) so they don't pile up
          const photos = (st2.customFoods || []).filter((f) => f.source === 'photo');
          st2.customFoods = [...photoFoods, ...(st2.customFoods || []).filter((f) => f.source !== 'photo'), ...photos.slice(0, Math.max(0, 60 - photoFoods.length))];
        });
        st.meal = ph.meal;
        addEntries(ctx.date, entries, { toastMsg: `Added ${entries.length} item${entries.length > 1 ? 's' : ''} to ${MEAL_LABEL[ph.meal]}`,
          portions: entries.map((e) => ({ foodId: e.foodId, mode: e.unit === 'oz' ? 'oz' : 'g', qty: e.qty })) });
        if (saveMealBox.checked) {
          const name = entries.slice(0, 3).map((e) => String(e.name).split(/[,·(—]/)[0].trim().split(' ').slice(0, 2).join(' ')).join(' + ').slice(0, 60) || 'Photo meal';
          store.update((st2) => { st2.mealTemplates = [{ id: uid('mt'), name, items: entries.map(({ id, meal: _m, ...rest }) => rest) }, ...(st2.mealTemplates || [])]; });
          setTimeout(() => toast(`Saved “${name}” to Meals`, { kind: 'go' }), 1800);
        }
        revoke(); ph.items = [];
        sh.close();
      });
      clear(root).append(backBtn(),
        h('div', { class: 'row gap fu-photo-head' }, h('div', { class: 'fu-photo-prev sm' }, ph.prepared?.previewUrl ? h('img', { src: ph.prepared.previewUrl, alt: 'Your meal photo' }) : null),
          h('div', { class: 'grow' }, h('h3', null, `${ph.items.length} item${ph.items.length > 1 ? 's' : ''} found`),
            h('p', { class: 'xs muted' }, 'Untick anything that’s wrong, and adjust grams.'))),
        h('div', { class: 'callout fu-ai-note' }, h('b', null, 'AI estimate — check portions.'), ph.notes ? h('p', { class: 'small mt' }, ph.notes) : null),
        h('div', { class: 'stack sm' }, rows),
        h('h4', null, 'Total selected'),
        totalsEl,
        groupField('Meal', seg(MEALS, ph.meal, (m) => { ph.meal = m; refresh(); }, { label: 'Meal' })),
        h('label', { class: 'switch fu-save', for: 'fu-photo-savemeal' }, h('span', null, 'Also save as a meal'), saveMealBox),
        addBtn,
        h('button', { type: 'button', class: 'btn ghost block', on: { click: () => { revoke(); pickView(); } } }, 'Start over with a new photo'));
      refresh();
    }

    function itemRow(it, idx, refresh) {
      const macroEl = h('div', { class: 'xs muted tabular fu-item-macros' });
      const kcalEl = h('b', { class: 'tabular fu-item-kcal' });
      const nameIn = h('input', { type: 'text', value: it.name, maxlength: '80', 'aria-label': `Item ${idx + 1} name`, class: 'fu-item-name', on: { input: (e) => { it.name = e.target.value.trim() || it.aiName; } } });
      // grams internally; imperial users see and step in oz (R2 P2-3)
      const shown = () => (it.oz ? String(Math.round((it.grams / OZ_G) * 10) / 10) : String(Math.round(it.grams)));
      const gIn = h('input', { type: 'number', inputmode: 'decimal', min: '0', step: 'any', value: shown(), 'aria-label': `Amount of ${it.name} in ${it.oz ? 'ounces' : 'grams'}`, class: 'fu-item-g',
        on: { input: (e) => { const v = parseFloat(e.target.value); const g = Number.isFinite(v) && v >= 0 ? (it.oz ? v * OZ_G : v) : 0; it.grams = Math.min(5000, g); upd(); } } });
      const unitBtn = h('button', { type: 'button', class: 'link-btn fu-item-unit', 'aria-label': `Show ${it.name} in ${it.oz ? 'grams' : 'ounces'}`,
        on: { click: () => { it.oz = !it.oz; gIn.value = shown(); unitBtn.textContent = it.oz ? 'oz' : 'g'; gIn.setAttribute('aria-label', `Amount of ${it.name} in ${it.oz ? 'ounces' : 'grams'}`); } } }, it.oz ? 'oz' : 'g');
      const stepG = (dir) => {
        const d = it.oz ? 0.5 * OZ_G : it.grams >= 100 ? 25 : 10;
        it.grams = Math.max(0, it.oz ? Math.round((it.grams + dir * d) / (0.5 * OZ_G)) * 0.5 * OZ_G : Math.round(it.grams + dir * d));
        gIn.value = shown(); haptic(); upd();
      };
      const inc = h('input', { type: 'checkbox', checked: it.include, 'aria-label': `Include ${it.name}`, on: { change: (e) => { it.include = e.target.checked; card.classList.toggle('off', !it.include); refresh(); } } });
      const swapEl = h('div');
      const card = h('div', { class: 'fu-item' + (it.include ? '' : ' off') },
        h('div', { class: 'row top' },
          h('label', { class: 'toggle fu-item-inc' }, inc, h('span')),
          h('div', { class: 'grow stack sm' },
            h('div', { class: 'row between' }, nameIn, h('span', { class: 'pill fu-conf ' + it.confidence, title: 'Model confidence' }, it.confidence === 'medium' ? 'med' : it.confidence)),
            h('div', { class: 'row between' },
              h('div', { class: 'fu-item-step' },
                h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Less ${it.name}`, on: { click: () => stepG(-1) } }, icon('minus', 16)),
                h('span', { class: 'fu-item-gwrap' }, gIn, unitBtn),
                h('button', { type: 'button', class: 'icon-btn', 'aria-label': `More ${it.name}`, on: { click: () => stepG(1) } }, icon('plus', 16))),
              h('div', { class: 'right' }, kcalEl, h('span', { class: 'xs muted' }, ' kcal'))),
            macroEl, swapEl)));
      function paintSwap() {
        clear(swapEl);
        if (!it.match) return;
        swapEl.append(h('button', { type: 'button', class: 'fu-swap' + (it.useDb ? ' on' : ''), 'aria-pressed': String(it.useDb), on: { click: () => {
          it.useDb = !it.useDb;
          it.per100 = it.useDb ? { ...it.match.per100 } : { ...it.aiPer100 };
          if (it.useDb) { it.name = it.match.name; nameIn.value = it.name; } else { it.name = nameIn.value.trim() || it.aiName; }
          paintSwap(); upd();
        } } }, icon(it.useDb ? 'check' : 'repeat', 14),
        it.useDb ? ` Using database: ${it.match.name}` : ` Use database values: ${it.match.name}`));
      }
      function upd() {
        const m = itemMacros(it);
        kcalEl.textContent = num(m.kcal);
        macroEl.textContent = `${macroLine(m)} · fiber ${r0(m.fiber)}`;
        refresh();
      }
      paintSwap();
      const m0 = itemMacros(it); kcalEl.textContent = num(m0.kcal); macroEl.textContent = `${macroLine(m0)} · fiber ${r0(m0.fiber)}`;
      return card;
    }

    show(root, 'Snap meal');
    cleanups.add(() => { reqId++; revoke(); }); // registered after show(), which runs the previous page's cleanups
    pickView();
  }

  if (opts.photo && photoAvail !== false) photoPage(); else browse();
  return sh;
}

// Lazily load js/api.js so Fuel keeps working when the photo API module is absent.
let apiMod = null;
async function apiCall(fn, ...args) {
  if (!apiMod) {
    try { apiMod = await import('../api.js'); } catch (e) {
      const err = new Error('Photo estimates aren’t available in this build.'); err.code = 'unavailable'; throw err;
    }
  }
  if (typeof apiMod[fn] !== 'function') { const err = new Error('Photo estimates aren’t available in this build.'); err.code = 'unavailable'; throw err; }
  return apiMod[fn](...args);
}

/** Best local database match for a free-text item name (all words, then progressively fewer). */
/**
 * Best local database match for a free-text item name (R2 P2-2): first with cooking-method words kept
 * ("roasted potatoes" → Roasted potatoes, not Mashed), then without them, then with progressively fewer words.
 */
export function matchFood(name, foods) {
  const words = String(name || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
  const tries = [words, words.filter((w) => !COOKING.has(w))];
  for (const toks of tries) {
    if (!toks.length) continue;
    for (let n = toks.length; n >= 1; n--) {
      const r = searchFoods(toks.slice(0, n).join(' '), foods, { limit: 1 })[0];
      if (r) return r;
      if (n > 1) { const r2 = searchFoods(toks.slice(-n).join(' '), foods, { limit: 1 })[0]; if (r2) return r2; }
    }
  }
  return null;
}
const STOP = new Set(['and', 'with', 'the', 'small', 'large', 'medium', 'piece', 'pieces', 'slice', 'slices', 'side', 'plate', 'bowl', 'portion', 'some', 'fresh', 'homemade', 'plain', 'serving']);
const COOKING = new Set(['grilled', 'roasted', 'baked', 'steamed', 'boiled', 'pan', 'seared', 'sauteed', 'fried', 'mashed', 'poached', 'broiled']);

function cameraIcon(size = 20) {
  const NS = 'http://www.w3.org/2000/svg';
  const sv = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.9', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'ico' })) sv.setAttribute(k, v);
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', 'M4 8h3l1.5-2h7L17 8h3v11H4zM12 17a3.5 3.5 0 100-7 3.5 3.5 0 000 7z');
  sv.append(p);
  return sv;
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
    per100: { kcal: Math.round(kcal), p: r1(nz(n.proteins_100g, 100)), c: r1(nz(n.carbohydrates_100g, 100)), f: r1(nz(n.fat_100g, 100)), fiber: r1(nz(n.fiber_100g, 100)), ...offSodium(n) },
    tags: ['off'], ...(c ? { barcode: c } : {}), source: 'off',
  };
}

// ---------------------------------------------------------------------------------------------
// Water
function waterCard(s, ctx) {
  const imperial = isImperial(s);
  const ml = sel.waterFor(s, ctx.date);
  const dt = targetsFor(s, ctx.date);
  const target = Math.max(250, +dt.waterMl || +s.targets.waterMl || 3000);
  const fmt = (v) => (imperial ? `${num(v / ML_PER_OZ)} oz` : v >= 1000 ? `${num(v / 1000, 2)} L` : `${num(v)} ml`);
  const glassMl = imperial ? 8 * ML_PER_OZ : 250;
  const nGlasses = Math.min(16, Math.ceil(target / glassMl));
  const filled = ml / glassMl;
  const glasses = h('div', { class: 'fu-glasses', 'aria-hidden': 'true', style: { gridTemplateColumns: `repeat(${nGlasses}, minmax(0, 1fr))` } },
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
  const hard = dt.dayType === 'training' && dt.trainingMin >= 45;
  return h('section', { class: 'fu-water', 'aria-label': 'Water' },
    sectionHead('Water', h('span', { class: 'lbl' }, `Goal ${fmt(target)}`), 5),
    h('div', { class: 'row between fu-water-top', role: 'progressbar', 'aria-label': 'Water progress', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100' },
      h('span', { class: 'fig fu-water-n' }, fmt(ml)),
      h('span', { class: 'lbl' }, `${num(clamp(pct, 0, 999))}%`)),
    glasses,
    hard ? h('p', { class: 'xs muted' }, `Includes ${fmt(500 * dt.trainingMin / 60)} for today’s ${dt.trainingMin}-min session. In long or sweaty sessions aim for ${imperial ? '16–24 oz' : '500–750 ml'} per hour with 300–600 mg sodium.`) : null,
    h('div', { class: 'row fu-water-btns' },
      h('button', { type: 'button', class: 'btn sm subtle grow', on: { click: () => add(small) } }, imperial ? '+8 oz' : '+250 ml'),
      h('button', { type: 'button', class: 'btn sm subtle grow', on: { click: () => add(big) } }, imperial ? '+16 oz' : '+500 ml'),
      h('button', { type: 'button', class: 'btn sm subtle grow', on: { click: () => customWater(ctx, imperial, add) } }, 'Custom'),
      h('button', { type: 'button', class: 'icon-btn filled', 'aria-label': 'Undo last water', disabled: !ctx.waterHist.length, on: { click: undo } }, icon('repeat', 18))));
}

function customWater(ctx, imperial, add) {
  const input = h('input', { type: 'number', inputmode: 'decimal', min: '0', max: imperial ? '169' : '5000', step: 'any', placeholder: imperial ? '12' : '330', 'aria-label': 'Amount' });
  const unit = imperial ? 'oz' : 'ml';
  const fe = fieldErr(`Amount (${unit})`, h('div', { class: 'input-unit' }, input, h('span', null, unit)), input);
  const val = () => {
    const r = parseNum(rawOf(input));
    if (r.bad) { fe.set('Enter a number'); return 0; }
    const res = validateWaterMl(r.empty ? NaN : imperial ? r.value * ML_PER_OZ : r.value);
    fe.set(res.error);
    return res.ok ? res.ml : 0;
  };
  input.addEventListener('input', () => fe.set(null));
  trackSheet(ctx, {
    title: 'Log water',
    content: ({ close }) => h('form', { class: 'stack', novalidate: true, on: { submit: (e) => { e.preventDefault(); const v = val(); if (v) { add(v); close(); } else input.focus(); } } },
      fe.el,
      h('div', { class: 'row gap' },
        h('button', { type: 'button', class: 'btn ghost grow', on: { click: () => { const v = val(); if (v) { add(-v); close(); } else input.focus(); } } }, 'Remove'),
        h('button', { type: 'submit', class: 'btn primary grow' }, 'Add'))),
  });
  softFocus(input, 60);
}

// ---------------------------------------------------------------------------------------------
// Weekly strip
function weeklyCard(s, ctx) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(ctx.date, i - 6));
  let pSum = 0, kSum = 0, logged = 0, tSum = 0;
  const bars = days.map((d) => {
    const t = sel.totalsFor(s, d);
    const dt = targetsFor(s, d);
    tSum += dt.kcal;
    if (t.kcal > 0) { logged++; pSum += t.p; kSum += t.kcal; }
    const ok = dt.kcal && Math.abs(t.kcal - dt.kcal) <= dt.kcal * 0.1;
    return { label: fmtDate(d, { weekday: 'narrow' }), value: t.kcal, color: !t.kcal ? 'var(--tick-off)' : ok ? 'var(--text)' : t.kcal > dt.kcal ? 'var(--warn)' : 'var(--text-2)', dim: d !== ctx.date && !t.kcal };
  });
  const avgTarget = Math.round(tSum / 7);
  const avgP = logged ? pSum / logged : 0, avgK = logged ? kSum / logged : 0;
  return h('section', { 'aria-label': 'Last 7 days' },
    sectionHead('Last 7 days', null, 6),
    h('div', null,
      barChart({ bars, height: 130, target: avgTarget, yFmt: (v) => (v >= 1000 ? `${r1(v / 1000)}k` : String(r0(v))), ariaLabel: `Calories for the 7 days ending ${fmtDate(ctx.date)}; average target ${num(avgTarget)} kcal` }),
      h('div', { class: 'fu-legend xs muted' },
        h('span', null, h('i', { class: 'dot', style: { background: 'var(--text)' } }), 'within 10 %'),
        h('span', null, h('i', { class: 'dot', style: { background: 'var(--text-2)' } }), 'under'),
        h('span', null, h('i', { class: 'dot', style: { background: 'var(--warn)' } }), 'over')),
      h('div', { class: 'stat-row' },
        h('div', { class: 'stat' }, h('span', { class: 'v' }, logged ? num(avgK) : '–', h('small', null, `/${num(avgTarget)}`)), h('span', { class: 'k' }, 'Avg kcal')),
        h('div', { class: 'stat' }, h('span', { class: 'v' }, logged ? num(avgP) : '–', h('small', null, `/${num(s.targets.protein)} g`)), h('span', { class: 'k' }, 'Avg protein')),
        h('div', { class: 'stat' }, h('span', { class: 'v' }, `${logged}`, h('small', null, '/7')), h('span', { class: 'k' }, 'Days logged')))));
}

// ---------------------------------------------------------------------------------------------
// Adaptive targets
// Apply semantics: applying a suggestion writes kcal (the WEEKLY-AVERAGE day, like-for-like with the
// average intake the estimate came from) + macros (§5 rules via macrosForKcal) into store.targets and sets
// targets.auto = false, targets.source = 'adaptive', targets.maintenance = the estimated TDEE and
// targets.adaptive = {tdee, appliedAt, confidence}. auto must go false: Today/Me recompute "auto" targets
// from the formula on every weigh-in/profile edit, which would silently undo the data-driven calibration.
// Day targets still flex with training via dayTargetsFor. "Back to formula" restores computeTargets(profile,
// {plan}) with auto = true. Suggestions come at most weekly and move ≤ ±150 kcal per check-in.
const LB_KG = 0.45359237;
// kg/week options; imperial users get lb-native steps (stored in kg). null = Auto (engine default).
const RATE_OPTIONS = {
  metric: { lose: [null, -0.25, -0.5, -0.75, -1], gain: [null, 0.1, 0.25, 0.5] },
  imperial: { lose: [null, -0.5 * LB_KG, -1 * LB_KG, -1.5 * LB_KG, -2 * LB_KG], gain: [null, 0.25 * LB_KG, 0.5 * LB_KG, 1 * LB_KG] },
};
/**
 * Goal-rate picker (R2 P1-4). Options faster than the target can deliver (maxGoalRate: −25 % of
 * maintenance, the kcal floor, 1 % BW/week; gain +15 % / 0.5 % BW) are disabled and annotated, so a
 * stored rate is always one the target actually delivers.
 */
function goalRateControl(s) {
  const goal = s.profile.goal;
  const imperial = isImperial(s);
  const opts = RATE_OPTIONS[imperial ? 'imperial' : 'metric'][goal];
  if (!opts) return null;
  const maint = +s.targets.maintenance || computeTargets(s.profile, { plan: s.plan }).maintenance;
  const cap = maxGoalRate(s.profile, maint);
  const fmtRate = (kg) => (imperial ? `${num(Math.abs(kg) / LB_KG, Math.abs(kg) / LB_KG < 1 ? 2 : 1)} lb` : `${num(Math.abs(kg), Math.abs(kg) < 1 ? 2 : 1)} kg`);
  const cur = s.targets.goalRateKgWk ?? s.profile.goalRateKgWk ?? null;
  const isCur = (v) => (v == null ? cur == null : cur != null && Math.abs(Math.abs(v) - Math.abs(cur)) < 0.01);
  // what Auto actually delivers once the kcal floor is applied
  const autoKg = (Math.abs(maint - goalKcal(maint, { ...s.profile, goalRateKgWk: null })) * 7) / 7700;
  const choose = (v) => {
    const rate = v == null ? null : Math.sign(v) * Math.min(Math.abs(v), cap);
    store.update((st) => {
      st.targets.goalRateKgWk = rate;
      st.profile.goalRateKgWk = rate;
      if (st.targets.auto) st.targets = { ...st.targets, ...computeTargets(st.profile, { plan: st.plan }), auto: true, goalRateKgWk: rate };
    });
    toast(rate == null ? `Goal: auto (≈ ${fmtRate(autoKg)}/week)` : `Goal rate: ${rate > 0 ? '+' : '−'}${fmtRate(rate)}/week`, { ms: 1600 });
  };
  const group = h('div', { class: 'seg fu-rate', role: 'radiogroup', 'aria-label': 'Goal rate per week' },
    opts.map((v) => {
      const over = v != null && Math.abs(v) > cap + 0.005;
      const label = v == null ? 'Auto' : imperial ? num(Math.abs(v) / LB_KG, Math.abs(v) / LB_KG < 1 ? 2 : 1) : num(Math.abs(v), 2);
      return h('button', { type: 'button', role: 'radio', 'aria-checked': String(isCur(v)), class: isCur(v) ? 'on' : '', disabled: over,
        title: over ? `Faster than your target can deliver (max ≈ ${fmtRate(cap)}/week)` : v == null ? `Auto ≈ ${fmtRate(autoKg)}/week` : '',
        on: { click: () => choose(v) } }, label);
    }));
  const curOver = cur != null && Math.abs(cur) > cap + 0.005;
  return h('div', { class: 'stack sm' },
    groupField(`Goal rate (${imperial ? 'lb' : 'kg'} per week)`, group),
    h('p', { class: 'data' },
      `Auto ≈ ${fmtRate(autoKg)}/week${goal === 'lose' && (s.profile.daysPerWeek ?? 4) >= 4 ? ' (the gentler of −15 % or 0.5 % body weight, to protect training)' : ''}. `,
      `Fastest your target can deliver: ≈ ${fmtRate(cap)}/week.`,
      curOver ? ` Your saved rate is capped at that.` : ''));
}

export function portionUnits(food, imperial) {
  const sg = +food?.serving?.grams || 100;
  const label = food?.serving?.label || 'serving';
  const units = [{ id: 'serving', seg: 'Servings', unit: label, gramsPer: sg, step: 0.25, presets: [0.5, 1, 1.5, 2, 3] }];
  const hh = parseHousehold(label);
  if (hh) units.push({ id: 'hh', seg: hh.unit, unit: hh.unit, gramsPer: sg / hh.qty, step: hh.unit === 'cup' ? 0.25 : 0.5, presets: hh.unit === 'cup' ? [0.25, 0.5, 1, 1.5, 2] : [0.5, 1, 2, 3, 4] });
  if (imperial) units.push({ id: 'oz', seg: 'oz', unit: 'oz', gramsPer: OZ_G, step: 0.5, presets: [2, 3, 4, 6, 8] });
  units.push({ id: 'g', seg: 'g', unit: 'g', gramsPer: 1, step: 10, presets: [50, 100, 150, 200, 250] });
  return units;
}

const FRACTIONS = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3 };

export function parseHousehold(label) {
  const m = String(label || '').trim().match(/^(\d+(?:\.\d+)?)?\s*([½¼¾⅓⅔])?\s*(cups?|tbsp|tsp)\b/i);
  if (!m || (!m[1] && !m[2])) return null;
  const qty = (m[1] ? +m[1] : 0) + (m[2] ? FRACTIONS[m[2]] : 0);
  if (!(qty > 0)) return null;
  const unit = m[3].toLowerCase().replace(/^cups$/, 'cup');
  return { qty, unit };
}

function unitIdOf(unit) {
  if (unit === 'g') return 'g';
  if (unit === 'oz') return 'oz';
  if (HH_UNITS.has(unit)) return 'hh';
  return 'serving';
}

function fuelMeta(s) {
  const f = s.settings?.fuel;
  return { lastPortion: f?.lastPortion && typeof f.lastPortion === 'object' ? f.lastPortion : {}, incompleteDays: Array.isArray(f?.incompleteDays) ? f.incompleteDays : [] };
}

function updateFuelMeta(st, fn) {
  const cur = fuelMeta(st);
  const next = { lastPortion: { ...cur.lastPortion }, incompleteDays: [...cur.incompleteDays] };
  fn(next);
  // keep the portion memory bounded
  const keys = Object.keys(next.lastPortion);
  if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete next.lastPortion[k];
  next.incompleteDays = next.incompleteDays.slice(-90);
  st.settings = { ...st.settings, fuel: next };
}

function lastPortionFor(s, food) {
  const lp = food?.id ? fuelMeta(s).lastPortion[food.id] : null;
  if (lp && +lp.qty > 0 && ['serving', 'hh', 'g', 'oz'].includes(lp.mode)) {
    if (lp.mode === 'hh' && !parseHousehold(food.serving?.label)) return { mode: 'serving', qty: 1 };
    return { mode: lp.mode, qty: +lp.qty };
  }
  return { mode: 'serving', qty: 1 };
}

function isImperial(s) { return (s.profile?.units || 'imperial') !== 'metric'; }

/** Totals for a list of entries, incl. optional alcohol / sodium. */
function totalsOf(list) {
  const t = { kcal: 0, p: 0, c: 0, f: 0, fiber: 0, alc: 0, na: 0, naKnown: 0 };
  for (const e of list) {
    t.kcal += +e.kcal || 0; t.p += +e.p || 0; t.c += +e.c || 0; t.f += +e.f || 0; t.fiber += +e.fiber || 0;
    t.alc += +e.alc || 0;
    if (e.na != null) { t.na += +e.na || 0; t.naKnown++; }
  }
  return t;
}


function targetsFor(s, date) {
  try { return dayTargetsFor(s, date); } catch (e) { console.error(e); return { ...s.targets, dayType: null, fiber: fiberTarget(s.targets.kcal), sessions: [], notes: [] }; }
}

function dayTools(s, ctx) {
  const today = todayISO();
  const flagged = fuelMeta(s).incompleteDays.includes(ctx.date);
  const past = ctx.date < today;
  const box = h('input', { type: 'checkbox', checked: flagged, id: 'fu-incomplete', on: { change: (e) => {
    const on = e.target.checked;
    store.update((st) => updateFuelMeta(st, (m) => { m.incompleteDays = on ? [...new Set([...m.incompleteDays, ctx.date])] : m.incompleteDays.filter((d) => d !== ctx.date); }));
    toast(on ? 'Day left out of adaptive targets' : 'Day counts toward adaptive targets', { ms: 1600 });
  } } });
  return h('div', { class: 'fu-daytools' },
    h('button', { type: 'button', class: 'btn sm ghost', on: { click: () => copyDaySheet(ctx) } }, 'Copy from another day…'),
    past || flagged ? h('label', { class: 'fu-incomplete xs', for: 'fu-incomplete' }, box, h('span', null, 'Incomplete log — leave this day out of the adaptive estimate')) : null);
}

function copyDaySheet(ctx) {
  const st0 = { from: addDays(ctx.date, -1), meals: new Set(MEALS.map(([m]) => m)) };
  const preview = h('div', { class: 'small muted', 'aria-live': 'polite' });
  const dateIn = h('input', { type: 'date', value: st0.from, max: addDays(todayISO(), 30), 'aria-label': 'Copy from date', on: { change: (e) => { if (isISODate(e.target.value)) { st0.from = e.target.value; paint(); } } } });
  const checks = h('div', { class: 'chips' });
  const btn = h('button', { type: 'submit', class: 'btn primary block' });
  const items = () => sel.foodsFor(store.get(), st0.from).filter((e) => st0.meals.has(e.meal));
  function paint() {
    const all = sel.foodsFor(store.get(), st0.from);
    clear(checks);
    for (const [m, l] of MEALS) {
      const cnt = all.filter((e) => e.meal === m).length;
      checks.append(h('button', { type: 'button', class: 'chip', 'aria-pressed': String(st0.meals.has(m)), disabled: !cnt,
        on: { click: () => { if (st0.meals.has(m)) st0.meals.delete(m); else st0.meals.add(m); paint(); } } }, `${l}${cnt ? ` · ${cnt}` : ''}`));
    }
    const it = items();
    preview.textContent = it.length ? `${it.length} item${it.length > 1 ? 's' : ''} · ${num(sumEntries(it).kcal)} kcal from ${fmtDate(st0.from)}` : `Nothing logged on ${fmtDate(st0.from)} for those meals.`;
    btn.textContent = it.length ? `Copy ${it.length} item${it.length > 1 ? 's' : ''} to ${fmtDate(ctx.date)}` : 'Nothing to copy';
    btn.disabled = !it.length;
  }
  trackSheet(ctx, {
    title: 'Copy from another day',
    content: ({ close }) => h('form', { class: 'stack', on: { submit: (e) => {
      e.preventDefault();
      const it = items();
      if (!it.length) return;
      const ids = [];
      store.update((st) => {
        const arr = st.foodLog[ctx.date] || (st.foodLog[ctx.date] = []);
        for (const x of it) { const id = uid('fe'); ids.push(id); arr.push({ ...x, id }); }
      });
      haptic();
      toast(`Copied ${it.length} item${it.length > 1 ? 's' : ''}`, { action: { label: 'Undo', fn: () => removeEntries(ctx.date, ids) } });
      close();
    } } },
    field('From', dateIn), groupField('Meals', checks), preview, btn),
  });
  paint();
}

function adaptiveCard(s, ctx) {
  const today = todayISO();
  const res = adaptiveTdee(s, today);
  const imperial = isImperial(s);
  const t = s.targets;
  const applied = t.source === 'adaptive' && !t.auto && t.adaptive?.appliedAt;
  const sinceApply = applied ? Math.round((Date.parse(today) - Date.parse(t.adaptive.appliedAt)) / 86400000) : Infinity;
  const coolDown = sinceApply < 7;
  const children = [];
  const logWeightBtn = h('button', { type: 'button', class: 'btn sm subtle', on: { click: () => openWeight() } }, '+ Log weight');
  const wkFmt = (wk) => `${wk > 0 ? '+' : wk < 0 ? '−' : '±'}${fmtWeight(Math.abs(wk), imperial ? 'imperial' : 'metric', 1)}/wk`;

  if (!res.tdee) {
    const prog = clamp(res.days / 14, 0, 1);
    children.push(
      h('p', { class: 'small dim' }, 'FORGE estimates your real maintenance calories from your weight trend and what you eat — then suggests a new target each week.'),
      h('div', { class: 'row between xs muted mt' }, h('span', null, res.reason || 'Collecting data…'), h('span', { class: 'tabular' }, `${Math.min(14, res.days)}/14 days`)),
      h('div', { class: 'mt' }, ticks({ value: prog, max: 1, n: 14, label: `${Math.min(14, res.days)} of 14 days` })),
      h('div', { class: 'row gap mt' }, logWeightBtn, h('span', { class: 'xs muted' }, `${res.weighIns} weigh-ins · ${res.intakeDays} complete food days`)));
  } else {
    const wk = res.weeklyChangeKg;
    const pts = res.trendKg;
    children.push(
      h('div', { class: 'stat-row' },
        h('div', { class: 'stat' }, h('span', { class: 'v' }, num(res.tdee)), h('span', { class: 'k' }, 'Est. TDEE')),
        h('div', { class: 'stat' }, h('span', { class: 'v' }, num(res.avgIntake)), h('span', { class: 'k' }, 'Avg intake')),
        h('div', { class: 'stat' }, h('span', { class: 'v' }, wkFmt(wk)), h('span', { class: 'k' }, 'Trend'))),
      pts.length > 2 ? h('div', { class: 'fu-trend' }, lineChart({
        series: [{ points: pts.map((p, i) => ({ x: i, y: imperial ? p.kg / 0.45359237 : p.kg })), color: 'var(--accent)' }],
        xLabels: [{ x: 0, label: fmtDate(pts[0].date, { month: 'short', day: 'numeric' }) }, { x: pts.length - 1, label: fmtDate(pts.at(-1).date, { month: 'short', day: 'numeric' }) }],
        height: 96, yTicks: 2, yFmt: (v) => num(v, 1), ariaLabel: 'Weight trend',
      })) : null,
      h('p', { class: 'xs muted' }, `${res.days} days · ${res.weighIns} weigh-ins · ${res.intakeDays} complete food days${res.excludedDays ? ` (${res.excludedDays} partial left out)` : ''} · formula ${num(res.formulaTdee)} kcal · confidence `,
        h('b', { class: res.confidence === 'high' ? 'go' : res.confidence === 'med' ? 'warn-text' : 'danger-text' }, res.confidence === 'med' ? 'medium' : res.confidence)),
      res.reason ? h('p', { class: 'xs warn-text' }, res.reason) : null);
    if (res.suggestion && !coolDown) {
      const sg = res.suggestion;
      const rate = t.goalRateKgWk ?? s.profile.goalRateKgWk;
      const goalTxt = s.profile.goal === 'maintain' ? 'maintain' : rate != null ? wkFmt(rate).replace('/wk', ' per week') : s.profile.goal === 'lose' ? '−20 %' : '+10 %';
      children.push(h('div', { class: 'callout fu-suggest' },
        h('div', { class: 'row between top' },
          h('div', null, h('div', { class: 'eyebrow' }, 'Suggested daily target (weekly average)'),
            h('div', null, fig(num(sg.kcal), 'kcal')),
            h('div', { class: 'xs muted tabular' }, `P ${sg.protein} g · C ${sg.carbs} g · F ${sg.fat} g · ${sg.delta > 0 ? '+' : '−'}${num(Math.abs(sg.delta))} vs now`)),
          h('button', { type: 'button', class: 'btn sm primary', on: { click: () => applySuggestion(res) } }, 'Apply')),
        h('p', { class: 'xs mt' }, `You averaged ${num(res.avgIntake)} kcal and your trend moved ${wkFmt(wk)} → maintenance ≈ ${num(res.tdee)}; goal ${goalTxt} = ${num(sg.ideal)}.`,
          sg.capped ? ` Changing by at most ${num(150)} kcal this week.` : '')));
    } else if (coolDown) {
      children.push(h('p', { class: 'small go' }, `✓ Adaptive target applied ${sinceApply === 0 ? 'today' : `${sinceApply} day${sinceApply > 1 ? 's' : ''} ago`}. Next check-in in ${7 - sinceApply} day${7 - sinceApply > 1 ? 's' : ''}.`));
    } else {
      children.push(h('p', { class: 'small go' }, '✓ Your current target matches your data — no change needed.'));
    }
    children.push(h('div', { class: 'row gap mt' }, logWeightBtn));
  }
  children.push(goalRateControl(s));
  if (applied) {
    children.push(h('div', { class: 'row between xs muted mt fu-adapt-foot' },
      h('span', null, `Using adaptive target (${num(t.kcal)} kcal) since ${fmtDate(t.adaptive.appliedAt)}.`),
      h('button', { type: 'button', class: 'link-btn', on: { click: () => resetToFormula() } }, 'Back to formula')));
  }
  if ((t.notes || []).includes('carb-short') && s.profile.goal === 'lose') {
    children.push(h('p', { class: 'xs warn-text' }, 'Your deficit leaves under 3.5 g/kg of carbs for hard training. Consider a slower goal rate during Build and Peak.'));
  }
  return h('section', { 'aria-label': 'Adaptive targets' },
    sectionHead('Adaptive targets', h('span', { class: 'pill' + (res.tdee ? ' go' : '') }, res.tdee ? 'Active' : 'Learning'), 7),
    h('div', { class: 'fu-adapt' }, children));
}

function applySuggestion(res) {
  const prev = { ...store.get().targets };
  const today = todayISO();
  store.update((st) => {
    const m = macrosForKcal(st.profile, res.suggestion.kcal);
    st.targets = { ...st.targets, kcal: m.kcal, protein: m.protein, carbs: m.carbs, fat: m.fat, notes: m.notes, auto: false, source: 'adaptive',
      maintenance: res.tdee, adaptive: { tdee: res.tdee, appliedAt: today, confidence: res.confidence } };
  });
  haptic(20);
  toast(`Target set to ${num(res.suggestion.kcal)} kcal`, { kind: 'go', action: { label: 'Undo', fn: () => store.update((st) => { st.targets = prev; }) }, ms: 5000 });
}

function resetToFormula() {
  const prev = { ...store.get().targets };
  store.update((st) => {
    const c = computeTargets(st.profile, { plan: st.plan });
    st.targets = { ...c, auto: true, goalRateKgWk: st.targets.goalRateKgWk ?? null };
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

function rawOf(inp) { return inp?.validity?.badInput ? '?' : inp?.value ?? ''; }

let errSeq = 0;
/** field() with an inline error slot. → {el, set(msg|null)} */

function fieldErr(label, control, input) {
  const id = 'fe-err' + ++errSeq;
  const err = h('span', { class: 'fu-err', id, role: 'alert' });
  const el = field(label, control, err);
  const set = (msg) => {
    err.textContent = msg || '';
    el.classList.toggle('invalid', !!msg);
    if (input) { if (msg) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', id); } else input.removeAttribute('aria-invalid'); }
  };
  return { el, set };
}

function formError() {
  const el = h('p', { class: 'fu-err fu-form-err', role: 'alert' });
  return { el, set: (msg) => { el.textContent = msg || ''; } };
}

// Photo estimates need the FORGE server (api/health). Checked once per page load; null = unknown.
let photoAvail = null;
let photoCheck = null;
function checkPhotoAvailable() {
  if (!photoCheck) photoCheck = apiCall('apiAvailable').then((ok) => (photoAvail = !!ok), () => (photoAvail = false));
  return photoCheck;
}

/** Open Food Facts sodium (R2 P1-3): sodium_100g is grams → mg; else salt_100g × 400 (salt is 40 % sodium). */
export function offSodium(n = {}) {
  const na = parseFloat(n.sodium_100g);
  if (Number.isFinite(na) && na >= 0 && na <= 40) return { na: Math.round(na * 1000) };
  const salt = parseFloat(n.salt_100g);
  if (Number.isFinite(salt) && salt >= 0 && salt <= 100) return { na: Math.round(salt * 400) };
  return {};
}
