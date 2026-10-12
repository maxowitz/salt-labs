// FORGE encrypted backup & sync.
// - The passphrase never leaves the device and is never stored. Two keys are derived from it with PBKDF2-SHA256:
//     vault id  = SHA-256(PBKDF2(passphrase, fixed salt))      → lets a new device find its backup
//     data key  = PBKDF2(passphrase, random per-vault salt)    → AES-256-GCM, non-extractable
// - The server only ever stores {kdf params, iv, ciphertext}. Without the passphrase it is unreadable.
// - The derived data key is kept as a non-extractable CryptoKey in IndexedDB so sync can run unattended.
import { store } from './store.js';
import { idbGet, idbSet, idbDel } from './idb.js';
import { _fetchJSON as fetchJSON, serverInfo } from './api.js';

export const KDF_ITERATIONS = 600_000;
const ID_SALT = 'forge-vault-id/v1';
const PUSH_DELAY = 4000;
const te = new TextEncoder(), td = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;

// ---------- encoding ----------
export const b64 = {
  enc(buf) { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); },
  dec(str) { const s = atob(str); const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; },
};
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

// ---------- crypto primitives (pure; unit-tested in Node) ----------
async function pbkdf2Bits(passphrase, salt, iterations, bits = 256) {
  const base = await subtle().importKey('raw', te.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveBits', 'deriveKey']);
  return subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: typeof salt === 'string' ? te.encode(salt) : salt, iterations }, base, bits);
}

export async function deriveKey(passphrase, salt, iterations = KDF_ITERATIONS) {
  const base = await subtle().importKey('raw', te.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function vaultIdFor(passphrase, iterations = KDF_ITERATIONS) {
  const bits = await pbkdf2Bits(passphrase, ID_SALT, iterations);
  return hex(await subtle().digest('SHA-256', bits));
}

export async function encryptWithKey(key, obj, aad = 'forge') {
  const iv = randomBytes(12);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key, te.encode(JSON.stringify(obj)));
  return { iv: b64.enc(iv), ct: b64.enc(ct) };
}

export async function decryptWithKey(key, { iv, ct }, aad = 'forge') {
  let plain;
  try { plain = await subtle().decrypt({ name: 'AES-GCM', iv: b64.dec(iv), additionalData: te.encode(aad) }, key, b64.dec(ct)); }
  catch { throw Object.assign(new Error('Wrong passphrase, or the backup is damaged.'), { code: 'bad_passphrase' }); }
  return JSON.parse(td.decode(plain));
}

/** Self-contained encrypted backup file contents (string). */
export async function encryptBackup(state, passphrase, iterations = KDF_ITERATIONS) {
  const salt = randomBytes(16);
  const key = await deriveKey(passphrase, salt, iterations);
  const enc = await encryptWithKey(key, state, 'forge-backup');
  return JSON.stringify({ format: 'forge-encrypted-backup', v: 1, kdf: { name: 'PBKDF2-SHA256', iterations, salt: b64.enc(salt) }, ...enc, createdAt: new Date().toISOString() });
}

export async function decryptBackup(text, passphrase) {
  let env;
  try { env = JSON.parse(text); } catch { throw Object.assign(new Error('That file isn’t a FORGE backup.'), { code: 'bad_file' }); }
  if (env?.format !== 'forge-encrypted-backup' || !env.kdf?.salt) throw Object.assign(new Error('That file isn’t an encrypted FORGE backup.'), { code: 'bad_file' });
  const iterations = Math.min(5_000_000, Math.max(1000, +env.kdf.iterations || KDF_ITERATIONS));
  const key = await deriveKey(passphrase, b64.dec(env.kdf.salt), iterations);
  return decryptWithKey(key, env, 'forge-backup');
}

// ---------- merge (pure) ----------
const byKey = (arr, k) => new Map((arr || []).filter(Boolean).map((x) => [x[k], x]));
function unionBy(a, b, k, prefer) {
  const m = byKey(a, k);
  for (const [id, item] of byKey(b, k)) if (!m.has(id) || prefer === 'b') m.set(id, item);
  return [...m.values()];
}

/**
 * Merge two states when both devices changed since the last sync.
 * Records (sessions, food entries, weigh-ins, custom foods, templates, check-ins) are unioned so nothing logged is lost;
 * singletons (profile, targets, plan, settings) come from whichever side saved last.
 */
export function mergeStates(local, remote) {
  const newer = (remote.savedAt || 0) > (local.savedAt || 0) ? remote : local;
  const older = newer === remote ? local : remote;
  const out = structuredClone(newer);
  out.sessions = unionBy(older.sessions, newer.sessions, 'id', 'b').sort((x, y) => String(x.date).localeCompare(String(y.date)) || String(x.startedAt || '').localeCompare(String(y.startedAt || '')));
  out.bodyweight = unionBy(older.bodyweight, newer.bodyweight, 'date', 'b').sort((x, y) => x.date.localeCompare(y.date));
  out.customFoods = unionBy(older.customFoods, newer.customFoods, 'id', 'b');
  out.mealTemplates = unionBy(older.mealTemplates, newer.mealTemplates, 'id', 'b');
  out.foodLog = { ...(older.foodLog || {}) };
  for (const [date, list] of Object.entries(newer.foodLog || {})) out.foodLog[date] = unionBy(out.foodLog[date], list, 'id', 'b');
  out.water = { ...(older.water || {}) };
  for (const [date, ml] of Object.entries(newer.water || {})) out.water[date] = Math.max(+ml || 0, +out.water[date] || 0);
  out.readiness = { ...(older.readiness || {}), ...(newer.readiness || {}) };
  out.favorites = [...new Set([...(newer.favorites || []), ...(older.favorites || [])])];
  out.recentFoods = [...new Set([...(newer.recentFoods || []), ...(older.recentFoods || [])])].slice(0, 30);
  out.savedAt = Math.max(local.savedAt || 0, remote.savedAt || 0);
  return out;
}

// ---------- device persistence ----------
export async function requestPersistence() {
  try { return !!(await navigator.storage?.persist?.()); } catch { return false; }
}
export async function persistenceStatus() {
  try {
    const persisted = !!(await navigator.storage?.persisted?.());
    const est = (await navigator.storage?.estimate?.()) || {};
    return { persisted, usage: est.usage ?? null, quota: est.quota ?? null };
  } catch { return { persisted: false, usage: null, quota: null }; }
}

// ---------- sync engine ----------
// IndexedDB 'sync' record: { vaultId, salt (b64), iterations, key: CryptoKey, remoteUpdatedAt, lastSyncAt, syncedSavedAt }
const status = { enabled: false, lastSyncAt: null, lastError: null, pending: false, busy: false, serverAvailable: null };
const subs = new Set();
let cfg = null;
let pushTimer = null;
let started = false;

function emit(patch) {
  Object.assign(status, patch);
  for (const fn of [...subs]) { try { fn({ ...status }); } catch (e) { console.error(e); } }
}
export const syncStatus = () => ({ ...status });
export function subscribeSync(fn) { subs.add(fn); return () => subs.delete(fn); }

async function saveCfg() { if (cfg) await idbSet('sync', cfg); }

async function upload() {
  const state = store.get();
  const enc = await encryptWithKey(cfg.key, state, 'forge-vault');
  const updatedAt = Math.max(Date.now(), (cfg.remoteUpdatedAt || 0) + 1);
  const res = await fetchJSON(`api/vault/${cfg.vaultId}`, {
    method: 'PUT', timeout: 30000,
    body: { v: 1, kdf: { iterations: cfg.iterations, salt: cfg.salt }, ...enc, updatedAt, baseUpdatedAt: cfg.remoteUpdatedAt || 0 },
  });
  cfg.remoteUpdatedAt = res.updatedAt;
  cfg.syncedSavedAt = state.savedAt;
  cfg.lastSyncAt = Date.now();
  await saveCfg();
}

async function download() {
  try { return await fetchJSON(`api/vault/${cfg.vaultId}`, { timeout: 30000 }); }
  catch (e) { if (e.code === 'not_found') return null; throw e; }
}

/** Pull remote changes (merging if both sides changed), then push local changes. */
export async function syncNow() {
  if (!cfg) return;
  if (status.busy) { status.pending = true; return; }
  emit({ busy: true, lastError: null });
  try {
    const remote = await download();
    if (remote && remote.updatedAt > (cfg.remoteUpdatedAt || 0)) {
      const remoteState = await decryptWithKey(cfg.key, remote, 'forge-vault');
      const local = store.get();
      const localChanged = (local.savedAt || 0) > (cfg.syncedSavedAt || 0);
      const next = localChanged ? mergeStates(local, remoteState) : remoteState;
      cfg.remoteUpdatedAt = remote.updatedAt;
      cfg.syncedSavedAt = next.savedAt;
      applyingRemote = true;
      try { store.replace(next); } finally { applyingRemote = false; }
      if (!localChanged) { cfg.syncedSavedAt = store.get().savedAt; cfg.lastSyncAt = Date.now(); await saveCfg(); emit({ busy: false, pending: false, lastSyncAt: cfg.lastSyncAt, serverAvailable: true }); return; }
    }
    if (!remote || (store.get().savedAt || 0) > (cfg.syncedSavedAt || 0)) {
      try { await upload(); }
      catch (e) {
        if (e.code !== 'conflict') throw e;
        cfg.remoteUpdatedAt = 0; // someone else wrote in between: pull + merge on the next pass
        emit({ busy: false });
        return syncNow();
      }
    } else {
      cfg.lastSyncAt = Date.now();
      await saveCfg();
    }
    emit({ busy: false, pending: false, lastSyncAt: cfg.lastSyncAt, serverAvailable: true });
  } catch (e) {
    emit({ busy: false, pending: true, lastError: e.code === 'offline' ? 'Offline — will sync when you’re back online.' : e.message, serverAvailable: e.code === 'offline' ? status.serverAvailable : e.code !== 'unavailable' });
  }
}

let applyingRemote = false;
function schedulePush() {
  if (!cfg || applyingRemote) return;
  status.pending = true;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(syncNow, PUSH_DELAY);
}

/**
 * Turn on encrypted sync. If a backup already exists for this passphrase it is restored
 * (merged with anything on this device); otherwise this device's data is uploaded.
 */
export async function enableSync(passphrase) {
  if (!passphrase || passphrase.length < 10) throw Object.assign(new Error('Use a passphrase of at least 10 characters.'), { code: 'weak' });
  const info = await serverInfo({ refresh: true });
  if (!info?.vault) throw Object.assign(new Error('Cloud backup needs the FORGE server (open FORGE from your Salt Labs site).'), { code: 'unavailable' });
  const vaultId = await vaultIdFor(passphrase);
  cfg = { vaultId, iterations: KDF_ITERATIONS, remoteUpdatedAt: 0, syncedSavedAt: 0, lastSyncAt: null };
  const remote = await download();
  let restored = false;
  if (remote) {
    cfg.salt = remote.kdf.salt;
    cfg.iterations = remote.kdf.iterations;
    cfg.key = await deriveKey(passphrase, b64.dec(cfg.salt), cfg.iterations);
    const remoteState = await decryptWithKey(cfg.key, remote, 'forge-vault');
    const local = store.get();
    const next = local.profile?.onboarded ? mergeStates(local, remoteState) : remoteState;
    cfg.remoteUpdatedAt = remote.updatedAt;
    applyingRemote = true;
    try { store.replace(next); } finally { applyingRemote = false; }
    restored = true;
  } else {
    const salt = randomBytes(16);
    cfg.salt = b64.enc(salt);
    cfg.key = await deriveKey(passphrase, salt, cfg.iterations);
  }
  await saveCfg();
  emit({ enabled: true, lastError: null });
  await upload().catch((e) => emit({ lastError: e.message, pending: true }));
  emit({ lastSyncAt: cfg.lastSyncAt, pending: false, serverAvailable: true });
  start();
  return { restored };
}

/** Stop syncing from this device (the encrypted copy stays on the server). */
export async function disableSync() {
  clearTimeout(pushTimer);
  cfg = null;
  await idbDel('sync');
  emit({ enabled: false, pending: false, lastSyncAt: null, lastError: null });
}

/** Stop syncing and delete the encrypted copy from the server. */
export async function forgetDevice({ deleteRemote = false } = {}) {
  if (cfg && deleteRemote) await fetchJSON(`api/vault/${cfg.vaultId}`, { method: 'DELETE' }).catch(() => {});
  await disableSync();
}

export async function exportEncrypted(passphrase) {
  if (!passphrase || passphrase.length < 10) throw Object.assign(new Error('Use a passphrase of at least 10 characters.'), { code: 'weak' });
  return new Blob([await encryptBackup(store.get(), passphrase)], { type: 'application/json' });
}

export async function importEncrypted(text, passphrase) {
  const state = await decryptBackup(text, passphrase);
  if (!state || typeof state !== 'object' || !state.profile) throw Object.assign(new Error('That backup has no FORGE data in it.'), { code: 'bad_file' });
  store.replace(state);
}

function start() {
  if (started) return;
  started = true;
  store.subscribe(schedulePush);
  window.addEventListener('online', () => cfg && syncNow());
  document.addEventListener('visibilitychange', () => {
    if (!cfg) return;
    if (document.visibilityState === 'visible') syncNow();
    else if (status.pending) syncNow();
  });
}

/** Called once at boot: resumes sync if this device was set up before. */
export async function initSync() {
  const saved = await idbGet('sync');
  if (!saved?.key || !saved.vaultId) return;
  cfg = saved;
  emit({ enabled: true, lastSyncAt: cfg.lastSyncAt || null });
  start();
  syncNow();
}
