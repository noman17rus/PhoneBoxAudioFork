import { $, LOCALE, cfg, h, ringSvg, safeFetch, sizeCanvas, store } from '../main.js';

// ---------------------------------------------------------------- more widgets: helpers
export const inflight = {};
/** fetch() + JSON with a localStorage cache; returns stale data when offline. */
export function cached(key, url, maxAgeMs) {
  const c = store.get('nc:' + key, null);
  if (c && Date.now() - c.at < maxAgeMs) return Promise.resolve(c.data);
  if (inflight[key]) return inflight[key];
  const ctl = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { ctl.abort(); reject(new Error('timeout')); }, 10_000);
  });
  const request = safeFetch(url, { signal: ctl.signal })
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  inflight[key] = Promise.race([request, deadline])
    .then((data) => { store.set('nc:' + key, { at: Date.now(), data }); return data; })
    .catch((e) => { if (c) return c.data; throw e; })
    .finally(() => { clearTimeout(timer); delete inflight[key]; });
  return inflight[key];
}

/** Calls load() now and then every intervalMs while the widget is on a visible page. */
export function every(intervalMs, load, retryMs = 60_000) {
  let next = 0;
  return () => {
    if (Date.now() < next) return;
    next = Date.now() + intervalMs;
    // a load that returns false failed (offline, service down): try again soon, not after the whole interval
    Promise.resolve(load()).then((ok) => { if (ok === false) next = Math.min(next, Date.now() + retryMs); }, () => {});
  };
}

export function sparkLine(canvas, data, col) {
  if (!canvas.clientWidth || !data || data.length < 2) return;
  const [g, w, hh, dpr] = sizeCanvas(canvas);
  g.clearRect(0, 0, w, hh);
  const min = Math.min(...data), max = Math.max(...data), span = max - min || 1;
  g.beginPath();
  data.forEach((v, i) => { const x = (i / (data.length - 1)) * w, y = hh - 2 * dpr - ((v - min) / span) * (hh - 4 * dpr); i ? g.lineTo(x, y) : g.moveTo(x, y); });
  g.strokeStyle = col; g.lineWidth = 1.5 * dpr; g.lineJoin = 'round'; g.stroke();
}

export const fmtNum = (v) => (v == null ? '—' : v >= 1000 ? v.toLocaleString(LOCALE, { maximumFractionDigits: 0 }) : v >= 10 ? v.toFixed(2) : v.toPrecision(4));
export const pctSpan = (p) => { const e = h('span', 'chg ' + (p >= 0 ? 'up' : 'down'), `${p >= 0 ? '▲' : '▼'} ${Math.abs(p).toFixed(2)}%`); return e; };
export const lines = (v, d) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split('\n') : d).map((x) => String(x).trim()).filter(Boolean);

/** Gauge-style dial used by several widgets. */
export function dialEl() {
  const dial = h('div', 'g-dial'), val = h('div', 'g-val');
  dial.append(val);
  dial.set = (pct, text, unit, elapsed) => {
    updateRing(dial, pct, elapsed);
    if (val.textContent !== String(text) + (unit || '')) val.replaceChildren(String(text), unit ? h('small', null, unit) : '');
  };
  return dial;
}

/** Retain the foreground circle so CSS can animate from its displayed value. */
export function updateRing(dial, pct, elapsed) {
  let svg = dial.querySelector('svg');
  if (!svg) {
    dial.insertAdjacentHTML('afterbegin', ringSvg(pct, elapsed)); // numbers only
    return;
  }
  const offset = (2 * Math.PI * 42 * (1 - Math.max(0, Math.min(100, pct)) / 100)).toFixed(1);
  const foreground = svg.querySelector('.fg');
  if (foreground.getAttribute('stroke-dashoffset') !== offset) foreground.setAttribute('stroke-dashoffset', offset);
  let pace = svg.querySelector('.pace');
  if (elapsed == null) { pace?.remove(); return; }
  if (!pace) { pace = document.createElementNS('http://www.w3.org/2000/svg', 'line'); pace.classList.add('pace'); svg.append(pace); }
  const angle = elapsed * 2 * Math.PI;
  for (const [key, value] of Object.entries({ x1: 50 + Math.cos(angle) * 35, y1: 50 + Math.sin(angle) * 35,
    x2: 50 + Math.cos(angle) * 49, y2: 50 + Math.sin(angle) * 49 })) pace.setAttribute(key, value.toFixed(1));
}

export function canKillAnywhere() {
  return (cfg.pages || []).some((p) => p.enabled !== false && (p.widgets || []).some((w) => w.type === 'processes' && w.options?.allowKill !== false));
}

// Keep meter nodes mounted so new telemetry retargets an existing transition.
export function syncMeters(root, values) {
  const existing = new Map([...root.children].filter(el => el.dataset.meter !== undefined).map(el => [el.dataset.meter, el]));
  values.forEach((v, index) => {
    const key = `${index}:${v.name}`;
    let el = existing.get(key);
    if (el) existing.delete(key);
    else {
      el = h('div', 'meter', h('div', 'm-row', h('span'), h('span')), h('div', 'track', h('i')));
      el.dataset.meter = key;
    }
    const row = el.firstChild;
    if (row.firstChild.textContent !== v.name) row.firstChild.textContent = v.name;
    if (row.lastChild.textContent !== v.txt) row.lastChild.textContent = v.txt;
    if (v.c) el.style.setProperty('--c', v.c); else el.style.removeProperty('--c');
    progressFill(el.querySelector('i'), v.pct / 100);
    if (root.children[index] !== el) root.insertBefore(el, root.children[index] || null);
  });
  for (const el of existing.values()) el.remove();
}

export function progressFill(el, value) {
  const scale = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  el.classList.add('scaled-fill');
  const transform = `scaleX(${scale})`;
  if (el.style.transform !== transform) el.style.transform = transform;
}
