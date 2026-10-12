// Salt Labs — static hub + FORGE API behind HTTP Basic Auth.
// Secrets live in env vars (set on Railway), never in this repo:
//   SITE_PASSWORD      required; the server fails closed without it
//   ANTHROPIC_API_KEY  optional; enables FORGE food-photo estimates
//   FORGE_DATA_DIR     optional; where encrypted FORGE backups are stored (mount a volume here)
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;
const PASS = process.env.SITE_PASSWORD || "";
const ROOT = __dirname;
const DATA_DIR = path.resolve(process.env.FORGE_DATA_DIR || path.join(ROOT, "data"));
const VAULT_DIR = path.join(DATA_DIR, "vaults");
const PHOTO_MODEL = process.env.FORGE_PHOTO_MODEL || "claude-opus-5-5";
const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".webp": "image/webp", ".woff2": "font/woff2", ".json": "application/json",
};

// Only these paths are ever served as static files. Everything else (server.js, package.json,
// node_modules, .git, data/, tests, docs) is unreachable even for authenticated users.
const STATIC_ALLOW = [/^\/index\.html$/, /^\/assets\/[\w.\-\/]+$/, /^\/forge\/(?!tests\/|docs\/|api\/)[\w.\-\/]+$/];

// ---------- rate limiting ----------
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now - b.t > windowMs) { buckets.set(key, { n: 1, t: now }); return false; }
  b.n++;
  return b.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now - b.t > 3600e3) buckets.delete(k); }, 600e3).unref();

// login lockout: after 20 bad passwords from one IP, lock that IP out for 10 minutes
const fails = new Map();
const WINDOW = 10 * 60 * 1000, MAX_FAILS = 20;
function ipOf(req) {
  const fwd = req.headers["x-forwarded-for"];
  return (fwd ? String(fwd).split(",")[0].trim() : req.socket.remoteAddress) || "?";
}
function lockedOut(ip) {
  const f = fails.get(ip);
  if (!f) return false;
  if (Date.now() - f.t > WINDOW) { fails.delete(ip); return false; }
  return f.n >= MAX_FAILS;
}
function recordFail(ip) {
  const f = fails.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - f.t > WINDOW) { f.n = 0; }
  f.n++; f.t = Date.now();
  fails.set(ip, f);
}
function timingSafeEq(a, b) {
  const A = crypto.createHash("sha256").update(String(a)).digest();
  const B = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(A, B);
}
function authed(req) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) return null; // no attempt
  let dec = "";
  try { dec = Buffer.from(h.slice(6), "base64").toString(); } catch (e) { return false; }
  const i = dec.indexOf(":");
  const pw = i < 0 ? dec : dec.slice(i + 1); // any username, password is what counts
  return PASS !== "" && timingSafeEq(pw, PASS);
}

// ---------- security headers ----------
const FORGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' https://world.openfoodfacts.org",
  "media-src 'self' blob:",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function baseHeaders(req, extra = {}) {
  const h = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
    ...extra,
  };
  if (req.headers["x-forwarded-proto"] === "https") h["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  return h;
}

function send(req, res, status, body, headers = {}) {
  res.writeHead(status, baseHeaders(req, headers));
  res.end(body);
}
function sendJSON(req, res, status, obj) {
  send(req, res, status, JSON.stringify(obj), { "Content-Type": "application/json", "Cache-Control": "no-store" });
}

// ---------- request body ----------
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error("too large"), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function readJSON(req, limit) {
  // JSON-only bodies force a CORS preflight from other origins, which this server never approves (CSRF guard).
  if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) throw Object.assign(new Error("expected JSON"), { status: 415 });
  const buf = await readBody(req, limit);
  try { return JSON.parse(buf.toString("utf8")); } catch { throw Object.assign(new Error("bad JSON"), { status: 400 }); }
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin fetches may omit it; JSON content-type still forces preflight cross-site
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

// ---------- FORGE: food photo estimate ----------
let anthropic = null;
function claude() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!anthropic) {
    const Anthropic = require("@anthropic-ai/sdk");
    anthropic = new (Anthropic.default || Anthropic)({ timeout: 90_000, maxRetries: 1 });
  }
  return anthropic;
}

const PHOTO_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["is_food", "items", "notes"],
  properties: {
    is_food: { type: "boolean" },
    notes: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "grams", "kcal", "protein_g", "carbs_g", "fat_g", "fiber_g", "confidence"],
        properties: {
          name: { type: "string" },
          grams: { type: "number" },
          kcal: { type: "number" },
          protein_g: { type: "number" },
          carbs_g: { type: "number" },
          fat_g: { type: "number" },
          fiber_g: { type: "number" },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
        },
      },
    },
  },
};

const PHOTO_SYSTEM = `You are a sports dietitian estimating the nutrition of a meal from a single photo for an athlete's food log.
Identify each distinct food or drink that is visible. For each, estimate the edible portion in grams as served (cooked weight for cooked foods) using visual cues such as plate size (assume a 27 cm dinner plate unless something suggests otherwise), utensils, hands and packaging. Then give kcal, protein, carbohydrate, fat and fiber for that portion using typical USDA-style values. Account for visible cooking fats, sauces and dressings as their own items when they are meaningful.
Be realistic rather than conservative: athletes under-log when estimates are low. Use "low" confidence when the portion or the food itself is ambiguous.
If the image does not show food or drink, set is_food to false, return no items, and say what you see in notes.
Keep notes to one or two short sentences with the biggest uncertainty and what the user should double-check. The user's hint, if any, is a description from the athlete and takes priority over what you infer.`;

const num = (v, max) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(max, Math.round(n * 10) / 10)) : 0; };
const cleanText = (s, max) => String(s || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max);

function sniffImage(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

async function foodPhoto(req, res, ip) {
  const client = claude();
  if (!client) return sendJSON(req, res, 503, { error: "not_configured", message: "Photo estimates need ANTHROPIC_API_KEY on the server." });
  if (limited("photo:" + ip, 40, 3600e3)) return sendJSON(req, res, 429, { error: "rate_limited", message: "Too many photos this hour. Try again later." });
  const body = await readJSON(req, 8 * 1024 * 1024);
  const b64 = typeof body.image === "string" ? body.image.replace(/^data:[^,]*,/, "") : "";
  if (!/^[A-Za-z0-9+/=]+$/.test(b64)) return sendJSON(req, res, 400, { error: "bad_image", message: "Image data is missing or invalid." });
  const buf = Buffer.from(b64, "base64");
  if (buf.length > 5 * 1024 * 1024) return sendJSON(req, res, 413, { error: "too_large", message: "Photo is too large." });
  const mediaType = sniffImage(buf);
  if (!mediaType) return sendJSON(req, res, 415, { error: "bad_image", message: "Only JPEG, PNG or WebP photos are supported." });
  const hint = cleanText(body.hint, 300);

  const response = await client.beta.messages.create({
    model: PHOTO_MODEL,
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema: PHOTO_SCHEMA } },
    system: PHOTO_SYSTEM,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: buf.toString("base64") } },
        { type: "text", text: hint ? `Athlete's note about this meal: ${hint}` : "Estimate this meal." },
      ],
    }],
  });

  if (response.stop_reason === "refusal") return sendJSON(req, res, 422, { error: "failed", message: "This photo couldn't be analysed." });
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  let parsed;
  try { parsed = JSON.parse(text); } catch { return sendJSON(req, res, 502, { error: "failed", message: "The estimate came back malformed. Try again." }); }

  const items = (Array.isArray(parsed.items) ? parsed.items : []).slice(0, 20).map((it) => ({
    name: cleanText(it.name, 80) || "Food",
    grams: num(it.grams, 3000),
    kcal: num(it.kcal, 5000),
    p: num(it.protein_g, 400),
    c: num(it.carbs_g, 800),
    f: num(it.fat_g, 400),
    fiber: num(it.fiber_g, 150),
    confidence: ["low", "medium", "high"].includes(it.confidence) ? it.confidence : "low",
  }));
  sendJSON(req, res, 200, {
    isFood: parsed.is_food !== false,
    items,
    notes: cleanText(parsed.notes, 400),
    totalKcal: Math.round(items.reduce((a, i) => a + i.kcal, 0)),
  });
}

// ---------- FORGE: encrypted backup vault ----------
// The client encrypts with a key derived from a passphrase the server never sees; the server stores opaque ciphertext.
const VAULT_ID = /^[a-f0-9]{64}$/;
const B64 = /^[A-Za-z0-9+/=_-]+$/;
function vaultPath(id) { return path.join(VAULT_DIR, id + ".json"); }

async function vault(req, res, ip, id) {
  if (!VAULT_ID.test(id)) return sendJSON(req, res, 400, { error: "bad_id" });
  const file = vaultPath(id);
  if (req.method === "GET") {
    if (limited("vault-r:" + ip, 600, 3600e3)) return sendJSON(req, res, 429, { error: "rate_limited" });
    fs.readFile(file, "utf8", (err, txt) => {
      if (err) return sendJSON(req, res, 404, { error: "not_found" });
      send(req, res, 200, txt, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    });
    return;
  }
  if (req.method === "PUT") {
    if (limited("vault-w:" + ip, 240, 3600e3)) return sendJSON(req, res, 429, { error: "rate_limited" });
    const body = await readJSON(req, 20 * 1024 * 1024);
    const ok = body && body.v === 1 && typeof body.ct === "string" && B64.test(body.ct) && typeof body.iv === "string" && B64.test(body.iv)
      && body.kdf && typeof body.kdf.salt === "string" && B64.test(body.kdf.salt) && Number.isInteger(body.kdf.iterations)
      && Number.isFinite(body.updatedAt);
    if (!ok) return sendJSON(req, res, 400, { error: "bad_vault" });
    let current = null;
    try { current = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    if (current && Number.isFinite(body.baseUpdatedAt) && current.updatedAt > body.baseUpdatedAt) {
      return sendJSON(req, res, 409, { error: "conflict", updatedAt: current.updatedAt });
    }
    const record = { v: 1, kdf: { name: "PBKDF2-SHA256", iterations: body.kdf.iterations, salt: body.kdf.salt }, iv: body.iv, ct: body.ct, updatedAt: body.updatedAt, storedAt: Date.now() };
    fs.mkdirSync(VAULT_DIR, { recursive: true, mode: 0o700 });
    const tmp = file + "." + crypto.randomBytes(6).toString("hex") + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return sendJSON(req, res, 200, { ok: true, updatedAt: record.updatedAt, storedAt: record.storedAt });
  }
  if (req.method === "DELETE") {
    fs.rm(file, { force: true }, () => sendJSON(req, res, 200, { ok: true }));
    return;
  }
  sendJSON(req, res, 405, { error: "method_not_allowed" });
}

async function api(req, res, url, ip) {
  if (req.method !== "GET" && !sameOrigin(req)) return sendJSON(req, res, 403, { error: "forbidden" });
  if (url === "/forge/api/health" && req.method === "GET") {
    return sendJSON(req, res, 200, { ok: true, photo: !!process.env.ANTHROPIC_API_KEY, vault: true });
  }
  if (url === "/forge/api/food-photo" && req.method === "POST") return foodPhoto(req, res, ip);
  const m = url.match(/^\/forge\/api\/vault\/([^/]+)$/);
  if (m) return vault(req, res, ip, m[1]);
  sendJSON(req, res, 404, { error: "not_found" });
}

// ---------- server ----------
http.createServer(async (req, res) => {
  let url;
  try { url = decodeURIComponent(req.url.split("?")[0]); } catch { return send(req, res, 400, "Bad request", { "Content-Type": "text/plain" }); }
  if (url === "/health") return send(req, res, 200, "ok", { "Content-Type": "text/plain" });

  if (!PASS) { // fail closed if the password was never configured
    return send(req, res, 503, "Salt Labs is locked: SITE_PASSWORD is not configured.", { "Content-Type": "text/plain" });
  }

  const ip = ipOf(req);
  if (lockedOut(ip)) return send(req, res, 429, "Too many attempts. Try again in a few minutes.", { "Content-Type": "text/plain", "Retry-After": "600" });

  const ok = authed(req);
  if (ok !== true) {
    if (ok === false) recordFail(ip);
    return send(req, res, 401, "Salt Labs — team access only.", { "WWW-Authenticate": 'Basic realm="Salt Labs", charset="UTF-8"', "Content-Type": "text/plain" });
  }

  if (url.startsWith("/forge/api/")) {
    try { await api(req, res, url, ip); }
    catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error("FORGE API error:", e && e.message);
      if (!res.headersSent) sendJSON(req, res, status, { error: status === 413 ? "too_large" : status === 415 ? "bad_request" : "failed", message: status >= 500 ? "Something went wrong. Try again." : e.message });
    }
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") return send(req, res, 405, "Method not allowed", { Allow: "GET, HEAD" });

  // sub-apps (e.g. /forge) live in folders: redirect to the slash form so relative URLs resolve
  let p = path.posix.normalize(url);
  if (p === "/forge") return send(req, res, 301, "", { Location: "/forge/" + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "") });
  if (p === "/") p = "/index.html";
  if (p.endsWith("/")) p += "index.html";

  const allowed = !p.split("/").some((seg) => seg.startsWith(".")) && STATIC_ALLOW.some((re) => re.test(p));
  const file = path.join(ROOT, p);
  const ext = path.extname(p).toLowerCase();
  // a missing asset is a real 404 (so caches never store HTML in place of a script); only page-like paths fall back
  if (allowed && ext && ext !== ".html" && !fs.existsSync(file)) return send(req, res, 404, "Not found", { "Content-Type": "text/plain", "Cache-Control": "no-store" });
  if (!allowed || !file.startsWith(ROOT + path.sep)) {
    // unknown paths fall back to the hub page (or the FORGE shell inside /forge/)
    p = p.startsWith("/forge/") ? "/forge/index.html" : "/index.html";
  }
  const target = path.join(ROOT, p);
  fs.readFile(target, (err, buf) => {
    if (err) {
      const home = p.startsWith("/forge/") ? "/forge/index.html" : "/index.html";
      return fs.readFile(path.join(ROOT, home), (e2, html) => {
        if (e2) return send(req, res, 404, "Not found", { "Content-Type": "text/plain" });
        send(req, res, 200, html, forgeHeaders(home, ".html"));
      });
    }
    send(req, res, 200, buf, forgeHeaders(p, path.extname(target).toLowerCase()));
  });
}).listen(PORT, () => console.log("Salt Labs up on :" + PORT + (PASS ? " (password protected)" : " (NO PASSWORD SET)") + (process.env.ANTHROPIC_API_KEY ? " · FORGE photo estimates on" : "")));

function forgeHeaders(p, ext) {
  const h = { "Content-Type": TYPES[ext] || "application/octet-stream" };
  if (p.startsWith("/forge/")) {
    h["Content-Security-Policy"] = FORGE_CSP;
    // the service worker and HTML must revalidate so updates roll out; hashed assets can be cached briefly
    h["Cache-Control"] = ext === ".html" || p.endsWith("/sw.js") ? "no-cache" : "public, max-age=300";
  }
  return h;
}
