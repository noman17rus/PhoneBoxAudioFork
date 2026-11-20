let current = null;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const worker = message => chrome.runtime.sendMessage({ target: 'worker', ...message });
async function request(run, path, options = {}) {
  const response = await fetch(run.agent + '/api/youtube/extension/' + path, {
    ...options, signal: AbortSignal.timeout(2500),
    headers: { Authorization: 'Bearer ' + run.token, 'X-PhoneBox-Extension': chrome.runtime.id, ...options.headers },
  });
  if (response.status === 403) {
    // Revocation must release the browser capture as well as stop uploads.
    if (current === run) await stop();
    void worker({ type: 'ended', session: run.session });
    throw new Error('Extension disconnected');
  }
  return response;
}
async function stop() {
  const old = current;
  current = null;
  if (!old) return;
  old.rejectEncoding?.(new Error('Capture stopped'));
  old.encoder?.terminate();
  try { await old.reader?.cancel(); } catch { }
  old.stream?.getTracks().forEach(track => track.stop());
  try { await request(old, 'stop?session=' + encodeURIComponent(old.session), { method: 'POST' }); } catch { }
}
async function pollOnce(run) {
  if (run.polling || current !== run) return;
  run.polling = true;
  run.lastPoll = performance.now();
  try {
    const data = await worker({ type: 'sample', session: run.session });
    if (current !== run) return;
    // A page navigation can briefly remove the content script. Never use an old crop then.
    run.rect = data?.rect || null;
    const valid = !!data?.hasVideo && !!run.rect;
    const response = await request(run, 'poll', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: run.session, revision: run.revision, hidden: run.hidden,
        title: data?.title || '', playing: !!data?.playing, hasVideo: valid,
        canPrevious: !!data?.canPrevious, canNext: !!data?.canNext, error: run.error || null }) });
    if (!response.ok) throw new Error('Agent unavailable');
    const result = await response.json();
    if (current !== run) return;
    run.capture = result.capture && run.hidden && valid;
    for (const command of result.commands || []) {
      if (command.session === run.session && Date.parse(command.expires) > Date.now())
        await worker({ type: 'command', session: run.session, action: command.action });
    }
  } catch { run.capture = false; }
  finally { run.polling = false; }
}
async function poll(run) {
  while (current === run) {
    await pollOnce(run);
    await sleep(200);
  }
}
async function frames(run) {
  // Read capture frames directly. Hidden offscreen documents may throttle DOM
  // video painting and timers; encoding from VideoFrame avoids both dependencies.
  const reader = new MediaStreamTrackProcessor({ track: run.stream.getVideoTracks()[0], maxBufferSize: 1 }).readable.getReader();
  run.reader = reader;
  let lastSent = 0;
  try {
    while (current === run) {
      const { value: captured, done } = await reader.read();
      if (done) break;
      try {
        if (performance.now() - run.lastPoll >= 200) void pollOnce(run);
        if (!run.capture || !run.hidden || !run.rect || performance.now() - lastSent < 1000 / 24) continue;
        lastSent = performance.now();
        const capturedAt = Date.now();
        const revision = run.revision;
        try {
          const blob = await new Promise((resolve, reject) => {
            run.rejectEncoding = reject;
            run.encoder.onmessage = ({ data }) => {
              run.rejectEncoding = null;
              if (data.error) reject(new Error(data.error)); else resolve(data.blob);
            };
            run.encoder.onerror = () => { run.rejectEncoding = null; reject(new Error('Encoder unavailable')); };
            run.encoder.postMessage({ frame: captured, rect: run.rect }, [captured]);
          });
          if (current === run && revision === run.revision && run.hidden && blob && blob.size <= 1024 * 1024)
            await request(run, 'frame?session=' + encodeURIComponent(run.session) + '&revision=' + revision,
              { method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'X-PhoneBox-Captured-At': String(capturedAt) }, body: blob });
        } catch { run.capture = false; }
      } finally { captured.close(); }
    }
  } finally { reader.releaseLock(); }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message.target !== 'offscreen') return;
  if (message.type === 'focus') {
    if (current && current.hidden !== message.hidden) {
      current.hidden = message.hidden;
      current.revision++;
      current.capture = false;
    }
    reply({ ok: true });
    return;
  }
  if (message.type === 'stop') { stop().then(() => reply({ ok: true })); return true; }
  if (message.type !== 'start') return;
  (async () => {
    await stop();
    const run = { ...message, hidden: false, revision: 0, capture: false, rect: null };
    // Video only: do not redirect or suppress the tab's audio output.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: {
      chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId, minFrameRate: 5, maxFrameRate: 24,
    } } });
    run.stream = stream;
    run.encoder = new Worker('encoder.js');
    current = run;
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      if (current === run) { void stop(); void worker({ type: 'ended', session: run.session }); }
    });
    void poll(run);
    void frames(run).catch(() => { if (current === run) { run.error = 'capture-unavailable'; run.capture = false; } });
    return { ok: true };
  })().then(reply, error => { console.error(error); reply({ ok: false }); });
  return true;
});
