// FORGE app lock — optional 4–6 digit passcode. A privacy lock for this device: it hides the app
// from casual eyes; it does NOT encrypt local data (use encrypted backup for that).
// Stored in state.settings.lock = { enabled, hash, salt, iterations, timeoutMin, digits }.
import { store } from './store.js';
import { h, clear, icon, haptic, sheet, confirmDialog, toast } from './ui.js';

const ITERATIONS = 150000;
const ATTEMPT_KEY = 'forge:lock-attempts';
const HIDDEN_KEY = 'forge:lock-hidden-at';
const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const lockSettings = () => store.get().settings.lock || { enabled: false };
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** A lock config is only honoured when it is well-formed; garbage is treated as "no lock" (never a dead keypad). */
export function validLock(l) {
  if (!l || typeof l !== 'object' || l.enabled !== true) return false;
  if (typeof l.hash !== 'string' || l.hash.length !== 44 || !B64.test(l.hash)) return false;
  if (typeof l.salt !== 'string' || l.salt.length < 16 || l.salt.length > 64 || !B64.test(l.salt)) return false;
  const it = l.iterations ?? ITERATIONS;
  if (!Number.isInteger(it) || it < 10000 || it > 5000000) return false;
  if (l.digits != null && ![4, 5, 6].includes(l.digits)) return false;
  return true;
}
export const isLockEnabled = () => validLock(lockSettings());
const timeoutMin = () => { const v = +lockSettings().timeoutMin; return Number.isFinite(v) && v >= 0 ? v : 5; };
export const validCode = (c) => /^\d{4,6}$/.test(String(c || ''));

async function derive(code, saltB64, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(code)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(saltB64), iterations }, key, 256);
  return b64(bits);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function verifyPasscode(code) {
  const l = lockSettings();
  if (!validLock(l) || !validCode(code)) return false;
  const got = await derive(code, l.salt, l.iterations || ITERATIONS);
  return timingSafeEqual(got, l.hash);
}

/** Enable (or change) the passcode. Caller must have verified the current code if one exists. */
export async function setPasscode(code, { timeoutMin } = {}) {
  if (!validCode(code)) throw new Error('Passcode must be 4–6 digits');
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await derive(code, salt, ITERATIONS);
  store.update((s) => {
    const prev = s.settings.lock || {};
    s.settings.lock = { enabled: true, hash, salt, iterations: ITERATIONS, digits: String(code).length,
      timeoutMin: Number.isFinite(timeoutMin) ? timeoutMin : Number.isFinite(prev.timeoutMin) ? prev.timeoutMin : 5 };
  });
  resetAttempts();
}

export function setLockTimeout(min) {
  store.update((s) => { s.settings.lock = { ...(s.settings.lock || {}), timeoutMin: min }; });
}

export function disableLock() {
  store.update((s) => { s.settings.lock = { enabled: false, timeoutMin: s.settings.lock?.timeoutMin ?? 5 }; });
  resetAttempts();
}

// ---------- attempt throttling (persisted so reload doesn't bypass it) ----------
function readAttempts() {
  try { const v = JSON.parse(localStorage.getItem(ATTEMPT_KEY) || '{}'); return { fails: +v.fails || 0, until: +v.until || 0, rounds: +v.rounds || 0 }; }
  catch { return { fails: 0, until: 0, rounds: 0 }; }
}
function writeAttempts(a) { try { localStorage.setItem(ATTEMPT_KEY, JSON.stringify(a)); } catch {} }
function resetAttempts() { try { localStorage.removeItem(ATTEMPT_KEY); } catch {} }
/** 5 wrong tries → 30 s, then 60 s, 2 min … capped at 15 min. */
export const cooldownMs = (rounds) => Math.min(15 * 60, 30 * 2 ** Math.max(0, rounds - 1)) * 1000;

// ---------- keypad (shared by overlay + settings sheets) ----------
function keypad({ digits, onDone, getDisabled = () => false }) {
  let code = '';
  const dots = h('div', { class: 'lk-dots', 'aria-hidden': 'true' });
  const live = h('div', { class: 'sr-only', 'aria-live': 'polite' });
  const paintDots = () => {
    clear(dots);
    const n = digits || Math.max(4, code.length);
    for (let i = 0; i < n; i++) dots.append(h('i', { class: i < code.length ? 'on' : '' }));
    live.textContent = `${code.length} digit${code.length === 1 ? '' : 's'} entered`;
  };
  const submit = () => { if (code.length >= 4) { const c = code; code = ''; paintDots(); onDone(c); } };
  const press = (k) => {
    if (getDisabled()) return;
    haptic(8);
    if (k === 'del') code = code.slice(0, -1);
    else if (k === 'ok') return submit();
    else if (code.length < 6) code += k;
    paintDots();
    if (digits && code.length === digits) setTimeout(submit, 90);
  };
  paintDots();
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', digits ? '' : 'ok', '0', 'del'];
  const pad = h('div', { class: 'lk-pad' }, keys.map((k) => (k === ''
    ? h('span')
    : h('button', { type: 'button', class: 'lk-key' + (k === 'del' || k === 'ok' ? ' fn' : ''), 'aria-label': k === 'del' ? 'Delete' : k === 'ok' ? 'Enter' : k,
      on: { click: () => press(k) } }, k === 'del' ? icon('chevL', 22) : k === 'ok' ? icon('check', 22) : k))));
  const onKey = (e) => {
    if (/^\d$/.test(e.key)) { press(e.key); e.preventDefault(); }
    else if (e.key === 'Backspace') { press('del'); e.preventDefault(); }
    else if (e.key === 'Enter') { press('ok'); e.preventDefault(); }
  };
  return { el: h('div', { class: 'lk-keypad' }, dots, live, pad), onKey, shake: () => { dots.classList.remove('shake'); void dots.offsetWidth; dots.classList.add('shake'); } };
}

// ---------- lock overlay ----------
let overlay = null;

export function lockNow() {
  if (!isLockEnabled() || overlay) return;
  const l = lockSettings();
  document.body.classList.add('locked');
  const msg = h('p', { class: 'lk-msg', role: 'status' }, 'Enter your passcode');
  let busy = false, timer = null;
  const cooling = () => readAttempts().until > Date.now();
  const tickCooldown = () => {
    clearInterval(timer);
    const run = () => {
      const left = Math.ceil((readAttempts().until - Date.now()) / 1000);
      if (left > 0) { msg.textContent = `Too many tries. Try again in ${left} s`; msg.classList.add('err'); }
      else { clearInterval(timer); msg.textContent = 'Enter your passcode'; msg.classList.remove('err'); }
    };
    run(); timer = setInterval(run, 500);
  };
  const kp = keypad({
    digits: l.digits,
    getDisabled: () => busy || cooling(),
    onDone: async (code) => {
      busy = true;
      const ok = await verifyPasscode(code).catch(() => false);
      busy = false;
      if (ok) { resetAttempts(); unlock(); return; }
      haptic(60); kp.shake();
      const a = readAttempts();
      a.fails++;
      if (a.fails >= 5) { a.rounds++; a.fails = 0; a.until = Date.now() + cooldownMs(a.rounds); writeAttempts(a); tickCooldown(); }
      else { writeAttempts(a); msg.textContent = `Wrong passcode · ${5 - a.fails} ${5 - a.fails === 1 ? 'try' : 'tries'} left`; msg.classList.add('err'); }
    },
  });
  const forgot = h('button', { type: 'button', class: 'link-btn lk-forgot', on: { click: async () => {
    const ok = await confirmDialog('There is no way to recover a forgotten passcode. You can erase all FORGE data on this device and start again — then restore from an encrypted backup or cloud sync if you have one.', { ok: 'Erase this device', danger: true });
    if (!ok) return;
    resetAttempts();
    store.reset();
    unlock();
    location.hash = '#/onboarding';
  } } }, 'Forgot passcode?');
  overlay = h('div', { class: 'lk-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'FORGE is locked' },
    h('div', { class: 'lk-inner' },
      h('div', { class: 'lk-mark', 'aria-hidden': 'true' }, icon('bell', 26)),
      h('h1', { class: 'lk-title' }, 'FORGE is locked'),
      msg, kp.el, forgot,
      h('p', { class: 'lk-note' }, 'Privacy lock for this device.')));
  overlay.addEventListener('keydown', kp.onKey);
  document.body.append(overlay);
  overlay.tabIndex = -1;
  requestAnimationFrame(() => overlay?.focus());
  if (cooling()) tickCooldown();
  function unlock() {
    clearInterval(timer);
    overlay?.remove(); overlay = null;
    document.body.classList.remove('locked');
  }
}

export const isLocked = () => !!overlay;

let inited = false;
/** Call once at boot, before the first route renders. */
export function initLock() {
  if (inited) return;
  inited = true;
  if (isLockEnabled()) lockNow();
  document.addEventListener('visibilitychange', () => {
    if (!isLockEnabled()) return;
    if (document.visibilityState === 'hidden') {
      try { sessionStorage.setItem(HIDDEN_KEY, String(Date.now())); } catch {}
      if (timeoutMin() === 0) lockNow();
    } else {
      let at = 0;
      try { at = +sessionStorage.getItem(HIDDEN_KEY) || 0; } catch {}
      const t = timeoutMin() * 60000;
      if (at && Date.now() - at >= t) lockNow();
    }
  });
}

// ---------- settings flows (used by Me) ----------
/** Sheet with a keypad. Resolves to the entered code or null if dismissed. */
export function promptCode({ title, sub, digits }) {
  return new Promise((resolve) => {
    let done = false;
    const s = sheet({
      title,
      onClose: () => { if (!done) resolve(null); },
      content: ({ close }) => {
        const kp = keypad({ digits, onDone: (c) => { done = true; resolve(c); close(); } });
        const wrap = h('div', { class: 'stack lk-sheet', tabindex: '-1' }, sub ? h('p', { class: 'small muted center' }, sub) : null, kp.el);
        wrap.addEventListener('keydown', kp.onKey);
        setTimeout(() => wrap.focus(), 50);
        return wrap;
      },
    });
    return s;
  });
}

async function confirmCurrent() {
  const l = lockSettings();
  const code = await promptCode({ title: 'Current passcode', sub: 'Enter your current passcode to continue.', digits: l.digits });
  if (code == null) return false;
  if (await verifyPasscode(code)) return true;
  toast('Wrong passcode', { kind: 'danger' });
  return false;
}

export async function setupFlow() {
  if (isLockEnabled() && !(await confirmCurrent())) return false;
  const a = await promptCode({ title: isLockEnabled() ? 'New passcode' : 'Choose a passcode', sub: 'Type 4 to 6 digits, then tap ✓.' });
  if (a == null) return false;
  if (!validCode(a)) { toast('Use 4 to 6 digits', { kind: 'danger' }); return false; }
  const b = await promptCode({ title: 'Confirm passcode', sub: 'Type it again.', digits: a.length });
  if (b == null) return false;
  if (a !== b) { toast('Passcodes didn’t match — try again', { kind: 'danger' }); return false; }
  await setPasscode(a);
  toast('App lock on', { kind: 'go' });
  return true;
}

export async function disableFlow() {
  if (!(await confirmCurrent())) return false;
  disableLock();
  toast('App lock off');
  return true;
}
