// FORGE server API client. Every call is same-origin (relative to /forge/) and behind the site password.
// Photos are re-encoded through a canvas before upload: that downsizes them and strips EXIF/GPS metadata.

const MAX_SIDE = 1280;
const TIMEOUT_MS = 95_000;

function apiError(code, message) { return Object.assign(new Error(message), { code }); }

let availability = null;
/** → Promise<{ok, photo, vault}|null>; null when there is no FORGE server (static hosting, offline). */
export function serverInfo({ refresh = false } = {}) {
  if (!availability || refresh) {
    // Remember "no server" for this browser session so static hosting doesn't log a 404 on every screen.
    let known = null;
    try { known = sessionStorage.getItem('forge:api'); } catch {}
    availability = known === 'none' && !refresh
      ? Promise.resolve(null)
      : fetchJSON('api/health', { timeout: 6000 }).then((info) => {
        try { sessionStorage.setItem('forge:api', 'ok'); } catch {}
        return info;
      }).catch((e) => {
        if (e.code === 'unavailable') { try { sessionStorage.setItem('forge:api', 'none'); } catch {} }
        return null;
      });
  }
  return availability;
}
export async function apiAvailable() { return !!(await serverInfo()); }

async function fetchJSON(url, { method = 'GET', body, timeout = 15000 } = {}) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw apiError('offline', 'You’re offline. Try again when you have a connection.');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(url, {
      method, credentials: 'same-origin', cache: 'no-store', signal: ctrl.signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw apiError(e.name === 'AbortError' ? 'unavailable' : 'offline', e.name === 'AbortError' ? 'The server took too long to answer.' : 'Couldn’t reach the FORGE server.');
  } finally { clearTimeout(t); }
  const type = res.headers.get('content-type') || '';
  if (!type.includes('application/json')) throw apiError('unavailable', 'The FORGE server isn’t available here.');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = { 503: 'not_configured', 429: 'rate_limited', 413: 'too_large', 404: 'not_found', 409: 'conflict' }[res.status] || data.error || 'failed';
    throw Object.assign(apiError(code, data.message || 'Request failed.'), { status: res.status, data });
  }
  return data;
}
export { fetchJSON as _fetchJSON };

/** Downscale + re-encode to JPEG (drops EXIF/GPS). → {blob, base64, mediaType, width, height, previewUrl} */
export async function prepareImage(file) {
  if (!file || !/^image\//.test(file.type || 'image/')) throw apiError('bad_image', 'Choose a photo.');
  let bitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch {
    bitmap = await new Promise((resolve, reject) => {
      const img = new Image();
      const u = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(u); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(u); reject(apiError('bad_image', 'That file couldn’t be read as a photo.')); };
      img.src = u;
    });
  }
  const w0 = bitmap.width, h0 = bitmap.height;
  const scale = Math.min(1, MAX_SIDE / Math.max(w0, h0));
  const width = Math.max(1, Math.round(w0 * scale)), height = Math.max(1, Math.round(h0 * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
  if (!blob) throw apiError('bad_image', 'That photo couldn’t be processed.');
  const base64 = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1]);
    fr.onerror = () => reject(apiError('bad_image', 'That photo couldn’t be processed.'));
    fr.readAsDataURL(blob);
  });
  return { blob, base64, mediaType: 'image/jpeg', width, height, previewUrl: URL.createObjectURL(blob) };
}

/**
 * Estimate nutrition from a meal photo.
 * → {isFood, items:[{name, grams, kcal, p, c, f, fiber, confidence}], notes, totalKcal}
 * Throws Error with .code ∈ offline | not_configured | rate_limited | too_large | unavailable | failed | bad_image
 */
export async function analyzeFoodPhoto(fileOrPrepared, { hint = '' } = {}) {
  const prepared = fileOrPrepared?.base64 ? fileOrPrepared : await prepareImage(fileOrPrepared);
  const info = await serverInfo();
  if (!info) throw apiError('unavailable', 'Photo estimates need the FORGE server (open FORGE from your Salt Labs site).');
  if (!info.photo) throw apiError('not_configured', 'Photo estimates aren’t switched on yet: the server needs an ANTHROPIC_API_KEY.');
  const data = await fetchJSON('api/food-photo', { method: 'POST', body: { image: prepared.base64, hint: String(hint).slice(0, 300) }, timeout: TIMEOUT_MS });
  const items = (Array.isArray(data.items) ? data.items : []).map((i) => ({
    name: String(i.name || 'Food').slice(0, 80),
    grams: +i.grams || 0, kcal: +i.kcal || 0, p: +i.p || 0, c: +i.c || 0, f: +i.f || 0, fiber: +i.fiber || 0,
    confidence: ['low', 'medium', 'high'].includes(i.confidence) ? i.confidence : 'low',
  }));
  return { isFood: data.isFood !== false, items, notes: String(data.notes || ''), totalKcal: items.reduce((a, i) => a + i.kcal, 0) };
}
