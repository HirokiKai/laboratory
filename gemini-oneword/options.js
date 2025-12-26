const DEFAULT_MODEL = 'gemini-2.5-flash-lite';
const MODEL_MIGRATION_KEY = 'geminiModelMigratedTo25FlashLite';

const migrateModelIfNeeded = () => {
  chrome.storage.local.get([MODEL_MIGRATION_KEY], (res) => {
    if (res[MODEL_MIGRATION_KEY]) return;
    chrome.storage.local.set({
      geminiModel: DEFAULT_MODEL,
      [MODEL_MIGRATION_KEY]: true
    });
  });
};

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
  migrateModelIfNeeded();
  chrome.storage.local.get(
    { geminiApiKey: '', geminiModel: DEFAULT_MODEL },
    (items) => {
      document.getElementById('apiKey').value = items.geminiApiKey;
      document.getElementById('modelSelect').value = items.geminiModel;
    }
  );
};

document.addEventListener('DOMContentLoaded', restoreOptions);
document.getElementById('save').addEventListener('click', saveOptions);
