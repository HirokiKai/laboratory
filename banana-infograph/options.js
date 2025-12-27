document.addEventListener('DOMContentLoaded', async () => {
  const input = document.getElementById('apiKey');
  const msg = document.getElementById('msg');
  const save = document.getElementById('save');

  const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
  if (geminiApiKey) input.value = geminiApiKey;

  save.addEventListener('click', async () => {
    const key = input.value.trim();
    await chrome.storage.local.set({ geminiApiKey: key });
    msg.textContent = '保存しました';
    setTimeout(() => msg.textContent = '', 2000);
  });
});
