// FORGE Me — profile, equipment, targets, plan, settings, data (docs/PROMPT.md §3.6).
import { store, todayISO, daysBetween } from '../store.js';
import { h, clear, icon, seg, sheet, toast, confirmDialog, navigate, num, fmtDur, fmtDate, fmtWeight,
  toDisplayWeight, fromDisplayWeight, field, sectionHead, masthead } from '../ui.js';
import { ribbon } from '../charts.js';
import * as program from '../engine/program.js';
import * as hyrox from '../engine/hyrox.js';
import { validLock } from '../lock.js';
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
      } } }, 'Save')),
  });
}

async function applyProfile(next, before) {
  const s = store.get();
  // keep a default HRmax in sync with age unless the user customised it
  const oldDefault = safe(() => Math.round(hyrox.defaultHrMax(before.age)));
  if (!next.hrMax || Math.round(next.hrMax) === oldDefault) next.hrMax = safe(() => hyrox.defaultHrMax(next.age), next.hrMax);
  store.update((st) => {
    st.profile = { ...st.profile, ...next, onboarded: true };
    if (Number.isFinite(next.weightKg) && next.weightKg !== before.weightKg) {
      const d = todayISO();
      st.bodyweight = st.bodyweight.filter((b) => b.date !== d).concat({ date: d, kg: next.weightKg }).sort((a, b) => a.date.localeCompare(b.date));
    }
    if (st.targets.auto) {
      const t = safe(() => computeAutoTargets(st.profile, st.plan));
      if (t) st.targets = { ...st.targets, ...t, auto: true };
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
    store.update((st) => {
      st.plan = plan;
      if (st.targets.auto) { const t = safe(() => computeAutoTargets(st.profile, plan)); if (t) st.targets = { ...st.targets, ...t, auto: true }; }
    });
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
    h('span', { class: 'li-main' }, h('div', { class: 'li-title' }, label), value ? h('div', { class: 'li-sub' }, value) : null),
    icon('chevR', 18));
}

function toggleRow(label, sub, checked, onChange) {
  const id = 'tg-' + label.toLowerCase().replace(/\W+/g, '-');
  return h('div', { class: 'switch li' },
    h('label', { for: id, class: 'li-main' }, h('div', { class: 'li-title' }, label), sub ? h('div', { class: 'li-sub' }, sub) : null),
    h('span', { class: 'toggle' }, h('input', { type: 'checkbox', id, role: 'switch', checked, on: { change: (e) => onChange(e.target.checked) } }), h('span', { 'aria-hidden': 'true' })));
}

function profileSection(p, s) {
  const bw = [...(s?.bodyweight || [])].sort((a, b) => a.date.localeCompare(b.date)).at(-1);
  const units = p.units;
  const exp = EXPERIENCE.find((e) => e.value === p.experience)?.label || cap(p.experience);
  return h('section', null, sectionHead('Profile', null, 1),
    h('div', { class: 'card flush' }, h('div', { class: 'list' },
      row('Name', String(p.name ?? '') || '—', () => openEditor('Name', nameEditor, [validate.name]), 'user'),
      row('Sex & age', `${p.sex === 'f' ? 'Female' : 'Male'} · ${p.age} yrs`, () => openEditor('Sex & age', sexAgeEditor, [validate.sexAge]), 'heart'),
      row('Height & weight', `${fmtHeight(p.heightCm, units)} · ${fmtWeight(bw?.kg ?? p.weightKg, units, 1)}${bw ? ` · weighed ${fmtDate(bw.date, { month: 'short', day: 'numeric' })}` : ''}`, () => openEditor('Height & weight', bodyEditor, [validate.body]), 'scale'),
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
  return h('section', null, sectionHead('Equipment', null, 2),
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
      : h('p', { class: 'xs go' }, `✓ Macros match calories (4·P + 4·C + 9·F = ${num(macroKcal)} kcal).`)) : null;
  return h('section', null, sectionHead('Nutrition targets', null, 3),
    h('div', { class: 'card' },
      h('div', { class: 'target-strip' },
        [['kcal', t.kcal, '', 'var(--text-2)'], ['Protein', t.protein, 'g', 'var(--protein)'], ['Carbs', t.carbs, 'g', 'var(--carbs)'], ['Fat', t.fat, 'g', 'var(--fat)'], ['Water', t.waterMl / 1000, 'L', 'var(--water)']]
          .map(([k, v, u, c]) => h('div', { class: 'stat' }, h('span', { class: 'v' }, num(v, u === 'L' ? 1 : 0), h('small', null, u)), h('span', { class: 'k' }, h('i', { class: 'swatch', style: { background: c } }), k)))),
      h('div', { class: 'list mt' },
        toggleRow('Automatic targets', t.auto ? 'Computed from your profile, goal and weight' : 'Manual — edit below', !!t.auto, (on) => {
          store.update((st) => {
            if (on) { const c = safe(() => computeAutoTargets(st.profile, st.plan)); st.targets = { ...st.targets, ...(c || {}), auto: true }; } else st.targets.auto = false;
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
  return h('section', null, sectionHead('Plan', null, 4),
    h('div', { class: 'card flush' },
      plan ? h('div', { class: 'me-plan' },
        h('div', { class: 'row between' },
          h('div', null, h('div', { class: 'eyebrow' }, 'Current plan'), h('div', { class: 'card-title' }, h('span', { class: 'fig me-weeks' }, String(plan.weeks.length)), ' weeks')),
          h('div', { class: 'right xs muted' }, `Started ${fmtDate(plan.startDate || plan.weeks[0]?.days[0]?.date)}`, h('br'), plan.generatedAt ? `Built ${fmtDate(String(plan.generatedAt).slice(0, 10))}` : '')),
        h('div', { class: 'mt' }, safe(() => ribbon({ weeks: plan.weeks, current: Math.max(-1, Math.min(plan.weeks.length, Math.floor(daysBetween(plan.weeks[0]?.days[0]?.date || todayISO(), todayISO()) / 7))), ariaLabel: `${plan.weeks.length}-week plan` }), null)))
        : h('div', { class: 'me-plan' }, h('p', { class: 'muted small' }, 'No plan yet.')),
      h('div', { class: 'list' },
        row('Race & division', `${raceTxt} · ${div}`, () => openEditor('Your race', raceEditor, [validate.race]), 'flag'),
        row('Training days', `${p.daysPerWeek} days / week`, () => openEditor('Training days', daysEditor, [validate.days]), 'calendar'),
        h('button', { type: 'button', class: 'li me-row', on: { click: async () => {
          const ok = await confirmDialog('Rebuild your plan from today using your current profile, bells and race date? Your logged sessions, PRs and food log are kept.' + (s.activeWorkout ? ' The workout in progress will keep running.' : ''), { ok: 'Regenerate' });
          if (ok) regenerate();
        } } }, h('span', { class: 'li-main' }, h('div', { class: 'li-title' }, 'Regenerate plan'), h('div', { class: 'li-sub' }, 'Keeps your history')), icon('chevR', 18)))));
}

function settingsSection(s) {
  const st = s.settings;
  const setS = (k, v) => store.update((x) => { x.settings[k] = v; });
  return h('section', null, sectionHead('Settings', null, 5),
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

// ---------- Backup & sync ----------
let syncMod = null; // js/sync.js, loaded lazily so Me still works if it fails
export async function loadSync() {
  if (syncMod) return syncMod;
  try { syncMod = await import('../sync.js'); } catch (e) { console.warn('FORGE: sync unavailable', e); syncMod = null; }
  return syncMod;
}

const fmtBytes = (b) => (!Number.isFinite(+b) ? '–' : b > 1048576 ? `${num(b / 1048576, 1)} MB` : `${num(Math.max(1, b / 1024), 0)} KB`);
export function ago(ts) {
  if (!ts) return 'never';
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return 'never';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

/** Passphrase strength: {score 0..4, label, hint}. */
export function passStrength(p) {
  p = p || '';
  if (p.length < 10) return { score: 0, label: 'Too short', hint: `${10 - p.length} more character${10 - p.length === 1 ? '' : 's'} needed` };
  let sc = 1;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length;
  if (p.length >= 14) sc++;
  if (p.length >= 20 || p.trim().split(/\s+/).length >= 4) sc++;
  if (classes >= 3) sc++;
  if (/^(.)\1+$/.test(p) || /^(?:password|forge|1234|qwerty)/i.test(p)) sc = 1;
  sc = Math.min(4, sc);
  return { score: sc, label: ['Too short', 'Weak', 'Fair', 'Good', 'Strong'][sc], hint: sc < 3 ? 'Tip: four random words are long and easy to remember.' : 'Nice — hard to guess.' };
}

function markBackup() { store.update((st) => { st.settings.lastBackupAt = new Date().toISOString(); }); }

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function exportPlain() {
  download(new Blob([store.exportJSON()], { type: 'application/json' }), `forge-backup-${todayISO()}.json`);
  markBackup();
  toast('Unencrypted backup downloaded', { kind: 'go' });
}

/** Sheet asking for a passphrase. confirm → second field + strength meter + warning. Resolves string|null. */
function askPassphrase({ title, intro, confirm = false, ok = 'Continue', warning }) {
  return new Promise((resolve) => {
    let done = false;
    sheet({
      title,
      onClose: () => { if (!done) resolve(null); },
      content: ({ close }) => {
        const p1 = h('input', { type: 'password', autocomplete: confirm ? 'new-password' : 'current-password', 'aria-label': 'Passphrase', placeholder: 'Passphrase' });
        const p2 = confirm ? h('input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'Confirm passphrase', placeholder: 'Type it again' }) : null;
        const meter = h('div', { class: 'pw-meter', 'aria-hidden': 'true' }, [0, 1, 2, 3].map(() => h('i')));
        const meterTxt = h('div', { class: 'xs muted', 'aria-live': 'polite' });
        const err = h('div', { class: 'small danger-text', role: 'alert' });
        const ack = confirm ? h('input', { type: 'checkbox', id: 'pw-ack' }) : null;
        const upd = () => {
          if (!confirm) return;
          const st = passStrength(p1.value);
          meter.dataset.score = String(st.score);
          meterTxt.textContent = p1.value ? `${st.label} · ${st.hint}` : 'At least 10 characters.';
        };
        p1.addEventListener('input', upd); upd();
        const submit = () => {
          const v = p1.value;
          if (confirm) {
            if (v.length < 10) { err.textContent = 'Use at least 10 characters.'; return; }
            if (v !== p2.value) { err.textContent = 'The two passphrases don’t match.'; return; }
            if (!ack.checked) { err.textContent = 'Please tick the box to confirm you’ve saved it.'; return; }
          } else if (!v) { err.textContent = 'Enter the passphrase.'; return; }
          done = true; resolve(v); close();
        };
        for (const el of [p1, p2].filter(Boolean)) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
        return h('div', { class: 'stack' },
          intro ? h('p', { class: 'small dim' }, intro) : null,
          field('Passphrase', p1),
          confirm ? h('div', { class: 'stack sm' }, meter, meterTxt) : null,
          confirm ? field('Confirm passphrase', p2) : null,
          warning ? h('div', { class: 'callout' }, h('strong', null, 'Write it down. '), warning) : null,
          confirm ? h('label', { class: 'row pw-ack', for: 'pw-ack' }, ack, h('span', { class: 'small' }, 'I’ve saved this passphrase somewhere safe. I understand it can’t be recovered.')) : null,
          err,
          h('button', { type: 'button', class: 'btn primary block', on: { click: submit } }, ok));
      },
    });
  });
}

async function exportEncrypted() {
  const sy = await loadSync();
  if (!sy?.exportEncrypted) { toast('Encrypted export isn’t available right now', { kind: 'danger' }); return; }
  const pass = await askPassphrase({ title: 'Encrypted export', confirm: true, ok: 'Encrypt & download',
    intro: 'Your backup file is encrypted on this device with AES-GCM. You’ll need the passphrase to import it.',
    warning: 'Without this passphrase the file can’t be opened — by you or anyone else.' });
  if (pass == null) return;
  try {
    const blob = await sy.exportEncrypted(pass);
    download(blob, `forge-backup-${todayISO()}.forge`);
    markBackup();
    toast('Encrypted backup downloaded', { kind: 'go' });
  } catch (e) { toast('Export failed: ' + (e.message || e), { kind: 'danger', ms: 5000 }); }
}

/** One Import button: plain FORGE JSON or an encrypted backup (asks for the passphrase). */
function importData() {
  const inp = h('input', { type: 'file', accept: '.json,.forge,application/json,text/plain', class: 'sr-only', 'aria-hidden': 'true' });
  inp.addEventListener('change', async () => {
    const f = inp.files?.[0];
    inp.remove();
    if (!f) return;
    let txt;
    try { txt = await f.text(); } catch { toast('Could not read that file', { kind: 'danger' }); return; }
    let parsed = null;
    try { parsed = JSON.parse(txt); } catch {}
    const plain = parsed && typeof parsed === 'object' && parsed.profile && typeof parsed.profile === 'object';
    const ok = await confirmDialog(`Replace everything on this device with “${f.name}”? Export a backup first if unsure.`, { ok: 'Import', danger: true });
    if (!ok) return;
    try {
      if (plain) store.importJSON(txt);
      else {
        const sy = await loadSync();
        if (!sy?.importEncrypted) throw new Error('that file isn’t a FORGE backup.');
        const pass = await askPassphrase({ title: 'Encrypted backup', intro: 'Enter the passphrase used when this backup was exported.', ok: 'Decrypt & import' });
        if (pass == null) return;
        try { await sy.importEncrypted(txt, pass); }
        catch (e) { throw new Error(/pass|decrypt|operation/i.test(String(e?.message || e?.name)) ? 'wrong passphrase, or the file is damaged.' : e.message || String(e)); }
      }
      toast('Backup imported', { kind: 'go' });
      navigate(store.get().profile.onboarded ? '#/today' : '#/onboarding');
    } catch (e) {
      toast('Import failed: ' + (e.message || e), { kind: 'danger', ms: 5000 });
    }
  });
  document.body.append(inp);
  inp.click();
}

async function enableCloud(sy) {
  const pass = await askPassphrase({ title: 'Encrypted cloud backup', confirm: true, ok: 'Turn on backup',
    intro: 'FORGE encrypts your data on this device before it’s uploaded. The server only ever stores ciphertext. Use the same passphrase on another device to restore.',
    warning: 'Nobody — not even the server owner — can reset or recover this passphrase. Lose it and the cloud copy is unreadable.' });
  if (pass == null) return;
  toast('Encrypting and syncing…', { ms: 8000 });
  try {
    const r = await sy.enableSync(pass);
    toast(r?.restored ? 'Backup found and merged into this device' : 'Encrypted backup is on', { kind: 'go' });
  } catch (e) { toast('Couldn’t turn on backup: ' + (e.message || e), { kind: 'danger', ms: 6000 }); }
}

function backupCard(host, sy, pers) {
  const s = store.get();
  const st = sy ? safe(() => sy.syncStatus(), null) : null;
  const usage = pers?.usage ?? store.exportJSON().length * 2;
  const persisted = pers?.persisted;
  const stor = h('div', { class: 'list' },
    h('div', { class: 'li' }, h('span', { class: 'li-main' },
        h('div', { class: 'li-title' }, persisted ? 'Protected storage' : 'Standard storage'),
        h('div', { class: 'li-sub wrap' }, `${fmtBytes(usage)} used${pers?.quota ? ` of ${fmtBytes(pers.quota)}` : ''} · ${persisted ? 'browser won’t auto-clear it' : 'browser may clear it if space runs low'}`)),
      persisted ? h('span', { class: 'pill go' }, 'On')
        : h('button', { type: 'button', class: 'btn sm subtle', disabled: !sy?.requestPersistence, on: { click: async () => {
          const ok = await sy.requestPersistence().catch(() => false);
          toast(ok ? 'Storage protected on this device' : 'The browser declined. Installing FORGE to your home screen usually helps.', { kind: ok ? 'go' : undefined, ms: 4500 });
          paintBackup(host);
        } } }, 'Protect my data')));

  let cloud;
  if (!sy || !st) {
    cloud = h('div', { class: 'li' }, h('span', { class: 'li-main' }, h('div', { class: 'li-title' }, 'Encrypted cloud backup'), h('div', { class: 'li-sub' }, 'Unavailable in this build')));
  } else if (!st.enabled) {
    cloud = h('div', { class: 'li li-col' },
      h('div', { class: 'row gap' }, h('span', { class: 'li-main' }, h('div', { class: 'li-title' }, 'Encrypted cloud backup'),
          h('div', { class: 'li-sub wrap' }, st.serverAvailable === false ? 'Server not reachable right now — FORGE works offline; backup needs the FORGE server.' : 'Off · encrypted on this device with your passphrase'))),
      h('button', { type: 'button', class: 'btn primary block', disabled: st.serverAvailable === false, on: { click: () => enableCloud(sy) } }, 'Turn on encrypted backup'));
  } else {
    const line = st.lastError ? `Last attempt failed: ${st.lastError}` : st.pending ? `Changes waiting · last synced ${ago(st.lastSyncAt)}` : `Last synced ${ago(st.lastSyncAt)}`;
    cloud = h('div', { class: 'li li-col' },
      h('div', { class: 'row gap' }, h('span', { class: 'li-main' }, h('div', { class: 'li-title' }, 'Encrypted cloud backup', h('span', { class: 'pill go sync-pill' }, 'On')),
          h('div', { class: 'li-sub wrap' + (st.lastError ? ' danger-text' : '') }, line))),
      h('div', { class: 'grid2' },
        h('button', { type: 'button', class: 'btn subtle', on: { click: async (e) => {
          const b = e.currentTarget; b.disabled = true;
          try { await sy.syncNow(); toast('Synced', { kind: 'go', ms: 1500 }); } catch (err) { toast('Sync failed: ' + (err.message || err), { kind: 'danger', ms: 5000 }); }
          b.disabled = false;
        } } }, 'Sync now'),
        h('button', { type: 'button', class: 'btn ghost', on: { click: async () => {
          const ok = await confirmDialog('Stop backing up this device? Your data stays here, and the encrypted copy on the server is kept so you can turn backup on again with the same passphrase.', { ok: 'Turn off' });
          if (!ok) return;
          try { await sy.disableSync(); toast('Cloud backup off'); } catch (err) { toast(String(err.message || err), { kind: 'danger' }); }
        } } }, 'Turn off')),
      sy.forgetDevice ? h('button', { type: 'button', class: 'link-btn small', on: { click: async () => {
        const ok = await confirmDialog('Forget this device? Sync stops and the encryption key is removed from this device. Your local data stays; the server copy is untouched.', { ok: 'Forget device' });
        if (!ok) return;
        try { await sy.forgetDevice(); toast('Device forgotten'); } catch (err) { toast(String(err.message || err), { kind: 'danger' }); }
      } } }, 'Forget this device') : null);
  }

  const files = h('div', { class: 'stack sm me-files' },
    h('div', { class: 'grid2' },
      h('button', { type: 'button', class: 'btn subtle', disabled: !sy?.exportEncrypted, on: { click: exportEncrypted } }, 'Encrypted export'),
      h('button', { type: 'button', class: 'btn subtle', on: { click: importData } }, 'Import file')),
    h('button', { type: 'button', class: 'btn ghost sm', on: { click: exportPlain } }, 'Export unencrypted JSON'),
    h('p', { class: 'xs muted' }, `Last file backup: ${ago(s.settings.lastBackupAt)}. Unencrypted files are readable by anyone who gets them. ${s.sessions.length} sessions · ${Object.keys(s.foodLog).length} food days · ${s.bodyweight.length} weigh-ins.`));

  clear(host).append(h('div', { class: 'card flush' }, stor, h('div', { class: 'list' }, cloud), files));
}

async function paintBackup(host) {
  const sy = await loadSync();
  const pers = sy?.persistenceStatus ? await sy.persistenceStatus().catch(() => null) : null;
  backupCard(host, sy, pers);
}

function backupSection() {
  const host = h('div', { id: 'backup' }, h('div', { class: 'card' }, h('div', { class: 'skeleton', style: { height: '120px' } })));
  paintBackup(host);
  return h('section', { id: 'backup-section' }, sectionHead('Backup & sync', null, 7), host);
}

function lockSection(s) {
  const l = s.settings.lock || {};
  const on = validLock(l);
  return h('section', null, sectionHead('App lock', null, 6),
    h('div', { class: 'card flush' }, h('div', { class: 'list' },
      toggleRow('Passcode lock', on ? `${l.digits || 4}-digit passcode · locks after ${l.timeoutMin === 0 ? 'leaving the app' : `${l.timeoutMin ?? 5} min away`}` : 'Ask for a 4–6 digit code when FORGE opens',
        on, async (want) => { const m = await import('../lock.js'); if (want) await m.setupFlow(); else await m.disableFlow(); paintAll(); }),
      on ? row('Change passcode', null, async () => { const m = await import('../lock.js'); await m.setupFlow(); }, 'edit') : null,
      on ? h('div', { class: 'li li-col' }, h('div', { class: 'li-title' }, 'Lock after'),
        seg([[0, 'Immediately'], [1, '1 min'], [5, '5 min'], [15, '15 min']], l.timeoutMin ?? 5, async (v) => { const m = await import('../lock.js'); m.setLockTimeout(v); }, { label: 'Lock after' })) : null),
      h('p', { class: 'xs muted me-note' }, 'A privacy lock for this device: it keeps casual eyes out. It doesn’t encrypt the data stored in this browser — use an encrypted backup for that. A forgotten passcode can only be cleared by erasing this device.')));
}
let paintAll = () => {};

function dangerSection() {
  return h('section', null, sectionHead('Danger zone', null, 8),
    h('div', { class: 'card' },
      h('button', { type: 'button', class: 'btn ghost danger-text block', on: { click: async () => {
        const ok = await confirmDialog('Erase ALL FORGE data on this device — profile, plan, sessions, food log and settings? This cannot be undone. Cloud backups (if on) are not deleted.', { ok: 'Erase everything', danger: true });
        if (!ok) return;
        store.reset();
        toast('All data erased');
        navigate('#/onboarding');
      } } }, 'Reset all data')));
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
  return h('section', null, sectionHead('About', null, 9),
    h('div', { class: 'card flush' }, h('div', { class: 'list' },
      row('Install as app', 'iOS: Share → Add to Home Screen', openInstallSheet, 'download'),
      h('div', { class: 'li' }, h('span', { class: 'li-main' }, h('div', { class: 'li-title' }, `FORGE ${VERSION}`), h('div', { class: 'li-sub' }, 'Kettlebell · Engine · HYROX · Fuel. Local-first, offline-ready.'))))),
    h('p', { class: 'xs muted center mt' }, 'Not medical advice. Listen to your body; consult a professional before starting a new program.'));
}

export function render(root, params = {}) {
  let unsubSync = null;
  let first = true;
  const paint = () => {
    const s = store.get();
    const p = s.profile;
    const y = window.scrollY;
    const pname = String(p.name ?? '').trim();
    const initial = pname[0]?.toUpperCase() || 'F';
    clear(root).append(h('div', { class: 'me' },
      masthead(fmtDate(todayISO(), { weekday: 'short', day: 'numeric', month: 'short' })),
      h('header', { class: 'me-head' },
        h('div', { class: 'avatar', 'aria-hidden': 'true' }, initial),
        h('div', { class: 'grow' },
          h('h1', null, pname || 'Athlete'),
          h('p', { class: 'data me-meta' }, [p.sex === 'f' ? 'F' : 'M', p.age, fmtHeight(p.heightCm, p.units), fmtWeight(([...(s.bodyweight || [])].sort((a, b) => a.date.localeCompare(b.date)).at(-1)?.kg) ?? p.weightKg, p.units, 1)].filter((x) => x != null && x !== '').join(' · ')),
          h('p', { class: 'data' }, `HYROX ${cap(p.division)} · ${EXPERIENCE.find((e) => e.value === p.experience)?.label || cap(p.experience)} · ${p.daysPerWeek}×/wk`))),
      profileSection(p, s),
      equipmentSection(p),
      targetsSection(s, paint),
      planSection(s),
      settingsSection(s),
      lockSection(s),
      backupSection(),
      dangerSection(),
      aboutSection()));
    if (first && params.query?.section === 'backup') {
      first = false;
      requestAnimationFrame(() => root.querySelector('#backup-section')?.scrollIntoView({ block: 'start' }));
    } else window.scrollTo(0, y);
    first = false;
  };
  paintAll = paint;
  paint();
  const unsub = store.subscribe(() => paint());
  loadSync().then((sy) => {
    if (!sy?.subscribeSync || !root.isConnected) return;
    unsubSync = sy.subscribeSync(() => { const host = root.querySelector('#backup'); if (host) paintBackup(host); });
  });
  return () => { unsub(); unsubSync?.(); paintAll = () => {}; };
}
