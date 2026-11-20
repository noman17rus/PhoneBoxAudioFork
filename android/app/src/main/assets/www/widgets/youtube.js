import { API, PANEL_HEADERS, curPage, h, pages, t } from '../main.js';
import { W } from '../registry.js';

W.youtube = {
  needs: ['tick'],
  create(box, { page, w }) {
    box.classList.add('youtube-widget');
    const stage = h('div', 'youtube-stage'), image = h('img', 'youtube-image');
    image.alt = 'YouTube';
    const note = h('div', 'empty youtube-note', t('w.youtube.unpaired'));
    const title = h('div', 'youtube-title', 'YouTube');
    const controls = h('div', 'youtube-controls');
    const buttons = {};
    let alive = true, running = false, pending = null, imageUrl = null, sequence = 0, state = null;
    let lastPicture = 0, lastState = 0, commandBusy = false;
    const query = 'widget=' + encodeURIComponent(`${page.id}/${w.id}`);
    const visible = () => alive && box.isConnected && !document.hidden && pages[curPage] === page
      && !document.body.classList.contains('night') && !box.closest('.stack-item:not(.active)');
    function clear() {
      image.hidden = true;
      image.removeAttribute('src');
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      imageUrl = null;
      lastPicture = 0;
    }
    function render() {
      const kind = state?.state || 'disconnected';
      const available = !['unpaired', 'disconnected'].includes(kind) && kind !== 'no-video';
      buttons.previous.disabled = commandBusy || !available || !state?.canPrevious;
      buttons.playpause.disabled = commandBusy || !available;
      buttons.next.disabled = commandBusy || !available || !state?.canNext;
      buttons.playpause.textContent = state?.playing ? '⏸' : '▶';
      buttons.playpause.setAttribute('aria-label', t(state?.playing ? 'w.youtube.pause' : 'w.youtube.play'));
      title.textContent = state?.title || 'YouTube';
      if (kind !== 'streaming') clear();
      const picture = kind === 'streaming' && imageUrl && Date.now() - lastPicture < 1200;
      if (kind === 'streaming' && imageUrl && !picture) clear();
      note.hidden = !!picture;
      note.textContent = t('w.youtube.' + (kind === 'streaming' ? 'waiting' : kind));
    }
    async function fetchWithTimeout(path, options = {}) {
      const controller = new AbortController();
      pending = controller;
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        const response = await fetch(`${API}/youtube/${path}`, { ...options, headers: PANEL_HEADERS, signal: controller.signal, cache: 'no-store' });
        // Consume the body within the timeout, including when the native proxy stalls mid-image.
        const body = response.status === 204 ? null : response.headers.get('Content-Type')?.includes('image/jpeg') ? await response.blob() : await response.json().catch(() => null);
        return { response, body };
      } finally { clearTimeout(timeout); if (pending === controller) pending = null; }
    }
    async function loop() {
      if (running) return;
      running = true;
      try {
        while (visible()) {
          try {
            if (!state || Date.now() - lastState >= 250) {
              const { response, body } = await fetchWithTimeout(`state?${query}`);
              if (!response.ok || !body?.state) throw new Error('offline');
              if (!visible()) break;
              state = body;
              if (body.sequence < sequence || body.state !== 'streaming') sequence = 0;
              lastState = Date.now();
              render();
            }
            if (state.state === 'streaming') {
              const { response, body } = await fetchWithTimeout(`frame?${query}&after=${sequence}`);
              if (!response.ok) throw new Error('offline');
              if (!visible()) break;
              if (body instanceof Blob) {
                const url = URL.createObjectURL(body);
                const next = new Image(); next.src = url;
                try {
                  if (next.decode) await next.decode();
                  else await new Promise((resolve, reject) => { next.onload = resolve; next.onerror = reject; });
                } catch { URL.revokeObjectURL(url); throw new Error('invalid image'); }
                if (!visible()) { URL.revokeObjectURL(url); break; }
                const old = imageUrl;
                imageUrl = url;
                image.src = url;
                image.hidden = false;
                lastPicture = Date.now();
                sequence = Number(response.headers.get('X-PhoneBox-Sequence')) || sequence;
                if (old) URL.revokeObjectURL(old);
              }
              render();
            } else await new Promise(resolve => setTimeout(resolve, 250));
          } catch {
            state = { state: 'disconnected' };
            lastState = 0;
            render();
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
      } finally { running = false; if (!visible()) { clear(); state = null; sequence = 0; } }
    }
    for (const [action, symbol, label] of [['previous', '⏮', 'previous'], ['playpause', '▶', 'play'], ['next', '⏭', 'next']]) {
      const button = h('button', 'youtube-button', symbol);
      button.type = 'button'; button.disabled = true;
      button.setAttribute('aria-label', t('w.youtube.' + label));
      button.addEventListener('click', async () => {
        if (commandBusy || button.disabled) return;
        commandBusy = true; render();
        try {
          const ctl = new AbortController(), timeout = setTimeout(() => ctl.abort(), 3000);
          try { await fetch(`${API}/youtube/command?${query}&action=${action}`, { method: 'POST', headers: PANEL_HEADERS, signal: ctl.signal }); }
          finally { clearTimeout(timeout); }
        } catch { }
        finally { commandBusy = false; lastState = 0; render(); }
      });
      buttons[action] = button;
      controls.append(button);
    }
    stage.append(image, note); box.append(stage, title, controls);
    image.hidden = true;
    const pause = () => { if (!visible()) { pending?.abort(); clear(); } else void loop(); };
    document.addEventListener('visibilitychange', pause);
    render();
    return {
      update() { if (visible()) { void loop(); if (state) render(); } else { pending?.abort(); clear(); } },
      destroy() { alive = false; pending?.abort(); clear(); document.removeEventListener('visibilitychange', pause); },
    };
  },
};
