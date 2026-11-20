(() => {
  if (globalThis.__phoneboxYouTube) return;
  globalThis.__phoneboxYouTube = true;
  const available = el => !!el && !el.disabled && el.getAttribute('aria-disabled') !== 'true'
    && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || !message.phoneboxYouTube) return;
    const video = document.querySelector('#movie_player video.html5-main-video');
    const previous = document.querySelector('#movie_player .ytp-prev-button');
    const next = document.querySelector('#movie_player .ytp-next-button');
    if (message.action !== 'sample') {
      if (message.action === 'playpause' && video) {
        if (video.paused) video.play().catch(() => {}); else video.pause();
      } else if (message.action === 'previous' && available(previous)) previous.click();
      else if (message.action === 'next' && available(next)) next.click();
      reply({ ok: true });
      return;
    }
    const rect = video?.getBoundingClientRect();
    const hasVideo = !!video && video.readyState >= 2 && !!video.videoWidth && rect.width > 0 && rect.height > 0;
    reply({
      title: (document.querySelector('h1.ytd-watch-metadata')?.textContent?.trim() || document.title.replace(/ - YouTube$/, '')).slice(0, 512),
      playing: !!video && !video.paused && !video.ended,
      hasVideo, canPrevious: available(previous), canNext: available(next),
      // Capture is the viewport. Refuse clipped/offscreen players rather than transmit other page content.
      rect: hasVideo && rect.left >= -1 && rect.top >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1
        ? { x: Math.max(0, rect.left) / innerWidth, y: Math.max(0, rect.top) / innerHeight,
          w: rect.width / innerWidth, h: rect.height / innerHeight, aspect: innerWidth / innerHeight } : null,
    });
  });
})();
