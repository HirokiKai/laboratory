// Content Script - Gemini ReRT (Auto draft for reply/quote)
console.log('[Gemini ReRT] Loaded.');

const PANEL_MARGIN = { top: 210, right: 70 };
const PANEL_Z_INDEX_EXPANDED = 2147483647;
const PANEL_Z_INDEX_MINIMIZED = 2147483000;
const CHARS_PER_TOKEN = 4;
const MAX_PROMPT_PATTERNS = 5;
const DEFAULT_PROMPT_TEMPLATE = `次の投稿内容から{{mode}}してください。\n\n条件:\n- 40〜80文字\n- 観察者の視点で、事実と解釈を分けて\n- 不特定多数に伝わるようにする\n- 出力は本文だけ\n- 前置き、記号、注釈は不要\n\n投稿内容:\n{{text}}`;
const SHIMMER_STYLE = `
  @keyframes rr-shimmer { 0% { background-position: -200px 0; } 100% { background-position: 200px 0; } }
  .rr-shimmer {
    position: relative;
    color: transparent !important;
    background: linear-gradient(90deg, #f1f3f4 0%, #e6ecf0 50%, #f1f3f4 100%);
    background-size: 200px 100%;
    animation: rr-shimmer 1.1s linear infinite;
    border-radius: 6px;
  }
  @keyframes rr-flash { 0% { background-color: #e8f5fd; } 100% { background-color: transparent; } }
  .rr-done { animation: rr-flash 0.8s ease; }
`;

const DEFAULT_MODEL = 'gemini-2.5-flash-lite';
const MODEL_MIGRATION_KEY = 'geminiModelMigratedTo25FlashLite';
const PRICING = {
  'gemini-2.5-flash-lite': { input: 0.10, output: 0.40 },
  'gemini-2.0-flash-lite': { input: 0.075, output: 0.30 },
  'gemini-2.0-flash': { input: 0.10, output: 0.40 },
  'gemini-2.5-flash': { input: 0.30, output: 2.50 },
  'gemini-3-flash-preview': { input: 0.30, output: 2.50 },
  'default': { input: 0.10, output: 0.40 }
};

let isPanelMinimized = true;
let cachedApiKey = '';
const draftCache = new Map();
const pendingDrafts = new Set();
let toastContainer = null;

function getTweetTextElements(root) {
  const primary = root.querySelectorAll ? root.querySelectorAll('[data-testid="tweetText"]') : [];
  if (primary && primary.length) return Array.from(primary);
  const fallback = root.querySelectorAll ? root.querySelectorAll('div[lang]') : [];
  return Array.from(fallback).filter((el) => el.closest && el.closest('article'));
}

async function ensureApiKey() {
  if (cachedApiKey) return cachedApiKey;
  const res = await chrome.storage.local.get(['geminiApiKey']);
  cachedApiKey = (res.geminiApiKey || '').trim();
  return cachedApiKey;
}

function getCacheKey(text, mode) {
  return `${mode}::${text.trim()}`;
}

function ensureToast() {
  if (toastContainer) return toastContainer;
  const div = document.createElement('div');
  div.id = 'rr-toast';
  div.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483646;display:flex;flex-direction:column;gap:8px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;';
  document.body.appendChild(div);
  toastContainer = div;
  return div;
}

function showToast(message, tone = 'info') {
  const container = ensureToast();
  const toast = document.createElement('div');
  toast.textContent = message;
  toast.style.cssText = 'padding:10px 12px;border-radius:10px;box-shadow:rgba(0,0,0,0.12) 0 6px 16px; background:' +
    (tone === 'error' ? '#ffe6e6' : tone === 'success' ? '#e6ffed' : '#f7f9f9') +
    '; color:#0f1419; min-width: 200px;';
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 160ms ease';
    setTimeout(() => toast.remove(), 200);
  }, 2200);
}

function createPanel() {
  const section = document.createElement('div');
  section.id = 'gemini-rert-panel';
  section.style.cssText = `
    position: fixed;
    z-index: ${PANEL_Z_INDEX_MINIMIZED};
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  `;
  section.style.top = `${PANEL_MARGIN.top}px`;
  section.style.right = `${PANEL_MARGIN.right}px`;
  section.style.bottom = 'auto';
  section.style.left = 'auto';
  section.style.width = 'auto';

  const rIconSvg = `<span aria-hidden="true" style="display: inline-flex; align-items: center; justify-content: center; width: 100%; height: 100%; font-size: 24px; font-weight: 700; line-height: 1; font-family: system-ui, -apple-system, 'Segoe UI', Arial, sans-serif; color: currentColor;">R</span>`;
  const closeIconSvg = `<svg viewBox="0 0 24 24" aria-hidden="true" style="color: #536471; width: 20px; height: 20px;"><g><path d="M12 15.41l-7.29-7.29 1.41-1.42L12 12.59l5.88-5.89 1.41 1.42L12 15.41z" fill="currentColor"></path></g></svg>`;

  section.innerHTML = `
    <style>
      ${SHIMMER_STYLE}
      #rr-expanded-view { transform-origin: top right; transition: opacity 220ms ease, transform 260ms cubic-bezier(0.2, 0.9, 0.2, 1); }
      #rr-minimized-view { transform-origin: top right; transition: opacity 180ms ease, transform 220ms cubic-bezier(0.2, 0.9, 0.2, 1); }
      .rr-hidden { opacity: 0; transform: scale(0.92); pointer-events: none; }
      .rr-visible { opacity: 1; transform: scale(1); }
      .rr-tab-btn {
        flex:1;
        display:flex;
        align-items:center;
        justify-content:center;
        padding:12px 10px;
        border:1.5px solid #d4dce3;
        background:#fff;
        cursor:pointer;
        font-weight:800;
        font-size:13px;
        border-radius:14px;
        color:#0f1419;
        box-shadow: inset 0 0 0 0 transparent;
        transition: background 0.18s ease, color 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease;
      }
      .rr-tab-btn.active {
        background:#0f1419;
        color:#ffffff;
        border-color:#0f1419;
        box-shadow: 0 2px 6px rgba(0,0,0,0.18);
      }
      .rr-tab-pane { display:none; }
      .rr-tab-pane.active { display:block; }
    </style>

    <div id="rr-expanded-view" class="css-175oi2r r-105ug2t r-14lw9ot r-1867qdf r-1upvrn0 r-13awgt0 r-1ce3o0f r-1udh08x r-u8s1d r-13qz1uu rr-hidden" style="width: 300px; max-height: 80vh; display: none; flex-direction: column; box-shadow: rgba(101, 119, 134, 0.2) 0px 0px 15px, rgba(101, 119, 134, 0.15) 0px 0px 3px 1px; border-radius: 16px; background-color: white; position: relative;">
      <button id="rr-minimize-btn" type="button" style="position: absolute; top: 8px; right: 8px; background: rgba(0,0,0,0.05); border: none; border-radius: 50%; width: 32px; height: 32px; display: flex; justify-content: center; align-items: center; cursor: pointer; transition: background 0.2s; z-index: 1;">${closeIconSvg}</button>
      <div id="rr-header" class="css-175oi2r" style="cursor: move; padding: 12px 16px 8px 16px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #eff3f4; min-height: 50px;">
        <div style="font-weight: 800; font-size: 15px; color: #0f1419;">Gemini ReRT</div>
      </div>
      <div id="rr-body" style="padding: 16px; overflow-y: auto;">
        <div style="display:flex; gap:8px; margin-bottom:12px;">
          <button class="rr-tab-btn active" data-tab="gen">生成</button>
          <button class="rr-tab-btn" data-tab="pattern">パターン</button>
          <button class="rr-tab-btn" data-tab="settings">設定</button>
        </div>
        <div id="rr-tab-gen" class="rr-tab-pane active">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
          <span style="font-size: 14px; font-weight: 700; color: #0f1419;">自動下書き</span>
          <label style="position: relative; display: inline-block; width: 44px; height: 24px;">
            <input type="checkbox" id="rr-toggle" checked style="opacity: 0; width: 0; height: 0;">
            <span style="position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #2ecc71; transition: .4s; border-radius: 24px;"></span>
            <span id="rr-slider-knob" style="position: absolute; content: ''; height: 20px; width: 20px; left: 2px; bottom: 2px; background-color: white; transition: .4s; border-radius: 50%; transform: translateX(20px);"></span>
          </label>
        </div>

        <div style="background-color: #f7f9f9; padding: 12px 16px; border-radius: 12px; margin-bottom: 20px; border: 1px solid #eff3f4;">
          <div style="font-size: 11px; color: #536471; font-weight: 500;">推定コスト (モデル別目安)</div>
          <div id="rr-cost" style="font-size: 22px; font-weight: 800; color: #0f1419; margin: 4px 0 8px 0;">$0.0000</div>
          <div style="font-size: 11px; color: #536471; display: flex; justify-content: space-between;">
            <span>In: <b id="rr-input-chars" style="color: #0f1419;">0</b></span>
            <span>Out: <b id="rr-output-chars" style="color: #0f1419;">0</b></span>
          </div>
        </div>
        </div>
        <div id="rr-tab-pattern" class="rr-tab-pane">
        <div style="margin-bottom: 12px;">
          <label style="display: block; font-size: 13px; margin-bottom: 6px; font-weight: 700; color: #0f1419;">プロンプトパターン</label>
          <select id="rr-pattern-select" style="width: 100%; appearance: none; -webkit-appearance: none; background-color: white; border: 1px solid #cfd9de; border-radius: 8px; padding: 10px 32px 10px 12px; font-size: 14px; color: #0f1419; font-weight: 500; cursor: pointer;"></select>
        </div>

        <div style="margin-bottom: 10px;">
          <label style="display: block; font-size: 13px; margin-bottom: 6px; font-weight: 700; color: #0f1419;">パターン名</label>
          <input type="text" id="rr-pattern-name" placeholder="例: デフォルト / 断定控えめ" style="width: 100%; border: 1px solid #cfd9de; border-radius: 8px; padding: 10px 12px; font-size: 14px; color: #0f1419; box-sizing: border-box; outline: none; transition: border 0.2s;">
        </div>

        <div style="margin-bottom: 12px;">
          <label style="display: block; font-size: 13px; margin-bottom: 6px; font-weight: 700; color: #0f1419;">プロンプト本文</label>
          <textarea id="rr-pattern-prompt" rows="7" placeholder="ここにプロンプトを入力" style="width: 100%; border: 1px solid #cfd9de; border-radius: 8px; padding: 10px 12px; font-size: 13px; color: #0f1419; box-sizing: border-box; outline: none; transition: border 0.2s; resize: vertical;"></textarea>
          <div style="font-size: 11px; color: #536471; margin-top: 6px;">{{mode}} と {{text}} が使えます</div>
        </div>

        <button id="rr-pattern-add" style="width: 100%; margin-bottom: 12px; background-color: #f7f9f9; color: #0f1419; border: 1px dashed #cfd9de; padding: 10px; border-radius: 10px; cursor: pointer; font-weight: 700; font-size: 13px;">+ 新規パターン</button>
        </div>
        <div id="rr-tab-settings" class="rr-tab-pane">
          <div style="margin-bottom: 15px;">
            <label style="display: block; font-size: 13px; margin-bottom: 6px; font-weight: 700; color: #0f1419;">モデル</label>
            <select id="rr-model" style="width: 100%; appearance: none; -webkit-appearance: none; background-color: white; border: 1px solid #cfd9de; border-radius: 8px; padding: 10px 32px 10px 12px; font-size: 14px; color: #0f1419; font-weight: 500; cursor: pointer;">
              <option value="gemini-2.0-flash-lite">Gemini 2.0 Flash-Lite</option>
              <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
              <option value="gemini-2.5-flash-lite">Gemini 2.5 Flash-Lite</option>
              <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
              <option value="gemini-3-flash-preview">Gemini 3 Flash Preview</option>
            </select>
          </div>
          <div style="margin: 0 0 15px 0; padding: 10px 12px; border: 1px solid #eff3f4; border-radius: 10px; background-color: #f7f9f9;">
            <div style="font-size: 11px; font-weight: 700; color: #536471; margin-bottom: 6px;">モデル料金 (USD / 1M tokens)</div>
            <div style="display: grid; grid-template-columns: 1fr auto auto; column-gap: 8px; row-gap: 4px; font-size: 11px; color: #0f1419;">
              <div style="font-weight: 700;">Model</div><div style="font-weight: 700; text-align: right;">In</div><div style="font-weight: 700; text-align: right;">Out</div>
              <div>gemini-2.0-flash-lite</div><div style="text-align: right;">$0.075</div><div style="text-align: right;">$0.30</div>
              <div>gemini-2.0-flash</div><div style="text-align: right;">$0.10</div><div style="text-align: right;">$0.40</div>
              <div>gemini-2.5-flash-lite</div><div style="text-align: right;">$0.10</div><div style="text-align: right;">$0.40</div>
              <div>gemini-2.5-flash</div><div style="text-align: right;">$0.30</div><div style="text-align: right;">$2.50</div>
              <div>gemini-3-flash-preview</div><div style="text-align: right;">$0.30</div><div style="text-align: right;">$2.50</div>
            </div>
          </div>

          <div style="margin-bottom: 20px;">
            <label style="display: block; font-size: 13px; margin-bottom: 6px; font-weight: 700; color: #0f1419;">API Key</label>
            <input type="password" id="rr-apikey" placeholder="AI Studio Key" style="width: 100%; border: 1px solid #cfd9de; border-radius: 8px; padding: 10px 12px; font-size: 14px; color: #0f1419; box-sizing: border-box; outline: none; transition: border 0.2s;">
          </div>
        </div>

        <button id="rr-save" style="width: 100%; margin-top: 16px; background-color: #0f1419; color: white; border: none; padding: 12px; border-radius: 9999px; cursor: pointer; font-weight: 700; font-size: 14px; transition: background 0.2s;">保存</button>
        <div id="rr-msg" style="text-align: center; font-size: 12px; margin-top: 8px; min-height: 16px; color: #00ba7c;"></div>
      </div>
    </div>

    <div id="rr-minimized-view" class="rr-visible" style="display: block; cursor: pointer;">
      <div id="rr-minimize-main" class="css-175oi2r r-105ug2t r-1867qdf r-1upvrn0 r-13awgt0 r-1ce3o0f r-1udh08x r-u8s1d r-13qz1uu r-173mn98 r-1e5uvyk r-6026j r-1xsrhxi r-rs99b7 r-12jitg0" style="width: 50px; height: 50px; border-radius: 12px; color: #0f1419; box-shadow: rgba(101, 119, 134, 0.2) 0px 0px 8px, rgba(101, 119, 134, 0.25) 0px 1px 3px 1px; border: 2px solid transparent; display: flex; align-items: center; justify-content: center;">
        ${rIconSvg}
      </div>
    </div>
  `;

  document.body.appendChild(section);
  setupPanelLogic(section);
}

function setupPanelLogic(panel) {
  const expandedView = panel.querySelector('#rr-expanded-view');
  const minimizedView = panel.querySelector('#rr-minimized-view');
  const header = panel.querySelector('#rr-header');
  const minimizeBtn = panel.querySelector('#rr-minimize-btn');
  const toggle = panel.querySelector('#rr-toggle');
  const knob = panel.querySelector('#rr-slider-knob');
  const tabButtons = Array.from(panel.querySelectorAll('.rr-tab-btn'));
  const tabPanes = {
    gen: panel.querySelector('#rr-tab-gen'),
    pattern: panel.querySelector('#rr-tab-pattern'),
    settings: panel.querySelector('#rr-tab-settings')
  };
  const patternSelect = panel.querySelector('#rr-pattern-select');
  const patternNameInput = panel.querySelector('#rr-pattern-name');
  const patternPromptInput = panel.querySelector('#rr-pattern-prompt');
  const patternAddBtn = panel.querySelector('#rr-pattern-add');
  const modelSelect = panel.querySelector('#rr-model');
  const apiKeyInput = panel.querySelector('#rr-apikey');
  const saveBtn = panel.querySelector('#rr-save');
  const msgEl = panel.querySelector('#rr-msg');
  const costEl = panel.querySelector('#rr-cost');
  const inputCharsEl = panel.querySelector('#rr-input-chars');
  const outputCharsEl = panel.querySelector('#rr-output-chars');
  const minimizedMain = panel.querySelector('#rr-minimize-main');
  let minimizedAnchorRightPx = PANEL_MARGIN.right;
  let minimizedAnchorTopPx = PANEL_MARGIN.top;
  let promptPatterns = [];
  let selectedPatternId = '';

  const setPanelFixedPosition = (topPx, rightPx) => {
    panel.style.setProperty('top', topPx, 'important');
    panel.style.setProperty('right', rightPx, 'important');
    panel.style.setProperty('bottom', 'auto', 'important');
    panel.style.setProperty('left', 'auto', 'important');
  };

  const applyResponsiveLayout = (isMinimized) => {
    const isMobile = window.innerWidth < 768;
    if (isMobile) {
      panel.style.width = 'calc(100% - 24px)';
      panel.style.left = '12px';
      panel.style.right = '12px';
      panel.style.bottom = '16px';
      panel.style.top = 'auto';
    } else {
      panel.style.left = 'auto';
      panel.style.bottom = 'auto';
      setPanelFixedPosition(`${PANEL_MARGIN.top}px`, `${PANEL_MARGIN.right}px`);
      panel.style.width = isMinimized ? 'auto' : '300px';
    }
  };

  const updateMinimizedAnchorRight = () => {
    const rect = minimizedMain.getBoundingClientRect();
    minimizedAnchorRightPx = Math.max(0, Math.round(window.innerWidth - rect.right));
    minimizedAnchorTopPx = Math.max(0, Math.round(rect.top));
  };

  const setPanelState = (minimize) => {
    isPanelMinimized = minimize;
    applyResponsiveLayout(minimize);
    if (minimize) {
      panel.style.zIndex = PANEL_Z_INDEX_MINIMIZED;
      setPanelFixedPosition(`${PANEL_MARGIN.top}px`, `${PANEL_MARGIN.right}px`);
      panel.style.width = 'auto';
      expandedView.style.display = 'none';
      expandedView.classList.remove('rr-visible');
      expandedView.classList.add('rr-hidden');
      minimizedView.style.display = 'block';
      requestAnimationFrame(() => {
        minimizedView.classList.remove('rr-hidden');
        minimizedView.classList.add('rr-visible');
        updateMinimizedAnchorRight();
      });
    } else {
      panel.style.zIndex = PANEL_Z_INDEX_EXPANDED;
      setPanelFixedPosition(`${minimizedAnchorTopPx}px`, `${minimizedAnchorRightPx}px`);
      panel.style.width = '300px';
      minimizedView.style.display = 'none';
      minimizedView.classList.remove('rr-visible');
      minimizedView.classList.add('rr-hidden');
      expandedView.style.display = 'flex';
      requestAnimationFrame(() => {
        expandedView.classList.remove('rr-hidden');
        expandedView.classList.add('rr-visible');
        // Re-apply anchor to top-right after layout
        setPanelFixedPosition(`${minimizedAnchorTopPx}px`, `${minimizedAnchorRightPx}px`);
      });
    }
  };

  const updateToggleStyle = (checked) => {
    const slider = toggle.nextElementSibling;
    if (checked) {
      slider.style.backgroundColor = '#2ecc71';
      knob.style.transform = 'translateX(20px)';
      minimizedMain.style.borderColor = '#2ecc71';
      minimizedMain.style.boxShadow = 'rgba(46, 204, 113, 0.25) 0px 0px 8px, rgba(46, 204, 113, 0.18) 0px 1px 3px 1px';
    } else {
      slider.style.backgroundColor = '#cfd9de';
      knob.style.transform = 'translateX(2px)';
      minimizedMain.style.borderColor = 'transparent';
      minimizedMain.style.boxShadow = 'rgba(101, 119, 134, 0.2) 0px 0px 8px, rgba(101, 119, 134, 0.25) 0px 1px 3px 1px';
    }
  };

  const addFocusEffects = (el) => {
    el.addEventListener('focus', () => el.style.border = '1px solid #1d9bf0');
    el.addEventListener('blur', () => el.style.border = '1px solid #cfd9de');
  };
  addFocusEffects(apiKeyInput);
  addFocusEffects(modelSelect);
  addFocusEffects(patternSelect);
  addFocusEffects(patternNameInput);
  addFocusEffects(patternPromptInput);

  minimizeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setPanelState(true);
  });

  minimizedMain.addEventListener('click', (e) => {
    e.stopPropagation();
    setPanelState(false);
  });

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      tabButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      Object.entries(tabPanes).forEach(([key, pane]) => {
        if (pane) pane.classList.toggle('active', key === tab);
      });
    });
  });

  toggle.addEventListener('change', (e) => {
    const checked = e.target.checked;
    updateToggleStyle(checked);
    chrome.storage.local.set({ rertEnabled: checked });
    if (checked) {
      const dialog = getDialogRoot();
      const textarea = getComposerTextArea(dialog);
      if (dialog && textarea) {
        generateAndAppendDraft(dialog, textarea).catch((err) => console.error('[Gemini ReRT] failed:', err));
      }
    }
  });

  saveBtn.addEventListener('click', () => {
    const key = apiKeyInput.value.trim();
    const model = modelSelect.value;
    const name = patternNameInput.value.trim();
    const prompt = patternPromptInput.value.trim();
    saveBtn.textContent = '保存中...';

    if (selectedPatternId) {
      promptPatterns = promptPatterns.map((pattern) => {
        if (pattern.id !== selectedPatternId) return pattern;
        return {
          ...pattern,
          name: name || pattern.name,
          prompt: prompt || pattern.prompt
        };
      });
    }

    chrome.storage.local.set({
      geminiApiKey: key,
      geminiModel: model,
      rertPromptPatterns: promptPatterns,
      rertSelectedPatternId: selectedPatternId
    }, () => {
      cachedApiKey = key;
      saveBtn.textContent = '保存';
      msgEl.textContent = '設定を保存しました';
      setTimeout(() => { msgEl.textContent = ''; }, 2000);
      renderPatternOptions();
    });
  });

  chrome.storage.local.get([
    'rertEnabled',
    'geminiModel',
    'geminiApiKey',
    'rertPromptPatterns',
    'rertSelectedPatternId',
    'rertInlineButtons',
    'modelStats',
    MODEL_MIGRATION_KEY
  ], (res) => {
    const isEnabled = res.rertEnabled !== false;
    toggle.checked = isEnabled;
    updateToggleStyle(isEnabled);
    inlineButtonsEnabled = false;

    let currentModel = res.geminiModel || DEFAULT_MODEL;
    if (!res[MODEL_MIGRATION_KEY]) {
      currentModel = DEFAULT_MODEL;
      chrome.storage.local.set({
        geminiModel: DEFAULT_MODEL,
        [MODEL_MIGRATION_KEY]: true
      });
    }
    modelSelect.value = currentModel;
    apiKeyInput.value = res.geminiApiKey || '';
    cachedApiKey = (res.geminiApiKey || '').trim();
    promptPatterns = Array.isArray(res.rertPromptPatterns) ? res.rertPromptPatterns : [];
    if (!promptPatterns.length) {
      const defaultPattern = {
        id: 'default',
        name: 'デフォルト',
        prompt: DEFAULT_PROMPT_TEMPLATE
      };
      promptPatterns = [defaultPattern];
      selectedPatternId = defaultPattern.id;
      chrome.storage.local.set({
        rertPromptPatterns: promptPatterns,
        rertSelectedPatternId: selectedPatternId
      });
    } else {
      selectedPatternId = res.rertSelectedPatternId || promptPatterns[0].id;
    }

    renderPatternOptions();
    applySelectedPattern();
    updateStatsUI(res.modelStats || {}, currentModel);

    setPanelState(true);
  });

  modelSelect.addEventListener('change', (e) => {
    const newModel = e.target.value;
    chrome.storage.local.get(['modelStats'], (r) => {
      updateStatsUI(r.modelStats || {}, newModel);
    });
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.modelStats) {
      chrome.storage.local.get(['modelStats', 'geminiModel'], (r) => {
        updateStatsUI(r.modelStats || {}, r.geminiModel || DEFAULT_MODEL);
      });
    }
    if (changes.geminiApiKey) {
      cachedApiKey = (changes.geminiApiKey.newValue || '').trim();
    }
  });

  patternSelect.addEventListener('change', (e) => {
    selectedPatternId = e.target.value;
    chrome.storage.local.set({ rertSelectedPatternId: selectedPatternId });
    applySelectedPattern();
  });

  patternAddBtn.addEventListener('click', () => {
    if (promptPatterns.length >= MAX_PROMPT_PATTERNS) {
      msgEl.textContent = 'パターンは最大5件です';
      setTimeout(() => { msgEl.textContent = ''; }, 2000);
      return;
    }
    const nextIndex = promptPatterns.length + 1;
    const newPattern = {
      id: `pattern-${Date.now()}-${nextIndex}`,
      name: `新規パターン${nextIndex}`,
      prompt: DEFAULT_PROMPT_TEMPLATE
    };
    promptPatterns.push(newPattern);
    selectedPatternId = newPattern.id;
    chrome.storage.local.set({
      rertPromptPatterns: promptPatterns,
      rertSelectedPatternId: selectedPatternId
    }, () => {
      renderPatternOptions();
      applySelectedPattern();
    });
  });

  function updateStatsUI(modelStats, modelId) {
    const stats = modelStats[modelId] || { input: 0, output: 0 };
    const inChars = stats.input;
    const outChars = stats.output;

    inputCharsEl.textContent = inChars.toLocaleString();
    outputCharsEl.textContent = outChars.toLocaleString();

    const prices = PRICING[modelId] || PRICING['default'];
    const inCost = (inChars / CHARS_PER_TOKEN / 1000000) * prices.input;
    const outCost = (outChars / CHARS_PER_TOKEN / 1000000) * prices.output;

    costEl.textContent = '$' + (inCost + outCost).toFixed(5);
  }

  function renderPatternOptions() {
    patternSelect.innerHTML = '';
    promptPatterns.forEach((pattern) => {
      const option = document.createElement('option');
      option.value = pattern.id;
      option.textContent = pattern.name || '無題';
      if (pattern.id === selectedPatternId) option.selected = true;
      patternSelect.appendChild(option);
    });
    patternAddBtn.disabled = promptPatterns.length >= MAX_PROMPT_PATTERNS;
    patternAddBtn.style.opacity = patternAddBtn.disabled ? '0.5' : '1';
    patternAddBtn.style.cursor = patternAddBtn.disabled ? 'not-allowed' : 'pointer';
  }

  function applySelectedPattern() {
    const selected = promptPatterns.find((pattern) => pattern.id === selectedPatternId) || promptPatterns[0];
    if (!selected) return;
    selectedPatternId = selected.id;
    patternNameInput.value = selected.name || '';
    patternPromptInput.value = selected.prompt || '';
  }

  // Drag (expanded only)
  let isDragging = false;
  let startX, startY, initialLeft, initialTop;
  const handleMouseDown = (e) => {
    if (isPanelMinimized) return;
    if (['BUTTON', 'INPUT', 'SELECT', 'LABEL'].includes(e.target.tagName)) return;
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = panel.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;
    panel.style.bottom = 'auto';
    panel.style.right = 'auto';
    panel.style.left = `${initialLeft}px`;
    panel.style.top = `${initialTop}px`;
    e.preventDefault();
  };

  header.addEventListener('mousedown', handleMouseDown);
  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    panel.style.left = `${initialLeft + dx}px`;
    panel.style.top = `${initialTop + dy}px`;
  });
  document.addEventListener('mouseup', () => { isDragging = false; });
  window.addEventListener('resize', () => applyResponsiveLayout(isPanelMinimized));
}

function getDialogRoot() {
  return document.querySelector('div[role="dialog"]');
}

function getComposerTextArea(dialog) {
  return dialog ? dialog.querySelector('[data-testid="tweetTextarea_0"]') : null;
}

function getSourceTweetText(dialog) {
  if (!dialog) return '';
  const texts = getTweetTextElements(dialog);
  return texts.map((el) => el.innerText.trim()).filter(Boolean).join('\n');
}

function detectMode(dialog) {
  if (!dialog) return 'reply';
  if (dialog.querySelector('[data-testid="replyingTo"]')) return 'reply';
  const dialogText = dialog.innerText || '';
  if (dialogText.includes('返信先')) return 'reply';
  return 'quote';
}

function addInlineControls(dialog) {
  const shouldShow = inlineButtonsEnabled;
  if (!shouldShow) {
    const exist = dialog?.querySelector && dialog.querySelector('.rr-inline-bar');
    if (exist && exist.remove) exist.remove();
    return;
  }
  if (!dialog || dialog.querySelector('.rr-inline-bar')) return;
  const textarea = getComposerTextArea(dialog);
  if (!textarea) return;
  const bar = document.createElement('div');
  bar.className = 'rr-inline-bar';
  bar.style.cssText = 'display:flex;gap:10px;margin:8px 0 6px 4px;align-items:center;flex-wrap:wrap;justify-content:flex-end;width:100%;';
  const makeBtn = (label, mode) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'padding:8px 14px;border-radius:12px;border:1.5px solid #d4dce3;background:#fff;cursor:pointer;font-size:12px;font-weight:800;line-height:1.1;box-shadow:0 1px 3px rgba(0,0,0,0.06);transition:transform 0.12s ease, box-shadow 0.12s ease;';
    b.addEventListener('mouseenter', () => {
      b.style.boxShadow = '0 2px 6px rgba(0,0,0,0.12)';
      b.style.transform = 'translateY(-1px)';
    });
    b.addEventListener('mouseleave', () => {
      b.style.boxShadow = '0 1px 3px rgba(0,0,0,0.06)';
      b.style.transform = 'translateY(0)';
    });
    b.addEventListener('click', (e) => {
      e.preventDefault();
      generateAndAppendDraft(dialog, textarea, { mode, allowOverwrite: true });
    });
    return b;
  };
  bar.appendChild(makeBtn('返信案', 'reply'));
  bar.appendChild(makeBtn('引用RT案', 'quote'));
  textarea.parentElement && textarea.parentElement.insertAdjacentElement('beforebegin', bar);
}

function insertTextAtEnd(el, text) {
  if (!el || !el.isConnected) return;
  el.focus();
  const selection = window.getSelection();
  if (selection) {
    const range = document.createRange();
    if (el.isConnected) {
      range.selectNodeContents(el);
      range.collapse(false);
      selection.removeAllRanges();
      try {
        selection.addRange(range);
      } catch (e) {
        // If the node got detached mid-flight, skip range selection.
      }
    }
  }

  // Try paste event first (closest to manual paste)
  try {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    const pasteEvent = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: data
    });
    const dispatched = el.dispatchEvent(pasteEvent);
    if (dispatched) return;
  } catch (e) {
    // Fall through to execCommand
  }

  // Fallback to insertText
  const ok = document.execCommand && document.execCommand('insertText', false, text);
  if (!ok) {
    el.textContent = (el.innerText || '') + text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }
}

async function generateAndAppendDraft(dialog, textarea, options = {}) {
  if (!dialog || !textarea) return;
  const { mode: forcedMode = null, allowOverwrite = false } = options;
  if (!allowOverwrite) {
    if (textarea.dataset.geminiRertFilled === 'true') return;
    if (dialog.dataset.geminiRertProcessed === 'true') return;
    if (dialog.dataset.geminiRertProcessing === 'true') return;
  }
  if (!dialog.isConnected || !textarea.isConnected) return;
  const apiKey = await ensureApiKey();
  if (!apiKey) {
    showToast('APIキーを設定してください', 'error');
    return;
  }
  dialog.dataset.geminiRertProcessing = 'true';
  textarea.classList.add('rr-shimmer');

  let processed = false;
  let sourceText = '';
  try {
    sourceText = getSourceTweetText(dialog);
    if (!sourceText || sourceText.length < 3) return;

    const mode = forcedMode || detectMode(dialog);
    const pendingKey = getCacheKey(sourceText, mode);
    if (!allowOverwrite) {
      if (pendingDrafts.has(pendingKey)) return;
      pendingDrafts.add(pendingKey);
    }
    const cacheKey = getCacheKey(sourceText, mode);
    const cached = draftCache.get(cacheKey);
    if (cached) {
      const current = (textarea.innerText || '').trim();
      const prefix = current ? ' ' : '';
      insertTextAtEnd(textarea, `${prefix}${cached}`);
      textarea.dataset.geminiRertFilled = 'true';
      dialog.dataset.geminiRertProcessed = 'true';
      processed = true;
      textarea.classList.remove('rr-shimmer');
      textarea.classList.add('rr-done');
      setTimeout(() => textarea.classList.remove('rr-done'), 700);
      return;
    }

    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: 'GENERATE_RERT',
        text: sourceText,
        mode
      }, (res) => resolve(res));
    });

    if (!response || !response.success) {
      showToast(response?.error || '生成に失敗しました', 'error');
      return;
    }

    if (!dialog.isConnected || !textarea.isConnected) return;
    const current = (textarea.innerText || '').trim();
    const prefix = current ? ' ' : '';
    insertTextAtEnd(textarea, `${prefix}${response.data}`);
    draftCache.set(cacheKey, response.data);
    textarea.dataset.geminiRertFilled = 'true';
    dialog.dataset.geminiRertProcessed = 'true';
    processed = true;
    textarea.classList.remove('rr-shimmer');
    textarea.classList.add('rr-done');
    setTimeout(() => textarea.classList.remove('rr-done'), 700);
  } finally {
    if (sourceText) {
      const mode = detectMode(dialog);
      pendingDrafts.delete(getCacheKey(sourceText, mode));
    }
    if (!processed) {
      dialog.dataset.geminiRertProcessing = 'false';
      textarea.classList.remove('rr-shimmer');
    } else {
      dialog.dataset.geminiRertProcessing = 'false';
    }
  }
}

const observer = new MutationObserver(() => {
  const dialog = getDialogRoot();
  if (!dialog) return;
  const textarea = getComposerTextArea(dialog);
  if (!textarea) return;
  addInlineControls(dialog);
  generateAndAppendDraft(dialog, textarea).catch((e) => console.error('[Gemini ReRT] failed:', e));
});

function startObserving() {
  createPanel();
  observer.observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startObserving);
} else {
  startObserving();
}

// Keyboard shortcuts for dialog actions
document.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
  if (tag === 'input' || tag === 'textarea' || e.metaKey || e.ctrlKey || e.altKey) return;
  const dialog = getDialogRoot();
  if (!dialog) return;
  const textarea = getComposerTextArea(dialog);
  if (!textarea) return;
  if (e.shiftKey && (e.key === 'R' || e.key === 'r')) {
    // toggle panel
    const minimized = document.getElementById('rr-minimized-view');
    const expanded = document.getElementById('rr-expanded-view');
    if (expanded && expanded.classList.contains('rr-hidden')) {
      minimized && minimized.click();
    } else if (expanded) {
      const btn = document.getElementById('rr-minimize-btn');
      btn && btn.click();
    }
    e.preventDefault();
  }
  if (e.shiftKey && (e.key === 'Q' || e.key === 'q')) {
    generateAndAppendDraft(dialog, textarea, { mode: 'quote', allowOverwrite: true });
    e.preventDefault();
  }
  if (e.shiftKey && (e.key === 'Y' || e.key === 'y')) {
    generateAndAppendDraft(dialog, textarea, { mode: 'reply', allowOverwrite: true });
    e.preventDefault();
  }
});
