// Content Script - Gemini Slack Reply
typeof console !== 'undefined' && console.log('[Gemini Slack Reply] loaded');

const PANEL_ID = 'gslr-panel';
const PANEL_Z_EXPANDED = 2147483647;
const PANEL_Z_MINIMIZED = 2147483000;
const CHARS_PER_TOKEN = 4;
const RUN_DEBOUNCE_MS = 1200;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULTS = {
  model: 'gemini-2.5-flash-lite',
  enabled: true
};

const PRICING = {
  'gemini-2.5-flash-lite': { input: 0.10, output: 0.40 },
  'gemini-2.5-flash': { input: 0.30, output: 2.50 },
  'gemini-3-flash-preview': { input: 0.30, output: 2.50 },
  default: { input: 0.10, output: 0.40 }
};

const FIXED_PARAMS = {
  temperature: 0.7,
  topP: 0.9,
  maxTokens: 500
};

let cachedKey = '';
let settingsCache = { ...DEFAULTS };
let observing = false;
let cancelFlag = false;
let generationInFlight = false;
let processingPane = null;
let modelStatsCache = {};
let lastContextKey = '';
let lastContextTime = 0;
let lastDraftText = '';
let lastObserverRun = 0;
const replyCache = new Map(); // key -> { ts, draft }
const threadProcessed = new Set(); // threadKey strings
const threadDraftMap = new Map(); // threadKey -> draft

// ---------- Storage helpers ----------
async function loadSettings() {
  const data = await chrome.storage.local.get([
    'geminiApiKey',
    'gslrModel',
    'gslrEnabled',
    'modelStats'
  ]);
  cachedKey = (data.geminiApiKey || '').trim();
  settingsCache = {
    model: data.gslrModel || DEFAULTS.model,
    enabled: data.gslrEnabled !== false
  };
  modelStatsCache = data.modelStats || {};
}

async function saveSettings(partial) {
  const next = { ...settingsCache, ...partial };
  const payload = {
    geminiApiKey: partial.geminiApiKey !== undefined ? partial.geminiApiKey : cachedKey,
    gslrModel: next.model,
    gslrEnabled: next.enabled
  };
  cachedKey = payload.geminiApiKey;
  settingsCache = next;
  await chrome.storage.local.set(payload);
}

// ---------- DOM helpers ----------
function qs(sel, root = document) { return root.querySelector(sel); }
function qsa(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

function findThreadPane() {
  const sels = [
    '[data-qa="threads_flexpane"]',
    '.p-threads_flexpane',
    '.p-flexpane'
  ];
  for (const s of sels) {
    const el = qs(s);
    if (el) return el;
  }
  return null;
}

function findMessages(pane) {
  if (!pane) return [];
  const msgSelectors = ['[data-qa="message_container"]', '.p-thread_message', '.c-message'];
  const bodySelectors = ['.p-rich_text_section', '.c-message__body', '.p-rich_text_block'];
  const senderSelectors = ['[data-qa="message_sender_name"]', '.c-message__sender_button', '.p-message_sender__name'];

  const nodes = [];
  msgSelectors.forEach(sel => nodes.push(...qsa(sel, pane)));
  const uniq = Array.from(new Set(nodes));

  return uniq.map((node, idx) => {
    const senderEl = senderSelectors.map(s => qs(s, node)).find(Boolean);
    const bodyEl = bodySelectors.map(s => qs(s, node)).find(Boolean);
    const sender = (senderEl?.textContent || '').trim();
    const text = (bodyEl?.textContent || '').trim();
    return {
      sender,
      text,
      isParent: idx === 0,
      ts: idx
    };
  }).filter(m => m.text);
}

function formatContext(messages) {
  return messages
    .map((m, i) => {
      const label = m.isParent ? '[親]' : i === messages.length - 1 ? '[最新]' : `[返信${i}]`;
      return `${label} ${m.sender || 'Someone'}: ${m.text}`;
    })
    .join('\n');
}

function findComposer(pane) {
  return qs('.ql-editor[contenteditable="true"]', pane || document);
}

function insertText(editor, text) {
  if (!editor) return;
  editor.focus();
  const current = (editor.innerText || '').trim();
  const prefix = current ? ' ' : '';
  const full = `${prefix}${text}`;
  try {
    const data = new DataTransfer();
    data.setData('text/plain', full);
    const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data });
    const ok = editor.dispatchEvent(ev);
    if (ok) return;
  } catch (e) {
    // fallback
  }
  document.execCommand('insertText', false, full);
}

function showToast(message, duration = 2000) {
  const id = 'gslr-toast';
  const old = qs(`#${id}`);
  if (old) old.remove();
  const div = document.createElement('div');
  div.id = id;
  div.textContent = message;
  div.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#0f172a;color:#fff;padding:10px 14px;border-radius:8px;z-index:2147483600;font-size:13px;box-shadow:0 6px 20px rgba(0,0,0,0.18);';
  document.body.appendChild(div);
  setTimeout(() => div.remove(), duration);
}

function setLoading(editor, on) {
  if (!editor) return;
  if (on) {
    editor.setAttribute('data-gslr-loading', 'true');
    editor.style.background = '#f3f4f6';
  } else {
    editor.removeAttribute('data-gslr-loading');
    editor.style.background = '';
  }
}

// ---------- Panel UI ----------
function ensurePanel() {
  if (qs(`#${PANEL_ID}`)) return;
  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:${PANEL_Z_MINIMIZED};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;`;
  panel.innerHTML = `
    <style>
      #gslr-expanded { display:none; width:280px; background:#fff; border-radius:14px; box-shadow:0 12px 28px rgba(0,0,0,0.12); padding:14px; }
      #gslr-min { width:54px; height:54px; border-radius:14px; background:#fff; color:#0f172a; display:flex; align-items:center; justify-content:center; cursor:pointer; box-shadow:0 10px 20px rgba(0,0,0,0.16); border:2px solid transparent; }
      #gslr-min span { font-weight:800; font-size:24px; }
      #gslr-expanded label { display:block; margin:8px 0 4px; font-size:12px; font-weight:700; }
      #gslr-expanded input, #gslr-expanded select { width:100%; padding:8px; border:1px solid #d1d5db; border-radius:8px; font-size:13px; }
      #gslr-save { width:100%; margin-top:12px; padding:10px; background:#0f172a; color:#fff; border:none; border-radius:10px; font-weight:700; cursor:pointer; }
      .gslr-switch { position:relative; display:inline-block; width:46px; height:26px; margin-right:8px; }
      .gslr-switch input { opacity:0; width:0; height:0; }
      .gslr-slider { position:absolute; cursor:pointer; top:0; left:0; right:0; bottom:0; background:#d1d5db; transition:.2s; border-radius:26px; }
      .gslr-slider:before { position:absolute; content:\"\"; height:20px; width:20px; left:3px; bottom:3px; background:white; transition:.2s; border-radius:50%; box-shadow:0 1px 3px rgba(0,0,0,0.25); }
      .gslr-switch input:checked + .gslr-slider { background:#10b981; }
      .gslr-switch input:checked + .gslr-slider:before { transform:translateX(20px); }
      #gslr-msg { font-size:12px; color:#10b981; min-height:16px; margin-top:6px; }
    </style>
    <div id="gslr-expanded">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div style="font-weight:800;">Gemini Slack Reply</div>
        <button id="gslr-close" style="border:none;background:none;padding:6px;cursor:pointer;line-height:0;">
          <svg viewBox="0 0 24 24" aria-hidden="true" style="width:20px;height:20px;color:#536471;"><g><path d="M12 15.41l-7.29-7.29 1.41-1.42L12 12.59l5.88-5.89 1.41 1.42L12 15.41z" fill="currentColor"></path></g></svg>
        </button>
      </div>
      <label style="display:flex;align-items:center;gap:6px;">
        <span class="gslr-switch"><input type="checkbox" id="gslr-toggle"><span class="gslr-slider"></span></span>
        自動生成を有効化
      </label>
      <div id="gslr-cost-card" style="background:#f7f9f9; padding:10px 12px; border-radius:12px; border:1px solid #eef1f4; margin:10px 0 14px;">
        <div style="font-size:11px; color:#6b7280; font-weight:700;">推定コスト (モデル別目安)</div>
        <div id="gslr-cost" style="font-size:20px; font-weight:800; color:#0f172a; margin:4px 0 6px;">$0.00000</div>
        <div style="font-size:11px; color:#374151; display:flex; justify-content:space-between;">
          <span>In: <b id="gslr-input-chars" style="color:#0f172a;">0</b></span>
          <span>Out: <b id="gslr-output-chars" style="color:#0f172a;">0</b></span>
        </div>
      </div>
      <button id="gslr-settings-toggle" style="width:100%; text-align:left; background:none; border:none; padding:0; cursor:pointer; display:flex; align-items:center; gap:6px; color:#10b981; font-weight:700; font-size:13px; margin:8px 0 6px;">
        <span style="font-size:16px;">⚙️</span> 設定 (モデル・キー)
      </button>
      <div id="gslr-settings-content" style="display:none;">
        <label>モデル</label>
        <select id="gslr-model">
          <option value="gemini-2.5-flash-lite">Gemini 2.5 Flash-Lite</option>
          <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
          <option value="gemini-3-flash-preview">Gemini 3 Flash Preview</option>
        </select>
        <label style="margin-top:10px;">Gemini APIキー</label>
        <input type="password" id="gslr-key" placeholder="AI Studio Key">
      </div>
      <button id="gslr-save">保存</button>
      <div id="gslr-msg"></div>
      <div style="margin-top:10px;font-size:12px;color:#6b7280;">もう1件生成: スレッド内でボタン再クリック</div>
    </div>
    <div id="gslr-min"><span>S</span></div>
  `;
  document.body.appendChild(panel);

  const expanded = qs('#gslr-expanded', panel);
  const minBtn = qs('#gslr-min', panel);
  const closeBtn = qs('#gslr-close', panel);
  const toggle = qs('#gslr-toggle', panel);
  const modelSel = qs('#gslr-model', panel);
  const keyInput = qs('#gslr-key', panel);
  const saveBtn = qs('#gslr-save', panel);
  const msgEl = qs('#gslr-msg', panel);
  const costEl = qs('#gslr-cost', panel);
  const inEl = qs('#gslr-input-chars', panel);
  const outEl = qs('#gslr-output-chars', panel);
  const settingsToggle = qs('#gslr-settings-toggle', panel);
  const settingsContent = qs('#gslr-settings-content', panel);

  const applyMinBtnStyle = (checked) => {
    if (!minBtn) return;
    if (checked) {
      minBtn.style.borderColor = '#2ecc71';
      minBtn.style.boxShadow = 'rgba(46, 204, 113, 0.25) 0px 0px 10px, rgba(46, 204, 113, 0.18) 0px 2px 6px 1px';
    } else {
      minBtn.style.borderColor = 'transparent';
      minBtn.style.boxShadow = 'rgba(101, 119, 134, 0.2) 0px 0px 8px, rgba(101, 119, 134, 0.2) 0px 2px 5px 1px';
    }
  };

  function syncUI() {
    toggle.checked = settingsCache.enabled;
    modelSel.value = settingsCache.model;
    keyInput.value = cachedKey;
    updateStatsUI(modelSel.value);
    applyMinBtnStyle(toggle.checked);
  }
  syncUI();

  function showExpanded(on) {
    if (on) {
      panel.style.zIndex = PANEL_Z_EXPANDED;
      expanded.style.display = 'block';
      minBtn.style.display = 'none';
    } else {
      panel.style.zIndex = PANEL_Z_MINIMIZED;
      expanded.style.display = 'none';
      minBtn.style.display = 'flex';
    }
  }

  minBtn.addEventListener('click', () => showExpanded(true));
  closeBtn.addEventListener('click', () => showExpanded(false));

  saveBtn.addEventListener('click', async () => {
    await saveSettings({
      geminiApiKey: keyInput.value.trim(),
      model: modelSel.value,
      enabled: toggle.checked
    });
    updateStatsUI(modelSel.value);
    msgEl.textContent = '保存しました';
    setTimeout(() => msgEl.textContent = '', 1600);
  });

  toggle.addEventListener('change', async (e) => {
    await saveSettings({ enabled: e.target.checked });
    applyMinBtnStyle(e.target.checked);
  });

  settingsToggle.addEventListener('click', () => {
    const hidden = settingsContent.style.display === 'none';
    settingsContent.style.display = hidden ? 'block' : 'none';
  });

  modelSel.addEventListener('change', () => {
    updateStatsUI(modelSel.value);
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.modelStats) {
      modelStatsCache = changes.modelStats.newValue || {};
      updateStatsUI(modelSel.value);
    }
  });

  function updateStatsUI(modelId) {
    const stats = (modelStatsCache && modelStatsCache[modelId]) || { input: 0, output: 0 };
    inEl.textContent = stats.input.toLocaleString();
    outEl.textContent = stats.output.toLocaleString();
    const price = PRICING[modelId] || PRICING.default;
    const inCost = (stats.input / CHARS_PER_TOKEN / 1_000_000) * price.input;
    const outCost = (stats.output / CHARS_PER_TOKEN / 1_000_000) * price.output;
    costEl.textContent = '$' + (inCost + outCost).toFixed(5);
  }
}

// ---------- Generation flow ----------
function startObserver() {
  if (observing) return;
  observing = true;
  const observer = new MutationObserver(() => {
    const now = Date.now();
    if (now - lastObserverRun < RUN_DEBOUNCE_MS) return;
    lastObserverRun = now;
    if (generationInFlight || cancelFlag) return;
    const pane = findThreadPane();
    if (!pane) return;
    if (pane.dataset.gslrProcessed === 'true') return;
    if (pane.dataset.gslrProcessing === 'true') return;
    const composer = findComposer(pane);
    if (!composer) return;
    if (composer.dataset.gslrFilled === 'true') return;
    if (composer.dataset.gslrDone === 'true') return;
    const tKey = getThreadKey(composer);
    if (tKey && threadProcessed.has(tKey)) return;
    if (!settingsCache.enabled) return;
    generateForPane(pane, composer).catch(err => console.error('[gslr]', err));
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

async function generateForPane(pane, composer) {
  pane.dataset.gslrProcessing = 'true';
  composer.dataset.gslrProcessing = 'true';
  await loadSettings();
  if (!cachedKey) {
    showToast('Gemini APIキーを設定してください');
    pane.dataset.gslrProcessing = 'false';
    composer.dataset.gslrProcessing = 'false';
    return;
  }

  generationInFlight = true;
  cancelFlag = false;
  setLoading(composer, true);
  const messages = await collectMessagesWithRetry(pane, 10);
  if (!messages.length) {
    setLoading(composer, false);
    generationInFlight = false;
    pane.dataset.gslrProcessing = 'false';
    composer.dataset.gslrProcessing = 'false';
    return;
  }

  const context = formatContext(messages);
  const threadKey = getThreadKey(composer) || 'unknown-thread';
  const contextKey = `${settingsCache.model}::${threadKey}::${context}`;
  const now = Date.now();

  // If the same context was just processed in the last 30s, reuse it to avoid double generation
  if (lastDraftText && contextKey === lastContextKey && now - lastContextTime < 30000) {
    const normalizedExisting = (composer.innerText || '').replace(/\s+/g, ' ').trim();
    const normalizedTarget = lastDraftText.replace(/\s+/g, ' ').trim();
    if (!normalizedExisting.includes(normalizedTarget)) {
      insertText(composer, lastDraftText);
    }
    composer.dataset.gslrFilled = 'true';
    composer.dataset.gslrDone = 'true';
    pane.dataset.gslrProcessed = 'true';
    pane.dataset.gslrProcessing = 'false';
    composer.dataset.gslrProcessing = 'false';
    showToast('前回のAI返信を再利用しました（Ctrl+Zで取り消し可）', 3000);
    generationInFlight = false;
    return;
  }

  // Cache reuse up to CACHE_TTL_MS
  const cached = replyCache.get(contextKey) || threadDraftMap.get(threadKey);
  if (cached && now - cached.ts < CACHE_TTL_MS) {
    const normalizedExisting = normalizeText(composer.innerText);
    const normalizedTarget = normalizeText(cached.draft || cached);
    if (!normalizedExisting.includes(normalizedTarget)) {
      insertText(composer, cached.draft || cached);
    }
    composer.dataset.gslrFilled = 'true';
    composer.dataset.gslrDone = 'true';
    pane.dataset.gslrProcessed = 'true';
    pane.dataset.gslrProcessing = 'false';
    composer.dataset.gslrProcessing = 'false';
    showToast('キャッシュ済みAI返信を挿入しました（Ctrl+Zで取り消し可）', 3000);
    generationInFlight = false;
    return;
  }

  const payload = {
    type: 'GENERATE_REPLY',
    contextText: context,
    settings: {
      apiKey: cachedKey,
      model: settingsCache.model,
      temperature: FIXED_PARAMS.temperature,
      topP: FIXED_PARAMS.topP,
      maxTokens: FIXED_PARAMS.maxTokens
    }
  };

  const res = await new Promise((resolve) => {
    chrome.runtime.sendMessage(payload, resolve);
    setTimeout(() => resolve({ success: false, error: 'タイムアウト' }), 9000);
  });

  setLoading(composer, false);
  generationInFlight = false;
  if (cancelFlag) return;

  if (!res || !res.success) {
    showToast(res?.error || '生成に失敗しました');
    pane.dataset.gslrProcessing = 'false';
    composer.dataset.gslrProcessing = 'false';
    return;
  }

  // Avoid duplicate insert if already present
  const draftWithMark = `${res.data.trim()}\n😊`;
  const existing = normalizeText(composer.innerText);
  const target = normalizeText(draftWithMark);
  if (composer.dataset.gslrDraft !== target && !existing.includes(target)) {
    insertText(composer, draftWithMark);
    composer.dataset.gslrDraft = target;
  }
  lastContextKey = contextKey;
  lastContextTime = Date.now();
  lastDraftText = draftWithMark;
  const stamp = { ts: Date.now(), draft: draftWithMark };
  replyCache.set(contextKey, stamp);
  threadDraftMap.set(threadKey, stamp);
  if (threadKey) threadProcessed.add(threadKey);
  composer.dataset.gslrFilled = 'true';
  composer.dataset.gslrDone = 'true';
  pane.dataset.gslrProcessed = 'true';
  pane.dataset.gslrProcessing = 'false';
  composer.dataset.gslrProcessing = 'false';
  showToast('AI返信を挿入しました（Ctrl+Zで取り消し可）', 3000);
}

function normalizeText(str) {
  return (str || '').replace(/\s+/g, ' ').trim();
}

function getThreadKey(composer) {
  if (!composer) return '';
  const container = composer.closest('[data-thread-key]');
  const key = container?.getAttribute('data-thread-key') || composer.getAttribute('data-thread-key');
  return key || '';
}

async function collectMessagesWithRetry(pane, attempts) {
  let remaining = attempts;
  while (remaining-- > 0) {
    const msgs = findMessages(pane);
    if (msgs.length) return trimMessages(msgs);
    await wait(300);
  }
  return [];
}

function trimMessages(msgs) {
  // If too many, keep parent + last 40, summarize middle (placeholder)
  if (msgs.length <= 50) return msgs;
  const parent = msgs[0];
  const tail = msgs.slice(-40);
  const middle = msgs.slice(1, -40);
  const summary = {
    sender: 'system',
    text: `中間${middle.length}件は省略しました（要約未実装）`,
    isParent: false,
    ts: 1
  };
  return [parent, summary, ...tail];
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------- Init ----------
(async function init() {
  await loadSettings();
  ensurePanel();
  startObserver();
})();
