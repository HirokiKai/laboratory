const DEFAULTS = { model: 'gemini-2.5-flash-lite', enabled: true };

async function load() {
  const data = await chrome.storage.local.get([
    'geminiApiKey', 'gslrModel', 'gslrEnabled', 'gslrDebug'
  ]);
  document.getElementById('key').value = data.geminiApiKey || '';
  document.getElementById('model').value = data.gslrModel || DEFAULTS.model;
  document.getElementById('enabled').checked = data.gslrEnabled !== false;
  document.getElementById('debug').checked = data.gslrDebug === true;
}

async function save() {
  const payload = {
    geminiApiKey: document.getElementById('key').value.trim(),
    gslrModel: document.getElementById('model').value,
    gslrEnabled: document.getElementById('enabled').checked,
    gslrDebug: document.getElementById('debug').checked
  };
  await chrome.storage.local.set(payload);
  const msg = document.getElementById('msg');
  msg.textContent = '保存しました';
  setTimeout(() => { msg.textContent = ''; }, 1500);
}

document.getElementById('save').addEventListener('click', save);
load();
