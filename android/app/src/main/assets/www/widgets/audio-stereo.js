import { createAnimation } from '../animation.js';
import { W } from '../registry.js';
import { h, api, streaming, pages, curPage, idle } from '../main.js';

const INTERVALS = [[250, '250 ms'], [800, '800 ms'], [1500, '1.5 s']];
const STATES = { starting: 'Waiting for PC audio…', live: 'Live', silent: 'Silence', unavailable: 'Output unavailable — retrying…',
  unsupported: 'Audio capture requires Windows', 'unsupported-format': 'Select a mono or stereo PCM output', busy: 'Too many audio profiles', stopped: 'Capture stopped' };

W['audio-stereo'] = {
  needs: [],
  create(box, ctx) {
    let alive = true, key = '', sequence = -1, timestamp = 0, paused = false;
    let interval = INTERVALS.some(([v]) => v === +ctx.o.afterglow) ? +ctx.o.afterglow : 800;
    let trails = [], frozenAt = 0;
    let timer = 0, lastRequest = 0, lastReceived = 0, wasVisible = false, generation = 0;
    const header = h('div', 'as-header');
    const status = h('span', 'as-status st-status', 'Waiting for PC audio…');
    header.append(h('strong', '', ctx.o.title || 'Stereo field'), status);
    const controls = h('div', 'as-controls');
    const duration = h('select'); duration.setAttribute('aria-label', 'Vectorscope afterglow');
    for (const [v, label] of INTERVALS) { const opt = h('option', '', label); opt.value = String(v); duration.append(opt); }
    duration.value = String(interval);
    const pause = h('button', '', 'Freeze'); pause.type = 'button'; pause.setAttribute('aria-pressed', 'false');
    const expand = h('button', '', 'Expand'); expand.type = 'button'; expand.setAttribute('aria-label', 'Expand stereo field');
    controls.append(duration, pause, expand);
    const plot = h('div', 'as-plot st-plot');
    const canvas = h('canvas'); canvas.setAttribute('aria-label', 'Stereo vectorscope: vertical Mid (mono), horizontal Side (antiphase); left-only upper left, right-only upper right');
    const message = h('div', 'as-message st-message', 'Waiting for PC audio…');
    plot.append(canvas, message);
    const info = h('div', 'as-info st-info', '100 ms measurements · x = −Side · y = Mid · fixed ±1 scale');
    const meters = h('div', 'st-meters');
    function meter(name, min, max, labels) {
      const wrap = h('div', 'st-meter'), label = h('label', '', name), value = h('output', '', '—');
      const bar = h('input'); bar.type = 'range'; bar.min = min; bar.max = max; bar.step = 'any';
      bar.disabled = true; bar.setAttribute('aria-label', name); bar.value = (min + max) / 2;
      const scale = h('div', 'st-scale'); labels.forEach(t => scale.append(h('span', '', t)));
      wrap.append(label, value, bar, scale); meters.append(wrap); return { value, bar };
    }
    const correlation = meter('Correlation', -1, 1, ['−1', '0', '+1']);
    const balance = meter('L / R levels', 0, 1, ['L', 'R']);
    const energy = meter('Mid / Side energy', 0, 1, ['Mid', 'Side']);
    function measurements(frame) {
      const signed = v => v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
      const db = v => v == null ? '−∞' : v.toFixed(1);
      correlation.value.textContent = signed(frame?.correlation);
      correlation.bar.value = frame?.correlation ?? 0;
      balance.value.textContent = frame ? `L ${db(frame.leftDb)} / R ${db(frame.rightDb)} dBFS` : '—';
      balance.bar.value = frame?.leftShare == null ? .5 : 1 - frame.leftShare;
      energy.value.textContent = frame?.midShare == null ? '—' : `M ${(frame.midShare * 100).toFixed(0)}% / S ${((1 - frame.midShare) * 100).toFixed(0)}%`;
      energy.bar.value = frame?.midShare == null ? .5 : 1 - frame.midShare;
    }
    box.append(header, controls, plot, meters, info);
    const g = canvas.getContext('2d');
    const visible = () => alive && box.isConnected && !idle() && !document.body.classList.contains('night')
      && pages[curPage] === ctx.page && !box.closest('.stack-item:not(.active)');
    const motion = createAnimation(draw, visible);
    const wantDraw = () => motion.request();
    const reset = () => { trails = []; measurements(null); key = ''; sequence = -1; timestamp = 0; lastRequest = 0; lastReceived = 0; generation++; wantDraw(); };
    duration.onchange = () => { interval = +duration.value; wantDraw(); };
    pause.onclick = () => {
      paused = !paused; if (paused) frozenAt = performance.now(); wantDraw(); pause.textContent = paused ? 'Resume' : 'Freeze'; pause.setAttribute('aria-pressed', String(paused));
      status.textContent = paused ? 'Frozen' : 'Waiting for PC audio…';
      if (!paused) { trails = []; sequence = -1; timestamp = 0; lastRequest = 0; }
    };
    expand.onclick = () => {
      const expanded = box.classList.toggle('as-expanded'); expand.textContent = expanded ? 'Close' : 'Expand';
      expand.setAttribute('aria-expanded', String(expanded)); resize();
    };
    controls.addEventListener('pointerdown', e => e.stopPropagation());
    const onEscape = e => { if (e.key === 'Escape' && box.classList.contains('as-expanded')) expand.click(); };
    window.addEventListener('keydown', onEscape);

    function receive(frame) {
      if (!visible() || !frame || frame.key !== key) return;
      if (frame.timestamp < timestamp || (frame.timestamp === timestamp && frame.sequence <= sequence)) return;
      timestamp = frame.timestamp; sequence = frame.sequence; lastReceived = Date.now();
      if (paused) return;
      status.textContent = STATES[frame.state] || 'Waiting for PC audio…';
      const valid = ['live', 'silent'].includes(frame.state) && frame.windowMs === 100
        && Array.isArray(frame.points) && frame.points.length <= 512
        && frame.points.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))
        && ['correlation', 'leftDb', 'rightDb', 'leftShare', 'midShare'].every(k => frame[k] === null || Number.isFinite(frame[k]))
        && (frame.correlation === null || Math.abs(frame.correlation) <= 1)
        && ['leftShare', 'midShare'].every(k => frame[k] === null || (frame[k] >= 0 && frame[k] <= 1));
      message.hidden = valid;
      if (!valid) { trails = []; measurements(null); message.textContent = status.textContent; wantDraw(); return; }
      measurements(frame);
      trails.push({ at: performance.now(), points: frame.points });
      trails = trails.filter(t => performance.now() - t.at < interval).slice(-50);
      info.textContent = `${frame.deviceName} · ${frame.sampleRate / 1000} kHz · 100 ms · x = −Side · y = Mid`;
      wantDraw();
    }
    const onFrame = e => receive(e.detail);
    window.addEventListener('phonebox-audio-stereo', onFrame);
    function resize() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(plot.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(plot.clientHeight * dpr)); wantDraw();
    }
    const observer = new ResizeObserver(resize); observer.observe(plot);

    function draw() {
      if (!visible()) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1), width = canvas.width / dpr, height = canvas.height / dpr;
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, width, height);
      const cx = width / 2, cy = height / 2, radius = Math.min(width - 110, height - 38) / 2;
      if (radius <= 0) return;
      const now = paused ? frozenAt : performance.now();
      if (!paused) trails = trails.filter(t => now - t.at < interval);
      g.save(); g.beginPath(); g.rect(cx - radius, cy - radius, radius * 2, radius * 2); g.clip();
      for (const trail of trails) {
        g.globalAlpha = Math.max(0, 1 - (now - trail.at) / interval) * .7;
        g.fillStyle = '#42dcca';
        for (const [side, mid] of trail.points) {
          const x = cx - Math.max(-1, Math.min(1, side)) * radius;
          const y = cy - Math.max(-1, Math.min(1, mid)) * radius;
          g.fillRect(x - .7, y - .7, 1.4, 1.4);
        }
      }
      g.restore(); g.globalAlpha = 1; g.lineWidth = 1; g.strokeStyle = '#324658';
      for (const fraction of [.5, 1]) {
        g.beginPath(); g.arc(cx, cy, radius * fraction, 0, Math.PI * 2); g.stroke();
      }
      g.beginPath(); g.moveTo(cx - radius, cy); g.lineTo(cx + radius, cy);
      g.moveTo(cx, cy - radius); g.lineTo(cx, cy + radius); g.stroke();
      g.setLineDash([3, 4]); g.beginPath();
      g.moveTo(cx - radius / 2, cy - radius / 2); g.lineTo(cx + radius / 2, cy + radius / 2);
      g.moveTo(cx + radius / 2, cy - radius / 2); g.lineTo(cx - radius / 2, cy + radius / 2); g.stroke(); g.setLineDash([]);
      g.font = '10px system-ui'; g.fillStyle = '#98abbc'; g.textAlign = 'center';
      g.fillText('Mid + · Mono', cx, cy - radius - 6);
      g.fillText('Mid −', cx, cy + radius + 13);
      g.textAlign = 'right'; g.fillText('Side +', cx - radius - 4, cy - 3);
      g.fillText('Antiphase', cx - radius - 4, cy + 10);
      g.textAlign = 'left'; g.fillText('Side −', cx + radius + 4, cy - 3);
      g.fillText('Antiphase', cx + radius + 4, cy + 10);
      g.textAlign = 'center'; g.fillStyle = '#fbaf64';
      g.fillText('L', cx - radius * .55, cy - radius * .55 - 4);
      g.fillText('R', cx + radius * .55, cy - radius * .55 - 4);
      if (!paused && trails.length) wantDraw();
    }

    async function poll() {
      if (!alive || !box.isConnected) return;
      const shown = visible();
      if (!shown && wasVisible) { reset(); box.classList.remove('as-expanded'); expand.textContent = 'Expand'; }
      if (shown && !wasVisible) { lastRequest = 0; sequence = -1; timestamp = 0; wantDraw(); }
      wasVisible = shown;
      const requestGeneration = generation;
      let delay = 250;
      if (shown) {
        const fallback = !streaming() || Date.now() - lastReceived > 1500;
        if (fallback || Date.now() - lastRequest > 1500) {
          try {
            const response = await api(`/audio-stereo?widget=${encodeURIComponent(`${ctx.page.id}/${ctx.w.id}`)}`, 'GET', 1500);
            if (!alive || requestGeneration !== generation) return;
            lastRequest = Date.now();
            if (key !== response.key) { trails = []; measurements(null); timestamp = 0; sequence = -1; }
            key = response.key;
            if (response.shown === false && !paused) { trails = []; measurements(null); message.hidden = false; message.textContent = 'Save this widget on an enabled page to start analysis'; wantDraw(); }
            else receive(response.frame);
          } catch (_) {
            if (requestGeneration !== generation || !alive) return;
            if (!paused && Date.now() - lastReceived > 2000) {
              trails = []; measurements(null); status.textContent = 'Disconnected'; message.textContent = 'No data from the PC'; message.hidden = false; wantDraw();
            }
          }
        }
        delay = fallback ? 33 : 250;
      }
      if (alive) timer = setTimeout(poll, delay);
    }
    timer = setTimeout(poll, 250);
    return { update() {}, destroy() {
      alive = false; generation++; clearTimeout(timer); motion.destroy(); observer.disconnect();
      window.removeEventListener('phonebox-audio-stereo', onFrame); window.removeEventListener('keydown', onEscape);
    } };
  },
};
