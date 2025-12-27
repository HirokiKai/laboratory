// Background Script - Gemini Translator (Cloud API)

const DEFAULT_MODEL = 'gemini-2.5-flash-lite';
const MODEL_MIGRATION_KEY = 'geminiModelMigratedTo25FlashLite';

const DIR_JA_SIMPLIFY = 'ja_simplify';

function buildPrompt(text, direction = DIR_JA_SIMPLIFY) {
  return `あなたはプロの日本語ライターです。入力された日本語を、意味を変えずに「やさしい日本語」に書き直してください。
厳守ルール:
- 出力は書き直した文章のみ。説明や注釈は不要。
- 専門用語や比喩表現はできるだけ平易な言葉に置き換える。
- 文を短く、主語と述語をはっきりさせる。
- 区切り文字 "---SEPARATOR---" はそのまま維持し、入力と同じ区切り数で出力する。

入力:
${text}`;
}

async function translateWithGemini(text, apiKey, modelName = DEFAULT_MODEL, direction = DIR_JA_SIMPLIFY) {
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
        const direction = DIR_JA_SIMPLIFY;

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
