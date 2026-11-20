const { test, expect } = require('@playwright/test');

test('motion stays near 60 Hz on fast displays, sleeps when hidden and releases destroyed subscriptions', async ({ page }) => {
  await page.route('**/animation-clock-test', route => route.fulfill({ contentType: 'text/html', body: '<body></body>' }));
  await page.goto('/animation-clock-test');
  const result = await page.evaluate(async () => {
    let callbacks = new Map(), serial = 0;
    window.requestAnimationFrame = fn => { callbacks.set(++serial, fn); return serial; };
    window.cancelAnimationFrame = id => callbacks.delete(id);
    const { createAnimation, refreshAnimations, pauseAnimations } = await import('/panel/animation.js');
    const tick = time => { const batch = [...callbacks.values()]; callbacks.clear(); batch.forEach(fn => fn(time)); };
    const rates = [];
    for (const hz of [60, 120, 144]) {
      let count = 0, elapsed = 0;
      const motion = createAnimation((now, dt) => { count++; elapsed += dt; return true; });
      motion.request();
      for (let i = 0; i <= hz; i++) tick(1000 + i * 1000 / hz);
      rates.push({ count, elapsed });
      motion.destroy();
    }
    let shown = true, deltas = [];
    const motion = createAnimation((now, dt) => { deltas.push(dt); return true; }, () => shown);
    motion.request(); tick(3000); tick(3017);
    shown = false; refreshAnimations();
    const hiddenCallbacks = callbacks.size;
    shown = true; refreshAnimations(); tick(9000);
    const resumedDelta = deltas.at(-1);
    pauseAnimations(true);
    const pausedCallbacks = callbacks.size;
    pauseAnimations(false); tick(15000);
    const unpausedDelta = deltas.at(-1);
    motion.destroy(); motion.request();
    return { rates, hiddenCallbacks, pausedCallbacks, resumedDelta, unpausedDelta, destroyedCallbacks: callbacks.size };
  });
  for (const rate of result.rates) {
    expect(rate.count).toBeGreaterThanOrEqual(59);
    expect(rate.count).toBeLessThanOrEqual(61);
    expect(rate.elapsed).toBeGreaterThan(.97);
    expect(rate.elapsed).toBeLessThanOrEqual(1.01);
  }
  expect(result).toMatchObject({ hiddenCallbacks: 0, pausedCallbacks: 0, resumedDelta: 0, unpausedDelta: 0, destroyedCallbacks: 0 });
});

async function show(page) {
  await page.addInitScript(() => {
    const config = JSON.stringify({ night: { enabled: false }, rules: [], shortcuts: [], pages: [
      { id: 'motion', title: 'Motion', widgets: [
        { id: 'media', type: 'media', x: 0, y: 0, w: 8, h: 4 },
        { id: 'meters', type: 'meters', x: 8, y: 0, w: 4, h: 4 },
        { id: 'stopwatch', type: 'stopwatch', x: 0, y: 4, w: 6, h: 2 },
        { id: 'gauge', type: 'gauge', x: 6, y: 4, w: 6, h: 2, options: { metric: 'cpu' } },
      ] },
      { id: 'other', title: 'Other', widgets: [{ id: 'clock', type: 'clock', x: 0, y: 0, w: 12, h: 6 }] },
    ] });
    localStorage.setItem('cfg', config); localStorage.setItem('pb-demo-config', config);
  });
  await page.goto('/panel/');
  await expect(page.locator('.w-media')).toBeVisible();
  await page.evaluate(async () => {
    const main = await import('/panel/main.js');
    const fetch = window.fetch;
    window.fetch = (url, options) => String(url).includes('/api/state')
      ? Promise.resolve(Response.json(main.D.state)) : fetch(url, options);
    window.__motionApply = (extra = {}) => main.applyState({
      ts: 9e12 + (window.__motionSequence = (window.__motionSequence || 0) + 1), evSeq: 0,
      media: { app: 'Spotify', title: 'Motion test', artist: 'Test', playing: true, posMs: 30000, durMs: 200000, canSeek: true, ageMs: 0, ...extra },
      pc: { cpu: 35, ramUsedGb: 8, ramTotalGb: 16, uptimeSec: 100, disks: [] },
    });
    window.__motionApply();
  });
  await expect(page.locator('.m-title')).toHaveText('Motion test');
}

async function movement(page, duration = 400) {
  return page.locator('.w-media .fill').evaluate((el, duration) => new Promise(resolve => {
    let writes = 0;
    const observer = new MutationObserver(records => writes += records.length);
    observer.observe(el, { attributes: true, attributeFilter: ['style'] });
    setTimeout(() => { observer.disconnect(); resolve(writes); }, duration);
  }), duration);
}

test('media moves between data packets, freezes on pause and resumes at current time', async ({ page }) => {
  await show(page);
  expect(await movement(page)).toBeGreaterThan(10);
  await page.evaluate(() => window.__motionApply({ playing: false }));
  // A paused track paints its anchor once, then stops requesting animation frames.
  await page.waitForTimeout(60);
  expect(await movement(page)).toBe(0);
  await page.evaluate(() => window.__motionApply());
  await expect.poll(() => movement(page)).toBeGreaterThan(10);
  await page.evaluate(() => window.onAppPause(true));
  expect(await movement(page)).toBe(0);
  await page.waitForTimeout(500);
  await page.evaluate(() => window.onAppPause(false));
  expect(await movement(page)).toBeGreaterThan(10);
});

test('neighbouring pages stop moving, night mode sleeps and meter nodes survive telemetry updates', async ({ page }) => {
  await show(page);
  const sameMeter = await page.evaluate(async () => {
    const old = document.querySelector('.w-meters .track i');
    window.__motionApply();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return old === document.querySelector('.w-meters .track i');
  });
  expect(sameMeter).toBe(true);
  await page.evaluate(async () => (await import('/panel/main.js')).goPage(1, true));
  expect(await movement(page)).toBe(0);
  await page.evaluate(async () => (await import('/panel/main.js')).goPage(0, true));
  expect(await movement(page)).toBeGreaterThan(10);
  await page.evaluate(async () => { const main = await import('/panel/main.js'); main.cfg.night = { enabled: true, start: '00:00', end: '23:59' }; main.setNight(true); });
  expect(await movement(page)).toBe(0);
  await page.evaluate(async () => { const main = await import('/panel/main.js'); main.cfg.night.enabled = false; main.setNight(false); });
  expect(await movement(page)).toBeGreaterThan(10);
});

test('gauge updates retain the animated circle and duplicate meter names stay bounded', async ({ page }) => {
  await show(page);
  const result = await page.evaluate(async () => {
    const main = await import('/panel/main.js');
    const { syncMeters } = await import('/panel/widgets/helpers.js');
    const circle = document.querySelector('.w-gauge .fg');
    main.D.state.pc.cpu = 80; main.emit('state');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const root = document.createElement('div');
    const items = [{ name: 'GPU', txt: '1 GB', pct: 10 }, { name: 'GPU', txt: '2 GB', pct: 20 }];
    syncMeters(root, items);
    const first = root.firstChild;
    for (let i = 0; i < 10; i++) syncMeters(root, items);
    return { retained: circle === document.querySelector('.w-gauge .fg'),
      offset: Number(circle.getAttribute('stroke-dashoffset')), rows: root.children.length, firstRetained: first === root.firstChild };
  });
  expect(result).toMatchObject({ retained: true, rows: 2, firstRetained: true });
  expect(result.offset).toBeCloseTo(52.8, 1);
});

test('Smart Stack media sleeps in inactive cards and stops after destruction', async ({ page }) => {
  await show(page);
  const result = await page.evaluate(async () => {
    const main = await import('/panel/main.js'), { W } = await import('/panel/registry.js');
    const box = document.createElement('div');
    box.className = 'w w-stack';
    box.style.cssText = 'position:fixed;left:0;top:0;width:500px;height:300px;z-index:100';
    document.body.append(box);
    const stack = W.stack.create(box, { page: main.pages[main.curPage], w: { id: 'temporary-stack' },
      o: { interval: 0, widgets: [{ type: 'clock' }, { type: 'media' }] } });
    stack.update('state');
    const fill = box.querySelector('.w-media .fill');
    let writes = 0;
    const observer = new MutationObserver(records => writes += records.length);
    observer.observe(fill, { attributes: true, attributeFilter: ['style'] });
    const count = async () => { writes = 0; await new Promise(resolve => setTimeout(resolve, 300)); return writes; };
    const hidden = await count();
    box.querySelectorAll('.stack-dot')[1].click();
    const active = await count();
    box.querySelectorAll('.stack-dot')[0].click();
    const hiddenAgain = await count();
    box.querySelectorAll('.stack-dot')[1].click();
    stack.destroy();
    // Leave the node connected: destruction itself must cancel its frame subscription.
    await new Promise(resolve => setTimeout(resolve, 40));
    const destroyed = await count();
    observer.disconnect(); box.remove();
    return { hidden, active, hiddenAgain, destroyed };
  });
  expect(result).toMatchObject({ hidden: 0, hiddenAgain: 0, destroyed: 0 });
  expect(result.active).toBeGreaterThan(8);
});
