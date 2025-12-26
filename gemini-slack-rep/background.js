// Background Service Worker - Gemini Slack Reply

const DEFAULT_MODEL = 'gemini-2.5-flash-lite';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GENERATE_REPLY') {
    (async () => {
      try {
        const {
          contextText,
          settings: {
            apiKey,
            model = DEFAULT_MODEL,
            temperature = 0.7,
            topP = 0.9,
            maxTokens = 500,
          } = {}
        } = message;

        if (!apiKey) throw new Error('APIキーが設定されていません');
        const prompt = buildPrompt(contextText);
        const result = await callGemini({ apiKey, model, temperature, topP, maxTokens, prompt });

        // stats update
        const inputLen = contextText?.length || 0;
        const outputLen = result?.length || 0;
        const current = await chrome.storage.local.get(['modelStats']);
        const modelStats = current.modelStats || {};
        if (!modelStats[model]) modelStats[model] = { input: 0, output: 0 };
        modelStats[model].input += inputLen;
        modelStats[model].output += outputLen;
        chrome.storage.local.set({ modelStats });

        sendResponse({ success: true, data: result });
      } catch (e) {
        console.error('[Gemini Slack Reply] error:', e);
        sendResponse({ success: false, error: e.message || '生成に失敗しました' });
      }
    })();
    return true; // keep channel open
  }
});

function buildPrompt(contextText) {
  return (
    'あなたはSlackでの返信を手助けするアシスタントです。' +
    '最新の発話を最重視し、過去発話は補足として扱ってください。' +
    '引用・挨拶・署名・原文の再掲は不要です。' +
    '個人情報や事実でないことをでっち上げないでください。' +
    '\n\n以下がスレッド全文です（親→古い順→新しい順）。' +
    '\n---\n' + contextText + '\n---\n' +
    '上記の会話への返信を日本語で1つだけ出力してください。'
  );
}

async function callGemini({ apiKey, model, temperature, topP, maxTokens, prompt }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [
      {
        parts: [
          {
            text: prompt
          }
        ]
      }
    ],
    generationConfig: {
      temperature,
      topP,
      maxOutputTokens: maxTokens
    }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    let detail = '';
    try {
      const data = await res.json();
      detail = data.error?.message || JSON.stringify(data);
    } catch (err) {
      detail = res.statusText;
    }
    throw new Error(`Gemini APIエラー: ${detail}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Geminiレスポンスが空です');
  return text.trim();
}
