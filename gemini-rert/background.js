// Background Script - Gemini ReRT

function buildLengthInstruction(length) {
  switch (length) {
    case 'short':
      return '20〜40文字';
    case 'long':
      return '80〜140文字';
    case 'standard':
    default:
      return '40〜80文字';
  }
}

function buildViewpointInstruction(viewpoint) {
  const trimmed = (viewpoint || '').trim();
  if (!trimmed) return '観察者の視点で、事実と解釈を分けて';
  return `${trimmed}という視点で、元の意図を言語化して（視点の肩書きは本文に書かない）`;
}

function buildAudienceInstruction(audience) {
  const trimmed = (audience || '').trim();
  if (!trimmed) return '不特定多数に伝わるようにする';
  return `${trimmed}に伝わるようにする（相手の呼称は本文に書かない）`;
}

function buildBanWordsInstruction(banWordsRaw) {
  const list = (banWordsRaw || '')
    .split(',')
    .map((w) => w.trim())
    .filter(Boolean);
  if (!list.length) return '';
  return `次の語は使わない: ${list.join('、')}`;
}

function buildWritingHabitInstruction(writingHabit) {
  const trimmed = (writingHabit || '').trim();
  if (!trimmed) return '';
  return `文章のクセとして「${trimmed}」を守る`;
}

async function generateWithGemini(text, apiKey, modelName, length, viewpoint, audience, mode, banWordsRaw, writingHabit) {
  if (!apiKey) {
    throw new Error('API Key is missing. Please set it in the panel.');
  }

  const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
  const lengthInstruction = buildLengthInstruction(length);
  const viewpointInstruction = buildViewpointInstruction(viewpoint);
  const audienceInstruction = buildAudienceInstruction(audience);
  const banWordsInstruction = buildBanWordsInstruction(banWordsRaw);
  const writingHabitInstruction = buildWritingHabitInstruction(writingHabit);
  const modeInstruction = mode === 'reply' ? '返信文を作成' : '引用リツイート文を作成';
  const banLine = banWordsInstruction ? `\n- ${banWordsInstruction}` : '';
  const habitLine = writingHabitInstruction ? `\n- ${writingHabitInstruction}` : '';

  const response = await fetch(`${API_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [{
          text: `次の投稿内容から${modeInstruction}してください。\n\n条件:\n- ${lengthInstruction}\n- ${viewpointInstruction}\n- ${audienceInstruction}${habitLine}${banLine}\n- 出力は本文だけ\n- 前置き、記号、注釈は不要\n\n投稿内容:\n${text}`
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
  const draft = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!draft) throw new Error('No draft in response');
  return draft.trim();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GENERATE_RERT') {
    (async () => {
      try {
        const settings = await chrome.storage.local.get([
          'geminiApiKey',
          'geminiModel',
          'rertEnabled',
          'rertViewpoint',
          'rertAudience',
          'rertLength',
          'rertWritingHabit',
          'rertBanWords'
        ]);

        if (settings.rertEnabled === false) {
          sendResponse({ success: false, error: 'Auto draft disabled by user.' });
          return;
        }

        const apiKey = settings.geminiApiKey;
        const model = settings.geminiModel || 'gemini-2.0-flash';
        const viewpoint = settings.rertViewpoint || '';
        const audience = settings.rertAudience || '';
        const length = settings.rertLength || 'standard';
        const banWordsRaw = settings.rertBanWords || '';
        const writingHabit = settings.rertWritingHabit || '';

        const draft = await generateWithGemini(message.text, apiKey, model, length, viewpoint, audience, message.mode, banWordsRaw, writingHabit);

        const inputLen = message.text.length;
        const outputLen = draft.length;
        const currentData = await chrome.storage.local.get(['modelStats']);
        const modelStats = currentData.modelStats || {};

        if (!modelStats[model]) {
          modelStats[model] = { input: 0, output: 0 };
        }

        modelStats[model].input += inputLen;
        modelStats[model].output += outputLen;

        chrome.storage.local.set({ modelStats });
        sendResponse({ success: true, data: draft });
      } catch (e) {
        console.error('Draft generation failed:', e);
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }
});
