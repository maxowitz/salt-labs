import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptBackup, decryptBackup, vaultIdFor, deriveKey, encryptWithKey, decryptWithKey, mergeStates, b64 } from '../js/sync.js';
import { defaultState } from '../js/store.js';

const IT = 1000; // fast iterations for tests; production uses KDF_ITERATIONS

test('encrypted backup round-trips and rejects a wrong passphrase', async () => {
  const s = defaultState();
  s.profile.name = 'Max';
  s.sessions.push({ id: 'a', date: '2026-10-01', title: 'Swings' });
  const txt = await encryptBackup(s, 'correct horse battery', IT);
  assert.ok(!txt.includes('Max') && !txt.includes('Swings'), 'ciphertext must not leak plaintext');
  const back = await decryptBackup(txt, 'correct horse battery');
  assert.equal(back.profile.name, 'Max');
  await assert.rejects(decryptBackup(txt, 'wrong passphrase!!'), (e) => e.code === 'bad_passphrase');
  await assert.rejects(decryptBackup('{"nope":1}', 'x'), (e) => e.code === 'bad_file');
});

test('tampered ciphertext fails authentication', async () => {
  const key = await deriveKey('passphrase-123', new Uint8Array(16), IT);
  const enc = await encryptWithKey(key, { a: 1 });
  const bytes = b64.dec(enc.ct); bytes[0] ^= 1;
  await assert.rejects(decryptWithKey(key, { iv: enc.iv, ct: b64.enc(bytes) }), (e) => e.code === 'bad_passphrase');
  await assert.rejects(decryptWithKey(key, enc, 'other-aad'));
  assert.deepEqual(await decryptWithKey(key, enc), { a: 1 });
});

test('vault id is deterministic per passphrase and hex-64', async () => {
  const a = await vaultIdFor('my long passphrase', IT);
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.equal(a, await vaultIdFor('my long passphrase', IT));
  assert.notEqual(a, await vaultIdFor('my long passphrase.', IT));
});

test('merge keeps every logged record from both devices', () => {
  const a = defaultState(), b = defaultState();
  a.savedAt = 100; b.savedAt = 200;
  a.profile.name = 'Old'; b.profile.name = 'New';
  a.sessions = [{ id: 's1', date: '2026-10-01' }, { id: 's2', date: '2026-10-03' }];
  b.sessions = [{ id: 's1', date: '2026-10-01', rpe: 7 }, { id: 's3', date: '2026-10-02' }];
  a.foodLog = { '2026-10-01': [{ id: 'f1', kcal: 100 }] };
  b.foodLog = { '2026-10-01': [{ id: 'f2', kcal: 200 }], '2026-10-02': [{ id: 'f3', kcal: 5 }] };
  a.bodyweight = [{ date: '2026-10-01', kg: 82 }];
  b.bodyweight = [{ date: '2026-10-02', kg: 81.5 }];
  a.water = { '2026-10-01': 1500 }; b.water = { '2026-10-01': 1000 };
  const m = mergeStates(a, b);
  assert.equal(m.profile.name, 'New');
  assert.deepEqual(m.sessions.map((s) => s.id), ['s1', 's3', 's2']);
  assert.equal(m.sessions[0].rpe, 7);
  assert.deepEqual(m.foodLog['2026-10-01'].map((e) => e.id).sort(), ['f1', 'f2']);
  assert.equal(m.foodLog['2026-10-02'].length, 1);
  assert.equal(m.bodyweight.length, 2);
  assert.equal(m.water['2026-10-01'], 1500);
  assert.equal(m.savedAt, 200);
});
