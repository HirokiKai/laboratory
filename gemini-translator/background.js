// Background Script - Gemini Translator (Cloud API)

const DEFAULT_MODEL = 'gemini-2.5-flash-lite';
const MODEL_MIGRATION_KEY = 'geminiModelMigratedTo25FlashLite';

const DIR_EN_JA = 'en_to_ja';
const DIR_JA_EN = 'ja_to_en';

function buildPrompt(text, direction = DIR_EN_JA) {
  const target = direction === DIR_JA_EN ? 'English' : 'Japanese';
  return `You are a professional translator. Translate the following text to ${target}.
IMPORTANT RULES:
- Output ONLY the translation.
- Do NOT provide explanations, notes, or pronunciation guide.
- Keep the separator "---SEPARATOR---" exactly as is between translation segments.
- Maintain the same number of segments as the input.

Input Text:
${text}`;
}

async function translateWithGemini(text, apiKey, modelName = DEFAULT_MODEL, direction = DIR_EN_JA) {
  if (!apiKey) {
    throw new Error('API Key is missing. Please set it in the extension options.');
  }

  const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;

  const response = await fetch(`${API_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents: [{
        parts: [{
          text: buildPrompt(text, direction)
        }]
      }]
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    console.error('Gemini API Error:', errorData);
    const status = response.status;
    const reason = errorData.error?.message || 'Failed to fetch from Gemini API';
    throw new Error(`HTTP ${status}: ${reason}`);
  }

  const data = await response.json();
  const translation = data.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!translation) {
    throw new Error('No translation in response');
  }

  return translation;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'TRANSLATE_TEXT_BG') {
    (async () => {
      try {
        // Get Settings & State
        const settings = await chrome.storage.local.get([
          'geminiApiKey',
          'geminiModel',
          'isAutoTranslateEnabled',
          'statsInputChars',
          'statsOutputChars',
          'translationDirection',
          MODEL_MIGRATION_KEY
        ]);

        // Check if Enabled (Default true)
        if (settings.isAutoTranslateEnabled === false) {
          sendResponse({ success: false, error: 'Translation disabled by user.' });
          return;
        }

        const apiKey = settings.geminiApiKey;
        let model = settings.geminiModel || DEFAULT_MODEL;
        if (!settings[MODEL_MIGRATION_KEY]) {
          model = DEFAULT_MODEL;
          await chrome.storage.local.set({
            geminiModel: DEFAULT_MODEL,
            [MODEL_MIGRATION_KEY]: true
          });
        }
        const direction = message.direction || settings.translationDirection || DIR_EN_JA;

        // Execute Translation
        const translation = await translateWithGemini(message.text, apiKey, model, direction);

        // Update Stats (Async, no await needed)
        const inputLen = message.text.length;
        const outputLen = translation.length;

        // Fetch current modelStats along with legacy global stats for migration if needed
        const currentData = await chrome.storage.local.get(['modelStats']);
        const modelStats = currentData.modelStats || {};

        // Initialize entries if missing
        if (!modelStats[model]) {
          modelStats[model] = { input: 0, output: 0 };
        }

        // Increment per-model stats
        modelStats[model].input += inputLen;
        modelStats[model].output += outputLen;

        chrome.storage.local.set({
          modelStats: modelStats,
          // Keep legacy simplified global sync just in case, or we can deprecate it. 
          // Let's just update the new structure.
        });

        sendResponse({ success: true, data: translation });
      } catch (e) {
        console.error('Translation failed:', e);
        // If API key is missing, try opening options page
        if (e.message.includes('API Key is missing')) {
          chrome.runtime.openOptionsPage();
        }
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true; // Async response
  }
});
