const { test, expect } = require('@playwright/test');
const widget = { id: 'wave', type: 'audio-waveform', x: 0, y: 0, w: 12, h: 6, options: {} };
async function show(page, pages = [{ id: 'audio', widgets: [widget] }]) {
  await page.goto('/panel/');
  await page.evaluate(pages => {
    localStorage.clear(); localStorage.setItem('pb-demo-config', JSON.stringify({
      night: { enabled: false }, display: { idleReturnSec: 0 }, rules: [], shortcuts: [], pages,
    }));
  }, pages);
  await page.reload();
}

test('waveform defaults to 1 s, renders both lanes, time scale and 0 dBFS marks', async ({ page }) => {
  await page.addInitScript(() => {
    window.__waveText = [];
    const text = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (s, ...args) { window.__waveText.push(s); return text.call(this, s, ...args); };
    const rect = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function (...args) {
      if (this.fillStyle === '#ff526d') window.__clipMarks = (window.__clipMarks || 0) + 1;
      return rect.apply(this, args);
    };
  });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await show(page);
  await expect(page.getByLabel('Waveform visible interval')).toHaveValue('1000');
  await expect(page.locator('.aw-info')).toContainText('48 kHz · 1 s');
  await expect(page.locator('.aw-message')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__clipMarks || 0)).toBeGreaterThan(0);
  const text = await page.evaluate(() => window.__waveText);
  for (const value of ['L', 'R', '-1 s', '0 s', '0 dBFS']) expect(text).toContain(value);
  await page.getByLabel('Waveform channels').selectOption('ms');
  await expect.poll(() => page.evaluate(() => window.__waveText.includes('Mid') && window.__waveText.includes('Side'))).toBe(true);
  expect(errors).toEqual([]);
});

test('all visible intervals work, with numeric saved settings', async ({ page }) => {
  await show(page, [{ id: 'audio', widgets: [{ ...widget, options: { interval: 50, mode: 'ms' } }] }]);
  await expect(page.getByLabel('Waveform visible interval')).toHaveValue('50');
  await expect(page.getByLabel('Waveform channels')).toHaveValue('ms');
  for (const [value, label] of [[10, '10 ms'], [50, '50 ms'], [100, '100 ms'], [500, '500 ms'], [1000, '1 s'], [5000, '5 s'], [10000, '10 s']]) {
    await page.getByLabel('Waveform visible interval').selectOption(String(value));
    await expect(page.locator('.aw-info')).toContainText(`· ${label} ·`);
    await expect(page.locator('.aw-message')).toBeHidden();
  }
});

test('freeze preserves the canvas through pushed errors, resume receives fresh data', async ({ page }) => {
  await show(page); await expect(page.locator('.aw-info')).toContainText('48 kHz');
  await page.getByRole('button', { name: 'Freeze', exact: true }).click();
  await expect(page.locator('.aw-status')).toHaveText('Frozen');
  const canvas = page.locator('.aw-plot canvas');
  await page.waitForTimeout(100);
  const frozen = await canvas.evaluate(c => c.toDataURL());
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('phonebox-audio-waveform', { detail: {
    key: 'wave:1000:', timestamp: Date.now() + 1000, sequence: 9999, intervalMs: 1000, state: 'unavailable', min: [], max: [],
  } })));
  await page.waitForTimeout(200);
  expect(await canvas.evaluate(c => c.toDataURL())).toBe(frozen);
  await expect(page.locator('.aw-message')).toBeHidden();
  await expect(page.locator('.aw-status')).toHaveText('Frozen');
  await page.getByRole('button', { name: 'Resume' }).click();
  await expect.poll(() => canvas.evaluate(c => c.toDataURL())).not.toBe(frozen);
});

test('hidden pages and stack cards do not renew the capture lease', async ({ page }) => {
  await show(page, [{ id: 'home', widgets: [{ id: 'c', type: 'clock', w: 12, h: 6 }] }, { id: 'audio', widgets: [widget] }]);
  await page.evaluate(() => {
    window.__waveRequests = 0; const fetch = window.fetch;
    window.fetch = (url, init) => { if (String(url).includes('/api/audio-waveform')) window.__waveRequests++; return fetch(url, init); };
  });
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => window.__waveRequests)).toBe(0);
  await show(page, [{ id: 'audio', widgets: [{ id: 'stack', type: 'stack', w: 12, h: 6,
    options: { interval: 0, widgets: [{ type: 'clock' }, { type: 'audio-waveform' }] } }] }]);
  await expect(page.locator('.aw-info')).not.toContainText('48 kHz');
  await page.getByRole('button', { name: 'audio-waveform', exact: true }).click();
  await expect(page.locator('.aw-info')).toContainText('48 kHz');
});

test('unknown widget is rejected and stale or unrelated stream frames are ignored', async ({ page }) => {
  await show(page); await expect(page.locator('.aw-info')).toContainText('48 kHz');
  const response = await page.evaluate(async () => (await fetch('/api/audio-waveform?widget=audio/missing')).json());
  expect(response.shown).toBe(false);
  await page.evaluate(() => {
    const fetch = window.fetch;
    window.fetch = (url, init) => String(url).includes('/api/audio-waveform') ? new Promise(() => {}) : fetch(url, init);
    const send = detail => window.dispatchEvent(new CustomEvent('phonebox-audio-waveform', { detail }));
    send({ key: 'wave:1000:', timestamp: Date.now() + 1000, sequence: 999, intervalMs: 1000, state: 'unavailable' });
    send({ key: 'wave:50:', timestamp: Date.now() + 2000, sequence: 1000, intervalMs: 50, state: 'unsupported' });
    send({ key: 'wave:1000:', timestamp: 1, sequence: 1, intervalMs: 1000, state: 'unsupported' });
  });
  await expect(page.locator('.aw-message')).toHaveText('Output unavailable — retrying…');
});

test('waveform fits portrait and landscape, expands and closes', async ({ page }, testInfo) => {
  for (const viewport of [{ width: 780, height: 360 }, { width: 390, height: 740 }]) {
    await page.setViewportSize(viewport); await show(page);
    await expect(page.locator('.aw-info')).toContainText('48 kHz');
    const plot = await page.locator('.aw-plot').boundingBox();
    expect(plot.width).toBeGreaterThan(240); expect(plot.height).toBeGreaterThan(80);
    await page.screenshot({ path: testInfo.outputPath(`waveform-${viewport.width}.png`) });
    await page.getByRole('button', { name: 'Expand waveform' }).click();
    await expect(page.locator('.w-audio-waveform')).toHaveClass(/as-expanded/);
    await page.keyboard.press('Escape');
    await expect(page.locator('.w-audio-waveform')).not.toHaveClass(/as-expanded/);
  }
});
