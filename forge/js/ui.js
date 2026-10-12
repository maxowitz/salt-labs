// FORGE UI helpers — tiny DOM builder, overlays and formatters. See docs/PROMPT.md §6.3.

export const KG_PER_LB = 0.45359237;
export const M_PER_MI = 1609.344;

export function h(tag, attrs, ...children) {
  const el = tag === 'svg' || attrs?.svg ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v; // trusted strings only
      else if (k === 'class') el.setAttribute('class', v);
      else if (k === 'svg') continue;
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected' || k === 'indeterminate') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) { while (el.firstChild) el.firstChild.remove(); return el; }

export function navigate(hash) {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}

// ---------- Overlays ----------
let toastTimer;
export function toast(msg, opts = {}) {
  const root = document.getElementById('toast-root') || document.body;
  clear(root);
  const t = h('div', { class: 'toast' + (opts.kind ? ' ' + opts.kind : ''), role: 'status' }, msg,
    opts.action ? h('button', { class: 'toast-action', on: { click: () => { opts.action.fn(); t.remove(); } } }, opts.action.label) : null);
  root.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, opts.ms || 2600);
}

const openSheets = new Set();
/** Close every open sheet (the router calls this on navigation so no sheet outlives its screen). */
export function closeAllSheets() { for (const c of [...openSheets]) c({ restoreFocus: false }); }

export function sheet({ title, content, onClose, full = false }) {
  const root = document.getElementById('sheet-root') || document.body;
  const prevFocus = document.activeElement;
  let closed = false;
  const close = ({ restoreFocus = true } = {}) => {
    if (closed) return; closed = true;
    openSheets.delete(close);
    // inert immediately: no double-submits or stray taps during the close animation
    wrap.inert = true;
    wrap.style.pointerEvents = 'none';
    wrap.classList.remove('open');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => { wrap.remove(); if (!root.children.length) document.body.classList.remove('sheet-open'); }, 260);
    onClose?.();
    if (restoreFocus) prevFocus?.focus?.();
  };
  const onKey = (e) => {
    if (wrap !== root.lastElementChild) return; // only the top-most sheet reacts
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key === 'Tab') { // focus trap
      const f = [...panel.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled && el.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (!panel.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    }
  };
  const body = h('div', { class: 'sheet-body' });
  const panel = h('div', { class: 'sheet' + (full ? ' full' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog' },
    h('div', { class: 'sheet-grip', 'aria-hidden': 'true' }),
    h('div', { class: 'sheet-head' },
      h('h2', { class: 'sheet-title' }, title || ''),
      h('button', { class: 'icon-btn', 'aria-label': 'Close', on: { click: close } }, icon('x'))),
    body);
  const wrap = h('div', { class: 'sheet-wrap' }, h('div', { class: 'sheet-scrim', on: { click: close } }), panel);
  append(body, [typeof content === 'function' ? content({ close }) : content]);
  root.append(wrap);
  openSheets.add(close);
  document.body.classList.add('sheet-open');
  document.addEventListener('keydown', onKey);
  requestAnimationFrame(() => {
    wrap.classList.add('open');
    const f = panel.querySelector('[autofocus], input, select, textarea, button:not(.icon-btn)');
    f?.focus?.({ preventScroll: true });
  });
  return { close, body, panel };
}

export function confirmDialog(msg, { ok = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const s = sheet({
      title: 'Are you sure?',
      onClose: () => { if (!answered) resolve(false); },
      content: ({ close }) => h('div', { class: 'stack' },
        h('p', { class: 'muted' }, msg),
        h('div', { class: 'row gap' },
          h('button', { class: 'btn ghost grow', on: { click: () => close() } }, 'Cancel'),
          h('button', { class: 'btn grow ' + (danger ? 'danger' : 'primary'), on: { click: () => { answered = true; resolve(true); close(); } } }, ok))),
    });
    return s;
  });
}

// ---------- Formatters ----------
export const num = (v, d = 0) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '–';
  return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
};
export const round = (v, step = 1) => Math.round(v / step) * step;
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function fmtWeight(kg, units = 'imperial', d) {
  if (!Number.isFinite(+kg)) return '–';
  return units === 'metric' ? `${num(kg, d ?? (kg % 1 ? 1 : 0))} kg` : `${num(kg / KG_PER_LB, d ?? 0)} lb`;
}
export const toDisplayWeight = (kg, units) => (units === 'metric' ? kg : kg / KG_PER_LB);
export const fromDisplayWeight = (v, units) => (units === 'metric' ? +v : +v * KG_PER_LB);

export function fmtBell(kg) {
  if (!Number.isFinite(+kg) || !kg) return 'BW';
  return `${num(kg, kg % 1 ? 1 : 0)} kg`;
}
export const bellLb = (kg) => `${Math.round(kg / KG_PER_LB)} lb`;

export function fmtDist(m, units = 'imperial') {
  if (!Number.isFinite(+m)) return '–';
  if (m < 1000 && units === 'metric') return `${Math.round(m)} m`;
  if (units === 'metric') return `${num(m / 1000, 2)} km`;
  if (m < 400) return `${Math.round(m)} m`;
  return `${num(m / M_PER_MI, 2)} mi`;
}

export function fmtDur(sec, { long = false } = {}) {
  sec = Math.max(0, Math.round(+sec || 0));
  const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
  if (long) return hh ? `${hh}h ${mm}m` : mm ? `${mm} min` : `${ss}s`;
  const p = (n) => String(n).padStart(2, '0');
  return hh ? `${hh}:${p(mm)}:${p(ss)}` : `${mm}:${p(ss)}`;
}

export function fmtPace(secPerKm, units = 'imperial') {
  if (!Number.isFinite(+secPerKm) || secPerKm <= 0) return '–';
  const s = units === 'metric' ? secPerKm : secPerKm * (M_PER_MI / 1000);
  return `${fmtDur(s)} /${units === 'metric' ? 'km' : 'mi'}`;
}

export function fmtDate(iso, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, opts);
}

export function parseDur(str) {
  // "mm:ss" | "h:mm:ss" | "ss" -> seconds
  if (str == null || str === '') return null;
  const parts = String(str).trim().split(':').map((p) => Number(p));
  if (parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

export function haptic(ms = 12) {
  try { if (document.body.dataset.haptics !== 'off') navigator.vibrate?.(ms); } catch {}
}

// ---------- Icons (inline SVG, stroke-based) ----------
const ICONS = {
  x: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  check: 'M5 12.5l4.5 4.5L19 7',
  chevR: 'M9 6l6 6-6 6',
  chevL: 'M15 6l-6 6 6 6',
  play: 'M8 5.5v13l11-6.5z',
  pause: 'M8 5v14M16 5v14',
  skip: 'M6 6l9 6-9 6zM18 6v12',
  back: 'M18 6l-9 6 9 6zM6 6v12',
  today: 'M4 12a8 8 0 1016 0 8 8 0 00-16 0zM12 7v5l3 2',
  bell: 'M9 5a3 3 0 016 0M7.5 8.5h9M8 8.5c-2 1.5-3 3.5-3 6a7 7 0 0014 0c0-2.5-1-4.5-3-6M9 5v3.5M15 5v3.5',
  fuel: 'M7 3v8a3 3 0 006 0V3M10 3v18M17 3c-2 2-2 6 0 8v10',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0',
  timer: 'M12 21a8 8 0 100-16 8 8 0 000 16zM12 9v4l2 2M9 2h6',
  flame: 'M12 22c4 0 7-3 7-7 0-5-5-7-5-12-2 2-3 4-3 6-1-1-2-2-2-4-2 2-4 5-4 10 0 4 3 7 7 7z',
  drop: 'M12 3s6 6.5 6 11a6 6 0 01-12 0c0-4.5 6-11 6-11z',
  scale: 'M4 7h16l-2 13H6zM9 7a3 3 0 016 0',
  run: 'M13 4a1.5 1.5 0 103 0 1.5 1.5 0 00-3 0M7 21l3-6 3 2v4M5 12l3-3 4 1 2 3 3 1M10 15l-2-4',
  trophy: 'M8 4h8v5a4 4 0 01-8 0zM8 6H5a3 3 0 003 4M16 6h3a3 3 0 01-3 4M12 13v4M8 21h8M9 17h6',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4',
  barcode: 'M4 6v12M7 6v12M10 6v12M14 6v12M17 6v12M20 6v12',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z',
  trash: 'M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  info: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 11v6M12 7.5v.5',
  heart: 'M12 20s-7-4.5-7-10a4 4 0 017-2.5A4 4 0 0119 10c0 5.5-7 10-7 10z',
  zap: 'M13 2L4 14h7l-1 8 9-12h-7z',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
  volume: 'M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 010 6M19 6a8 8 0 010 12',
  mute: 'M4 9v6h4l5 4V5L8 9zM17 9l5 6M22 9l-5 6',
  book: 'M4 4h6a3 3 0 013 3v13a2 2 0 00-2-2H4zM20 4h-6a3 3 0 00-3 3v13a2 2 0 012-2h7z',
  flag: 'M5 21V4M5 4h12l-2 4 2 4H5',
  target: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 16a4 4 0 100-8 4 4 0 000 8zM12 12h.01',
  download: 'M12 4v12M7 11l5 5 5-5M5 20h14',
  upload: 'M12 20V8M7 13l5-5 5 5M5 4h14',
  moon: 'M20 14A8 8 0 019.9 4 8 8 0 1020 14z',
  sun: 'M12 17a5 5 0 100-10 5 5 0 000 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  repeat: 'M17 2l4 4-4 4M3 11V9a3 3 0 013-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 01-3 3H3',
};
export function icon(name, size = 20) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', size); s.setAttribute('height', size);
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.6'); s.setAttribute('stroke-linecap', 'square'); s.setAttribute('stroke-linejoin', 'miter');
  s.setAttribute('aria-hidden', 'true'); s.setAttribute('class', 'ico');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICONS[name] || ICONS.info);
  s.append(p);
  return s;
}

// ---------- Small composite components ----------
export function seg(options, value, onChange, { label } = {}) {
  const wrap = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label || '' });
  const render = (v) => {
    clear(wrap);
    for (const o of options) {
      const [val, text] = Array.isArray(o) ? o : [o.value, o.label];
      wrap.append(h('button', {
        type: 'button', role: 'radio', 'aria-checked': String(val === v), class: val === v ? 'on' : '',
        on: { click: () => { render(val); onChange(val); } },
      }, text));
    }
  };
  render(value);
  return wrap;
}

export function stepper(value, { min = 0, max = 9999, step = 1, onChange, label, fmt = (v) => v } = {}) {
  let v = value;
  const out = h('output', { class: 'stepper-val', 'aria-live': 'polite' }, fmt(v));
  const set = (nv) => { v = Math.round(clamp(nv, min, max) * 1000) / 1000; out.textContent = fmt(v); onChange?.(v); };
  return h('div', { class: 'stepper', role: 'group', 'aria-label': label || '' },
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Decrease ' + (label || ''), on: { click: () => { haptic(); set(v - step); } } }, icon('minus')),
    out,
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Increase ' + (label || ''), on: { click: () => { haptic(); set(v + step); } } }, icon('plus')));
}

let fieldSeq = 0;
export function field(label, input, hint) {
  // A <label> forwards clicks to its first button, which breaks seg/stepper groups — only wrap single form controls.
  const single = input instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(input.tagName);
  if (single) return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('span', { class: 'field-hint' }, hint) : null);
  const id = 'fl' + ++fieldSeq;
  return h('div', { class: 'field', role: 'group', 'aria-labelledby': id },
    h('span', { class: 'field-label', id }, label), input, hint ? h('span', { class: 'field-hint' }, hint) : null);
}

// Field Ledger (docs/DESIGN.md §10): empty states are left-aligned text, no pictogram. iconName is kept for API compatibility.
export function emptyState(iconName, title, text, action) {
  return h('div', { class: 'empty' }, h('h3', null, title), text ? h('p', { class: 'muted' }, text) : null, action || null);
}

/** Numbered section rule: `01  TITLE ───────── right`. index is optional (number or string). */
export function sectionHead(title, right, index) {
  return h('div', { class: 'section-head' + (index != null ? ' has-ix' : '') },
    index != null ? h('span', { class: 'ix', 'aria-hidden': 'true' }, typeof index === 'number' ? String(index).padStart(2, '0') : String(index)) : null,
    h('h2', null, title),
    right || null);
}

/** Condensed figure with a mono unit: fig('16', 'kg') → <span class="fig">16<span class="unit">kg</span></span>. */
export function fig(value, unit, cls = '') {
  return h('span', { class: 'fig' + (cls ? ' ' + cls : '') }, String(value ?? '–'), unit ? h('span', { class: 'unit' }, unit) : null);
}

/** Page masthead: expanded wordmark + mono dateline over an ink rule. right: string | Node. */
export function masthead(right) {
  return h('header', { class: 'masthead' }, h('span', { class: 'wordmark', 'aria-hidden': 'true' }, 'FORGE'),
    right != null ? h('span', { class: 'lbl' }, right) : null);
}
