const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const demo = fs.readFileSync(path.resolve(__dirname, '../pages/demo.js'), 'utf8');

async function show(page) {
  await page.route('**/demo.js', route => route.fulfill({ contentType: 'text/javascript', body: demo + `
    window.__yt = { state: 'unpaired', title: '', playing: true, canPrevious: false, canNext: true, sequence: 0 };
    window.__ytCommands = []; window.__ytFrames = 0; window.__ytRequests = [];
    const ytFetch = window.fetch;
    window.fetch = async (url, options = {}) => {
      const parsed = new URL(url, location.href);
      if (!parsed.pathname.includes('/api/youtube/')) return ytFetch(url, options);
      window.__ytRequests.push(parsed.searchParams.get('widget'));
      if (parsed.pathname.endsWith('/state')) return new Response(JSON.stringify(window.__yt), { headers: { 'Content-Type': 'application/json' } });
      if (parsed.pathname.endsWith('/command')) {
        window.__ytCommands.push(parsed.searchParams.get('action'));
        return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
      }
      window.__ytFrames++;
      await new Promise(resolve => setTimeout(resolve, 40));
      if (window.__yt.state !== 'streaming' || window.__ytNoFrames) return new Response(null, { status: 204 });
      const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#d53b31'; ctx.fillRect(0, 0, 160, 90);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg'));
      return new Response(blob, { headers: { 'Content-Type': 'image/jpeg', 'X-PhoneBox-Sequence': String(++window.__yt.sequence) } });
    };
  ` }));
  await page.goto('/panel/');
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('pb-demo-config', JSON.stringify({ night: { enabled: false }, display: { idleReturnSec: 0 },
      pages: [{ id: 'p', title: 'YouTube', widgets: [{ id: 'yt', type: 'youtube', x: 0, y: 0, w: 12, h: 6 }] }] }));
  });
  await page.reload();
}

test('YouTube changes between setup, PC, video and disconnected states and sends scoped controls', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await show(page);
  await expect(page.locator('.youtube-note')).toContainText('Pair the Chrome extension');
  await page.evaluate(() => Object.assign(window.__yt, { state: 'pc', title: 'Test video' }));
  await expect(page.locator('.youtube-note')).toContainText('YouTube is open on the PC');
  await expect(page.locator('.youtube-image')).toBeHidden();
  await page.evaluate(() => { window.__yt.state = 'streaming'; });
  await expect(page.locator('.youtube-image')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Previous video' })).toBeDisabled();
  await page.getByRole('button', { name: 'Pause YouTube' }).click();
  await page.getByRole('button', { name: 'Next video' }).click();
  expect(await page.evaluate(() => window.__ytCommands)).toEqual(['playpause', 'next']);
  expect(await page.evaluate(() => [...new Set(window.__ytRequests)])).toEqual(['p/yt']);
  await page.evaluate(() => { window.__yt.state = 'pc'; });
  await expect(page.locator('.youtube-image')).toBeHidden();
  await page.evaluate(() => { window.__yt.state = 'disconnected'; });
  await expect(page.locator('.youtube-note')).toContainText('Open YouTube in Chrome');
  await expect(page.getByRole('button', { name: 'Next video' })).toBeDisabled();
  expect(errors).toEqual([]);
});

test('YouTube drops stalled images and releases resources when the widget is hidden', async ({ page }) => {
  await show(page);
  await page.evaluate(() => { window.__yt.state = 'streaming'; });
  await expect(page.locator('.youtube-image')).toBeVisible();
  await page.evaluate(() => { window.__ytNoFrames = true; });
  await expect(page.locator('.youtube-image')).toBeHidden({ timeout: 4000 });
  await expect(page.locator('.youtube-note')).toContainText('Waiting for video');
  await page.evaluate(() => { window.__ytNoFrames = false; window.__yt.sequence = 0; });
  await expect(page.locator('.youtube-image')).toBeVisible();
  await page.evaluate(() => document.body.classList.add('night'));
  await page.waitForTimeout(1100);
  const before = await page.evaluate(() => window.__ytFrames);
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.__ytFrames)).toBe(before);
  expect(await page.locator('.youtube-image').getAttribute('src')).toBeNull();
});
