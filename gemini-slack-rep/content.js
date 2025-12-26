// Content Script - Gemini Slack Reply
typeof console !== 'undefined' && console.log('[Gemini Slack Reply] loaded');

const PANEL_ID = 'gslr-panel';
const BUTTON_ID = 'gslr-header-btn';
const PANEL_Z_EXPANDED = 2147483647;
const CHARS_PER_TOKEN = 4;
const RUN_DEBOUNCE_MS = 300;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULTS = {
  model: 'gemini-2.5-flash-lite',
  enabled: true,
  debug: false
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
  maxTokens: 2048
};

// Model-specific output token ceilings (largerモデルで途切れないように少し多め)
const MODEL_MAX_TOKENS = {
  'gemini-3-flash-preview': 2048,
  'gemini-2.5-flash': 2048,
  'gemini-2.5-flash-lite': 2048
};

let cachedKey = '';
let settingsCache = { ...DEFAULTS };
let observing = false;
let cancelFlag = false;
let generationInFlight = false;
let modelStatsCache = {};
let lastContextKey = '';
let lastContextTime = 0;
let lastDraftText = '';
let lastObserverRun = 0;
const replyCache = new Map(); // key -> { ts, draft }
const threadProcessed = new Set(); // threadKey strings
const threadDraftMap = new Map(); // threadKey -> draft
const threadLock = new Set(); // threadKey processing mutex
const activeDropdowns = new Set(); // track open dropdown menus
const CHANNEL_TYPE = {
  PUBLIC: 'public',
  PRIVATE: 'private',
  DM: 'dm',
  MPDM: 'mpdm',
  UNKNOWN: 'unknown'
};

// Global click handler for closing dropdowns (prevents memory leak)
document.addEventListener('click', (e) => {
  activeDropdowns.forEach(menu => {
    if (!menu.parentElement?.contains(e.target)) {
      menu.style.display = 'none';
    }
  });
});

// ---------- Storage helpers ----------
async function loadSettings() {
  try {
    const data = await chrome.storage.local.get([
      'geminiApiKey',
      'gslrModel',
      'gslrEnabled',
      'gslrInstruction',
      'gslrMyName',
      'gslrRelationships',
      'gslrHonorific',
      'gslrDebug',
      'modelStats'
    ]);
    cachedKey = (data.geminiApiKey || '').trim();
    settingsCache = {
      model: data.gslrModel || DEFAULTS.model,
      enabled: data.gslrEnabled !== false,
      instruction: data.gslrInstruction || '',
      myName: data.gslrMyName || '',
      relationships: data.gslrRelationships || '',
      honorific: data.gslrHonorific || 'さん',
      debug: data.gslrDebug === true
    };
    modelStatsCache = data.modelStats || {};
  } catch (e) {
    if (e.message.includes('Extension context invalidated')) {
      console.log('Context invalidated during loadSettings');
      return;
    }
    throw e;
  }
}

async function saveSettings(partial) {
  try {
    const next = { ...settingsCache, ...partial };
    const payload = {
      geminiApiKey: partial.geminiApiKey !== undefined ? partial.geminiApiKey : cachedKey,
      gslrModel: next.model,
      gslrEnabled: next.enabled,
      gslrInstruction: next.instruction,
      gslrMyName: next.myName,
      gslrRelationships: next.relationships,
      gslrHonorific: next.honorific,
      gslrDebug: next.debug === true
    };
    cachedKey = payload.geminiApiKey;
    settingsCache = next;
    await chrome.storage.local.set(payload);
  } catch (e) {
    if (e.message.includes('Extension context invalidated')) {
      showToast('拡張機能が更新されました。ページを再読み込みしてください。', 5000);
      return;
    }
    throw e;
  }
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

  const getTsFromNode = (node) => {
    const attrs = ['data-ts', 'data-qa-ts', 'data-message-ts', 'data-ts-value'];
    const grab = (el) => {
      if (!el) return null;
      for (const a of attrs) {
        const v = el.getAttribute?.(a);
        if (v) {
          const n = parseFloat(v);
          if (!Number.isNaN(n)) return n;
        }
      }
      // time element with datetime
      const t = el.querySelector?.('time');
      const dt = t?.getAttribute?.('datetime') || t?.dateTime;
      if (dt) {
        const n = Date.parse(dt);
        if (!Number.isNaN(n)) return n / 1000;
      }
      const aria = t?.getAttribute?.('aria-label');
      if (aria && /\d{4}/.test(aria)) {
        const n = Date.parse(aria);
        if (!Number.isNaN(n)) return n / 1000;
      }
      return null;
    };
    // try node itself, descendants, then ancestors
    const self = grab(node);
    if (self) return self;
    const desc = Array.from(node.querySelectorAll?.('[data-ts], time') || []);
    for (const d of desc) {
      const v = grab(d);
      if (v) return v;
    }
    const anc = node.closest?.('[data-ts], [data-message-ts]');
    if (anc) return grab(anc);
    return null;
  };

  const nodes = [];
  msgSelectors.forEach(sel => nodes.push(...qsa(sel, pane)));
  const uniq = Array.from(new Set(nodes));

  return uniq.map((node, idx) => {
    const senderEl = senderSelectors.map(s => qs(s, node)).find(Boolean);
    const bodyEl = bodySelectors.map(s => qs(s, node)).find(Boolean);
    const sender = (senderEl?.textContent || '').trim();
    const text = (bodyEl?.textContent || '').trim();
    const tsSec = getTsFromNode(node);
    return {
      sender,
      text,
      isParent: idx === 0,
      ts: idx,
      tsSec
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

function findAllComposers(pane) {
  return qsa('.ql-editor[contenteditable="true"]', pane || document);
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
    const notCancelled = editor.dispatchEvent(ev);
    if (!notCancelled) return;
  } catch (e) {
    // fallback
  }
  document.execCommand('insertText', false, full);
}

// Replace entire composer content with text, restoring previous content on failure
function replaceTextSafely(editor, text) {
  if (!editor) return false;
  const prevHtml = editor.innerHTML;
  try {
    editor.innerText = text; // simple deterministic insert
  } catch (e) {
    editor.innerHTML = prevHtml;
    return false;
  }
  const afterNorm = normalizeText(editor.innerText);
  const targetNorm = normalizeText(text);
  const ok = !!afterNorm && afterNorm.includes(targetNorm);
  if (!ok) editor.innerHTML = prevHtml;
  return ok;
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

// ---------- UI Components ----------

function ensureHeaderButton() {
  if (qs(`#${BUTTON_ID}`)) return;

  // Try to find the container in the top nav
  // User provided: .p-ia4_top_nav__right_container -> .align_items_center.display_flex
  const rightContainer = qs('.p-ia4_top_nav__right_container .align_items_center.display_flex');

  if (!rightContainer) return;

  const btnDiv = document.createElement('div');
  btnDiv.id = BUTTON_ID;
  btnDiv.role = 'button';
  btnDiv.tabIndex = 0;
  // Style to match Slack header icons somewhat
  btnDiv.style.cssText = `
    width: 32px; 
    height: 32px; 
    display: flex; 
    align-items: center; 
    justify-content: center; 
    margin-right: 2px; 
    border-radius: 4px; 
    cursor: pointer; 
    color: rgba(255,255,255,0.9);
    border: 1px solid rgba(255,255,255,0.3);
    background: rgba(255,255,255,0.1);
    transition: background 0.1s;
  `;
  // "S" Icon
  btnDiv.innerHTML = `<span style="font-weight:900;font-size:18px;">S</span>`;

  // Hover effect similar to Slack
  btnDiv.onmouseenter = () => { btnDiv.style.backgroundColor = 'rgba(255,255,255,0.1)'; };
  btnDiv.onmouseleave = () => { btnDiv.style.backgroundColor = 'transparent'; };

  btnDiv.addEventListener('click', () => {
    const panel = qs(`#${PANEL_ID}`);
    if (panel) {
      const isHidden = panel.style.display === 'none';
      panel.style.display = isHidden ? 'block' : 'none';
      if (isHidden) {
        // Position panel near the button? Or just fixed top right
        // Let's keep fixed top right as defined in ensurePanel
      }
    }
  });

  // Insert at the beginning of the container (left of ?)
  if (rightContainer.firstChild) {
    rightContainer.insertBefore(btnDiv, rightContainer.firstChild);
  } else {
    rightContainer.appendChild(btnDiv);
  }
}

function ensurePanel() {
  // Try to insert header button first
  ensureHeaderButton();

  if (qs(`#${PANEL_ID}`)) return;

  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  // Fixed positioning, hidden by default
  panel.style.cssText = `position:fixed;top:48px;right:16px;z-index:${PANEL_Z_EXPANDED};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:none;`;

  panel.innerHTML = `
    <style>
      #gslr-expanded { width:280px; background:#fff; border-radius:14px; box-shadow:0 12px 28px rgba(0,0,0,0.12); padding:14px; }
      #gslr-expanded label { display:block; margin:8px 0 4px; font-size:12px; font-weight:700; }
      #gslr-expanded input, #gslr-expanded select, #gslr-expanded textarea { width:100%; padding:8px; border:1px solid #d1d5db; border-radius:8px; font-size:13px; }
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
          <svg viewBox="0 0 24 24" aria-hidden="true" style="width:20px;height:20px;color:#536471;"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" fill="currentColor"></path></svg>
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
      <label style="margin-top:10px;">返信の指示 (任意)</label>
      <textarea id="gslr-instruction" rows="2" placeholder="例: 「丁寧語で」「箇条書きで」など" style="margin-bottom:8px;"></textarea>

      <button id="gslr-settings-toggle" style="width:100%; text-align:left; background:none; border:none; padding:0; cursor:pointer; display:flex; align-items:center; gap:6px; color:#10b981; font-weight:700; font-size:13px; margin:8px 0 6px;">
        <span style="font-size:16px;">⚙️</span> 設定 (モデル・キー)
      </button>
      <div id="gslr-settings-content" style="display:none;">
        <label>自分の表示名 (文脈判定用)</label>
        <input type="text" id="gslr-my-name" placeholder="Slackの表示名 (例: yamada)" style="margin-bottom:8px;">

        <label>関係性・役割 (任意)</label>
        <textarea id="gslr-relationships" rows="2" placeholder="フォーマット: 名前:役割:呼び名\n例: 田中:上司:田中部長, 鈴木:同僚:すずさん" style="margin-bottom:8px;"></textarea>

        <label>相手の呼び方 (自動メンション用)</label>
        <input type="text" id="gslr-honorific" placeholder="例: さん, くん, 様 (デフォルト: さん)" style="margin-bottom:8px;">

        <label>モデル</label>
        <select id="gslr-model">
          <option value="gemini-2.5-flash-lite">gemini-2.5-flash-lite (最安)</option>
          <option value="gemini-2.5-flash">gemini-2.5-flash</option>
          <option value="gemini-3-flash-preview">gemini-3-flash-preview (最新)</option>
        </select>
        <label style="margin-top:10px;">Gemini APIキー</label>
        <input type="password" id="gslr-key" placeholder="AI Studio Key">
        <label style="display:flex;align-items:center;gap:8px;margin-top:10px;">
          <input type="checkbox" id="gslr-debug">
          <span>デバッグログを有効化（コンソールに環境情報を出力）</span>
        </label>
      </div>
      <button id="gslr-save">保存</button>
      <div id="gslr-msg"></div>
    </div>
  `;
  document.body.appendChild(panel);

  const closeBtn = qs('#gslr-close', panel);
  const toggle = qs('#gslr-toggle', panel);
  const modelSel = qs('#gslr-model', panel);
  const keyInput = qs('#gslr-key', panel);
  const instructionInput = qs('#gslr-instruction', panel);
  const myNameInput = qs('#gslr-my-name', panel);
  const relationshipsInput = qs('#gslr-relationships', panel);
  const honorificInput = qs('#gslr-honorific', panel);
  const debugInput = qs('#gslr-debug', panel);
  const saveBtn = qs('#gslr-save', panel);
  const msgEl = qs('#gslr-msg', panel);
  const costEl = qs('#gslr-cost', panel);
  const inEl = qs('#gslr-input-chars', panel);
  const outEl = qs('#gslr-output-chars', panel);
  const settingsToggle = qs('#gslr-settings-toggle', panel);
  const settingsContent = qs('#gslr-settings-content', panel);

  closeBtn.addEventListener('click', () => {
    panel.style.display = 'none';
  });

  const applyBtnStyle = (checked) => {
    const btn = qs(`#${BUTTON_ID}`);
    if (!btn) return;
    if (checked) {
      btn.style.opacity = '1';
      btn.style.filter = 'none';
    } else {
      btn.style.opacity = '0.6';
      btn.style.filter = 'grayscale(100%)';
    }
  };

  function syncUI() {
    toggle.checked = settingsCache.enabled;
    modelSel.value = settingsCache.model;
    keyInput.value = cachedKey;
    if (instructionInput) instructionInput.value = settingsCache.instruction || '';
    if (myNameInput) myNameInput.value = settingsCache.myName || '';
    if (relationshipsInput) relationshipsInput.value = settingsCache.relationships || '';
    if (honorificInput) honorificInput.value = settingsCache.honorific || 'さん';
    if (debugInput) debugInput.checked = settingsCache.debug === true;
    updateStatsUI(modelSel.value);
    applyBtnStyle(toggle.checked);
  }
  syncUI();

  saveBtn.addEventListener('click', async () => {
    await saveSettings({
      geminiApiKey: keyInput.value.trim(),
      model: modelSel.value,
      enabled: toggle.checked,
      instruction: instructionInput ? instructionInput.value : '',
      myName: myNameInput ? myNameInput.value : '',
      relationships: relationshipsInput ? relationshipsInput.value : '',
      honorific: honorificInput ? honorificInput.value : 'さん',
      debug: debugInput ? debugInput.checked : false
    });
    msgEl.textContent = '保存しました';
    setTimeout(() => msgEl.textContent = '', 1600);
    applyBtnStyle(toggle.checked);
  });

  toggle.addEventListener('change', async (e) => {
    await saveSettings({ enabled: e.target.checked });
    applyBtnStyle(e.target.checked);
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

function ensureInlineButton(pane, composer) {
  if (composer.dataset.gslrHasButton === 'true') return;
  const container = composer.closest('.c-wysiwyg_container');
  const toolbarSuffix = container?.querySelector('.c-wysiwyg_container__suffix');
  if (!toolbarSuffix) return;

  // Wrapper: mimic c-wysiwyg_container__send_button--with_options
  const wrapper = document.createElement('div');
  wrapper.className = 'gslr-btn-group';
  wrapper.style.cssText = `
    display: inline-flex;
    align-items: center;
    margin-left: 8px;
    height: 28px; /* Match x-small size */
    border-radius: 4px;
    background: #fff;
    border: 1px solid #d1d5db; /* Default border */
    box-shadow: 0 1px 2px rgba(0,0,0,0.05);
    position: relative;
  `;

  // Main Button
  const mainBtn = document.createElement('button');
  mainBtn.type = 'button';
  mainBtn.innerHTML = `
    <span style="display:flex;align-items:center;gap:4px;">
      <span style="font-size:14px;">💬</span>
      <span style="font-weight:700;font-size:13px;padding-top:1px;">AI返信</span>
    </span>`;
  mainBtn.style.cssText = `
    height: 100%;
    padding: 0 8px 0 8px;
    border: none;
    border-right: 1px solid #d1d5db;
    background: transparent;
    color: #0f172a;
    cursor: pointer;
    display: flex;
    align-items: center;
    transition: background 0.1s;
  `;
  mainBtn.onmouseenter = () => mainBtn.style.background = '#f1f5f9';
  mainBtn.onmouseleave = () => mainBtn.style.background = 'transparent';
  mainBtn.addEventListener('click', () => {
    if (!settingsCache.enabled) return;
    generateForPane(pane, composer, { manual: true }).catch(err => console.error('[gslr]', err));
  });

  // Dropdown Toggle
  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.innerHTML = `<svg viewBox="0 0 20 20" style="width:16px;height:16px;color:#64748b;"><path fill="currentColor" fill-rule="evenodd" d="M5.72 7.47a.75.75 0 0 1 1.06 0L10 10.69l3.22-3.22a.75.75 0 1 1 1.06 1.06l-3.75 3.75a.75.75 0 0 1-1.06 0L5.72 8.53a.75.75 0 0 1 0-1.06" clip-rule="evenodd"></path></svg>`;
  toggleBtn.style.cssText = `
    height: 100%;
    padding: 0 4px;
    border: none;
    background: transparent;
    cursor: pointer;
    display: flex;
    align-items: center;
    transition: background 0.1s;
  `;
  toggleBtn.onmouseenter = () => toggleBtn.style.background = '#f1f5f9';
  toggleBtn.onmouseleave = () => toggleBtn.style.background = 'transparent';

  // Dropdown Menu
  const menu = document.createElement('div');
  menu.style.cssText = `
    position: absolute;
    bottom: 100%;
    right: 0;
    margin-bottom: 4px;
    background: #fff;
    border: 1px solid #e2e8f0;
    box-shadow: 0 4px 12px rgba(0,0,0,0.1);
    border-radius: 6px;
    min-width: 140px;
    display: none;
    z-index: 10000;
    padding: 4px 0;
  `;
  const forceBtn = document.createElement('div');
  forceBtn.textContent = '♻️ 強制再生成';
  forceBtn.style.cssText = 'padding:8px 12px;font-size:13px;cursor:pointer;color:#334155;font-weight:500;';
  forceBtn.onmouseenter = () => forceBtn.style.background = '#f8fafc';
  forceBtn.onmouseleave = () => forceBtn.style.background = 'transparent';
  forceBtn.addEventListener('click', () => {
    menu.style.display = 'none';
    generateForPane(pane, composer, { manual: true, force: true }).catch(err => console.error('[gslr]', err));
  });

  menu.appendChild(forceBtn);
  wrapper.appendChild(mainBtn);
  wrapper.appendChild(toggleBtn);
  wrapper.appendChild(menu);

  // Toggle Logic
  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = menu.style.display === 'none';
    menu.style.display = isHidden ? 'block' : 'none';
  });

  // Register menu for global close handler
  activeDropdowns.add(menu);

  toolbarSuffix.appendChild(wrapper);
  composer.dataset.gslrHasButton = 'true';
}

function startObserver() {
  if (observing) return;
  observing = true;

  // Immediately try to inject buttons
  const pane = findThreadPane();
  if (pane) {
    const composers = findAllComposers(pane);
    composers.forEach(composer => ensureInlineButton(pane, composer));
  }

  const observer = new MutationObserver(() => {
    const now = Date.now();
    ensureHeaderButton();

    // Always check for composers (no debounce for button injection)
    const pane = findThreadPane();
    if (pane && pane.dataset.gslrProcessing !== 'true') {
      const composers = findAllComposers(pane);
      composers.forEach(composer => ensureInlineButton(pane, composer));
    }

    // Debounce only for generation logic
    if (now - lastObserverRun < RUN_DEBOUNCE_MS) return;
    lastObserverRun = now;
    if (generationInFlight || cancelFlag) return;
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

// ---------- Logic ----------
async function generateForPane(pane, composer, opts = {}) {
  // Respect global toggle even if some path calls this unexpectedly
  await loadSettings().catch(() => { });
  if (!settingsCache.enabled && !opts.manual) {
    pane.dataset.gslrProcessing = 'false';
    composer.dataset.gslrProcessing = 'false';
    return;
  }

  const { threadKey, channelId } = getThreadMeta(composer);
  if (threadLock.has(threadKey)) {
    if (opts.force) {
      // Wait a short time for previous run to finish instead of dropping force request
      const waited = await waitForUnlock(threadKey, 8, 400);
      if (!waited) {
        showToast('直前の生成が処理中です。数秒おいて再度お試しください。');
      }
    }
    if (threadLock.has(threadKey)) return;
  }
  threadLock.add(threadKey);
  generationInFlight = true;

  pane.dataset.gslrProcessing = 'true';
  composer.dataset.gslrProcessing = 'true';
  // loadSettings already done at top; cachedKey set there
  if (!cachedKey) {
    showToast('Gemini APIキーを設定してください');
    pane.dataset.gslrProcessing = 'false';
    composer.dataset.gslrProcessing = 'false';
    threadLock.delete(threadKey);
    generationInFlight = false;
    return;
  }

  cancelFlag = false;
  setLoading(composer, true);

  if (!opts.manual && normalizeText(composer.innerText).length > 0 && composer.dataset.gslrFilled !== 'true') {
    setLoading(composer, false);
    pane.dataset.gslrProcessing = 'false';
    composer.dataset.gslrProcessing = 'false';
    threadLock.delete(threadKey);
    generationInFlight = false;
    return;
  }

  const messages = await collectMessagesWithRetry(pane, 10);
  if (!messages.length) {
    setLoading(composer, false);
    generationInFlight = false;
    pane.dataset.gslrProcessing = 'false';
    composer.dataset.gslrProcessing = 'false';
    threadLock.delete(threadKey);
    return;
  }

  const context = formatContext(messages);
  const contextKey = `${settingsCache.model}::${threadKey}::${context}`;
  const now = Date.now();
  const latestTsSec = Math.max(...messages.map(m => m.tsSec || 0));
  const elapsedText = latestTsSec ? formatElapsed(latestTsSec) : '';
  const channelMeta = detectChannelType(channelId);
  if (settingsCache.debug) {
    console.log('[gslr][debug] channel', { channelId, channelType: channelMeta.type, visibility: channelMeta.visibility });
    console.log('[gslr][debug] latestTsSec', latestTsSec, 'elapsed', elapsedText);
    console.log('[gslr][debug] messages', messages.slice(-5));
    console.log('[gslr][debug] context', context);
  }

  // Find reply target
  let replyTargetName = '';
  if (messages.length > 0) {
    // Find the last message that isn't from me
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.sender && m.sender !== 'system' && m.sender !== settingsCache.myName) {
        replyTargetName = m.sender;
        break;
      }
    }
  }

  // Relationships are now passed verbatim to the model; it decides呼び名/敬称
  const parsedRelationships = settingsCache.relationships;
  const finalHonorific = settingsCache.honorific;

  if (!opts.force && lastDraftText && contextKey === lastContextKey && now - lastContextTime < 30000) {
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
    threadLock.delete(threadKey);
    showToast('前回のAI返信を再利用しました（強制生成は▼メニューから）', 3000);
    generationInFlight = false;
    return;
  }

  const cached = replyCache.get(contextKey) || threadDraftMap.get(threadKey);
  if (!opts.force && cached && now - cached.ts < CACHE_TTL_MS) {
    const normalizedExisting = normalizeText(composer.innerText);
    const normalizedTarget = normalizeText(cached.draft || cached);
    if (!normalizedExisting.includes(normalizedTarget)) {
      composer.innerHTML = '';
      insertText(composer, cached.draft || cached);
    }
    composer.dataset.gslrFilled = 'true';
    composer.dataset.gslrDone = 'true';
    pane.dataset.gslrProcessed = 'true';
    pane.dataset.gslrProcessing = 'false';
    composer.dataset.gslrProcessing = 'false';
    threadLock.delete(threadKey);
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
      maxTokens: MODEL_MAX_TOKENS[settingsCache.model] || FIXED_PARAMS.maxTokens,
      instruction: settingsCache.instruction,
      myName: settingsCache.myName,
      relationships: parsedRelationships,
      replyTarget: replyTargetName,
      honorific: finalHonorific,
      channelInfo: { channelId, channelType: channelMeta.type, visibility: channelMeta.visibility },
      timingInfo: { latestTsSec, latestElapsed: elapsedText }
    }
  };

  const res = await new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(payload, resolve);
    } catch (e) {
      resolve({ success: false, error: e.message || 'コンテキストエラー' });
    }
    // 大きめmaxTokens時の遅延に備えて少し長めのタイムアウト
    // 大きめmaxTokens時の遅延に備えて少し長めのタイムアウト
    setTimeout(() => resolve({ success: false, error: 'タイムアウト' }), 25000);
  });

  setLoading(composer, false);
  generationInFlight = false;
  if (cancelFlag) return;

  if (!res || !res.success) {
    if ((res?.error || '').includes('Extension context invalidated')) {
      threadLock.delete(threadKey);
      pane.dataset.gslrProcessing = 'false';
      composer.dataset.gslrProcessing = 'false';
      return;
    }
    showToast(res?.error || '生成に失敗しました');
    pane.dataset.gslrProcessing = 'false';
    composer.dataset.gslrProcessing = 'false';
    threadLock.delete(threadKey);
    return;
  }

  const draftWithMark = res.data.trim();
  const existing = normalizeText(composer.innerText);
  const target = normalizeText(draftWithMark);
  const shouldReplace = opts.force || composer.dataset.gslrDraft !== target || !existing.includes(target);
  let inserted = false;
  if (shouldReplace) {
    const ok = replaceTextSafely(composer, draftWithMark);
    if (!ok) {
      showToast('AI返信の挿入に失敗しました（復元済み）');
      threadLock.delete(threadKey);
      pane.dataset.gslrProcessing = 'false';
      composer.dataset.gslrProcessing = 'false';
      return;
    }
    composer.dataset.gslrDraft = target;
    inserted = true;
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
  threadLock.delete(threadKey);
  if (inserted) {
    showToast('AI返信を挿入しました（Ctrl+Zで取り消し可）', 3000);
  } else if (opts.force) {
    showToast('AI返信は既存内容と同じため変更なしでした', 2500);
  }
}

function normalizeText(str) {
  return (str || '').replace(/\s+/g, ' ').trim();
}

function getThreadMeta(composer) {
  if (!composer) return { threadKey: 'unknown-thread', channelId: '' };
  const container = composer.closest('[data-thread-key]');
  const keyFromAttr = container?.getAttribute('data-thread-key') || composer.getAttribute('data-thread-key');
  const metaEl = composer.closest('[data-thread-ts]') || composer.closest('[data-qa="message_input"]');
  const threadTs = metaEl?.getAttribute('data-thread-ts') || metaEl?.getAttribute('data-thread_ts');
  const channelId = metaEl?.getAttribute('data-channel-id') || metaEl?.getAttribute('data-channel_id') || '';
  const threadKey = keyFromAttr || (threadTs && channelId ? `${channelId}-${threadTs}` : threadTs ? `thread-${threadTs}` : 'unknown-thread');
  return { threadKey, channelId };
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

function detectChannelType(channelId = '') {
  if (!channelId) return { type: CHANNEL_TYPE.UNKNOWN, visibility: 'unknown' };
  const prefix = channelId[0];
  if (prefix === 'D') return { type: CHANNEL_TYPE.DM, visibility: 'private' };
  if (prefix === 'E' || prefix === 'F') return { type: CHANNEL_TYPE.MPDM, visibility: 'private' };
  if (prefix === 'G') return { type: CHANNEL_TYPE.PRIVATE, visibility: 'private' };
  if (prefix === 'C') return { type: CHANNEL_TYPE.PUBLIC, visibility: 'public' };
  return { type: CHANNEL_TYPE.UNKNOWN, visibility: 'unknown' };
}

function formatElapsed(tsSec) {
  if (!tsSec) return '';
  const nowSec = Date.now() / 1000;
  const diff = Math.max(0, nowSec - tsSec);
  const minutes = Math.floor(diff / 60);
  if (minutes < 1) return '直近数十秒以内';
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  const days = Math.floor(hours / 24);
  return `${days}日前`;
}

async function waitForUnlock(threadKey, attempts = 6, interval = 300) {
  while (attempts-- > 0) {
    await wait(interval);
    if (!threadLock.has(threadKey)) return true;
  }
  return false;
}

// ---------- Init ----------
(async function init() {
  await loadSettings();
  ensurePanel();
  startObserver();
})();
