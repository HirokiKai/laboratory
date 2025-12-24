const saveOptions = () => {
  const apiKey = document.getElementById('apiKey').value;
  const model = document.getElementById('modelSelect').value;

  chrome.storage.local.set(
    { geminiApiKey: apiKey, geminiModel: model },
    () => {
      const status = document.getElementById('status');
      status.textContent = 'Options saved.';
      setTimeout(() => {
        status.textContent = '';
      }, 750);
    }
  );
};

const restoreOptions = () => {
  chrome.storage.local.get(
    { geminiApiKey: '', geminiModel: 'gemini-2.0-flash' },
    (items) => {
      document.getElementById('apiKey').value = items.geminiApiKey;
      document.getElementById('modelSelect').value = items.geminiModel;
    }
  );
};

document.addEventListener('DOMContentLoaded', restoreOptions);
document.getElementById('save').addEventListener('click', saveOptions);
