// Content Script - Gemini ReRT (Auto draft for reply/quote)
console.log('[Gemini ReRT] Loaded.');

const PANEL_MARGIN = { top: 210, right: 70 };
const PANEL_Z_INDEX_EXPANDED = 2147483647;
const PANEL_Z_INDEX_MINIMIZED = 2147483000;
const CHARS_PER_TOKEN = 4;

const PRICING = {
  'gemini-2.5-flash-lite': { input: 0.10, output: 0.40 },
  'gemini-2.0-flash-lite': { input: 0.075, output: 0.30 },
  'gemini-2.0-flash': { input: 0.10, output: 0.40 },
  'gemini-2.5-flash': { input: 0.30, output: 2.50 },
  'gemini-3-flash-preview': { input: 0.30, output: 2.50 },
  'gemini-1.5-flash': { input: 0.075, output: 0.30 },
  'default': { input: 0.10, output: 0.40 }
};

let isPanelMinimized = true;

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
      #rr-expanded-view { transform-origin: top right; transition: opacity 220ms ease, transform 260ms cubic-bezier(0.2, 0.9, 0.2, 1); }
      #rr-minimized-view { transform-origin: top right; transition: opacity 180ms ease, transform 220ms cubic-bezier(0.2, 0.9, 0.2, 1); }
      .rr-hidden { opacity: 0; transform: scale(0.92); pointer-events: none; }
      .rr-visible { opacity: 1; transform: scale(1); }
    </style>

    <div id="rr-expanded-view" class="css-175oi2r r-105ug2t r-14lw9ot r-1867qdf r-1upvrn0 r-13awgt0 r-1ce3o0f r-1udh08x r-u8s1d r-13qz1uu rr-hidden" style="width: 300px; max-height: 80vh; display: none; flex-direction: column; box-shadow: rgba(101, 119, 134, 0.2) 0px 0px 15px, rgba(101, 119, 134, 0.15) 0px 0px 3px 1px; border-radius: 16px; background-color: white; position: relative;">
      <button id="rr-minimize-btn" type="button" style="position: absolute; top: 8px; right: 8px; background: rgba(0,0,0,0.05); border: none; border-radius: 50%; width: 32px; height: 32px; display: flex; justify-content: center; align-items: center; cursor: pointer; transition: background 0.2s; z-index: 1;">${closeIconSvg}</button>
      <div id="rr-header" class="css-175oi2r" style="cursor: move; padding: 12px 16px 8px 16px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #eff3f4; min-height: 50px;">
        <div style="font-weight: 800; font-size: 15px; color: #0f1419;">Gemini ReRT</div>
      </div>
      <div id="rr-body" style="padding: 16px; overflow-y: auto;">
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

        <div style="margin-bottom: 15px;">
          <label style="display: block; font-size: 13px; margin-bottom: 6px; font-weight: 700; color: #0f1419;">視点</label>
          <input type="text" id="rr-viewpoint" placeholder="例: 翻訳者 / 観察者 / 擁護者 / 研究者" style="width: 100%; border: 1px solid #cfd9de; border-radius: 8px; padding: 10px 12px; font-size: 14px; color: #0f1419; box-sizing: border-box; outline: none; transition: border 0.2s;">
        </div>

        <div style="margin-bottom: 15px;">
          <label style="display: block; font-size: 13px; margin-bottom: 6px; font-weight: 700; color: #0f1419;">伝える相手</label>
          <input type="text" id="rr-audience" placeholder="例: 初見の人 / 反対者 / 社内 / 未来の自分" style="width: 100%; border: 1px solid #cfd9de; border-radius: 8px; padding: 10px 12px; font-size: 14px; color: #0f1419; box-sizing: border-box; outline: none; transition: border 0.2s;">
        </div>

        <div style="margin-bottom: 15px;">
          <label style="display: block; font-size: 13px; margin-bottom: 6px; font-weight: 700; color: #0f1419;">長さ</label>
          <select id="rr-length" style="width: 100%; appearance: none; -webkit-appearance: none; background-color: white; border: 1px solid #cfd9de; border-radius: 8px; padding: 10px 32px 10px 12px; font-size: 14px; color: #0f1419; font-weight: 500; cursor: pointer;">
            <option value="short">短め (20-40)</option>
            <option value="standard">標準 (40-80)</option>
            <option value="long">長め (80-140)</option>
          </select>
        </div>

        <div style="margin-bottom: 15px;">
          <label style="display: block; font-size: 13px; margin-bottom: 6px; font-weight: 700; color: #0f1419;">文章のクセ</label>
          <input type="text" id="rr-writing-habit" placeholder="例: 断定を避ける / 比喩は使わない / 一文を短く" style="width: 100%; border: 1px solid #cfd9de; border-radius: 8px; padding: 10px 12px; font-size: 14px; color: #0f1419; box-sizing: border-box; outline: none; transition: border 0.2s;">
        </div>

        <div style="margin-bottom: 15px;">
          <label style="display: block; font-size: 13px; margin-bottom: 6px; font-weight: 700; color: #0f1419;">禁則ワード</label>
          <input type="text" id="rr-ban-words" placeholder="例: マジ, やばい, 最強" style="width: 100%; border: 1px solid #cfd9de; border-radius: 8px; padding: 10px 12px; font-size: 14px; color: #0f1419; box-sizing: border-box; outline: none; transition: border 0.2s;">
        </div>

        <button id="rr-settings-toggle" style="width: 100%; text-align: left; background: none; border: none; padding: 0; cursor: pointer; display: flex; align-items: center; gap: 6px; color: #2ecc71; font-weight: 600; font-size: 13px;">
          <span style="font-size: 16px;">⚙️</span> 設定 (モデル・キー)
        </button>

        <div id="rr-settings-content" style="display: none; margin-top: 15px;">
          <div style="margin-bottom: 15px;">
            <label style="display: block; font-size: 13px; margin-bottom: 6px; font-weight: 700; color: #0f1419;">モデル</label>
            <select id="rr-model" style="width: 100%; appearance: none; -webkit-appearance: none; background-color: white; border: 1px solid #cfd9de; border-radius: 8px; padding: 10px 32px 10px 12px; font-size: 14px; color: #0f1419; font-weight: 500; cursor: pointer;">
              <option value="gemini-2.5-flash-lite">Gemini 2.5 Flash-Lite</option>
              <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
              <option value="gemini-2.0-flash-lite">Gemini 2.0 Flash-Lite</option>
              <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
              <option value="gemini-3-flash-preview">Gemini 3 Flash Preview</option>
            </select>
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
  const viewpointSelect = panel.querySelector('#rr-viewpoint');
  const audienceSelect = panel.querySelector('#rr-audience');
  const lengthSelect = panel.querySelector('#rr-length');
  const writingHabitInput = panel.querySelector('#rr-writing-habit');
  const banWordsInput = panel.querySelector('#rr-ban-words');
  const modelSelect = panel.querySelector('#rr-model');
  const apiKeyInput = panel.querySelector('#rr-apikey');
  const saveBtn = panel.querySelector('#rr-save');
  const msgEl = panel.querySelector('#rr-msg');
  const costEl = panel.querySelector('#rr-cost');
  const inputCharsEl = panel.querySelector('#rr-input-chars');
  const outputCharsEl = panel.querySelector('#rr-output-chars');
  const settingsToggle = panel.querySelector('#rr-settings-toggle');
  const settingsContent = panel.querySelector('#rr-settings-content');
  const minimizedMain = panel.querySelector('#rr-minimize-main');
  let minimizedAnchorRightPx = PANEL_MARGIN.right;
  let minimizedAnchorTopPx = PANEL_MARGIN.top;

  const setPanelFixedPosition = (topPx, rightPx) => {
    panel.style.setProperty('top', topPx, 'important');
    panel.style.setProperty('right', rightPx, 'important');
    panel.style.setProperty('bottom', 'auto', 'important');
    panel.style.setProperty('left', 'auto', 'important');
  };

  const updateMinimizedAnchorRight = () => {
    const rect = minimizedMain.getBoundingClientRect();
    minimizedAnchorRightPx = Math.max(0, Math.round(window.innerWidth - rect.right));
    minimizedAnchorTopPx = Math.max(0, Math.round(rect.top));
  };

  const setPanelState = (minimize) => {
    isPanelMinimized = minimize;
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
  addFocusEffects(viewpointSelect);
  addFocusEffects(audienceSelect);
  addFocusEffects(lengthSelect);
  addFocusEffects(writingHabitInput);
  addFocusEffects(banWordsInput);

  minimizeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setPanelState(true);
  });

  minimizedMain.addEventListener('click', (e) => {
    e.stopPropagation();
    setPanelState(false);
  });

  settingsToggle.addEventListener('click', () => {
    const isHidden = settingsContent.style.display === 'none';
    settingsContent.style.display = isHidden ? 'block' : 'none';
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
    const viewpoint = viewpointSelect.value.trim();
    const audience = audienceSelect.value.trim();
    const length = lengthSelect.value;
    const writingHabit = writingHabitInput.value.trim();
    const banWords = banWordsInput.value.trim();
    saveBtn.textContent = '保存中...';

    chrome.storage.local.set({
      geminiApiKey: key,
      geminiModel: model,
      rertViewpoint: viewpoint,
      rertAudience: audience,
      rertLength: length,
      rertWritingHabit: writingHabit,
      rertBanWords: banWords
    }, () => {
      saveBtn.textContent = '保存';
      msgEl.textContent = '設定を保存しました';
      setTimeout(() => { msgEl.textContent = ''; }, 2000);
    });
  });

  chrome.storage.local.get(['rertEnabled', 'geminiModel', 'geminiApiKey', 'rertViewpoint', 'rertAudience', 'rertLength', 'rertWritingHabit', 'rertBanWords', 'modelStats'], (res) => {
    const isEnabled = res.rertEnabled !== false;
    toggle.checked = isEnabled;
    updateToggleStyle(isEnabled);

    const currentModel = res.geminiModel || 'gemini-2.0-flash';
    modelSelect.value = currentModel;
    apiKeyInput.value = res.geminiApiKey || '';
    viewpointSelect.value = res.rertViewpoint || '';
    audienceSelect.value = res.rertAudience || '';
    lengthSelect.value = res.rertLength || 'standard';
    writingHabitInput.value = res.rertWritingHabit || '';
    banWordsInput.value = res.rertBanWords || '';
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
        updateStatsUI(r.modelStats || {}, r.geminiModel || 'gemini-2.0-flash');
      });
    }
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
}

function getDialogRoot() {
  return document.querySelector('div[role="dialog"]');
}

function getComposerTextArea(dialog) {
  return dialog ? dialog.querySelector('[data-testid="tweetTextarea_0"]') : null;
}

function getSourceTweetText(dialog) {
  if (!dialog) return '';
  const texts = Array.from(dialog.querySelectorAll('[data-testid="tweetText"]'));
  return texts.map((el) => el.innerText.trim()).filter(Boolean).join('\n');
}

function detectMode(dialog) {
  if (!dialog) return 'reply';
  if (dialog.querySelector('[data-testid="replyingTo"]')) return 'reply';
  const dialogText = dialog.innerText || '';
  if (dialogText.includes('返信先')) return 'reply';
  return 'quote';
}

function insertTextAtEnd(el, text) {
  el.focus();
  const selection = window.getSelection();
  if (selection) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
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

async function generateAndAppendDraft(dialog, textarea) {
  if (!dialog || !textarea) return;
  if (textarea.dataset.geminiRertFilled === 'true') return;
  if (dialog.dataset.geminiRertProcessed === 'true') return;
  if (dialog.dataset.geminiRertProcessing === 'true') return;
  dialog.dataset.geminiRertProcessing = 'true';

  let processed = false;
  try {
    const sourceText = getSourceTweetText(dialog);
    if (!sourceText || sourceText.length < 3) return;

    const mode = detectMode(dialog);

    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: 'GENERATE_RERT',
        text: sourceText,
        mode
      }, (res) => resolve(res));
    });

    if (!response || !response.success) return;

    const current = (textarea.innerText || '').trim();
    const prefix = current ? ' ' : '';
    insertTextAtEnd(textarea, `${prefix}${response.data}`);
    textarea.dataset.geminiRertFilled = 'true';
    dialog.dataset.geminiRertProcessed = 'true';
    processed = true;
  } finally {
    if (!processed) {
      dialog.dataset.geminiRertProcessing = 'false';
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
