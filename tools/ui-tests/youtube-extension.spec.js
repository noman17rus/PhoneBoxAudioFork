const { test, expect, chromium } = require('@playwright/test');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A real Chromium extension/capture test. The page is a local synthetic player at
// a routed YouTube origin; no account, remote video, or user's browser profile is used.
test('Chrome keeps capture armed across focus changes and streams the hidden tab', async () => {
  test.setTimeout(60_000);
  const extensionPath = path.resolve(__dirname, '../../extensions/phonebox-youtube');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'phonebox-youtube-chrome-'));
  let context, state = null, frames = 0, lastFrame = null, lastFrameAt = 0, lastCapturedAt = 0, commands = [], stopped = false;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname.endsWith('/poll')) {
      state = JSON.parse(body);
      res.end(JSON.stringify({ capture: state.hidden && state.hasVideo, commands: commands.splice(0) }));
    } else if (url.pathname.endsWith('/frame')) {
      frames++; lastFrame = body; lastFrameAt = Date.now(); lastCapturedAt = Number(req.headers['x-phonebox-captured-at']); res.end('{}');
    } else if (url.pathname.endsWith('/stop')) { stopped = true; res.end('{}'); }
    else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = 'http://127.0.0.1:' + server.address().port;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: true, viewport: null,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--enable-unsafe-extension-debugging'],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    await worker.evaluate(async agent => { await chrome.storage.local.set({ agent, token: 'test-key' }); }, agent);
    const video = await context.newPage();
    await video.route('https://www.youtube.com/**', route => route.fulfill({ contentType: 'text/html', body: `
      <!doctype html><title>Capture fixture - YouTube</title>
      <style>body{margin:0}video{display:block;width:640px;height:360px}</style>
      <h1 class="ytd-watch-metadata">Capture fixture</h1>
      <div id="movie_player"><video class="html5-main-video" muted playsinline></video>
      <button class="ytp-prev-button" disabled>Previous</button><button class="ytp-next-button" onclick="window.nextCount=(window.nextCount||0)+1">Next</button></div>
      <script>
      const canvas=document.createElement('canvas'); canvas.width=640;canvas.height=360;
      const ctx=canvas.getContext('2d'); let count=0;
      const clockWorker = new Worker(URL.createObjectURL(new Blob(['setInterval(()=>postMessage(0),33)'], {type:'text/javascript'})));
      clockWorker.onmessage=()=>{ctx.fillStyle=count++%2?'#d22':'#2d2';ctx.fillRect(0,0,640,360);
        const stamp=Date.now()%65536;
        for(let bit=0;bit<16;bit++){ctx.fillStyle=(stamp>>bit)&1?'#fff':'#000';ctx.fillRect(bit*20,0,20,20)}
      };
      const player=document.querySelector('video'); player.srcObject=canvas.captureStream(30); player.play();
      </script>` }));
    await video.goto('https://www.youtube.com/watch?v=phoneboxtest');
    await video.bringToFront();
    await expect.poll(() => video.evaluate(() => document.querySelector('video').readyState)).toBeGreaterThanOrEqual(2);
    const browserCdp = await context.browser().newBrowserCDPSession();
    const { targetInfos } = await browserCdp.send('Target.getTargets', { filter: [{ type: 'tab' }] });
    const tabTarget = targetInfos.find(target => target.url === video.url());
    if (!tabTarget) throw new Error('No Chrome tab target for the capture fixture');
    await browserCdp.send('Extensions.triggerAction', { id: extensionId, targetId: tabTarget.targetId });
    await expect.poll(() => state?.hasVideo, { message: 'Extension should start capture and report the selected player' }).toBe(true);
    await expect.poll(() => state?.hidden).toBe(false);
    expect(frames).toBe(0);
    const session = state.session;

    const other = await context.newPage(); await other.goto('about:blank'); await other.bringToFront();
    await expect.poll(() => frames, { timeout: 12_000 }).toBeGreaterThan(2);
    expect(state.session).toBe(session);
    expect(lastFrame[0]).toBe(0xff); expect(lastFrame[1]).toBe(0xd8);
    await test.info().attach('captured.jpeg', { body: lastFrame, contentType: 'image/jpeg' });
    const latency = await other.evaluate(async ({ base64, receivedAt }) => {
      const image = new Image(); image.src = 'data:image/jpeg;base64,' + base64; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      let stamp = 0;
      for (let bit = 0; bit < 16; bit++) if (ctx.getImageData(Math.round((bit * 20 + 10) * image.width / 640), Math.round(10 * image.height / 360), 1, 1).data[0] > 127) stamp |= 1 << bit;
      return (receivedAt % 65536 - stamp + 98304) % 65536 - 32768;
    }, { base64: lastFrame.toString('base64'), receivedAt: lastCapturedAt });
    console.log('Synthetic video age at encoder:', latency, 'ms; encoder to server:', lastFrameAt - lastCapturedAt, 'ms');
    expect(latency).toBeGreaterThan(-100);
    expect(latency).toBeLessThan(1000); // CI tolerance; phone acceptance target is 250 ms.
    commands.push({ session, action: 'next', expires: new Date(Date.now() + 2000).toISOString() });
    await expect.poll(() => video.evaluate(() => window.nextCount || 0)).toBe(1);
    commands.push({ session, action: 'playpause', expires: new Date(Date.now() + 2000).toISOString() });
    await expect.poll(() => video.evaluate(() => document.querySelector('video').paused)).toBe(true);
    commands.push({ session, action: 'playpause', expires: new Date(Date.now() + 2000).toISOString() });
    await expect.poll(() => video.evaluate(() => document.querySelector('video').paused)).toBe(false);

    await video.bringToFront();
    await expect.poll(() => state?.hidden).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 400));
    const before = frames;
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(frames).toBe(before);
    await other.bringToFront();
    await expect.poll(() => frames).toBeGreaterThan(before);
    expect(state.session).toBe(session); // No second toolbar gesture.

    await video.bringToFront();
    await expect.poll(() => state?.hidden).toBe(false);
    const pageCdp = await context.newCDPSession(video);
    const { windowId } = await pageCdp.send('Browser.getWindowForTarget');
    await browserCdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await expect.poll(() => state?.hidden).toBe(true);
    const minimizedFrames = frames;
    await expect.poll(() => frames).toBeGreaterThan(minimizedFrames + 2);
    const priorImage = lastFrame;
    await expect.poll(() => !lastFrame.equals(priorImage)).toBe(true);
    await browserCdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });

    await video.close();
    await expect.poll(() => stopped).toBe(true);
    await expect.poll(() => worker.evaluate(async () => (await chrome.storage.session.get('selected')).selected)).toBeUndefined();
  } finally {
    await context?.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
