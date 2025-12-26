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
            instruction = '',
            myName = '',
            relationships = '',
            replyTarget = '',
            honorific = 'さん',
            channelInfo = {},
            timingInfo = {}
          } = {}
        } = message;

        if (!apiKey) throw new Error('APIキーが設定されていません');
        const nowIso = new Date().toISOString();
        const prompt = buildPrompt(contextText, instruction, myName, relationships, replyTarget, honorific, channelInfo, timingInfo, nowIso);
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

function buildPrompt(contextText, instruction, myName, relationships, replyTarget, honorific, channelInfo = {}, timingInfo = {}, nowIso = '') {
  let base = (
    'あなたはSlackでの返信を手助けするアシスタントです。' +
    '最新の発話を最重視し、過去発話は補足として扱ってください。' +
    '引用・挨拶・署名・原文の再掲は不要です。' +
    '個人情報や事実でないことをでっち上げないでください。'
  );

  // Critical: Role awareness instructions
  base += `

【重要：文脈の理解】
スレッド内のメッセージをよく読み、以下を判断してください：
1. メッセージが誰から誰宛なのか（@メンションを確認）
2. 依頼・質問・報告などの種類
3. あなた（ユーザー）が直接の宛先かどうか

【返信ルール】
- あなた宛のメッセージ → 直接回答してください
- 他の人宛のメッセージ → 第三者として適切に対応してください
  - 依頼を引き受ける返事はしないでください（自分の仕事ではない）
  - 情報共有への感謝、確認済みの報告、など第三者らしい返信を
- 全員宛の連絡 → 通常通り返信してください`;

  if (replyTarget) {
    base += `\n\n【返信先の指定】\n相手の名前: ${replyTarget}\nメンションは不要です。自然な日本語で呼びかけてください。`;
  }

  if (myName) {
    base += `\n\n【あなたの情報】\n名前: ${myName}\n(スレッド内の発言者名が "${myName}" の場合は、あなた自身の過去の発言です)\n(メッセージが "@${myName}" 宛でない場合、あなたは第三者です)`;
  }

  if (relationships) {
    base += `\n\n【人間関係・役割と呼び名】\n${relationships}\n- 呼び名が指定されている場合はその呼び名を使って自然に呼びかけてください。\n- 呼び名指定がなければデフォルト敬称（${honorific || 'さん'}）で丁寧に呼びかけてください。`;
  }

  const channelLabel = (() => {
    const t = (channelInfo.channelType || 'unknown');
    if (t === 'dm') return 'DM（非公開）';
    if (t === 'mpdm') return 'グループDM（非公開）';
    if (t === 'private') return 'プライベートチャンネル';
    if (t === 'public') return 'パブリックチャンネル';
    return 'チャンネル種別不明';
  })();
  const latestElapsed = timingInfo.latestElapsed ? `最新発話: ${timingInfo.latestElapsed}` : '';
  const latestAbs = timingInfo.latestTsSec ? `最新発話の時刻(JST): ${new Date(timingInfo.latestTsSec * 1000).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false })}` : '';
  if (channelInfo.channelType || timingInfo.latestElapsed) {
    base += `\n\n【スレッド情報】\n種別: ${channelLabel}${latestElapsed ? `\n${latestElapsed}` : ''}${latestAbs ? `\n${latestAbs}` : ''}\n- 経過時間と状況を踏まえ、適切なトーン・優先度・返答内容（謝意/再案内/断り等）を自律的に判断してください。`;
  }

  if (nowIso) {
    const nowStr = new Date(nowIso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false });
    base += `\n\n【現在日時】${nowStr} (ブラウザ時刻)`;
    base += '\n【時間に関する考慮】\n- 現在日時と最新発話のタイムスタンプを用いて、返信の緊急度や可否判断を適切に調整してください。\n- 過去イベントの可能性がある場合は、その状況に即した表現（謝意・再調整提案など）を自分で検討して選択してください。';
  }

  if (instruction) {
    base += `\n\n【ユーザーからの指針】\n${instruction}\nこの指針に従って返信を生成してください。`;
  }

  base += (
    '\n\n以下がスレッド全文です（親→古い順→新しい順）。' +
    '\n---\n' + contextText + '\n---\n' +
    '【出力言語】必ず日本語で返信してください。English is NOT allowed.\n' +
    '【呼びかけ】メンションは不要です。呼び名は上記「人間関係・役割」の呼び名を優先し、無ければデフォルト敬称（' + (honorific || 'さん') + '）で自然に呼びかけてください。\n' +
    '【出力形式】本文のみを1つ出力。見出し・ドラフト・"Drafting:"などのメタ表現や推論過程は絶対に含めないでください。'
  );
  return base;
}

function sanitizeModelText(rawText, allParts = [], prompt = '') {
  if (!rawText) return '';

  const hasJapanese = (str) => /[ぁ-んァ-ン一-龠々]/.test(str || '');
  const keepRatioJapanese = (str) => {
    let jp = 0, en = 0;
    for (const ch of str || '') {
      if (/[ぁ-んァ-ン一-龠々]/.test(ch)) jp++;
      else if (/[A-Za-z]/.test(ch)) en++;
    }
    // keep if at least one JP char and English is not dominating (<=2x JP)
    return jp > 0 && en <= jp * 2;
  };
  const isPromptEcho = (str) => {
    if (!str) return false;
    const checks = [
      'あなたはSlackでの返信を手助けするアシスタントです',
      '最新の発話を最重視',
      '第三者',
      '出力言語',
      '呼びかけ',
      'English is NOT allowed',
      '出力形式'
    ];
    return checks.some(k => str.includes(k));
  };

  // Choose the best part: avoid prompt echoes, prefer Japanese, prefer later parts (thinking系は後段がfinalのことが多い)
  const selectBestPart = () => {
    const nonEcho = allParts.filter(p => p && !isPromptEcho(p) && (!prompt || !prompt.includes(p.slice(0, Math.min(60, p.length)))));
    const jpNonEcho = nonEcho.filter(p => hasJapanese(p));
    if (jpNonEcho.length) return jpNonEcho[jpNonEcho.length - 1];
    if (nonEcho.length) return nonEcho[nonEcho.length - 1];
    return rawText; // fallback to original
  };

  // Prefer the provided text; if it has no Japanese but another part does, switch to that.
  let text = rawText;
  if (!hasJapanese(text) || isPromptEcho(text)) {
    const fallback = selectBestPart();
    if (fallback) text = fallback;
  }

  // Strip common meta prefixes from thinking models
  const lines = text.split('\n').map(l => l.trim());
  const filtered = lines.filter(l => !/^(drafting|draft\s*response|analysis|thoughts?|reasoning|meta|note)[:：]/i.test(l));
  text = filtered.join('\n').trim();

  // Remove backticks that sometimes wrap identifiers
  text = text.replace(/`+/g, '');

  // Remove fenced code blocks that wrap the whole response
  text = text.replace(/^```[a-zA-Z0-9]*\n([\s\S]*?)```$/m, '$1').trim();

  // Drop leading labels like "Response:" or "Answer:"
  text = text.replace(/^(response|reply|answer)[:：]\s*/i, '');

  // Drop lines withほぼ英語やプロンプト残渣（例: "* The message", "Default to ..."）
  text = text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l === '' || (hasJapanese(l) && keepRatioJapanese(l) && !/default to/i.test(l) && !/in the list/i.test(l)))
    .join('\n')
    .trim();

  // If overly short after filtering, try another Japanese part as fallback (less aggressive filtering)
  if (text.length < 8) {
    const alt = [...allParts].reverse().find(p => p && hasJapanese(p) && !isPromptEcho(p) && p.length > 10);
    if (alt) {
      text = alt.trim();
      // light cleanup only
      text = text.replace(/^```[a-zA-Z0-9]*\n([\s\S]*?)```$/m, '$1').trim();
      text = text.replace(/`+/g, '').trim();
      text = text.replace(/^(response|reply|answer)[:：]\s*/i, '').trim();
    }
  }

  text = text.trim();

  // 最終ガード：日本語が含まれていなければエラーにする（英語混入防止）
  if (!hasJapanese(text)) {
    throw new Error('日本語の応答を取得できませんでした（English is NOT allowed）');
  }

  return text;
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

  // Handle models that return multiple parts (e.g., thinking models)
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const textParts = parts
    .filter(p => p.text)
    .map(p => p.text);

  // For thinking models, the last part is usually the actual response
  const text = textParts.length > 0 ? textParts[textParts.length - 1] : null;

  const sanitized = sanitizeModelText(text, textParts, prompt);

  if (!sanitized) {
    console.error('[Gemini] Empty response:', JSON.stringify(data));
    throw new Error('Geminiレスポンスが空です');
  }
  return sanitized;
}
