const form = document.querySelector('#pair'), agent = document.querySelector('#agent'), status = document.querySelector('#status');
chrome.storage.local.get(['agent', 'token']).then(config => {
  agent.value = config.agent || agent.value;
  status.textContent = config.token ? 'Подключение сохранено. Откройте YouTube и нажмите значок расширения.' : 'Введите код из настроек PhoneBox.';
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const url = new URL(agent.value.trim());
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
      throw new Error('Используйте локальный адрес: http://127.0.0.1:8765');
    const response = await fetch(url.origin + '/api/youtube/extension/claim?code=' + encodeURIComponent(document.querySelector('#code').value), {
      method: 'POST', headers: { 'X-PhoneBox-Extension': chrome.runtime.id }, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('Код неверен или истёк. Создайте новый код в PhoneBox.');
    const { token } = await response.json();
    await chrome.storage.local.set({ agent: url.origin, token });
    document.querySelector('#code').value = '';
    status.textContent = 'Подключено. Откройте видео YouTube и нажмите значок расширения.';
  } catch (error) { status.textContent = error.message || 'Нет связи с агентом PhoneBox.'; }
  finally { button.disabled = false; }
});
document.querySelector('#forget').addEventListener('click', async () => {
  await chrome.storage.local.remove(['token', 'agent']);
  // Also release a capture that is still using the old credential.
  try { await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' }); } catch { }
  await chrome.storage.session.remove('selected');
  await chrome.action.setBadgeText({ text: '' });
  status.textContent = 'Подключение забыто. Для отзыва ключа нажмите «Отключить» в настройках агента.';
});
