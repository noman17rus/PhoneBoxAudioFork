const { test, expect } = require('@playwright/test');
const widget = { id: 'stereo', type: 'audio-stereo', x: 0, y: 0, w: 12, h: 6, options: {} };
async function show(page, pages = [{ id: 'audio', widgets: [widget] }]) {
  await page.goto('/panel/');
  await page.evaluate(pages => {
    localStorage.clear(); localStorage.setItem('pb-demo-config', JSON.stringify({
      night: { enabled: false }, display: { idleReturnSec: 0 }, rules: [], shortcuts: [], pages,
    }));
  }, pages);
  await page.reload();
}

test('renders signed axes, correlation and measured energies without browser errors', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    window.__stereoLabels = [];
    const text = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (s, ...args) { window.__stereoLabels.push(s); return text.call(this, s, ...args); };
  });
  await show(page);
  await expect(page.locator('.st-info')).toContainText('48 kHz · 100 ms');
  await expect(page.locator('.st-message')).toBeHidden();
  await expect(page.getByLabel('Vectorscope afterglow')).toHaveValue('800');
  await expect(page.locator('.st-meters')).toContainText('M ');
  const labels = await page.evaluate(() => window.__stereoLabels);
  for (const value of ['Mid + · Mono', 'Mid −', 'Side +', 'Side −', 'Antiphase', 'L', 'R']) expect(labels).toContain(value);
  expect(errors).toEqual([]);
});

test('freeze preserves trace and meters, rejects stale frames, resumes and reports silence', async ({ page }) => {
  await show(page); await expect(page.locator('.st-info')).toContainText('48 kHz');
  await page.evaluate(() => {
    const fetch = window.fetch;
    window.fetch = (url, init) => String(url).includes('/api/audio-stereo') ? new Promise(() => {}) : fetch(url, init);
  });
  await page.getByRole('button', { name: 'Freeze', exact: true }).click();
  await page.waitForTimeout(100);
  const canvas = page.locator('.st-plot canvas'), frozen = await canvas.evaluate(c => c.toDataURL());
  const meters = await page.locator('.st-meters').innerText();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('phonebox-audio-stereo', { detail: {
    key: 'stereo:', timestamp: Date.now() + 1000, sequence: 9999, state: 'unavailable',
  } })));
  await page.waitForTimeout(200);
  expect(await canvas.evaluate(c => c.toDataURL())).toBe(frozen);
  expect(await page.locator('.st-meters').innerText()).toBe(meters);
  await page.getByRole('button', { name: 'Resume' }).click();
  await page.evaluate(() => {
    const send = detail => window.dispatchEvent(new CustomEvent('phonebox-audio-stereo', { detail }));
    send({ key: 'stereo:', timestamp: Date.now() + 2000, sequence: 10000, state: 'silent', windowMs: 100,
      points: [[0, 0]], correlation: null, leftDb: null, rightDb: null, leftShare: null, midShare: null });
    send({ key: 'stereo:', timestamp: 1, sequence: 1, state: 'unsupported' });
    send({ key: 'stereo:other', timestamp: Date.now() + 3000, sequence: 20000, state: 'unsupported' });
  });
  await expect(page.locator('.st-status')).toHaveText('Silence');
  await expect(page.locator('.st-meter output').first()).toHaveText('—');
  await expect(page.locator('.st-meter output').nth(1)).toHaveText('L −∞ / R −∞ dBFS');
  await expect(page.locator('.st-meter output').nth(2)).toHaveText('—');
});

test('afterglow fades when new frames stop, and known mono/antiphase points have correct axes', async ({ page }) => {
  await page.addInitScript(() => {
    window.__stereoPoints = [];
    const rect = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function (x, y, w, h) {
      if (this.fillStyle === '#42dcca') window.__stereoPoints.push([x + .7, y + .7]);
      return rect.call(this, x, y, w, h);
    };
  });
  await show(page); await expect(page.locator('.st-info')).toContainText('48 kHz');
  await page.getByLabel('Vectorscope afterglow').selectOption('250');
  await page.evaluate(() => {
    const fetch = window.fetch;
    window.fetch = (url, init) => String(url).includes('/api/audio-stereo') ? new Promise(() => {}) : fetch(url, init);
  });
  await page.waitForTimeout(500);
  const canvas = page.locator('.st-plot canvas');
  const tracePixels = () => canvas.evaluate(c => {
    const pixels = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4)
      if (pixels[i + 3] > 64 && pixels[i + 1] > 150 && pixels[i] < 100) count++;
    return count;
  });
  await expect.poll(tracePixels).toBe(0);
  for (const [point, axis] of [[[0, .8], 0], [[.8, 0], 1]]) {
    await page.evaluate(point => {
      window.__stereoPoints = [];
      window.dispatchEvent(new CustomEvent('phonebox-audio-stereo', { detail: {
        key: 'stereo:', timestamp: Date.now() + 1000, sequence: Date.now(), state: 'live', windowMs: 100,
        points: [point], correlation: 1, leftDb: -3, rightDb: -3, leftShare: .5, midShare: 1,
      } }));
    }, point);
    await expect.poll(() => page.evaluate(() => window.__stereoPoints.length)).toBeGreaterThan(0);
    const coordinates = await page.evaluate(() => window.__stereoPoints.at(-1));
    const size = await canvas.boundingBox();
    expect(coordinates[axis]).toBeCloseTo((axis === 0 ? size.width : size.height) / 2, 0);
    await expect.poll(tracePixels).toBe(0);
  }
});

test('fits portrait/landscape and expands', async ({ page }, testInfo) => {
  for (const viewport of [{ width: 780, height: 360 }, { width: 390, height: 740 }]) {
    await page.setViewportSize(viewport); await show(page);
    await expect(page.locator('.st-info')).toContainText('48 kHz');
    const plot = await page.locator('.st-plot').boundingBox();
    expect(plot.width).toBeGreaterThan(240); expect(plot.height).toBeGreaterThan(60);
    await page.screenshot({ path: testInfo.outputPath(`stereo-${viewport.width}.png`) });
    await page.getByRole('button', { name: 'Expand stereo field' }).click();
    await expect(page.locator('.w-audio-stereo')).toHaveClass(/as-expanded/);
    await page.keyboard.press('Escape');
    await expect(page.locator('.w-audio-stereo')).not.toHaveClass(/as-expanded/);
  }
});

test('hidden pages do not request capture and unknown widgets are rejected', async ({ page }) => {
  await show(page, [{ id: 'home', widgets: [{ id: 'clock', type: 'clock', w: 12, h: 6 }] }, { id: 'audio', widgets: [widget] }]);
  await page.evaluate(() => {
    window.__stereoRequests = 0; const fetch = window.fetch;
    window.fetch = (url, init) => { if (String(url).includes('/api/audio-stereo')) window.__stereoRequests++; return fetch(url, init); };
  });
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => window.__stereoRequests)).toBe(0);
  const response = await page.evaluate(async () => (await fetch('/api/audio-stereo?widget=audio/missing')).json());
  expect(response.shown).toBe(false);
});
