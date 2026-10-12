// FORGE onboarding — multi-step first-run flow (docs/PROMPT.md §3.1).
// The step builders are exported so Me (§3.6) can reuse the exact same editors in sheets.
import { store, todayISO, addDays, daysBetween } from '../store.js';
import { h, clear, icon, seg, field, toast, navigate, haptic, num, parseDur, fmtDur, fmtDate, fmtPace,
  toDisplayWeight, fromDisplayWeight, KG_PER_LB, bellLb } from '../ui.js';
import * as program from '../engine/program.js';
import * as nutrition from '../engine/nutrition.js';
import * as hyrox from '../engine/hyrox.js';

// ---------- Shared constants ----------
export const BELL_SIZES = [8, 10, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 40, 48];
export const NO_RACE_WEEKS = 12;

export const EXPERIENCE = [
  { value: 'beginner', label: 'New to kettlebells', desc: 'Under 6 months with bells. We start with swing, goblet squat and press technique and build a base.' },
  { value: 'intermediate', label: 'Solid foundation', desc: 'Clean swings, cleans, presses and snatches with good form. Ready for ladders, complexes and EMOMs.' },
  { value: 'advanced', label: 'Seasoned lifter', desc: 'Years of training, comfortable with double bells and heavy snatches. Bring on density and volume.' },
];

export const EQUIPMENT = [
  { key: 'row', label: 'Rower', icon: 'repeat' },
  { key: 'ski', label: 'SkiErg', icon: 'zap' },
  { key: 'bike', label: 'Bike / Assault bike', icon: 'repeat' },
  { key: 'pullup', label: 'Pull-up bar', icon: 'chevR' },
  { key: 'sandbag', label: 'Sandbag', icon: 'scale' },
  { key: 'wallball', label: 'Wall ball', icon: 'target' },
];

export const DIVISIONS = [
  { value: 'open', label: 'Open', desc: 'Standard weights. The classic first HYROX.' },
  { value: 'pro', label: 'Pro', desc: 'Heavier sleds, sandbag and wall ball. For seasoned racers.' },
  { value: 'doubles', label: 'Doubles', desc: 'Run every km together, split the station work.' },
];

export const GOALS = [
  { value: 'lose', label: 'Lose fat', desc: 'About 20 % below maintenance, with high protein to keep muscle.' },
  { value: 'maintain', label: 'Maintain', desc: 'Fuel performance and recomposition at maintenance.' },
  { value: 'gain', label: 'Build muscle', desc: 'About 10 % above maintenance for a lean gain.' },
];

export const ACTIVITY = [
  { value: 'sedentary', label: 'Desk job', desc: 'Mostly sitting — office, driving, studying' },
  { value: 'light', label: 'On my feet some of the day', desc: 'Some walking, errands, a bit of standing' },
  { value: 'moderate', label: 'On my feet all day', desc: 'Teacher, nurse, retail, hospitality' },
  { value: 'very', label: 'Physical job', desc: 'Lifting and carrying — trades, labour, farming' },
];

export const DAYS_INFO = {
  3: 'Minimum effective dose: 2 KB strength / conditioning days + 1 run.',
  4: 'Balanced: strength, conditioning, a Zone 2 run and a quality run.',
  5: 'Race-focused: adds a hybrid compromised-running day.',
  6: 'High volume: only if you recover well and sleep 7+ hours.',
};

export const recommendedDays = (exp) => ({ beginner: 3, intermediate: 4, advanced: 5 }[exp] || 4);

// ---------- Unit helpers ----------
export function cmToFtIn(cm) {
  const totalIn = cm / 2.54;
  let ft = Math.floor(totalIn / 12), inch = Math.round(totalIn - ft * 12);
  if (inch === 12) { ft += 1; inch = 0; }
  return { ft, inch };
}
export function fmtHeight(cm, units) {
  if (!Number.isFinite(+cm)) return '–';
  if (units === 'metric') return `${Math.round(cm)} cm`;
  const { ft, inch } = cmToFtIn(cm);
  return `${ft}′ ${inch}″`;
}
const r1 = (v) => Math.round(v * 10) / 10;

/** No race booked → program.generatePlan plans a NO_RACE_WEEKS block itself (plan.raceIsDefault). */
export function buildPlan(profile, today = todayISO()) {
  return program.generatePlan(profile, today);
}
export function computeAutoTargets(profile, plan) {
  return { auto: true, ...nutrition.computeTargets(profile, plan ? { plan } : {}) };
}
export function cleanProfile(d) {
  const out = {};
  for (const [k, v] of Object.entries(d)) if (!k.startsWith('_')) out[k] = v;
  out.bells = (d.bells || []).filter((b) => b.count > 0).sort((a, b) => a.kg - b.kg);
  return out;
}

// ---------- Small building blocks ----------
function choiceCards(options, value, onPick, { name, cols = 1 } = {}) {
  return h('div', { class: 'ob-choices' + (cols > 1 ? ' cols' + cols : ''), role: 'radiogroup', 'aria-label': name || '' },
    options.map((o) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(o.value === value), class: 'ob-choice' + (o.value === value ? ' on' : ''),
      on: { click: () => { haptic(); onPick(o.value); } },
    },
    h('span', { class: 'ob-choice-main' },
      h('span', { class: 'ob-choice-label' }, o.label, o.tag ? h('span', { class: 'pill go ob-tag' }, o.tag) : null),
      o.desc ? h('span', { class: 'ob-choice-desc' }, o.desc) : null),
    h('span', { class: 'ob-radio', 'aria-hidden': 'true' }, o.value === value ? icon('check', 16) : null))));
}

function numInput(value, { min, max, step = 1, unit, label, onInput, inputmode = 'decimal', placeholder }) {
  const inp = h('input', {
    type: 'number', inputmode, min, max, step, value: Number.isFinite(value) ? String(value) : '', 'aria-label': label, placeholder,
    on: { input: (e) => onInput(e.target.value === '' ? NaN : Number(e.target.value)) },
  });
  return unit ? h('div', { class: 'input-unit' }, inp, h('span', null, unit)) : inp;
}

// ---------- Step builders: (draft, ctx) → Element. ctx.refresh() re-renders the step. ----------
export function nameEditor(d) {
  return field('Your first name', h('input', {
    type: 'text', value: String(d.name ?? ''), maxlength: 40, autocomplete: 'given-name', placeholder: 'e.g. Alex', autofocus: true,
    on: { input: (e) => { d.name = e.target.value; } },
  }));
}

export function sexAgeEditor(d, ctx) {
  return h('div', { class: 'stack lg' },
    h('div', { class: 'stack sm' }, h('span', { class: 'field-label' }, 'Sex'),
      h('p', { class: 'field-hint' }, 'Used for calorie maths and HYROX division weights.'),
      choiceCards([{ value: 'm', label: 'Male' }, { value: 'f', label: 'Female' }], d.sex, (v) => { d.sex = v; ctx.refresh(); }, { name: 'Sex', cols: 2 })),
    field('Age', numInput(d.age, { min: 14, max: 90, unit: 'yrs', label: 'Age', inputmode: 'numeric', onInput: (v) => { d.age = v; } })));
}

export function bodyEditor(d, ctx) {
  const units = d.units;
  const heightInputs = units === 'metric'
    ? numInput(Math.round(d.heightCm), { min: 120, max: 230, unit: 'cm', label: 'Height in centimetres', inputmode: 'numeric', onInput: (v) => { d.heightCm = v; } })
    : (() => {
      const { ft, inch } = Number.isFinite(d.heightCm) ? cmToFtIn(d.heightCm) : { ft: NaN, inch: NaN };
      let f = ft, i = inch;
      const sync = () => { d.heightCm = Number.isFinite(f) && Number.isFinite(i) ? Math.round((f * 12 + i) * 2.54) : NaN; };
      return h('div', { class: 'grid2' },
        numInput(f, { min: 3, max: 7, unit: 'ft', label: 'Height feet', inputmode: 'numeric', onInput: (v) => { f = v; sync(); } }),
        numInput(i, { min: 0, max: 11, unit: 'in', label: 'Height inches', inputmode: 'numeric', onInput: (v) => { i = Number.isFinite(v) ? v : 0; sync(); } }));
    })();
  const wDisp = Number.isFinite(d.weightKg) ? r1(toDisplayWeight(d.weightKg, units)) : NaN;
  return h('div', { class: 'stack lg' },
    h('div', { class: 'stack sm' }, h('span', { class: 'field-label' }, 'Units'),
      seg([['imperial', 'Imperial · ft, lb'], ['metric', 'Metric · cm, kg']], units, (v) => { d.units = v; ctx.refresh(); }, { label: 'Units' }),
      h('span', { class: 'field-hint' }, 'FORGE stores everything metric — switch any time. Bells always show in kg.')),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Height'), heightInputs),
    field('Body weight', numInput(wDisp, { min: 30, max: 600, step: 0.1, unit: units === 'metric' ? 'kg' : 'lb', label: 'Body weight',
      onInput: (v) => { d.weightKg = Number.isFinite(v) ? r1(fromDisplayWeight(v, units)) : NaN; } })));
}

export function experienceEditor(d, ctx) {
  return choiceCards(EXPERIENCE, d.experience, (v) => { d.experience = v; if (!d._daysTouched && !d.onboarded) d.daysPerWeek = recommendedDays(v); ctx.refresh(); }, { name: 'Experience' });
}

export function bellGrid(d, ctx) {
  const counts = new Map((d.bells || []).map((b) => [b.kg, b.count]));
  const owned = [...counts.entries()].filter(([, c]) => c > 0);
  const set = (kg, c) => {
    const list = (d.bells || []).filter((b) => b.kg !== kg);
    if (c > 0) list.push({ kg, count: c });
    d.bells = list.sort((a, b) => a.kg - b.kg);
    ctx.refresh();
  };
  // include any non-standard sizes the user already had
  const sizes = [...new Set([...BELL_SIZES, ...(d.bells || []).map((b) => b.kg)])].sort((a, b) => a - b);
  return h('div', { class: 'stack' },
    h('div', { class: 'bell-grid', role: 'group', 'aria-label': 'Kettlebells owned' },
      sizes.map((kg) => {
        const c = counts.get(kg) || 0;
        const state = c === 2 ? 'Pair' : c === 1 ? 'Single' : 'None';
        return h('button', {
          type: 'button', class: 'bell-tile' + (c ? ' on' : '') + (c === 2 ? ' pair' : ''),
          'aria-label': `${kg} kilogram bell: ${state}. Tap to change.`,
          on: { click: () => { haptic(); set(kg, (c + 1) % 3); } },
        },
        h('span', { class: 'bell-kg' }, String(kg), h('small', null, 'kg')),
        h('span', { class: 'bell-lb' }, bellLb(kg)),
        h('span', { class: 'bell-count' }, c === 2 ? '× 2' : c === 1 ? '× 1' : '—'));
      })),
    h('p', { class: 'field-hint center' }, 'Tap to cycle: none → single → pair. ',
      owned.length ? `${owned.length} size${owned.length > 1 ? 's' : ''} · ${owned.reduce((a, [, c]) => a + c, 0)} bells` : 'No bells selected yet.'));
}

export function equipmentEditor(d, ctx, { showFiveK = true } = {}) {
  const eq = d.equipment || (d.equipment = {});
  const fiveKStr = d._fiveK ?? (d.fiveKSec ? fmtDur(d.fiveKSec) : '');
  let pacesEl = h('div');
  const showPaces = () => {
    clear(pacesEl);
    const sec = parseDur(d._fiveK ?? fiveKStr);
    if (!sec || sec < 720 || sec > 3600) return;
    try {
      const p = hyrox.paces(sec);
      const units = d.units;
      const lo = Array.isArray(p.easy) ? p.easy[0] : p.easy;
      pacesEl.append(h('div', { class: 'ob-paces' },
        [['Easy', lo], ['Threshold', p.threshold], ['Interval', p.interval], ['Race', p.race]]
          .filter(([, v]) => Number.isFinite(+v))
          .map(([k, v]) => h('div', { class: 'stat' }, h('span', { class: 'k' }, k), h('span', { class: 'v sm' }, fmtPace(v, units))))));
    } catch { /* paces unavailable */ }
  };
  showPaces();
  return h('div', { class: 'stack lg' },
    h('div', { class: 'equip-grid' },
      h('div', { class: 'equip-tile on locked', 'aria-label': 'Running: always included' }, h('span', null, 'Running'), h('small', null, 'Always included')),
      EQUIPMENT.map((e) => h('button', {
        type: 'button', class: 'equip-tile' + (eq[e.key] ? ' on' : ''), 'aria-pressed': String(!!eq[e.key]),
        on: { click: () => { haptic(); eq[e.key] = !eq[e.key]; ctx.refresh(); } },
      }, h('span', null, e.label), h('small', null, eq[e.key] ? 'Have it' : 'Not owned · we’ll sub')))),
    showFiveK ? h('div', { class: 'stack sm' },
      field('Recent 5 km time (optional)', h('input', {
        type: 'text', inputmode: 'numeric', placeholder: 'mm:ss  e.g. 26:30', value: fiveKStr, 'aria-label': 'Recent 5 km time, minutes and seconds',
        on: { input: (e) => { d._fiveK = e.target.value.trim(); showPaces(); } },
      }), 'Sets your run paces. No idea? Leave blank — we’ll calibrate from your first benchmark run.'),
      pacesEl) : null);
}

export function daysEditor(d, ctx) {
  const rec = recommendedDays(d.experience);
  return h('div', { class: 'stack' },
    h('div', { class: 'days-grid', role: 'radiogroup', 'aria-label': 'Training days per week' },
      [3, 4, 5, 6].map((n) => h('button', {
        type: 'button', role: 'radio', 'aria-checked': String(d.daysPerWeek === n), class: 'day-tile' + (d.daysPerWeek === n ? ' on' : ''),
        on: { click: () => { haptic(); d.daysPerWeek = n; d._daysTouched = true; ctx.refresh(); } },
      }, h('span', { class: 'day-n' }, String(n)), h('span', { class: 'day-k' }, 'days'), n === rec ? h('span', { class: 'pill go' }, 'Recommended') : null))),
    h('div', { class: 'callout info' }, DAYS_INFO[d.daysPerWeek] || ''));
}

export function raceEditor(d, ctx) {
  const today = todayISO();
  const noRace = !d.raceDate;
  const weeks = d.raceDate ? Math.floor(daysBetween(today, d.raceDate) / 7) : NO_RACE_WEEKS;
  return h('div', { class: 'stack lg' },
    h('div', { class: 'stack sm' },
      field('Race date', h('input', {
        type: 'date', min: addDays(today, 1), value: d.raceDate || '', 'aria-label': 'HYROX race date',
        on: { change: (e) => { d.raceDate = e.target.value || null; ctx.refresh(); } },
      })),
      h('button', { type: 'button', class: 'ob-choice' + (noRace ? ' on' : ''), 'aria-pressed': String(noRace),
        on: { click: () => { d.raceDate = null; ctx.refresh(); } } },
      h('span', { class: 'ob-choice-main' }, h('span', { class: 'ob-choice-label' }, 'No race booked yet'),
        h('span', { class: 'ob-choice-desc' }, `Plan a ${NO_RACE_WEEKS}-week block to be race-ready. Add a date later in Me.`)),
      h('span', { class: 'ob-radio', 'aria-hidden': 'true' }, noRace ? icon('check', 16) : null)),
      d.raceDate ? h('p', { class: 'field-hint' }, `${fmtDate(d.raceDate, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })} · ${Math.max(0, daysBetween(today, d.raceDate))} days · ${weeks} weeks out`) : null),
    h('div', { class: 'stack sm' }, h('span', { class: 'field-label' }, 'Division'),
      choiceCards(DIVISIONS, d.division, (v) => { d.division = v; ctx.refresh(); }, { name: 'Division' })));
}

export function nutritionEditor(d, ctx) {
  return h('div', { class: 'stack lg' },
    h('div', { class: 'stack sm' }, h('span', { class: 'field-label' }, 'Goal'),
      choiceCards(GOALS, d.goal, (v) => { d.goal = v; ctx.refresh(); }, { name: 'Nutrition goal' })),
    h('div', { class: 'stack sm' }, h('span', { class: 'field-label' }, 'Outside of training, how active is your day?'),
      h('p', { class: 'field-hint' }, 'Don’t count workouts — FORGE adds your training on top.'),
      choiceCards(ACTIVITY, d.activity, (v) => { d.activity = v; ctx.refresh(); }, { name: 'Activity level' })));
}

// ---------- Validators (return message or null) ----------
export const validate = {
  name: (d) => (!String(d.name ?? '').trim() ? 'What should your coach call you?' : String(d.name).trim().length > 40 ? 'Keep it under 40 characters.' : null),
  sexAge: (d) => (!['m', 'f'].includes(d.sex) ? 'Pick one so we can set calorie targets.'
    : !Number.isFinite(d.age) || d.age < 14 || d.age > 90 ? 'Age should be between 14 and 90.' : null),
  body: (d) => {
    if (!Number.isFinite(d.heightCm) || d.heightCm < 120 || d.heightCm > 230) return d.units === 'metric' ? 'Height should be between 120 and 230 cm.' : 'Height should be between 4′0″ and 7′6″.';
    if (!Number.isFinite(d.weightKg) || d.weightKg < 35 || d.weightKg > 250) return d.units === 'metric' ? 'Weight should be between 35 and 250 kg.' : 'Weight should be between 77 and 550 lb.';
    return null;
  },
  experience: (d) => (!d.experience ? 'Choose the closest match.' : null),
  bells: (d) => (!(d.bells || []).some((b) => b.count > 0) ? 'Select at least one kettlebell — even a single bell is enough to start.' : null),
  equipment: (d) => {
    if (d._fiveK) {
      const sec = parseDur(d._fiveK);
      if (!sec || !/^\d{1,2}:\d{2}$/.test(d._fiveK)) return 'Enter your 5 km time as mm:ss, like 26:30.';
      if (sec < 720 || sec > 3600) return 'That 5 km time looks off — between 12:00 and 60:00 please.';
    }
    return null;
  },
  days: (d) => (![3, 4, 5, 6].includes(d.daysPerWeek) ? 'Pick 3 to 6 days.' : null),
  race: (d) => {
    if (!d.raceDate) return null;
    const days = daysBetween(todayISO(), d.raceDate);
    if (!(days > 0)) return 'Race date needs to be in the future.';
    if (days > 730) return 'That’s more than two years away — pick a closer race or “No race booked”.';
    return null;
  },
  nutrition: (d) => (!d.goal || !d.activity ? 'Pick a goal and activity level.' : null),
};

/** Apply transient fields (_fiveK) to the draft. */
export function commitDraft(d) {
  if (d._fiveK !== undefined) d.fiveKSec = d._fiveK ? parseDur(d._fiveK) : null;
  if (Number.isFinite(d.weightKg)) d.weightKg = r1(d.weightKg);
  d.name = String(d.name ?? '').trim();
  return d;
}

// ---------- Flow ----------
const STEPS = [
  { id: 'welcome', eyebrow: 'Welcome to FORGE', title: 'Let’s forge your plan.', sub: 'Kettlebell strength, a big engine and HYROX race prep — with food tracking built in. Two minutes of questions, then you train.', build: nameEditor, check: validate.name },
  { id: 'sexAge', eyebrow: 'About you', title: 'The basics', build: sexAgeEditor, check: validate.sexAge },
  { id: 'body', eyebrow: 'About you', title: 'Height & weight', sub: 'Drives calorie targets and suggested bell sizes.', build: bodyEditor, check: validate.body },
  { id: 'experience', eyebrow: 'Training', title: 'Kettlebell experience', sub: 'Be honest — the plan progresses fast either way.', build: experienceEditor, check: validate.experience, skippable: true },
  { id: 'bells', eyebrow: 'Equipment', title: 'Which bells do you own?', sub: 'FORGE only ever suggests a bell you actually have.', build: bellGrid, check: validate.bells },
  { id: 'equipment', eyebrow: 'Equipment', title: 'Cardio kit', sub: 'Running is always in. Missing stations get smart kettlebell substitutions.', build: equipmentEditor, check: validate.equipment, skippable: true },
  { id: 'days', eyebrow: 'Schedule', title: 'Training days per week', build: daysEditor, check: validate.days, skippable: true },
  { id: 'race', eyebrow: 'HYROX', title: 'Your race', sub: '8 × 1 km runs, 8 stations. We periodise backwards from race day.', build: raceEditor, check: validate.race, skippable: true },
  { id: 'nutrition', eyebrow: 'Fuel', title: 'Nutrition goal', build: nutritionEditor, check: validate.nutrition, skippable: true },
  { id: 'summary', eyebrow: 'Ready', title: 'Your plan is ready to forge', build: summary },
];

let draft = null; // survives hash changes within the session
let stepIdx = 0;

function phaseColor(ph) { return `var(--${ph || 'base'})`; }

function summary(d) {
  const p = commitDraft({ ...d, equipment: { ...d.equipment } });
  const profile = cleanProfile(p);
  let plan = null, targets = null, err = null;
  try { plan = buildPlan(profile); } catch (e) { err = e; console.error(e); }
  try { targets = nutrition.computeTargets(profile, plan ? { plan } : {}); } catch (e) { err = err || e; console.error(e); }
  const weeks = plan?.weeks || [];
  const phases = [];
  for (const w of weeks) {
    const last = phases[phases.length - 1];
    if (last && last.phase === w.phase) last.n++; else phases.push({ phase: w.phase, n: 1 });
  }
  const P = program.PHASES || {};
  const bells = profile.bells.map((b) => `${b.kg}${b.count === 2 ? '×2' : ''}`).join(' · ');
  const race = profile.raceDate ? fmtDate(profile.raceDate, { month: 'short', day: 'numeric', year: 'numeric' }) : `${NO_RACE_WEEKS}-week block`;
  return h('div', { class: 'stack lg' },
    err ? h('div', { class: 'callout danger', role: 'alert' }, 'Some engine parts didn’t load: ', String(err.message || err)) : null,
    plan ? h('div', { class: 'card hero ob-plan' },
      h('div', { class: 'row between top' },
        h('div', null, h('div', { class: 'eyebrow' }, 'Training plan'),
          h('div', { class: 'ob-big' }, String(weeks.length), h('small', null, ' weeks'))),
        h('div', { class: 'right' }, h('div', { class: 'eyebrow' }, profile.raceDate ? 'Race day' : 'Target'), h('div', { class: 'card-title' }, race))),
      h('div', { class: 'phase-bar', 'aria-label': 'Phases' },
        phases.map((ph) => h('i', { style: { flexGrow: String(ph.n), background: phaseColor(ph.phase) }, title: `${P[ph.phase]?.label || ph.phase}: ${ph.n} wk` }))),
      h('div', { class: 'phase-legend' },
        phases.map((ph) => h('span', null, h('span', { class: 'dot', style: { background: phaseColor(ph.phase) } }), `${P[ph.phase]?.label || ph.phase} · ${ph.n} wk`))),
      h('div', { class: 'grid3 mt' },
        h('div', { class: 'stat' }, h('span', { class: 'v' }, String(profile.daysPerWeek)), h('span', { class: 'k' }, 'days / week')),
        h('div', { class: 'stat' }, h('span', { class: 'v' }, (profile.division || 'open').replace(/^./, (c) => c.toUpperCase())), h('span', { class: 'k' }, 'division')),
        h('div', { class: 'stat' }, h('span', { class: 'v' }, String(profile.bells.reduce((a, b) => a + b.count, 0))), h('span', { class: 'k' }, 'bells')))) : null,
    targets ? h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('div', { class: 'eyebrow' }, 'Daily nutrition targets'), h('span', { class: 'pill' }, GOALS.find((g) => g.value === profile.goal)?.label || '')),
      h('div', { class: 'ob-kcal' }, num(targets.kcal), h('small', null, ' kcal')),
      h('div', { class: 'grid4 ob-macros' },
        [['Protein', targets.protein, 'g', '--protein'], ['Carbs', targets.carbs, 'g', '--carbs'], ['Fat', targets.fat, 'g', '--fat'], ['Water', targets.waterMl / 1000, 'L', '--water']]
          .map(([k, v, u, c]) => h('div', { class: 'stat' }, h('span', { class: 'v', style: { color: `var(${c})` } }, num(v, u === 'L' ? 1 : 0), h('small', null, u)), h('span', { class: 'k' }, k)))),
      h('p', { class: 'field-hint mt' }, 'Carbs flex ±10 % on training vs rest days. Targets adapt to your weight trend after two weeks.')) : null,
    h('div', { class: 'card tight' }, h('div', { class: 'list' },
      [['Athlete', `${profile.name} · ${profile.sex === 'f' ? 'F' : 'M'} · ${profile.age}`],
        ['Body', `${fmtHeight(profile.heightCm, profile.units)} · ${fmtWeightU(profile.weightKg, profile.units)}`],
        ['Bells (kg)', bells || '—'],
        ['5 km', profile.fiveKSec ? fmtDur(profile.fiveKSec) : 'Not set']]
        .map(([k, v]) => h('div', { class: 'li' }, h('span', { class: 'li-main muted small' }, k), h('span', { class: 'li-end' }, v))))));
}

function fmtWeightU(kg, units) {
  return units === 'metric' ? `${num(kg, kg % 1 ? 1 : 0)} kg` : `${num(kg / KG_PER_LB, 0)} lb`;
}

export function render(root) {
  const s = store.get();
  if (!draft) {
    draft = structuredClone(s.profile);
    if (!draft.onboarded) draft.daysPerWeek = recommendedDays(draft.experience);
    if (!ACTIVITY.some((a) => a.value === draft.activity)) draft.activity = 'light';
    stepIdx = 0;
  }
  let error = null;
  let dir = 1;

  const finish = (btn) => {
    btn.disabled = true;
    try {
      const today = todayISO();
      const profile = cleanProfile(commitDraft(draft));
      profile.onboarded = true;
      profile.hrMax = profile.hrMax || hyrox.defaultHrMax(profile.age);
      const plan = buildPlan(profile, today);
      const targets = computeAutoTargets(profile, plan);
      store.update((st) => {
        st.profile = profile;
        st.targets = targets;
        st.plan = plan;
        st.bodyweight = st.bodyweight.filter((b) => b.date !== today);
        st.bodyweight.push({ date: today, kg: profile.weightKg });
      });
      draft = null;
      toast(`Plan forged, ${profile.name}. Let’s go.`, { kind: 'go' });
      navigate('#/today');
    } catch (e) {
      console.error(e);
      btn.disabled = false;
      error = 'Could not build your plan: ' + (e.message || e);
      paint();
    }
  };

  const go = (delta) => {
    const step = STEPS[stepIdx];
    if (delta > 0 && step.check) {
      error = step.check(draft);
      if (error) { haptic(30); paint(); return; }
    }
    if (delta > 0) commitDraft(draft);
    error = null; dir = delta;
    stepIdx = Math.max(0, Math.min(STEPS.length - 1, stepIdx + delta));
    paint();
    root.querySelector('.ob-body input, .ob-body button')?.focus?.({ preventScroll: true });
  };

  function paint() {
    const step = STEPS[stepIdx];
    const last = stepIdx === STEPS.length - 1;
    const ctx = { refresh: () => { error = null; paintBody(); } };
    const body = h('div', { class: 'ob-body' });
    const errEl = h('div', { class: 'ob-error', role: 'alert', 'aria-live': 'assertive' });
    function paintBody() {
      clear(body).append(step.build(draft, ctx));
      clear(errEl);
      if (error) errEl.append(h('div', { class: 'callout danger' }, icon('info', 16), h('span', null, error)));
    }
    paintBody();
    const nextBtn = h('button', { type: 'button', class: 'btn primary xl block', on: { click: (e) => (last ? finish(e.currentTarget) : go(1)) } },
      last ? [icon('flame', 20), 'Forge my plan'] : stepIdx === 0 ? 'Get started' : ['Continue', icon('chevR', 18)]);
    clear(root).append(h('div', { class: 'ob' },
      h('header', { class: 'ob-top' },
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Back', disabled: stepIdx === 0, style: { visibility: stepIdx === 0 ? 'hidden' : 'visible' }, on: { click: () => go(-1) } }, icon('chevL')),
        h('div', { class: 'ob-dots', role: 'progressbar', 'aria-valuemin': '1', 'aria-valuemax': String(STEPS.length), 'aria-valuenow': String(stepIdx + 1), 'aria-label': `Step ${stepIdx + 1} of ${STEPS.length}` },
          STEPS.map((_, i) => h('i', { class: i < stepIdx ? 'done' : i === stepIdx ? 'on' : '' }))),
        step.skippable ? h('button', { type: 'button', class: 'link-btn ob-skip', on: { click: () => { error = null; dir = 1; stepIdx++; paint(); } } }, 'Skip') : h('span', { class: 'ob-skip' })),
      h('section', { class: 'ob-step ' + (dir > 0 ? 'in-r' : 'in-l'), 'aria-labelledby': 'ob-title' },
        stepIdx === 0 ? h('div', { class: 'ob-brand', 'aria-hidden': 'true' }, h('span', { class: 'ob-mark' }, icon('bell', 34)), 'FORGE') : null,
        h('div', { class: 'eyebrow' }, `${step.eyebrow} · ${stepIdx + 1}/${STEPS.length}`),
        h('h1', { id: 'ob-title', class: 'ob-title' }, step.id === 'sexAge' && String(draft.name ?? '').trim() ? `Nice to meet you, ${String(draft.name).trim()}.` : step.title),
        step.sub ? h('p', { class: 'ob-sub' }, step.sub) : null,
        body, errEl),
      h('footer', { class: 'ob-foot' }, nextBtn,
        last ? h('p', { class: 'field-hint center' }, 'Everything is editable later in Me. Your data stays on this device.') : null)));
    // Enter submits text steps
    root.querySelectorAll('.ob-body input[type="text"], .ob-body input[type="number"]').forEach((inp) =>
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(1); } }));
  }

  paint();
}
