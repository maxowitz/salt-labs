// Applies the saved theme before first paint (classic script, loaded synchronously in <head>).
try {
  var s = JSON.parse(localStorage.getItem('forge:v1') || '{}').settings || {};
  var t = s.theme || 'dark';
  if (t === 'system') t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  var m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute('content', t === 'light' ? '#F1EDE4' : '#13120F');
} catch (e) {}
