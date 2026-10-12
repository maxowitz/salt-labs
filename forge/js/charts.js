// FORGE charts — dependency-free SVG. Every function returns an Element.
const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  for (const k of kids) if (k) el.append(k);
  return el;
}
const txt = (str, attrs) => { const t = s('text', attrs); t.textContent = str; return t; };

/** Progress ring. value/max may exceed 1 (overflow drawn as second lap tint). */
export function ring({ value = 0, max = 1, size = 88, stroke = 9, color = 'var(--accent)', label, sub, track = 'var(--surface-3)' }) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const pct = max > 0 ? value / max : 0;
  const p1 = Math.max(0, Math.min(1, pct));
  const svg = s('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: 'img', 'aria-label': `${label ?? ''} ${sub ?? ''}`.trim() });
  svg.append(s('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', stroke: track, 'stroke-width': stroke }));
  svg.append(s('circle', {
    cx: size / 2, cy: size / 2, r, fill: 'none', stroke: color, 'stroke-width': stroke, 'stroke-linecap': 'round',
    'stroke-dasharray': `${c * p1} ${c}`, transform: `rotate(-90 ${size / 2} ${size / 2})`,
    style: 'transition: stroke-dasharray .6s cubic-bezier(.22,1,.36,1)',
  }));
  if (pct > 1) {
    const over = Math.min(1, pct - 1);
    svg.append(s('circle', {
      cx: size / 2, cy: size / 2, r, fill: 'none', stroke: 'var(--danger)', 'stroke-width': stroke, 'stroke-linecap': 'round', opacity: 0.85,
      'stroke-dasharray': `${c * over} ${c}`, transform: `rotate(-90 ${size / 2} ${size / 2})`,
    }));
  }
  const wrap = document.createElement('div');
  wrap.className = 'ring-wrap';
  wrap.style.width = wrap.style.height = size + 'px';
  wrap.append(svg);
  if (label != null || sub != null) {
    const l = document.createElement('div');
    l.className = 'ring-label';
    l.innerHTML = '<div></div>';
    const inner = l.firstChild;
    if (label != null) { const v = document.createElement('div'); v.className = 'v'; v.textContent = label; v.style.fontSize = Math.round(size / 4.6) + 'px'; inner.append(v); }
    if (sub != null) { const k = document.createElement('div'); k.className = 'k'; k.textContent = sub; inner.append(k); }
    wrap.append(l);
  }
  return wrap;
}

function niceRange(min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) { const pad = Math.abs(min) * 0.05 || 1; return [min - pad, max + pad]; }
  const pad = (max - min) * 0.08;
  return [min - pad, max + pad];
}

/**
 * Line chart. series: [{ points:[{x:number,y:number}], color, dashed, width, dots, area }]
 * xLabels: [{x, label}], yFmt: fn
 */
export function lineChart({ series, width = 340, height = 160, xLabels = [], yFmt = (v) => Math.round(v), yTicks = 3, goal, ariaLabel = 'Chart' }) {
  const pad = { l: 34, r: 8, t: 10, b: 20 };
  const all = series.flatMap((se) => se.points);
  const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, class: 'chart', role: 'img', 'aria-label': ariaLabel, preserveAspectRatio: 'none' });
  if (!all.length) { svg.append(txt('No data yet', { x: width / 2, y: height / 2, 'text-anchor': 'middle' })); return svg; }
  const xs = all.map((p) => p.x), ys = all.map((p) => p.y).concat(goal != null ? [goal] : []);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs) === Math.min(...xs) ? Math.min(...xs) + 1 : Math.max(...xs)];
  const [y0, y1] = niceRange(Math.min(...ys), Math.max(...ys));
  const X = (x) => pad.l + ((x - x0) / (x1 - x0)) * (width - pad.l - pad.r);
  const Y = (y) => pad.t + (1 - (y - y0) / (y1 - y0)) * (height - pad.t - pad.b);
  for (let i = 0; i <= yTicks; i++) {
    const v = y0 + ((y1 - y0) * i) / yTicks;
    svg.append(s('line', { x1: pad.l, x2: width - pad.r, y1: Y(v), y2: Y(v), stroke: 'var(--line)', 'stroke-width': 1 }));
    svg.append(txt(yFmt(v), { x: pad.l - 5, y: Y(v) + 3, 'text-anchor': 'end' }));
  }
  for (const xl of xLabels) svg.append(txt(xl.label, { x: X(xl.x), y: height - 5, 'text-anchor': 'middle' }));
  if (goal != null) svg.append(s('line', { x1: pad.l, x2: width - pad.r, y1: Y(goal), y2: Y(goal), stroke: 'var(--go)', 'stroke-dasharray': '4 4', 'stroke-width': 1.2 }));
  for (const se of series) {
    const pts = [...se.points].sort((a, b) => a.x - b.x);
    if (!pts.length) continue;
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join('');
    if (se.area) {
      svg.append(s('path', { d: `${d}L${X(pts.at(-1).x)},${Y(y0)}L${X(pts[0].x)},${Y(y0)}Z`, fill: se.color || 'var(--accent)', opacity: 0.12 }));
    }
    svg.append(s('path', { d, fill: 'none', stroke: se.color || 'var(--accent)', 'stroke-width': se.width || 2.2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'stroke-dasharray': se.dashed ? '4 4' : null, 'vector-effect': 'non-scaling-stroke' }));
    if (se.dots) for (const p of pts) svg.append(s('circle', { cx: X(p.x), cy: Y(p.y), r: 2.4, fill: se.color || 'var(--accent)', opacity: se.dotOpacity ?? 1 }));
  }
  return svg;
}

/** Bar chart. bars: [{label, value, color?, target?}] */
export function barChart({ bars, width = 340, height = 140, yFmt = (v) => Math.round(v), ariaLabel = 'Bar chart', target }) {
  const pad = { l: 30, r: 6, t: 10, b: 20 };
  const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, class: 'chart', role: 'img', 'aria-label': ariaLabel });
  const max = Math.max(1, target || 0, ...bars.map((b) => b.value || 0)) * 1.1;
  const bw = (width - pad.l - pad.r) / Math.max(1, bars.length);
  const Y = (v) => pad.t + (1 - v / max) * (height - pad.t - pad.b);
  for (let i = 0; i <= 2; i++) {
    const v = (max * i) / 2;
    svg.append(s('line', { x1: pad.l, x2: width - pad.r, y1: Y(v), y2: Y(v), stroke: 'var(--line)' }));
    svg.append(txt(yFmt(v), { x: pad.l - 4, y: Y(v) + 3, 'text-anchor': 'end' }));
  }
  bars.forEach((b, i) => {
    const x = pad.l + i * bw + bw * 0.18, w = bw * 0.64;
    const y = Y(b.value || 0);
    svg.append(s('rect', { x, y, width: w, height: Math.max(0, Y(0) - y), rx: Math.min(5, w / 3), fill: b.color || 'var(--accent)', opacity: b.dim ? 0.4 : 1 }));
    svg.append(txt(b.label, { x: x + w / 2, y: height - 5, 'text-anchor': 'middle' }));
  });
  if (target) svg.append(s('line', { x1: pad.l, x2: width - pad.r, y1: Y(target), y2: Y(target), stroke: 'var(--go)', 'stroke-dasharray': '4 4' }));
  return svg;
}

/** GitHub-style heatmap. days: [{date:'YYYY-MM-DD', value:0..1}], weeks columns oldest→newest. */
export function heatmap({ days, weeks = 12, cell = 14, gap = 3, color = 'var(--go)', ariaLabel = 'Activity calendar' }) {
  const width = weeks * (cell + gap), height = 7 * (cell + gap);
  const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, class: 'chart', role: 'img', 'aria-label': ariaLabel });
  const map = new Map(days.map((d) => [d.date, d.value]));
  const today = new Date();
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const start = new Date(end); start.setDate(end.getDate() - (weeks * 7 - 1) - ((end.getDay() + 6) % 7 === 6 ? 0 : 0));
  // align so the last column ends on today
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(end); d.setDate(end.getDate() - (weeks * 7 - 1 - i));
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const v = map.get(iso) || 0;
    const col = Math.floor(i / 7), row = i % 7;
    svg.append(s('rect', {
      x: col * (cell + gap), y: row * (cell + gap), width: cell, height: cell, rx: 3,
      fill: v > 0 ? color : 'var(--surface-3)', opacity: v > 0 ? 0.35 + 0.65 * Math.min(1, v) : 1,
    }, s('title', {}, document.createTextNode(`${iso}${v ? ' • active' : ''}`))));
  }
  return svg;
}

/** Semi-circular gauge 0..max with optional zones [{to, color}]. */
export function gauge({ value, max = 100, size = 180, zones, label, sub }) {
  const w = size, hgt = size * 0.62, r = size * 0.4, cx = w / 2, cy = size * 0.5, st = size * 0.075;
  const svg = s('svg', { viewBox: `0 0 ${w} ${hgt}`, width: w, height: hgt, role: 'img', 'aria-label': `${label ?? value} ${sub ?? ''}` });
  const arc = (a0, a1) => {
    const p = (a) => [cx + r * Math.cos(Math.PI * (1 - a)), cy - r * Math.sin(Math.PI * (1 - a))];
    const [x0, y0] = p(a0), [x1, y1] = p(a1);
    return `M${x0},${y0}A${r},${r} 0 0 1 ${x1},${y1}`;
  };
  svg.append(s('path', { d: arc(0, 1), fill: 'none', stroke: 'var(--surface-3)', 'stroke-width': st, 'stroke-linecap': 'round' }));
  let prev = 0;
  for (const z of zones || []) {
    svg.append(s('path', { d: arc(prev, Math.min(1, z.to / max)), fill: 'none', stroke: z.color, 'stroke-width': st * 0.35, opacity: 0.55 }));
    prev = Math.min(1, z.to / max);
  }
  const f = Math.max(0.001, Math.min(1, (value || 0) / max));
  svg.append(s('path', { d: arc(0, f), fill: 'none', stroke: 'var(--accent)', 'stroke-width': st, 'stroke-linecap': 'round' }));
  svg.append(txt(label ?? String(Math.round(value)), { x: cx, y: cy - 4, 'text-anchor': 'middle', style: `font-size:${size * 0.17}px;font-weight:800;fill:var(--text)` }));
  if (sub) svg.append(txt(sub, { x: cx, y: cy + size * 0.08, 'text-anchor': 'middle', style: `font-size:${size * 0.065}px` }));
  return svg;
}

/** Stacked horizontal macro bar. parts: [{value,color,label}] */
export function stackBar(parts, { height = 10 } = {}) {
  const total = parts.reduce((a, p) => a + (p.value || 0), 0) || 1;
  const wrap = document.createElement('div');
  wrap.style.cssText = `display:flex;height:${height}px;border-radius:99px;overflow:hidden;background:var(--surface-3)`;
  for (const p of parts) {
    const i = document.createElement('i');
    i.style.cssText = `display:block;width:${(100 * (p.value || 0)) / total}%;background:${p.color}`;
    i.title = p.label || '';
    wrap.append(i);
  }
  return wrap;
}
