// Salt Labs — static hub behind HTTP Basic Auth.
// The password lives in the SITE_PASSWORD env var (set on Railway), never in this repo.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;
const PASS = process.env.SITE_PASSWORD || "";
const ROOT = __dirname;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".webp": "image/webp", ".woff2": "font/woff2", ".json": "application/json",
};

// rate limit: after 20 bad passwords from one IP, lock that IP out for 10 minutes
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
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
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

http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/health") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("ok"); }

  if (!PASS) { // fail closed if the password was never configured
    res.writeHead(503, { "Content-Type": "text/plain" });
    return res.end("Salt Labs is locked: SITE_PASSWORD is not configured.");
  }

  const ip = ipOf(req);
  if (lockedOut(ip)) {
    res.writeHead(429, { "Content-Type": "text/plain", "Retry-After": "600" });
    return res.end("Too many attempts. Try again in a few minutes.");
  }

  const ok = authed(req);
  if (ok !== true) {
    if (ok === false) recordFail(ip);
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Salt Labs", charset="UTF-8"', "Content-Type": "text/plain" });
    return res.end("Salt Labs — team access only.");
  }

  // static files, safely rooted
  let p = path.normalize(url).replace(/^(\.\.[\/\\])+/, "");
  if (p === "/" || p === "\\") p = "/index.html";
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) {
      // unknown paths fall back to the hub page
      fs.readFile(path.join(ROOT, "index.html"), (e2, home) => {
        if (e2) { res.writeHead(404); return res.end("Not found"); }
        res.writeHead(200, { "Content-Type": TYPES[".html"] });
        res.end(home);
      });
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream" });
    res.end(buf);
  });
}).listen(PORT, () => console.log("Salt Labs up on :" + PORT + (PASS ? " (password protected)" : " (NO PASSWORD SET)")));
