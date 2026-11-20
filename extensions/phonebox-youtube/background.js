const OFFSCREEN = 'offscreen.html';
let switching = false;
const youtube = url => { try { const u = new URL(url); return u.origin === 'https://www.youtube.com'; } catch { return false; } };
async function offscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL(OFFSCREEN)] });
  if (!contexts.length) await chrome.offscreen.createDocument({ url: OFFSCREEN, reasons: ['USER_MEDIA'], justification: 'Capture the selected YouTube tab without capturing its sound.' });
}
async function tell(message) {
  return chrome.runtime.sendMessage({ target: 'offscreen', ...message });
}
async function selected() { return (await chrome.storage.session.get('selected')).selected; }
async function badge(text, title) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: '#c4302b' });
  await chrome.action.setTitle({ title });
}
async function stop() {
  try { await tell({ type: 'stop' }); } catch { }
  await chrome.storage.session.remove('selected');
  await badge('', 'Start YouTube on PhoneBox');
}
async function updateFocus() {
  const target = await selected();
  if (!target) return;
  try {
    const tab = await chrome.tabs.get(target.tabId);
    if (!youtube(tab.url)) { await stop(); return; }
    const win = await chrome.windows.get(tab.windowId);
    const hidden = !tab.active || !win.focused || win.state === 'minimized';
    await tell({ type: 'focus', hidden });
  } catch { await stop(); }
}

// The toolbar click is the user gesture required by tabCapture. Focus changes only
// pause/resume delivery; they never try to obtain a new capture permission.
chrome.action.onClicked.addListener(async tab => {
  if (switching) return;
  switching = true;
  try {
    const config = await chrome.storage.local.get(['agent', 'token']);
    if (!config.token) { await chrome.runtime.openOptionsPage(); return; }
    const current = await selected();
    if (current?.tabId === tab.id) { await stop(); return; }
    if (!youtube(tab.url)) { await badge('!', 'Open a YouTube video, then click PhoneBox'); return; }
    await stop();
    await offscreen();
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    const target = { tabId: tab.id, session: crypto.randomUUID() };
    await chrome.storage.session.set({ selected: target });
    const result = await tell({ type: 'start', streamId, ...target, agent: config.agent || 'http://127.0.0.1:8765', token: config.token });
    if (!result?.ok) throw new Error('Capture failed');
    await badge('ON', 'Stop YouTube on PhoneBox');
    await updateFocus();
  } catch (error) {
    await stop();
    await badge('!', 'Could not start capture. Check extension settings and try again.');
    console.error('PhoneBox capture:', error);
  } finally { switching = false; }
});
chrome.tabs.onActivated.addListener(() => { void updateFocus(); });
chrome.windows.onFocusChanged.addListener(() => { void updateFocus(); });
chrome.windows.onBoundsChanged.addListener(() => { void updateFocus(); });
chrome.tabs.onRemoved.addListener(async id => { if ((await selected())?.tabId === id) await stop(); });
chrome.tabs.onUpdated.addListener(async (id, info, tab) => {
  if ((await selected())?.tabId !== id) return;
  if (info.url && !youtube(info.url)) { await stop(); return; }
  if (info.status === 'complete') {
    try { await chrome.scripting.executeScript({ target: { tabId: id }, files: ['content.js'] }); }
    catch { await stop(); }
  }
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message.target !== 'worker') return;
  (async () => {
    const target = await selected();
    if (!target || message.session !== target.session) return null;
    if (message.type === 'sample' || message.type === 'command') {
      // Refresh focus before each sample as well as on browser events.
      await updateFocus();
      return chrome.tabs.sendMessage(target.tabId, { phoneboxYouTube: true, action: message.type === 'sample' ? 'sample' : message.action });
    }
    if (message.type === 'ended') { await stop(); return { ok: true }; }
    return null;
  })().then(reply, () => reply(null));
  return true;
});
chrome.runtime.onStartup.addListener(() => { void stop(); });
