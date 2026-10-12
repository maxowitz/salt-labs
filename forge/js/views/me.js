// FORGE Me — profile, equipment, targets, plan, settings, data (docs/PROMPT.md §3.6).
import { store, todayISO, daysBetween } from '../store.js';
import { h, clear, icon, seg, sheet, toast, confirmDialog, navigate, num, fmtDur, fmtDate, fmtWeight,
  toDisplayWeight, fromDisplayWeight, field, sectionHead } from '../ui.js';
import * as program from '../engine/program.js';
import * as hyrox from '../engine/hyrox.js';
import {
  nameEditor, sexAgeEditor, bodyEditor, experienceEditor, bellGrid, equipmentEditor, daysEditor, raceEditor, nutritionEditor,
  validate, commitDraft, cleanProfile, buildPlan, computeAutoTargets, fmtHeight, EXPERIENCE, GOALS, ACTIVITY, DIVISIONS, NO_RACE_WEEKS,
} from './onboarding.js';

export const VERSION = '1.0.0';
const PLAN_KEYS = ['experience', 'bells', 'equipment', 'daysPerWeek', 'raceDate', 'division', 'fiveKSec', 'sex', 'weightKg'];
const safe = (fn, fallback = null) => { try { return fn(); } catch (e) { console.warn('FORGE me:', e); return fallback; } };
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

// ---------- profile editing via the onboarding step editors ----------
function openEditor(title, builder, checks = []) {
  const draft = structuredClone(store.get().profile);
  const before = structuredClone(draft);
  const body = h('div');
  const err = h('div', { role: 'alert' });
  const ctx = { refresh: () => { clear(err); paintBody(); } };
  function paintBody() { clear(body).append(builder(draft, ctx)); }
  paintBody();
  sheet({
    title,
    content: ({ close }) => h('div', { class: 'stack lg me-editor' }, body, err,
      h('button', { type: 'button', class: 'btn primary xl block', on: { click: async () => {
        const msg = checks.map((c) => c(draft)).find(Boolean);
        clear(err);
        if (msg) { err.append(h('div', { class: 'callout danger' }, msg)); return; }
        commitDraft(draft);
        close();
        await applyProfile(cleanProfile(draft), before);
      } } }, icon('check'), 'Save')),
  });
}

async function applyProfile(next, before) {
  const s = store.get();
  // keep a default HRmax in sync with age unless the user customised it
  const oldDefault = safe(() => Math.round(hyrox.defaultHrMax(before.age)));
  if (!next.hrMax || Math.round(next.hrMax) === oldDefault) next.hrMax = safe(() => hyrox.defaultHrMax(next.age), next.hrMax);
  store.update((st) => {
    st.profile = { ...st.profile, ...next, onboarded: true };
    if (st.targets.auto) {
      const t = safe(() => computeAutoTargets(st.profile));
      if (t) st.targets = t;
    }
  });
  toast('Saved', { kind: 'go', ms: 1400 });
  const changed = PLAN_KEYS.filter((k) => k !== 'weightKg' && JSON.stringify(before[k]) !== JSON.stringify(next[k]));
  if (changed.length && s.plan) {
    const ok = await confirmDialog('Your training settings changed. Regenerate the plan from today so it reflects them? Logged sessions are kept.', { ok: 'Regenerate plan' });
    if (ok) regenerate();
  }
}

function regenerate() {
  try {
    const plan = buildPlan(store.get().profile, todayISO());
    store.update((st) => { st.plan = plan; });
    toast(`New ${plan.weeks.length}-week plan forged`, { kind: 'go' });
  } catch (e) {
    console.error(e);
    toast('Could not regenerate plan: ' + (e.message || e), { kind: 'danger', ms: 5000 });
  }
}

function goalWeightEditor(d) {
  const units = d.units;
  const v = Number.isFinite(+d.goalWeightKg) && d.goalWeightKg ? Math.round(toDisplayWeight(d.goalWeightKg, units) * 10) / 10 : '';
  return h('div', { class: 'stack' },
    field(`Goal weight (${units === 'metric' ? 'kg' : 'lb'})`, h('input', {
      type: 'number', inputmode: 'decimal', step: '0.1', value: String(v), placeholder: 'Optional',
      on: { input: (e) => { d.goalWeightKg = e.target.value === '' ? null : Math.round(fromDisplayWeight(+e.target.value, units) * 10) / 10; } },
    }), 'Shown as a dashed line on your weight chart. Leave empty for none.'));
}
const checkGoal = (d) => (d.goalWeightKg != null && (!(d.goalWeightKg >= 35) || d.goalWeightKg > 250) ? 'Goal weight looks out of range.' : null);

// ---------- rows ----------
function row(label, value, onClick, ic) {
  return h('button', { type: 'button', class: 'li me-row', on: { click: onClick } },
    ic ? h('span', { class: 'badge' }, icon(ic, 18)) : null,
    h('span', { class: 'li-main' }, h('div', { class: 'li-title' }, label), value ? h('div', { class: 'li-sub' }, value) : null),
    icon('chevR', 18));
}

function toggleRow(label, sub, checked, onChange) {
  const id = 'tg-' + label.toLowerCase().replace(/\W+/g, '-');
  return h('div', { class: 'switch li' },
    h('label', { for: id, class: 'li-main' }, h('div', { class: 'li-title' }, label), sub ? h('div', { class: 'li-sub' }, sub) : null),
    h('span', { class: 'toggle' }, h('input', { type: 'checkbox', id, role: 'switch', checked, on: { change: (e) => onChange(e.target.checked) } }), h('span', { 'aria-hidden': 'true' })));
}

function profileSection(p) {
  const units = p.units;
  const exp = EXPERIENCE.find((e) => e.value === p.experience)?.label || cap(p.experience);
  return h('section', null, sectionHead('Profile'),
    h('div', { class: 'card flush' }, h('div', { class: 'list' },
      row('Name', p.name || '—', () => openEditor('Name', nameEditor, [validate.name]), 'user'),
      row('Sex & age', `${p.sex === 'f' ? 'Female' : 'Male'} · ${p.age} yrs`, () => openEditor('Sex & age', sexAgeEditor, [validate.sexAge]), 'heart'),
      row('Height & weight', `${fmtHeight(p.heightCm, units)} · ${fmtWeight(p.weightKg, units, 1)}`, () => openEditor('Height & weight', bodyEditor, [validate.body]), 'scale'),
      row('Goal weight', p.goalWeightKg ? fmtWeight(p.goalWeightKg, units, 1) : 'Not set', () => openEditor('Goal weight', goalWeightEditor, [checkGoal]), 'target'),
      row('Experience', exp, () => openEditor('Kettlebell experience', experienceEditor, [validate.experience]), 'bell'),
      row('Heart rate max', p.hrMax ? `${Math.round(p.hrMax)} bpm` : 'Auto', () => openHrSheet(), 'heart'))));
}

function openHrSheet() {
  const p = store.get().profile;
  const def = Math.round(safe(() => hyrox.defaultHrMax(p.age), 208 - 0.7 * p.age));
  let v = Math.round(p.hrMax || def);
  const zones = h('div');
  const paintZones = () => {
    clear(zones);
    const z = safe(() => hyrox.hrZones(v), []);
    if (z?.length) zones.append(h('div', { class: 'list card flush' }, z.map((x) => h('div', { class: 'li' },
      h('span', { class: 'badge' }, `Z${x.z}`), h('span', { class: 'li-main' }, h('div', { class: 'li-title' }, x.label || '')), h('span', { class: 'li-end num' }, `${Math.round(x.lo)}–${Math.round(x.hi)}`)))));
  };
  paintZones();
  sheet({
    title: 'Heart rate max',
    content: ({ close }) => h('div', { class: 'stack' },
      h('p', { class: 'small muted' }, `Default for age ${p.age}: ${def} bpm (208 − 0.7 × age). Use a measured max if you have one.`),
      field('HR max (bpm)', h('input', { type: 'number', inputmode: 'numeric', min: 120, max: 230, value: String(v), on: { input: (e) => { v = +e.target.value; if (v >= 120 && v <= 230) paintZones(); } } })),
      zones,
      h('div', { class: 'row gap' },
        h('button', { type: 'button', class: 'btn ghost grow', on: { click: () => { store.update((st) => { st.profile.hrMax = def; }); close(); toast('Reset to age default'); } } }, 'Use default'),
        h('button', { type: 'button', class: 'btn primary grow', on: { click: () => {
          if (!(v >= 120 && v <= 230)) { toast('HR max should be 120–230 bpm', { kind: 'danger' }); return; }
          store.update((st) => { st.profile.hrMax = v; }); close(); toast('Saved', { kind: 'go', ms: 1400 });
        } } }, 'Save'))),
  });
}

function equipmentSection(p) {
  const bells = (p.bells || []).map((b) => `${b.kg}${b.count === 2 ? '×2' : ''}`).join(' · ') || 'None';
  const eq = Object.entries(p.equipment || {}).filter(([, v]) => v).map(([k]) => ({ row: 'Rower', ski: 'SkiErg', bike: 'Bike', pullup: 'Pull-up bar', sandbag: 'Sandbag', wallball: 'Wall ball' }[k]));
  return h('section', null, sectionHead('Equipment'),
    h('div', { class: 'card flush' }, h('div', { class: 'list' },
      row('Kettlebells', `${bells} kg`, () => openEditor('Kettlebells owned', bellGrid, [validate.bells]), 'bell'),
      row('Cardio kit & 5 km', `Run${eq.length ? ' · ' + eq.join(' · ') : ''}${p.fiveKSec ? ` · 5 km ${fmtDur(p.fiveKSec)}` : ''}`,
        () => openEditor('Cardio kit', equipmentEditor, [validate.equipment]), 'run'))));
}

function targetsSection(s, repaint) {
  const t = s.targets;
  const p = s.profile;
  const goal = GOALS.find((g) => g.value === p.goal)?.label || cap(p.goal);
  const act = ACTIVITY.find((a) => a.value === p.activity)?.label || cap(p.activity);
  const macroKcal = Math.round((+t.protein || 0) * 4 + (+t.carbs || 0) * 4 + (+t.fat || 0) * 9);
  const diff = macroKcal - (+t.kcal || 0);
  const setT = (k, v) => store.update((st) => { st.targets[k] = v; });
  const numField = (label, key, unit, min, max) => field(label, h('div', { class: 'input-unit' },
    h('input', { type: 'number', inputmode: 'numeric', min, max, value: String(Math.round(t[key] || 0)), 'aria-label': label,
      on: { change: (e) => {
        const v = Math.round(+e.target.value);
        if (!(v >= min && v <= max)) { toast(`${label} should be ${min}–${max} ${unit}`, { kind: 'danger' }); e.target.value = String(Math.round(t[key])); return; }
        setT(key, v);
      } } }), h('span', null, unit)));
  const manual = !t.auto ? h('div', { class: 'stack me-manual' },
    h('div', { class: 'grid2' },
      numField('Calories', 'kcal', 'kcal', 1000, 6000),
      numField('Water', 'waterMl', 'ml', 1000, 8000),
      numField('Protein', 'protein', 'g', 40, 400),
      numField('Carbs', 'carbs', 'g', 0, 900),
      numField('Fat', 'fat', 'g', 20, 300)),
    Math.abs(diff) > Math.max(50, t.kcal * 0.03)
      ? h('div', { class: 'callout' }, h('div', null, `Your macros add up to ${num(macroKcal)} kcal — ${num(Math.abs(diff))} ${diff > 0 ? 'over' : 'under'} your calorie target.`),
        h('div', { class: 'row gap mt' },
          h('button', { type: 'button', class: 'btn sm subtle', on: { click: () => setT('kcal', macroKcal) } }, `Set kcal to ${num(macroKcal)}`),
          h('button', { type: 'button', class: 'btn sm subtle', on: { click: () => setT('carbs', Math.max(0, Math.round(t.carbs - diff / 4))) } }, 'Balance with carbs')))
      : h('p', { class: 'xs go' }, icon('check', 14), ` Macros match calories (4·P + 4·C + 9·F = ${num(macroKcal)} kcal).`)) : null;
  return h('section', null, sectionHead('Nutrition targets'),
    h('div', { class: 'card' },
      h('div', { class: 'target-strip' },
        [['kcal', t.kcal, '', 'var(--accent)'], ['Protein', t.protein, 'g', 'var(--protein)'], ['Carbs', t.carbs, 'g', 'var(--carbs)'], ['Fat', t.fat, 'g', 'var(--fat)'], ['Water', t.waterMl / 1000, 'L', 'var(--water)']]
          .map(([k, v, u, c]) => h('div', { class: 'stat' }, h('span', { class: 'v', style: { color: c } }, num(v, u === 'L' ? 1 : 0), h('small', null, u)), h('span', { class: 'k' }, k)))),
      h('div', { class: 'list mt' },
        toggleRow('Automatic targets', t.auto ? 'Computed from your profile, goal and weight' : 'Manual — edit below', !!t.auto, (on) => {
          store.update((st) => {
            if (on) { const c = safe(() => computeAutoTargets(st.profile)); st.targets = c || { ...st.targets, auto: true }; } else st.targets.auto = false;
          });
        }),
        row('Goal & activity', `${goal} · ${act}`, () => openEditor('Nutrition goal', nutritionEditor, [validate.nutrition]), 'flame')),
      manual,
      h('p', { class: 'xs muted mt' }, 'Training days get +10 % carbs, rest days −10 %. Fuel suggests adaptive changes from your weight trend.')));
}

function planSection(s) {
  const plan = s.plan;
  const p = s.profile;
  const today = todayISO();
  const P = safe(() => program.PHASES, {}) || {};
  const raceTxt = p.raceDate ? `${fmtDate(p.raceDate, { month: 'short', day: 'numeric', year: 'numeric' })} · ${Math.max(0, daysBetween(today, p.raceDate))} days` : `No race booked (${NO_RACE_WEEKS}-week block)`;
  const div = DIVISIONS.find((d) => d.value === p.division)?.label || cap(p.division);
  return h('section', null, sectionHead('Plan'),
    h('div', { class: 'card flush' },
      plan ? h('div', { class: 'me-plan' },
        h('div', { class: 'row between' },
          h('div', null, h('div', { class: 'eyebrow' }, 'Current plan'), h('div', { class: 'card-title' }, `${plan.weeks.length} weeks`)),
          h('div', { class: 'right xs muted' }, `Started ${fmtDate(plan.startDate || plan.weeks[0]?.days[0]?.date)}`, h('br'), plan.generatedAt ? `Built ${fmtDate(String(plan.generatedAt).slice(0, 10))}` : '')),
        h('div', { class: 'phase-bar mt' }, plan.weeks.map((w) => h('i', { style: { flexGrow: '1', background: `var(--${w.phase})`, opacity: w.deload ? 0.5 : 1 }, title: `Week ${w.index + 1}: ${P[w.phase]?.label || w.phase}` }))))
        : h('div', { class: 'me-plan' }, h('p', { class: 'muted small' }, 'No plan yet.')),
      h('div', { class: 'list' },
        row('Race & division', `${raceTxt} · ${div}`, () => openEditor('Your race', raceEditor, [validate.race]), 'flag'),
        row('Training days', `${p.daysPerWeek} days / week`, () => openEditor('Training days', daysEditor, [validate.days]), 'calendar'),
        h('button', { type: 'button', class: 'li me-row', on: { click: async () => {
          const ok = await confirmDialog('Rebuild your plan from today using your current profile, bells and race date? Your logged sessions, PRs and food log are kept.' + (s.activeWorkout ? ' The workout in progress will keep running.' : ''), { ok: 'Regenerate' });
          if (ok) regenerate();
        } } }, h('span', { class: 'badge' }, icon('repeat', 18)), h('span', { class: 'li-main' }, h('div', { class: 'li-title accent' }, 'Regenerate plan'), h('div', { class: 'li-sub' }, 'Keeps your history')), icon('chevR', 18)))));
}

function settingsSection(s) {
  const st = s.settings;
  const setS = (k, v) => store.update((x) => { x.settings[k] = v; });
  return h('section', null, sectionHead('Settings'),
    h('div', { class: 'card stack' },
      h('div', { class: 'stack sm' }, h('span', { class: 'field-label' }, 'Units'),
        seg([['imperial', 'Imperial'], ['metric', 'Metric']], s.profile.units, (v) => store.update((x) => { x.profile.units = v; }), { label: 'Units' })),
      h('div', { class: 'stack sm' }, h('span', { class: 'field-label' }, 'Theme'),
        seg([['dark', 'Dark'], ['light', 'Light'], ['system', 'System']], st.theme, (v) => setS('theme', v), { label: 'Theme' })),
      h('div', { class: 'list' },
        toggleRow('Sound', 'Beeps for intervals and rest', !!st.sound, (v) => setS('sound', v)),
        toggleRow('Voice cues', 'Spoken exercise names and countdowns', !!st.voice, (v) => setS('voice', v)),
        toggleRow('Haptics', 'Vibration on taps and timers (where supported)', !!st.haptics, (v) => setS('haptics', v)))));
}

function storageBytes() {
  let n = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('forge')) n += (k.length + (localStorage.getItem(k) || '').length) * 2;
    }
  } catch { n = store.exportJSON().length * 2; }
  return n;
}
const fmtBytes = (b) => (b > 1048576 ? `${num(b / 1048576, 1)} MB` : `${num(b / 1024, 0)} KB`);

function exportData() {
  const blob = new Blob([store.exportJSON()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: `forge-backup-${todayISO()}.json` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('Backup downloaded', { kind: 'go' });
}

function importData() {
  const inp = h('input', { type: 'file', accept: 'application/json,.json', class: 'sr-only', 'aria-hidden': 'true' });
  inp.addEventListener('change', async () => {
    const f = inp.files?.[0];
    inp.remove();
    if (!f) return;
    try {
      const txt = await f.text();
      JSON.parse(txt); // validate before asking
      const ok = await confirmDialog(`Replace everything on this device with “${f.name}”? Export a backup first if unsure.`, { ok: 'Import', danger: true });
      if (!ok) return;
      store.importJSON(txt);
      toast('Backup imported', { kind: 'go' });
      navigate(store.get().profile.onboarded ? '#/today' : '#/onboarding');
    } catch (e) {
      toast('Import failed: ' + (e instanceof SyntaxError ? 'that file isn’t valid JSON.' : e.message || e), { kind: 'danger', ms: 5000 });
    }
  });
  document.body.append(inp);
  inp.click();
}

function dataSection(s) {
  const sz = storageBytes();
  const pct = Math.min(100, (sz / (5 * 1048576)) * 100);
  return h('section', null, sectionHead('Your data'),
    h('div', { class: 'card stack' },
      h('div', { class: 'row between small' }, h('span', null, 'Stored on this device'), h('span', { class: 'num muted' }, `${fmtBytes(sz)} of ~5 MB`)),
      h('div', { class: 'bar thin' }, h('i', { style: { width: `${Math.max(1, pct)}%` } })),
      h('p', { class: 'xs muted' }, `${s.sessions.length} sessions · ${Object.keys(s.foodLog).length} food days · ${s.bodyweight.length} weigh-ins. Nothing leaves your device unless you export it.`),
      h('div', { class: 'grid2' },
        h('button', { type: 'button', class: 'btn subtle', on: { click: exportData } }, icon('download', 18), 'Export'),
        h('button', { type: 'button', class: 'btn subtle', on: { click: importData } }, icon('upload', 18), 'Import')),
      h('button', { type: 'button', class: 'btn ghost danger-text', on: { click: async () => {
        const ok = await confirmDialog('Erase ALL FORGE data on this device — profile, plan, sessions, food log and settings? This cannot be undone.', { ok: 'Erase everything', danger: true });
        if (!ok) return;
        store.reset();
        toast('All data erased');
        navigate('#/onboarding');
      } } }, icon('trash', 18), 'Reset all data')));
}

function openInstallSheet() {
  sheet({
    title: 'Install FORGE',
    content: h('div', { class: 'stack' },
      h('p', { class: 'small dim' }, 'Add FORGE to your home screen for a full-screen app that works offline.'),
      h('div', { class: 'card tight' }, h('h3', null, 'iPhone / iPad (Safari)'),
        h('ol', { class: 'install-steps' }, h('li', null, 'Tap the Share button (square with an arrow).'), h('li', null, 'Scroll and tap “Add to Home Screen”.'), h('li', null, 'Tap Add. Open FORGE from the new icon.'))),
      h('div', { class: 'card tight' }, h('h3', null, 'Android (Chrome)'),
        h('ol', { class: 'install-steps' }, h('li', null, 'Tap the ⋮ menu.'), h('li', null, 'Tap “Install app” or “Add to Home screen”.'))),
      h('div', { class: 'card tight' }, h('h3', null, 'Desktop (Chrome / Edge)'),
        h('p', { class: 'small dim' }, 'Click the install icon at the right of the address bar.'))),
  });
}

function aboutSection() {
  return h('section', null, sectionHead('About'),
    h('div', { class: 'card flush' }, h('div', { class: 'list' },
      row('Install as app', 'iOS: Share → Add to Home Screen', openInstallSheet, 'download'),
      h('div', { class: 'li' }, h('span', { class: 'badge' }, icon('info', 18)),
        h('span', { class: 'li-main' }, h('div', { class: 'li-title' }, `FORGE ${VERSION}`), h('div', { class: 'li-sub' }, 'Kettlebell · Engine · HYROX · Fuel. Local-first, offline-ready.'))))),
    h('p', { class: 'xs muted center mt' }, 'Not medical advice. Listen to your body; consult a professional before starting a new program.'));
}

export function render(root) {
  const paint = () => {
    const s = store.get();
    const p = s.profile;
    const y = window.scrollY;
    const initial = (p.name || 'F').trim()[0]?.toUpperCase() || 'F';
    clear(root).append(h('div', { class: 'me stack' },
      h('header', { class: 'me-head' },
        h('div', { class: 'avatar', 'aria-hidden': 'true' }, initial),
        h('div', { class: 'grow' },
          h('h1', null, p.name || 'Athlete'),
          h('div', { class: 'row wrap mt-xs' },
            h('span', { class: 'pill accent' }, `HYROX ${cap(p.division)}`),
            h('span', { class: 'pill' }, EXPERIENCE.find((e) => e.value === p.experience)?.label || cap(p.experience)),
            h('span', { class: 'pill' }, `${p.daysPerWeek}×/wk`)))),
      profileSection(p),
      equipmentSection(p),
      targetsSection(s, paint),
      planSection(s),
      settingsSection(s),
      dataSection(s),
      aboutSection()));
    window.scrollTo(0, y);
  };
  paint();
  return store.subscribe(() => paint());
}
