async function progressAt(page, instant) {
  await page.clock.install({ time: new Date(instant) });
  await page.goto('/panel/');
  await page.clock.setFixedTime(new Date(instant));
  return page.evaluate(async () => {
    await import('/panel/main.js');
    const { W } = await import('/panel/registry.js');
    const box = document.createElement('div');
    document.body.append(box);
    try {
      W.progress.create(box).update();
      return [...box.querySelectorAll('.pr-row')].map(row => ({
        label: row.querySelector('.m-row span').textContent,
        text: row.querySelector('.m-row').lastElementChild.textContent,
        width: row.querySelector('.track i').getBoundingClientRect().width / row.querySelector('.track').getBoundingClientRect().width * 100,
      }));
    } finally { box.remove(); }
  });
}

module.exports = { progressAt };
