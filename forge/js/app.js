// FORGE boot + hash router. Views live in js/views/*.js and export render(root, params) → cleanup?
import { store } from './store.js';
import { h, icon, clear, toast } from './ui.js';

// route segment → [module, tab]
const ROUTES = {
  today: ['today', 'today'],
  train: ['train', 'train'],          // #/train, #/train/week/3
  session: ['session', 'train'],      // #/session/<workoutId>
  workout: ['workout', 'train'],      // #/workout/<workoutId|free>  (player, immersive)
  library: ['library', 'train'],      // #/library, #/library/<exId>
  timer: ['timer', 'train'],          // #/timer
  hyrox: ['hyrox', 'train'],          // #/hyrox
  history: ['history', 'progress'],   // #/history, #/history/<sessionId>
  fuel: ['fuel', 'fuel'],             // #/fuel, #/fuel/<date>
  progress: ['progress', 'progress'],
  me: ['me', 'me'],
  onboarding: ['onboarding', null],
};
const IMMERSIVE = new Set(['workout', 'onboarding']);

const viewEl = document.getElementById('view');
const tabbar = document.getElementById('tabbar');
let cleanup = null;
let renderSeq = 0;

function applyTheme(theme) {
  let t = theme || 'dark';
  if (t === 'system') t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'light' ? '#f4f1ec' : '#151412');
}

function parse() {
  const raw = (location.hash || '').replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  return { name: parts[0] || 'today', args: parts.slice(1), query: Object.fromEntries(new URLSearchParams(query)) };
}

async function route() {
  const seq = ++renderSeq;
  const s = store.get();
  let { name, args, query } = parse();
  if (!s.profile.onboarded && name !== 'onboarding') { location.replace('#/onboarding'); return; }
  if (!ROUTES[name]) name = 'today';
  const [mod, tab] = ROUTES[name];

  try { cleanup?.(); } catch (e) { console.error(e); }
  cleanup = null;

  document.body.classList.toggle('immersive', IMMERSIVE.has(name));
  tabbar.hidden = IMMERSIVE.has(name);
  for (const a of tabbar.querySelectorAll('a')) {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  updateLiveDot();

  let view;
  try {
    view = await import(`./views/${mod}.js`);
  } catch (e) {
    console.error(e);
    if (seq !== renderSeq) return;
    clear(viewEl).append(h('div', { class: 'fatal' }, h('h2', null, 'Could not load this screen'), h('p', { class: 'muted mt' }, String(e.message || e)),
      h('button', { class: 'btn primary mt', on: { click: () => location.reload() } }, 'Reload')));
    return;
  }
  if (seq !== renderSeq) return;
  clear(viewEl);
  const root = h('div', { class: 'view view-' + mod + ' fade-in' });
  viewEl.append(root);
  try {
    cleanup = (await view.render(root, { args, query, name })) || null;
  } catch (e) {
    console.error(e);
    clear(root).append(h('div', { class: 'fatal' }, h('h2', null, 'Something went wrong'), h('p', { class: 'muted mt' }, String(e.message || e)),
      h('button', { class: 'btn primary mt', on: { click: () => (location.hash = '#/today') } }, 'Go to Today')));
  }
  if (!query.keepScroll) window.scrollTo(0, 0);
}

function updateLiveDot() {
  const a = tabbar.querySelector('a[data-tab="train"]');
  a.querySelector('.tab-live')?.remove();
  if (store.get().activeWorkout) a.append(h('span', { class: 'tab-live', 'aria-label': 'Workout in progress' }));
}

function boot() {
  for (const el of tabbar.querySelectorAll('[data-icon]')) el.replaceWith(icon(el.dataset.icon, 22));
  const s = store.get();
  applyTheme(s.settings.theme);
  document.body.dataset.haptics = s.settings.haptics ? 'on' : 'off';
  store.subscribe((st) => {
    applyTheme(st.settings.theme);
    document.body.dataset.haptics = st.settings.haptics ? 'on' : 'off';
    updateLiveDot();
  });
  matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => applyTheme(store.get().settings.theme));
  if (store.loadError) setTimeout(() => toast('Saved data was unreadable — a backup copy was kept and FORGE started fresh.', { kind: 'danger', ms: 6000 }), 400);
  window.addEventListener('hashchange', route);
  window.addEventListener('error', (e) => console.error('FORGE error:', e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => console.error('FORGE rejection:', e.reason));
  route();

  if ('serviceWorker' in navigator && location.protocol !== 'file:' && !/[?&]nosw/.test(location.search)) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
  }
}

boot();
