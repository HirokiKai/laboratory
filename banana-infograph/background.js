const MODEL_ID = 'gemini-3-pro-image-preview';
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:generateContent`;

async function getSettings() {
  const { geminiApiKey, customPrompt } = await chrome.storage.local.get(['geminiApiKey', 'customPrompt']);
  return { geminiApiKey: geminiApiKey || '', customPrompt };
}

// ... (b64ToFile is unchanged)

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'generateInfograph') return;
  (async () => {
    const { geminiApiKey, customPrompt } = await getSettings();
    if (!geminiApiKey) {
      sendResponse({ ok: false, error: 'APIキーを設定してください' });
      return;
    }
    try {
      const prompt = buildPrompt(msg.text, customPrompt);
      const body = {
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt }
            ]
          }
        ],
        generationConfig: {
          responseModalities: ['IMAGE'],
          imageConfig: { imageSize: '1K' }
        }
      };

      const resp = await fetch(`${API_URL}?key=${geminiApiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      // ... (rest of logic unchanged)
      if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${err}`);
      }
      const json = await resp.json();
      const data = json?.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
      if (!data || !data.inlineData?.data) {
        throw new Error('画像が返ってきませんでした');
      }
      const mimeType = data.inlineData.mimeType || 'image/png';
      const fileName = `nanobanana-${Date.now()}.png`;
      // Need to make sure b64ToFile is available in scope or moved here if strict mode issues
      // Assuming b64ToFile is defined in global scope of this file
      const fileLink = `data:${mimeType};base64,${data.inlineData.data}`;

      // We return base64 data to content script, let it handle file creation
      sendResponse({ ok: true, fileName, mimeType, data: data.inlineData.data });
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true; // keep channel open
});

function buildPrompt(userText, customTemplate) {
  const defaultTemplate = `あなたはグラフィックデザイナーです。以下のテキストを1枚の正方形インフォグラフィックにしてください。
- フォント: 丸めサンセリフ、太め
- 配色: ダークネイビー背景 + バナナイエローのアクセント
- レイアウト: 大見出し + 3箇条書き + 右下に小アイコンスペース
- 余白多め、コントラスト強め、読みやすさ優先
- 出力は1:1の画像のみ
テキスト: 「{text}」`;

  const template = customTemplate || defaultTemplate;
  return template.replace('{text}', userText.trim());
}
