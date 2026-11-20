const { test, expect } = require('@playwright/test');

const widget = { id: 'fft', type: 'audio-spectrum', x: 0, y: 0, w: 12, h: 6, options: {} };
async function show(page, pages = [{ id: 'audio', title: 'Audio', widgets: [widget] }]) {
  await page.goto('/panel/');
  await page.evaluate(pages => {
    localStorage.clear();
    localStorage.setItem('pb-demo-config', JSON.stringify({ night: { enabled: false }, rules: [], shortcuts: [],
      display: { idleReturnSec: 0 }, pages }));
  }, pages);
  await page.reload();
}

test('spectrum renders with default FFT and adjustable tilt, channels, peaks and freeze', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await show(page);
  await expect(page.locator('.as-info')).toContainText('FFT 8192');
  await expect(page.locator('.as-message')).toBeHidden();
  const canvas = page.locator('.as-plot canvas');
  expect(await canvas.evaluate(c => c.width > 0 && c.height > 80)).toBe(true);
  await page.getByLabel('Spectrum channels').selectOption('ms');
  await page.getByLabel('Spectrum slope in dB per octave').fill('-2.5');
  await expect(page.locator('.as-tilt-value')).toHaveText('-2.5 dB/oct');
  await page.getByRole('button', { name: 'Peak hold' }).click();
  await expect(page.getByRole('button', { name: 'Peak hold' })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Freeze' }).click();
  await expect(page.getByRole('button', { name: 'Resume' })).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(150);
  const frozen = await canvas.evaluate(c => c.toDataURL());
  await page.waitForTimeout(200);
  expect(await canvas.evaluate(c => c.toDataURL())).toBe(frozen);
  await page.getByRole('button', { name: 'Resume' }).click();
  await expect(page.locator('.as-info')).toContainText('48 kHz');
  expect(errors).toEqual([]);
});

test('saved FFT and averaging choices work, including numeric imports', async ({ page }) => {
  await show(page, [{ id: 'audio', widgets: [{ ...widget, options: { fft: '16384', average: '1000' } }] }]);
  await expect(page.locator('.as-info')).toContainText('FFT 16384');
  await expect(page.locator('.as-info')).toContainText('avg 1000 ms');
  const result = await page.evaluate(async () => (await fetch('/api/audio-spectrum?widget=audio/fft')).json());
  expect(result.frame.curves).toHaveLength(5);
  expect(result.frame.frequencies).toHaveLength(512);
});

test('tilt changes the graph while the cursor retains the raw dBFS measurement', async ({ page }) => {
  await page.addInitScript(() => {
    const drawText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, ...rest) {
      if (String(text).endsWith('(raw)')) window.__rawSpectrumReadout = text;
      return drawText.call(this, text, ...rest);
    };
  });
  await show(page);
  await expect(page.locator('.as-info')).toContainText('FFT 8192');
  await page.getByRole('button', { name: 'Freeze' }).click();
  const canvas = page.locator('.as-plot canvas');
  const bounds = await canvas.boundingBox();
  await page.mouse.move(bounds.x + bounds.width * .72, bounds.y + 60);
  await expect.poll(() => page.evaluate(() => window.__rawSpectrumReadout)).toContain('dBFS');
  const before = await page.evaluate(() => window.__rawSpectrumReadout);
  const image = await canvas.evaluate(c => c.toDataURL());
  await page.getByLabel('Spectrum slope in dB per octave').fill('-6');
  await expect.poll(() => canvas.evaluate(c => c.toDataURL())).not.toBe(image);
  expect(await page.evaluate(() => window.__rawSpectrumReadout)).toBe(before);
});

test('unknown or disabled widgets cannot request analysis', async ({ page }) => {
  await show(page);
  const result = await page.evaluate(async () => (await fetch('/api/audio-spectrum?widget=audio/missing')).json());
  expect(result.shown).toBe(false);
  expect(result.frame).toBeNull();
});

test('expanded spectrum fits the viewport and closes with Escape', async ({ page }) => {
  await show(page);
  await expect(page.locator('.as-info')).toContainText('FFT');
  await page.getByRole('button', { name: 'Expand spectrum' }).click();
  await expect(page.locator('.w-audio-spectrum')).toHaveClass(/as-expanded/);
  const bounds = await page.locator('.w-audio-spectrum').boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.y).toBeGreaterThanOrEqual(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.w-audio-spectrum')).not.toHaveClass(/as-expanded/);
});

test('multiple spectra with different FFT profiles remain independent', async ({ page }) => {
  await show(page, [{ id: 'audio', widgets: [
    { ...widget, w: 6, options: { fft: 4096 } },
    { ...widget, id: 'fft2', x: 6, w: 6, options: { fft: 16384 } },
  ] }]);
  await expect(page.locator('.as-info').nth(0)).toContainText('FFT 4096');
  await expect(page.locator('.as-info').nth(1)).toContainText('FFT 16384');
});

async function countRequests(page) {
  await page.evaluate(() => {
    window.__asks = 0;
    const original = window.fetch;
    window.fetch = (url, init) => { if (String(url).includes('/api/audio-spectrum')) window.__asks++; return original(url, init); };
  });
  await page.waitForTimeout(800);
  return page.evaluate(() => window.__asks);
}

test('another page and the night screen do not keep capture alive', async ({ page }) => {
  await show(page, [{ id: 'home', widgets: [{ id: 'c', type: 'clock', w: 12, h: 6 }] }, { id: 'audio', widgets: [widget] }]);
  expect(await countRequests(page)).toBe(0);
  await show(page);
  expect(await countRequests(page)).toBeGreaterThan(0);
  await page.evaluate(() => document.body.classList.add('night'));
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => window.__asks);
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => window.__asks)).toBe(before);
});

test('hidden Smart Stack card does not ask until selected', async ({ page }) => {
  await show(page, [{ id: 'audio', widgets: [{ id: 'stack', type: 'stack', w: 12, h: 6,
    options: { interval: 0, widgets: [{ type: 'clock' }, { type: 'audio-spectrum' }] } }] }]);
  expect(await countRequests(page)).toBe(0);
  await page.getByRole('button', { name: 'audio-spectrum', exact: true }).click();
  await expect(page.locator('.as-info')).toContainText('FFT 8192');
});

test('stream status events clear stale traces and unrelated profiles are ignored', async ({ page }) => {
  await show(page);
  await expect(page.locator('.as-info')).toContainText('FFT');
  await page.evaluate(() => {
    // Hold HTTP replies so this test observes only the next pushed status.
    const original = window.fetch;
    window.fetch = (url, init) => String(url).includes('/api/audio-spectrum') ? new Promise(() => {}) : original(url, init);
    window.dispatchEvent(new CustomEvent('phonebox-audio-spectrum', { detail: {
      key: '8192:300:', timestamp: Date.now() + 1000, sequence: 999, state: 'unavailable', curves: [], frequencies: [],
    } }));
  });
  await expect(page.locator('.as-message')).toHaveText('Output unavailable — retrying…');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('phonebox-audio-spectrum', { detail: {
    key: 'other-profile', timestamp: Date.now() + 2000, sequence: 1000, state: 'unsupported',
  } })));
  await expect(page.locator('.as-message')).toHaveText('Output unavailable — retrying…');
});

test('small and large spectrum layouts have usable graph space', async ({ page }, testInfo) => {
  for (const viewport of [{ width: 780, height: 360 }, { width: 390, height: 740 }]) {
    await page.setViewportSize(viewport);
    await show(page);
    await expect(page.locator('.as-info')).toContainText('FFT');
    const plot = await page.locator('.as-plot').boundingBox();
    expect(plot.width).toBeGreaterThan(240); expect(plot.height).toBeGreaterThan(80);
    await page.screenshot({ path: testInfo.outputPath(`spectrum-${viewport.width}.png`) });
  }
});
