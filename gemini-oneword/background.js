// Background Script - Gemini Oneword

function buildLengthInstruction(length) {
  switch (length) {
    case 'short':
      return '10〜15文字';
    case 'long':
      return '25〜40文字';
    case 'standard':
    default:
      return '15〜25文字';
  }
}

async function summarizeWithGemini(text, apiKey, modelName = 'gemini-2.0-flash', length = 'standard') {
  if (!apiKey) {
    throw new Error('API Key is missing. Please set it in the extension options.');
  }

  const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
  const lengthInstruction = buildLengthInstruction(length);

  const response = await fetch(`${API_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents: [{
        parts: [{
          text: `次の日本語を${lengthInstruction}の「ひとこと」に要約してください。\n\n重要なルール:\n- 出力は要約だけ。\n- 前置き、注釈、記号は不要。\n- 入力に含まれる区切り「---SEPARATOR---」はそのまま維持。\n- 入力の分割数と同じ数だけ出力する。\n\n入力テキスト:\n${text}`
        }]
      }]
    })
  });

  if (!response.ok) {
    const errorData = await response.json();
    console.error('Gemini API Error:', errorData);
    throw new Error(errorData.error?.message || 'Failed to fetch from Gemini API');
  }

  const data = await response.json();
  const summary = data.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!summary) {
    throw new Error('No summary in response');
  }

  return summary;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SUMMARIZE_TEXT_BG') {
    (async () => {
      try {
        const settings = await chrome.storage.local.get(['geminiApiKey', 'geminiModel', 'isOnewordEnabled', 'onewordLength']);

        if (settings.isOnewordEnabled === false) {
          sendResponse({ success: false, error: 'Summarization disabled by user.' });
          return;
        }

        const apiKey = settings.geminiApiKey;
        const model = settings.geminiModel || 'gemini-2.0-flash';
        const length = settings.onewordLength || 'standard';

        const summary = await summarizeWithGemini(message.text, apiKey, model, length);

        const inputLen = message.text.length;
        const outputLen = summary.length;
        const currentData = await chrome.storage.local.get(['modelStats']);
        const modelStats = currentData.modelStats || {};

        if (!modelStats[model]) {
          modelStats[model] = { input: 0, output: 0 };
        }

        modelStats[model].input += inputLen;
        modelStats[model].output += outputLen;

        chrome.storage.local.set({ modelStats });

        sendResponse({ success: true, data: summary });
      } catch (e) {
        console.error('Summarization failed:', e);
        if (e.message.includes('API Key is missing')) {
          chrome.runtime.openOptionsPage();
        }
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true; // Async response
  }
});
