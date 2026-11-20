const start = document.querySelector('#youtubePairStart');
if (start) {
  const revoke = document.querySelector('#youtubeRevoke'), result = document.querySelector('#youtubePairResult');
  const t = key => window.PhoneBoxI18n?.t(key) || key;
  start.addEventListener('click', async () => {
    start.disabled = true;
    try {
      const response = await fetch('/api/youtube/pair/start', { method: 'POST' });
      if (!response.ok) throw new Error();
      const body = await response.json();
      result.textContent = `${body.code} · ${t('s.youtube.expires')}`;
    } catch { result.textContent = t('s.youtube.failed'); }
    finally { start.disabled = false; }
  });
  revoke.addEventListener('click', async () => {
    revoke.disabled = true;
    try {
      const response = await fetch('/api/youtube/pair/revoke', { method: 'POST' });
      if (!response.ok) throw new Error();
      result.textContent = t('s.youtube.revoked');
    } catch { result.textContent = t('s.youtube.failed'); }
    finally { revoke.disabled = false; }
  });
}
