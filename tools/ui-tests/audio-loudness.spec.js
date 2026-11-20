const { test, expect } = require('@playwright/test');
const widget = { id: 'loud', type: 'audio-loudness', x: 0, y: 0, w: 12, h: 6, options: {} };
async function show(page, pages = [{ id: 'audio', widgets: [widget] }]) {
  await page.goto('/panel/');
  await page.evaluate(pages => {
    localStorage.clear(); localStorage.setItem('pb-demo-config', JSON.stringify({
      night: { enabled: false }, display: { idleReturnSec: 0 }, rules: [], shortcuts: [], pages,
    }));
  }, pages);
  await page.reload();
}
const output = (page, field) => page.locator(`.lm-body output[data-field="${field}"]`);

test('displays separate L/R levels, LUFS, maxima and resets the server session', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await show(page);
  await expect(page.locator('.lm-info')).toContainText('48 kHz');
  await expect(output(page, 'samplePeak-0')).toHaveText('-12.0');
  await expect(output(page, 'rms-1')).toHaveText('-18.0');
  await expect(output(page, 'truePeak-0')).toHaveText('-11.9');
  await expect(output(page, 'maxTruePeak-1')).toHaveText('-12.9');
  await expect(output(page, 'shortTerm')).toHaveText('-23.0');
  await page.evaluate(() => {
    const fetch = window.fetch;
    window.fetch = (url, init) => { if (String(url).includes('/api/audio-loudness/reset')) window.__resetMethod = init?.method; return fetch(url, init); };
  });
  await page.getByRole('button', { name: 'Reset session' }).click();
  await expect.poll(() => page.evaluate(() => window.__resetMethod)).toBe('POST');
  await expect(output(page, 'shortTerm')).not.toHaveText('-23.0');
  expect(errors).toEqual([]);
});

test('rejects stale and unrelated frames, clears unavailable values and marks overs', async ({ page }) => {
  await show(page); await expect(page.locator('.lm-info')).toContainText('48 kHz');
  await page.evaluate(() => {
    const fetch = window.fetch;
    window.fetch = (url, init) => String(url).includes('/api/audio-loudness') ? new Promise(() => {}) : fetch(url, init);
    const send = detail => window.dispatchEvent(new CustomEvent('phonebox-audio-loudness', { detail }));
    const frame = { key: 'loud::audio/loud:', timestamp: Date.now() + 2000, sequence: 10000, state: 'silent', channels: 2,
      deviceName: 'Test output', sampleRate: 48000, values: { samplePeak: [null, null], rms: [null, null],
        truePeak: [null, null], maxSamplePeak: [-1, -2], maxRms: [-4, -5], maxTruePeak: [1.2, -.5],
        momentary: null, shortTerm: null, integrated: -23, maxMomentary: -19, maxShortTerm: -21, seconds: 10 } };
    send(frame);
    send({ ...frame, timestamp: 1, sequence: 1, state: 'unsupported' });
    send({ ...frame, key: 'other', timestamp: Date.now() + 3000, state: 'unsupported' });
  });
  await expect(page.locator('.lm-status')).toHaveText('Silence');
  await expect(output(page, 'samplePeak-0')).toHaveText('−∞');
  await expect(output(page, 'integrated')).toHaveText('-23.0');
  await expect(output(page, 'maxTruePeak-0')).toHaveClass(/lm-over/);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('phonebox-audio-loudness', { detail: {
    key: 'loud::audio/loud:', timestamp: Date.now() + 4000, sequence: 20000, state: 'unavailable', values: null,
  } })));
  await expect(output(page, 'integrated')).toHaveText('—');
});

test('a delayed GET cannot restore pre-reset measurements', async ({ page }) => {
  await show(page); await expect(page.locator('.lm-info')).toContainText('48 kHz');
  await page.evaluate(() => {
    const fetch = window.fetch;
    window.fetch = async (url, init) => {
      if (String(url).includes('/api/audio-loudness?')) {
        const response = await fetch(url, init);
        await new Promise(resolve => { window.__releaseLoudness = resolve; });
        return response;
      }
      return fetch(url, init);
    };
  });
  await expect.poll(() => page.evaluate(() => !!window.__releaseLoudness)).toBe(true);
  await page.getByRole('button', { name: 'Reset session' }).click();
  await expect(output(page, 'integrated')).toHaveText('—');
  await page.evaluate(() => window.__releaseLoudness());
  await expect(output(page, 'integrated')).not.toHaveText('-23.0');
});

test('fits portrait and landscape, and expands', async ({ page }, testInfo) => {
  for (const viewport of [{ width: 780, height: 360 }, { width: 390, height: 740 }]) {
    await page.setViewportSize(viewport); await show(page);
    await expect(page.locator('.lm-info')).toContainText('48 kHz');
    expect(await page.locator('.lm-body').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(output(page, 'shortTerm')).toHaveText('-23.0');
    await page.screenshot({ path: testInfo.outputPath(`loudness-${viewport.width}.png`) });
    await page.getByRole('button', { name: 'Expand loudness' }).click();
    await expect(page.locator('.w-audio-loudness')).toHaveClass(/as-expanded/);
    await page.keyboard.press('Escape');
    await expect(page.locator('.w-audio-loudness')).not.toHaveClass(/as-expanded/);
  }
});

test('hidden pages do not request capture and unknown reset targets are rejected', async ({ page }) => {
  await show(page, [{ id: 'home', widgets: [{ id: 'clock', type: 'clock', w: 12, h: 6 }] }, { id: 'audio', widgets: [widget] }]);
  await page.evaluate(() => {
    window.__loudRequests = 0; const fetch = window.fetch;
    window.fetch = (url, init) => { if (String(url).includes('/api/audio-loudness')) window.__loudRequests++; return fetch(url, init); };
  });
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => window.__loudRequests)).toBe(0);
  const response = await page.evaluate(async () => (await fetch('/api/audio-loudness/reset?widget=audio/missing', { method: 'POST' })).json());
  expect(response.shown).toBe(false);
});
