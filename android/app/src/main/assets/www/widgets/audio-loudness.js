import { createAnimation } from '../animation.js';
import { W } from '../registry.js';
import { h, api, streaming, pages, curPage, idle } from '../main.js';

const STATES = { starting: 'Waiting for PC audio…', live: 'Live', silent: 'Silence',
  unavailable: 'Output unavailable — retrying…', unsupported: 'Audio capture requires Windows',
  'unsupported-format': 'Select a mono or stereo PCM output', busy: 'Too many audio profiles', stopped: 'Capture stopped' };
const ARRAYS = ['samplePeak', 'rms', 'truePeak', 'maxSamplePeak', 'maxRms', 'maxTruePeak'];
const SCALARS = ['momentary', 'shortTerm', 'integrated', 'maxMomentary', 'maxShortTerm'];
const db = v => v == null ? '−∞' : v.toFixed(1);

W['audio-loudness'] = {
  needs: [],
  create(box, ctx) {
    let alive = true, key = '', sequence = -1, timestamp = 0, busy = false, resetting = false;
    let generation = 0, lastRequest = 0, lastReceived = 0, wasVisible = false;
    const visible = () => alive && box.isConnected && !idle() && !document.body.classList.contains('night')
      && pages[curPage] === ctx.page && !box.closest('.stack-item:not(.active)');
    const header = h('div', 'as-header'), status = h('span', 'as-status lm-status', 'Waiting for PC audio…');
    header.append(h('strong', '', ctx.o.title || 'Loudness'), status);
    const controls = h('div', 'as-controls');
    const reset = h('button', '', 'Reset session'); reset.type = 'button';
    const expand = h('button', '', 'Expand'); expand.type = 'button'; expand.setAttribute('aria-label', 'Expand loudness');
    const elapsed = h('span', 'lm-elapsed', '0.0 s'); controls.append(reset, expand, elapsed);
    const body = h('div', 'lm-body'), table = h('table', 'lm-levels');
    const head = h('tr'); ['Level', 'L', 'R', 'Max L', 'Max R'].forEach(t => head.append(h('th', '', t))); table.append(head);
    const outputs = {};
    for (const [name, field, max, unit] of [['Sample Peak', 'samplePeak', 'maxSamplePeak', 'dBFS'],
      ['RMS · 400 ms', 'rms', 'maxRms', 'dBFS'], ['True Peak', 'truePeak', 'maxTruePeak', 'dBTP']]) {
      const row = h('tr'); row.append(h('th', '', `${name} (${unit})`));
      for (const [f, channel] of [[field, 0], [field, 1], [max, 0], [max, 1]]) {
        const cell = h('td'), out = h('output', '', '—'); out.dataset.field = `${f}-${channel}`;
        cell.append(out); row.append(cell); outputs[`${f}-${channel}`] = out;
      }
      table.append(row);
    }
    const loudness = h('div', 'lm-lufs');
    for (const [name, field, max] of [['Momentary · 400 ms', 'momentary', 'maxMomentary'],
      ['Short-term · 3 s', 'shortTerm', 'maxShortTerm'], ['Integrated · gated', 'integrated', null]]) {
      const card = h('div', 'lm-card'), out = h('output', '', '—'), hold = h('small', '', max ? 'Max — LUFS' : '−70 LUFS / −10 LU gate');
      out.dataset.field = field; outputs[field] = out;
      if (max) outputs[max] = hold;
      card.append(h('label', '', name), out, h('span', '', 'LUFS'), hold); loudness.append(card);
    }
    const info = h('div', 'as-info lm-info', 'BS.1770 / EBU R128 · maxima held until reset');
    body.append(table, loudness); box.append(header, controls, body, info);
    let pendingFrame = null;
    const motion = createAnimation(() => {
      const frame = pendingFrame; pendingFrame = null;
      if (frame && frame.key === key && !resetting) render(frame);
    }, visible);
    function clear() { pendingFrame = null; motion.cancel(); Object.entries(outputs).forEach(([field, out]) => { out.textContent = ['maxMomentary', 'maxShortTerm'].includes(field) ? 'Max — LUFS' : '—'; out.classList.remove('lm-over'); }); elapsed.textContent = '0.0 s'; }
    function receive(frame) {
      if (!visible() || resetting || !frame || frame.key !== key || !Number.isFinite(frame.sequence) || !Number.isFinite(frame.timestamp)) return;
      if (frame.timestamp < timestamp || (frame.timestamp === timestamp && frame.sequence <= sequence)) return;
      timestamp = frame.timestamp; sequence = frame.sequence; lastReceived = Date.now();
      pendingFrame = frame; motion.request();
    }
    function render(frame) {
      status.textContent = STATES[frame.state] || 'Waiting for PC audio…';
      const v = frame.values, number = n => n === null || Number.isFinite(n);
      const valid = ['live', 'silent'].includes(frame.state) && v
        && ARRAYS.every(f => Array.isArray(v[f]) && v[f].length === 2 && v[f].every(number))
        && SCALARS.every(f => number(v[f])) && Number.isFinite(v.seconds) && v.seconds >= 0;
      if (!valid) { clear(); return; }
      for (const field of ARRAYS) for (let c = 0; c < 2; c++) {
        const out = outputs[`${field}-${c}`];
        out.textContent = frame.channels === 1 && c === 1 ? '—' : db(v[field][c]);
        out.classList.toggle('lm-over', v[field][c] != null && v[field][c] >= 0);
      }
      for (const field of SCALARS) outputs[field].textContent = field.startsWith('max') ? `Max ${db(v[field])} LUFS` : db(v[field]);
      elapsed.textContent = `${v.seconds.toFixed(1)} s`;
      info.textContent = `${frame.deviceName} · ${frame.sampleRate / 1000} kHz · ${frame.channels === 1 ? 'Mono' : 'Stereo'} · BS.1770 / EBU R128`;
    }
    const query = `?widget=${encodeURIComponent(`${ctx.page.id}/${ctx.w.id}`)}`;
    reset.onclick = async () => {
      if (resetting || !visible()) return;
      resetting = true; reset.disabled = true; generation++;
      try {
        const response = await api(`/audio-loudness/reset${query}`, 'POST', 2500);
        if (!alive) return;
        resetting = false; key = response.key;
        if (response.shown === false) { clear(); status.textContent = 'Save this widget to start analysis'; }
        else receive(response.frame);
        lastRequest = 0;
      } catch (_) { if (alive) status.textContent = 'Reset failed — try again'; }
      finally { resetting = false; reset.disabled = false; }
    };
    expand.onclick = () => { const on = box.classList.toggle('as-expanded'); expand.textContent = on ? 'Close' : 'Expand'; expand.setAttribute('aria-expanded', String(on)); };
    controls.addEventListener('pointerdown', e => e.stopPropagation());
    const onEscape = e => { if (e.key === 'Escape' && box.classList.contains('as-expanded')) expand.click(); };
    const onFrame = e => receive(e.detail);
    window.addEventListener('keydown', onEscape); window.addEventListener('phonebox-audio-loudness', onFrame);
    async function poll() {
      const shown = visible();
      if (!shown && wasVisible) { generation++; key = ''; clear(); box.classList.remove('as-expanded'); expand.textContent = 'Expand'; }
      if (shown && !wasVisible) { lastRequest = 0; timestamp = 0; sequence = -1; }
      wasVisible = shown;
      if (!shown || busy || resetting) return;
      if (streaming() && Date.now() - lastReceived < 1500 && Date.now() - lastRequest < 1500) return;
      busy = true; const requestedGeneration = generation;
      try {
        const response = await api(`/audio-loudness${query}`, 'GET', 1500);
        if (!alive || requestedGeneration !== generation) return;
        lastRequest = Date.now();
        if (key !== response.key) { clear(); timestamp = 0; sequence = -1; key = response.key; }
        if (response.shown === false) { clear(); status.textContent = 'Save this widget on an enabled page to start analysis'; }
        else receive(response.frame);
      } catch (_) {
        if (alive && requestedGeneration === generation && Date.now() - lastReceived > 2000) { clear(); status.textContent = 'Disconnected'; }
      } finally { busy = false; }
    }
    const timer = setInterval(poll, 100);
    return { update() {}, destroy() { alive = false; generation++; clearInterval(timer); motion.destroy();
      window.removeEventListener('keydown', onEscape); window.removeEventListener('phonebox-audio-loudness', onFrame);
    } };
  },
};
