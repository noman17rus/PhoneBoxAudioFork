// Run after forwarding the verified PhoneBox WebView socket with adb.
// node tools/ui-tests/android-motion.js http://127.0.0.1:9223 .temp_files/android-motion.json
const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const endpoint = process.argv[2] || 'http://127.0.0.1:9223';
  const version = await (await fetch(endpoint + '/json/version')).json();
  if (version['Android-Package'] !== 'net.oxog.phonebox.deskpanel') throw new Error('The endpoint is not PhoneBox');
  const browser = await chromium.connectOverCDP(endpoint);
  const page = browser.contexts()[0].pages().find(p => p.url().startsWith('https://appassets.androidplatform.net/assets/www/'));
  if (!page) throw new Error('PhoneBox panel not found');
  const initial = await page.evaluate(async () => {
    const m = await import('./main.js');
    if (m.idle() || m.nightOn) throw new Error('Show the awake PhoneBox panel before measuring');
    return { index: m.curPage, pages: m.pages.map(p => p.widgets.map(w => w.type)) };
  });
  const report = { browser: version.Browser, userAgent: version['User-Agent'], samples: [] };
  try {
    const media = initial.pages.findIndex((types, i) => i !== initial.index && types.includes('media'));
    const meters = initial.pages.findIndex(types => types.includes('meters'));
    const indices = [...new Set([initial.index, media, meters].filter(i => i >= 0))];
    for (const index of indices) {
      await page.evaluate(async i => (await import('./main.js')).goPage(i, true), index);
      await page.waitForTimeout(1200);
      report.samples.push(await measure(page, { index, types: initial.pages[index] }));
    }
    if (initial.pages.length > 1) {
      await page.evaluate(async i => (await import('./main.js')).goPage(i, true), initial.index);
      await page.waitForTimeout(800);
      report.samples.push(await measure(page, { swipe: true, index: initial.index }));
    }
  } finally {
    await page.evaluate(async i => (await import('./main.js')).goPage(i, true), initial.index);
    await browser.close(); // Detach; leave the app and its saved configuration intact.
  }
  if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });

async function measure(page, options) {
  return page.evaluate(async options => {
    const m = await import('./main.js');
    const times = [], longTasks = [];
    let writes = 0, swaps = 0;
    const observer = new MutationObserver(records => writes += records.length);
    document.querySelectorAll('.motion-active .w-media .fill').forEach(el => observer.observe(el, { attributes: true, attributeFilter: ['style'] }));
    const tasks = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(e => e.duration)));
    tasks.observe({ entryTypes: ['longtask'] });
    const interval = options.swipe ? setInterval(() => m.goPage(++swaps % 2 ? (options.index + 1) % m.pages.length : options.index), 1000) : 0;
    const start = performance.now();
    await new Promise(resolve => {
      const step = time => { times.push(time); if (time - start < 6000) requestAnimationFrame(step); else resolve(); };
      requestAnimationFrame(step);
    });
    clearInterval(interval); observer.disconnect(); tasks.disconnect();
    const gaps = times.slice(1).map((time, i) => time - times[i]).sort((a, b) => a - b);
    const duration = times[times.length - 1] - times[0];
    const round = value => Math.round(value * 100) / 100;
    return { ...options, frames: times.length, fps: round((times.length - 1) * 1000 / duration),
      p50ms: round(gaps[Math.floor(gaps.length * .5)]), p95ms: round(gaps[Math.floor(gaps.length * .95)]),
      p99ms: round(gaps[Math.floor(gaps.length * .99)]), intervalsOver25ms: gaps.filter(g => g > 25).length,
      mediaUpdatesPerSecond: round(writes * 1000 / duration), longTasks: longTasks.length };
  }, options);
}
