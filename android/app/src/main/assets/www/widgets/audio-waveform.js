import { createAnimation } from '../animation.js';
import { W } from '../registry.js';
import { h, api, streaming, pages, curPage, idle } from '../main.js';

const INTERVALS = [[10, '10 ms'], [50, '50 ms'], [100, '100 ms'], [500, '500 ms'], [1000, '1 s'], [5000, '5 s'], [10000, '10 s']];
const STATES = { starting: 'Waiting for PC audio…', live: 'Live', silent: 'Silence', unavailable: 'Output unavailable — retrying…',
  unsupported: 'Audio capture requires Windows', 'unsupported-format': 'Select a mono or stereo PCM output', busy: 'Too many audio profiles', stopped: 'Capture stopped' };

W['audio-waveform'] = {
  needs: [],
  create(box, ctx) {
    let alive = true, latest = null, key = '', sequence = -1, timestamp = 0, paused = false;
    let interval = INTERVALS.some(([v]) => v === +ctx.o.interval) ? +ctx.o.interval : 1000;
    let mode = ctx.o.mode === 'ms' ? 'ms' : 'lr';
    let timer = 0, lastRequest = 0, lastReceived = 0, wasVisible = false, generation = 0;
    const header = h('div', 'as-header');
    const status = h('span', 'as-status aw-status', 'Waiting for PC audio…');
    header.append(h('strong', '', ctx.o.title || 'Audio waveform'), status);
    const controls = h('div', 'as-controls');
    const channels = h('select'); channels.setAttribute('aria-label', 'Waveform channels');
    for (const [v, label] of [['lr', 'L / R'], ['ms', 'Mid / Side']]) {
      const opt = h('option', '', label); opt.value = v; channels.append(opt);
    }
    channels.value = mode;
    const duration = h('select'); duration.setAttribute('aria-label', 'Waveform visible interval');
    for (const [v, label] of INTERVALS) { const opt = h('option', '', label); opt.value = String(v); duration.append(opt); }
    duration.value = String(interval);
    const pause = h('button', '', 'Freeze'); pause.type = 'button'; pause.setAttribute('aria-pressed', 'false');
    const expand = h('button', '', 'Expand'); expand.type = 'button'; expand.setAttribute('aria-label', 'Expand waveform');
    controls.append(channels, duration, pause, expand);
    const plot = h('div', 'as-plot aw-plot');
    const canvas = h('canvas'); canvas.setAttribute('aria-label', 'Separate audio waveforms, time in milliseconds or seconds, red marks at 0 dBFS');
    const message = h('div', 'as-message aw-message', 'Waiting for PC audio…');
    plot.append(canvas, message);
    const info = h('div', 'as-info aw-info', 'Fixed ±1 scale · min/max envelope · red = ≥0 dBFS');
    box.append(header, controls, plot, info);
    const g = canvas.getContext('2d');
    const visible = () => alive && box.isConnected && !idle() && !document.body.classList.contains('night')
      && pages[curPage] === ctx.page && !box.closest('.stack-item:not(.active)');
    const motion = createAnimation(draw, visible);
    const wantDraw = () => motion.request();
    const reset = () => { latest = null; key = ''; sequence = -1; timestamp = 0; lastRequest = 0; lastReceived = 0; generation++; wantDraw(); };
    channels.onchange = () => { mode = channels.value; wantDraw(); };
    duration.onchange = () => {
      interval = +duration.value; paused = false; pause.textContent = 'Freeze'; pause.setAttribute('aria-pressed', 'false');
      reset(); message.hidden = false; message.textContent = 'Waiting for PC audio…';
      clearTimeout(timer); poll();
    };
    pause.onclick = () => {
      paused = !paused; pause.textContent = paused ? 'Resume' : 'Freeze'; pause.setAttribute('aria-pressed', String(paused));
      status.textContent = paused ? 'Frozen' : 'Waiting for PC audio…';
      if (!paused) { sequence = -1; timestamp = 0; lastRequest = 0; }
    };
    expand.onclick = () => {
      const expanded = box.classList.toggle('as-expanded'); expand.textContent = expanded ? 'Close' : 'Expand';
      expand.setAttribute('aria-expanded', String(expanded)); resize();
    };
    controls.addEventListener('pointerdown', e => e.stopPropagation());
    const onEscape = e => { if (e.key === 'Escape' && box.classList.contains('as-expanded')) expand.click(); };
    window.addEventListener('keydown', onEscape);

    function receive(frame) {
      if (!visible() || !frame || frame.key !== key || frame.intervalMs !== interval) return;
      if (frame.timestamp < timestamp || (frame.timestamp === timestamp && frame.sequence <= sequence)) return;
      timestamp = frame.timestamp; sequence = frame.sequence; lastReceived = Date.now();
      if (paused) return;
      status.textContent = STATES[frame.state] || 'Waiting for PC audio…';
      const count = frame.min?.[0]?.length;
      const valid = ['live', 'silent'].includes(frame.state) && count > 0 && count <= 512
        && frame.min?.length === 4 && frame.max?.length === 4
        && [...frame.min, ...frame.max].every(c => c.length === count && c.every(Number.isFinite));
      message.hidden = valid;
      if (!valid) { latest = null; message.textContent = status.textContent; wantDraw(); return; }
      latest = frame;
      info.textContent = `${frame.deviceName} · ${frame.sampleRate / 1000} kHz · ${INTERVALS.find(([v]) => v === interval)[1]} · min/max · red = ≥0 dBFS`;
      wantDraw();
    }
    const onFrame = e => receive(e.detail);
    window.addEventListener('phonebox-audio-waveform', onFrame);
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
      const left = 48, right = width - 12, top = 18, bottom = height - 25, gap = 18;
      if (right <= left || bottom - top <= gap) return;
      g.font = '10px system-ui';
      for (let i = 0; i <= 4; i++) {
        const x = left + i / 4 * (right - left), time = (i / 4 - 1) * interval;
        g.strokeStyle = '#263849'; g.beginPath(); g.moveTo(x, top); g.lineTo(x, bottom); g.stroke();
        g.fillStyle = '#98abbc'; g.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center';
        g.fillText(interval >= 1000 ? `${+(time / 1000).toFixed(2)} s` : `${+time.toFixed(1)} ms`, x, height - 8);
      }
      const indices = mode === 'ms' ? [2, 3] : [0, 1], names = mode === 'ms' ? ['Mid', 'Side'] : ['L', 'R'];
      indices.forEach((channel, lane) => {
        const laneHeight = (bottom - top - gap) / 2, yTop = top + lane * (laneHeight + gap), center = yTop + laneHeight / 2;
        const y = value => center - Math.max(-1, Math.min(1, value)) * laneHeight / 2;
        for (const value of [-1, 0, 1]) {
          g.strokeStyle = value ? '#59333e' : '#324658'; g.beginPath(); g.moveTo(left, y(value)); g.lineTo(right, y(value)); g.stroke();
        }
        g.fillStyle = lane ? '#fbaf64' : '#42dcca'; g.textAlign = 'left'; g.fillText(names[lane], 3, center + 3);
        g.fillStyle = '#b98d98'; g.textAlign = 'right'; g.fillText('0 dBFS', right, yTop - 4);
        if (!latest) return;
        const min = latest.min[channel], max = latest.max[channel];
        // Reduce again to physical display columns using extrema, never subsampling bins.
        const columns = Math.max(1, Math.min(min.length, Math.floor((right - left) * dpr)));
        for (let column = 0; column < columns; column++) {
          const first = Math.floor(column * min.length / columns), end = Math.floor((column + 1) * min.length / columns);
          let lo = Infinity, hi = -Infinity;
          for (let i = first; i < end; i++) { lo = Math.min(lo, min[i]); hi = Math.max(hi, max[i]); }
          const x = left + (column + .5) / columns * (right - left);
          g.strokeStyle = lane ? '#fbaf64' : '#42dcca'; g.lineWidth = Math.max(1, (right - left) / columns);
          g.beginPath(); g.moveTo(x, y(hi)); g.lineTo(x, y(lo) + .5); g.stroke();
          if (hi >= 1 || lo <= -1) {
            g.fillStyle = '#ff526d';
            if (hi >= 1) g.fillRect(x - 1, yTop, 2, 4);
            if (lo <= -1) g.fillRect(x - 1, yTop + laneHeight - 4, 2, 4);
          }
        }
        g.lineWidth = 1;
      });
    }

    async function poll() {
      if (!alive || !box.isConnected) return;
      const shown = visible(), requestGeneration = generation;
      if (!shown && wasVisible) { reset(); box.classList.remove('as-expanded'); expand.textContent = 'Expand'; }
      if (shown && !wasVisible) { lastRequest = 0; sequence = -1; timestamp = 0; wantDraw(); }
      wasVisible = shown;
      let delay = 250;
      if (shown) {
        const fallback = !streaming() || Date.now() - lastReceived > 1500;
        if (fallback || Date.now() - lastRequest > 1500) {
          try {
            const response = await api(`/audio-waveform?widget=${encodeURIComponent(`${ctx.page.id}/${ctx.w.id}`)}&interval=${interval}`, 'GET', 1500);
            if (!alive || requestGeneration !== generation) return;
            lastRequest = Date.now();
            if (key !== response.key) { latest = null; timestamp = 0; sequence = -1; }
            key = response.key;
            if (response.shown === false && !paused) { latest = null; message.hidden = false; message.textContent = 'Save this widget on an enabled page to start analysis'; wantDraw(); }
            else receive(response.frame);
          } catch (_) {
            if (requestGeneration !== generation || !alive) return;
            if (!paused && Date.now() - lastReceived > 2000) {
              status.textContent = 'Disconnected'; message.textContent = 'No data from the PC'; message.hidden = false; latest = null; wantDraw();
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
      window.removeEventListener('phonebox-audio-waveform', onFrame); window.removeEventListener('keydown', onEscape);
    } };
  },
};
