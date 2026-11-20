import { createAnimation } from '../animation.js';
import { W } from '../registry.js';
import { h, api, streaming, pages, curPage, idle } from '../main.js';

const STATES = {
  starting: 'Waiting for a complete FFT window…', silent: 'Silence', live: 'Live',
  unavailable: 'Output unavailable — retrying…', unsupported: 'Audio capture requires Windows',
  'unsupported-format': 'Select a mono or stereo PCM output', busy: 'Too many spectrum profiles',
  stopped: 'Capture stopped',
};
const MODES = { lr: [0, 1], power: [2], ms: [3, 4] };
const NAMES = ['L', 'R', 'Power', 'Mid', 'Side'];
const COLORS = ['#42dcca', '#fbaf64', '#42dcca', '#77baff', '#f09cdb'];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const number = (v, fallback) => Number.isFinite(+v) ? +v : fallback;
const hz = (f) => f >= 1000 ? `${+(f / 1000).toFixed(1)}k` : `${Math.round(f)}`;

W['audio-spectrum'] = {
  needs: [],
  create(box, ctx) {
    const o = ctx.o;
    let alive = true, key = '', latest = null, held = null, signature = '', sequence = -1, timestamp = 0;
    let slope = clamp(Math.round(number(o.slope, 3) * 2) / 2, -6, 6);
    let mode = MODES[o.mode] ? o.mode : 'power', peaks = o.peaks !== false, paused = false;
    let floor = clamp(number(o.floor, -100), -140, -40);
    let timer = 0, lastRequest = 0, lastReceived = 0, wasVisible = false;
    let hover = null;
    const header = h('div', 'as-header');
    const title = h('strong', '', o.title || 'Audio spectrum');
    const status = h('span', 'as-status', 'Waiting for PC audio…');
    header.append(title, status);
    const controls = h('div', 'as-controls');
    const select = h('select'); select.setAttribute('aria-label', 'Spectrum channels');
    for (const [v, label] of [['power', 'Power'], ['lr', 'L / R'], ['ms', 'Mid / Side']]) {
      const opt = h('option', '', label); opt.value = v; select.append(opt);
    }
    select.value = mode;
    const tilt = h('input'); tilt.type = 'range'; tilt.min = '-6'; tilt.max = '6'; tilt.step = '0.5'; tilt.value = String(slope);
    tilt.setAttribute('aria-label', 'Spectrum slope in dB per octave');
    const tiltValue = h('span', 'as-tilt-value');
    const tiltLabel = h('label', 'as-tilt', 'Tilt '); tiltLabel.append(tilt, tiltValue);
    const hold = h('button', '', 'Peak hold'); hold.type = 'button';
    const reset = h('button', '', 'Reset'); reset.type = 'button';
    const pause = h('button', '', 'Freeze'); pause.type = 'button';
    const expand = h('button', '', 'Expand'); expand.type = 'button';
    expand.setAttribute('aria-label', 'Expand spectrum');
    controls.append(select, tiltLabel, hold, reset, pause, expand);
    const plot = h('div', 'as-plot');
    const canvas = h('canvas'); canvas.setAttribute('aria-label', 'Audio spectrum, logarithmic frequency in Hz, level in decibels');
    const message = h('div', 'as-message', 'Waiting for PC audio…');
    plot.append(canvas, message);
    const info = h('div', 'as-info', 'Hann · fixed scale · slope affects display only');
    box.append(header, controls, plot, info);
    const g = canvas.getContext('2d');
    const visible = () => alive && box.isConnected && !idle() && !document.body.classList.contains('night')
      && pages[curPage] === ctx.page && !box.closest('.stack-item:not(.active)');
    const motion = createAnimation(draw, visible);
    const wantDraw = () => motion.request();
    const updateButtons = () => {
      tiltValue.textContent = `${slope > 0 ? '+' : ''}${slope} dB/oct`;
      hold.setAttribute('aria-pressed', String(peaks)); pause.setAttribute('aria-pressed', String(paused));
      pause.textContent = paused ? 'Resume' : 'Freeze';
    };
    const clear = () => { held = null; hover = null; wantDraw(); };
    select.onchange = () => { mode = select.value; clear(); };
    tilt.oninput = () => { slope = +tilt.value; updateButtons(); wantDraw(); };
    hold.onclick = () => { peaks = !peaks; clear(); updateButtons(); };
    reset.onclick = clear;
    pause.onclick = () => { paused = !paused; if (!paused) clear(); updateButtons(); };
    expand.onclick = () => {
      const expanded = box.classList.toggle('as-expanded');
      expand.textContent = expanded ? 'Close' : 'Expand'; expand.setAttribute('aria-expanded', String(expanded));
      resize();
    };
    // Only the controls handle input; gestures over the plot belong to the pager.
    controls.addEventListener('pointerdown', (e) => e.stopPropagation());
    plot.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      hover = e.clientX - canvas.getBoundingClientRect().left; wantDraw();
    });
    plot.addEventListener('pointerleave', () => { hover = null; wantDraw(); });
    const onEscape = (e) => { if (e.key === 'Escape' && box.classList.contains('as-expanded')) expand.click(); };
    window.addEventListener('keydown', onEscape);

    function receive(frame) {
      if (!visible() || !frame || frame.key !== key) return;
      if (frame.timestamp < timestamp || (frame.timestamp === timestamp && frame.sequence <= sequence)) return;
      timestamp = frame.timestamp; sequence = frame.sequence; lastReceived = Date.now();
      status.textContent = STATES[frame.state] || 'Waiting for PC audio…';
      const valid = ['live', 'silent'].includes(frame.state) && frame.curves?.length === 5 && frame.frequencies?.length === 512
        && frame.curves.every(c => c.length === 512);
      message.hidden = valid;
      if (!valid) { message.textContent = status.textContent; if (!paused) { latest = null; held = null; wantDraw(); } return; }
      if (paused) { status.textContent = 'Frozen'; return; }
      const nextSignature = `${frame.device}:${frame.sampleRate}:${frame.fftSize}:${frame.averageMs}`;
      if (signature !== nextSignature) { held = null; signature = nextSignature; }
      latest = frame;
      if (peaks) {
        if (!held) held = frame.curves.map(c => c.slice());
        else frame.curves.forEach((c, j) => c.forEach((v, i) => { held[j][i] = Math.max(held[j][i], v); }));
      }
      info.textContent = `${frame.deviceName} · ${frame.sampleRate / 1000} kHz · FFT ${frame.fftSize} · Δf ${frame.resolutionHz.toFixed(2)} Hz · Hann · avg ${frame.averageMs} ms`;
      wantDraw();
    }
    const onFrame = (e) => receive(e.detail);
    window.addEventListener('phonebox-audio-spectrum', onFrame);

    function resize() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(plot.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(plot.clientHeight * dpr));
      wantDraw();
    }
    const observer = new ResizeObserver(resize); observer.observe(plot);

    function draw() {
      if (!visible()) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const width = canvas.width / dpr, height = canvas.height / dpr;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, width, height);
      const left = 44, right = width - 14, top = 21, bottom = height - 25;
      if (right <= left || bottom <= top) return;
      const topHz = latest?.frequencies?.[511] || 20000;
      const x = f => left + Math.log(f / 20) / Math.log(topHz / 20) * (right - left);
      const y = db => bottom - (db - floor) / (12 - floor) * (bottom - top);
      g.font = '10px system-ui'; g.fillStyle = '#98abbc'; g.strokeStyle = '#263849'; g.lineWidth = 1;
      g.textAlign = 'right';
      for (let db = Math.ceil(floor / 20) * 20; db <= 0; db += 20) {
        const py = y(db); g.beginPath(); g.moveTo(left, py); g.lineTo(right, py); g.stroke(); g.fillText(String(db), left - 7, py + 3);
      }
      g.textAlign = 'center';
      for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
        if (f > topHz) continue;
        const px = x(f); g.beginPath(); g.moveTo(px, top); g.lineTo(px, bottom); g.stroke();
        if (width > 450 || [20, 100, 1000, 10000].includes(f)) g.fillText(hz(f), px, height - 8);
      }
      g.textAlign = 'left'; g.fillText(slope ? `dBFS + tilt (${slope > 0 ? '+' : ''}${slope} dB/oct @ 1k)` : 'dBFS · sine peak amplitude', left, 12);
      g.textAlign = 'right'; g.fillText('Hz', right, 12);
      if (!latest) return;
      g.save(); g.beginPath(); g.rect(left, top, right - left, bottom - top); g.clip();
      const trace = (values, index, peak) => {
        g.strokeStyle = COLORS[index]; g.globalAlpha = peak ? .45 : 1; g.lineWidth = peak ? 1 : 1.6;
        g.setLineDash(peak ? [3, 3] : []); g.beginPath();
        values.forEach((db, i) => {
          const f = latest.frequencies[i], px = x(f), py = y(db + slope * Math.log2(f / 1000));
          if (!i) g.moveTo(px, py); else g.lineTo(px, py);
        }); g.stroke();
      };
      for (const index of MODES[mode]) {
        if (peaks && held) trace(held[index], index, true);
        trace(latest.curves[index], index, false);
      }
      g.restore(); g.globalAlpha = 1; g.setLineDash([]);
      let legendX = left + 6;
      for (const index of MODES[mode]) { g.fillStyle = COLORS[index]; g.textAlign = 'left'; g.fillText(NAMES[index], legendX, top + 12); legendX += 48; }
      if (hover !== null && hover >= left && hover <= right) {
        const f = 20 * Math.pow(topHz / 20, (hover - left) / (right - left));
        const i = clamp(Math.round(Math.log(f / 20) / Math.log(topHz / 20) * 511), 0, 511);
        g.strokeStyle = '#ffffff66'; g.beginPath(); g.moveTo(hover, top); g.lineTo(hover, bottom); g.stroke();
        g.fillStyle = '#e2edf6'; g.textAlign = 'right';
        g.fillText(`${hz(latest.frequencies[i])} Hz · ${MODES[mode].map(j => `${NAMES[j]} ${latest.curves[j][i].toFixed(1)} dBFS`).join(' · ')} (raw)`, right - 4, top + 12);
      }
    }

    async function poll() {
      if (!alive || !box.isConnected) return;
      const shown = visible();
      if (!shown && wasVisible) { latest = null; held = null; box.classList.remove('as-expanded'); expand.textContent = 'Expand'; }
      if (shown && !wasVisible) { lastRequest = 0; sequence = -1; timestamp = 0; }
      wasVisible = shown;
      let delay = 250;
      if (shown) {
        const live = streaming();
        // A stalled stream falls back to polling even if the shell has not reported its disconnect yet.
        const fallback = !live || Date.now() - lastReceived > 1500;
        if (fallback || Date.now() - lastRequest > 1500) {
          try {
            const response = await api(`/audio-spectrum?widget=${encodeURIComponent(`${ctx.page.id}/${ctx.w.id}`)}`, 'GET', 1500);
            lastRequest = Date.now();
            if (key !== response.key) { latest = null; held = null; timestamp = 0; sequence = -1; }
            key = response.key;
            if (response.shown === false) { message.hidden = false; message.textContent = 'Save this widget on an enabled page to start analysis'; }
            else receive(response.frame);
          } catch (_) {
            if (Date.now() - lastReceived > 2000) { status.textContent = 'Disconnected'; message.textContent = 'No data from the PC'; message.hidden = false; latest = null; held = null; wantDraw(); }
          }
        }
        delay = fallback ? 33 : 250;
      }
      timer = setTimeout(poll, delay);
    }
    updateButtons();
    timer = setTimeout(poll, 250);
    return {
      update() {},
      destroy() {
        alive = false; clearTimeout(timer); motion.destroy(); observer.disconnect();
        window.removeEventListener('phonebox-audio-spectrum', onFrame); window.removeEventListener('keydown', onEscape);
      },
    };
  },
};
