// Content Script - Gemini Oneword (Japanese -> Japanese one-line gist)
console.log('[Gemini Oneword] Loaded.');

const MIN_DELAY_MS = 300;
const MAX_DELAY_MS = 1500;
const MAX_BATCH_SIZE = 12;
const MAX_BATCH_CHARS = 4000;
const JAPANESE_REGEX = /[ぁ-んァ-ン一-龠]/;
const CHARS_PER_TOKEN = 4;

const PRICING = {
  'gemini-2.5-flash-lite': { input: 0.10, output: 0.40 },
  'gemini-2.0-flash-lite': { input: 0.075, output: 0.30 },
  'gemini-2.0-flash': { input: 0.10, output: 0.40 },
  'gemini-2.5-flash': { input: 0.30, output: 2.50 },
  'gemini-1.5-flash': { input: 0.075, output: 0.30 },
  'default': { input: 0.10, output: 0.40 }
};

const PANEL_MARGIN = {
  top: 90,
  right: 20
};
const PANEL_Z_INDEX_EXPANDED = 2147483647;
const PANEL_Z_INDEX_MINIMIZED = 2147483000;

let summaryQueue = [];
let isProcessingQueue = false;
let scheduledTimerId = null;
let isPanelMinimized = true;

function createPanel() {
  const section = document.createElement('div');
  section.id = 'gemini-oneword-panel';
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

  const jIconSvg = `<span aria-hidden="true" style="display: inline-flex; align-items: center; justify-content: center; width: 100%; height: 100%; font-size: 24px; font-weight: 700; line-height: 1; font-family: system-ui, -apple-system, 'Segoe UI', Arial, sans-serif; color: currentColor;">1</span>`;
  const closeIconSvg = `<svg viewBox="0 0 24 24" aria-hidden="true" style="color: #536471; width: 20px; height: 20px;"><g><path d="M12 15.41l-7.29-7.29 1.41-1.42L12 12.59l5.88-5.89 1.41 1.42L12 15.41z" fill="currentColor"></path></g></svg>`;

  section.innerHTML = `
    <style>
      #go-expanded-view {
        transform-origin: top right;
        transition: opacity 220ms ease, transform 260ms cubic-bezier(0.2, 0.9, 0.2, 1);
      }
      #go-minimized-view {
        transform-origin: top right;
        transition: opacity 180ms ease, transform 220ms cubic-bezier(0.2, 0.9, 0.2, 1);
      }
      .go-hidden { opacity: 0; transform: scale(0.92); pointer-events: none; }
      .go-visible { opacity: 1; transform: scale(1); }
    </style>

    <!-- EXPANDED VIEW -->
    <div id="go-expanded-view" class="css-175oi2r r-105ug2t r-14lw9ot r-1867qdf r-1upvrn0 r-13awgt0 r-1ce3o0f r-1udh08x r-u8s1d r-13qz1uu go-hidden" style="width: 300px; max-height: 80vh; display: none; flex-direction: column; box-shadow: rgba(101, 119, 134, 0.2) 0px 0px 15px, rgba(101, 119, 134, 0.15) 0px 0px 3px 1px; border-radius: 16px; background-color: white; position: relative;">
      <button id="go-minimize-btn" type="button" style="position: absolute; top: 8px; right: 8px; background: rgba(0,0,0,0.05); border: none; border-radius: 50%; width: 32px; height: 32px; display: flex; justify-content: center; align-items: center; cursor: pointer; transition: background 0.2s; z-index: 1;">${closeIconSvg}</button>
      <div id="go-header" class="css-175oi2r" style="cursor: move; padding: 12px 16px 8px 16px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #eff3f4; min-height: 50px;">
        <div style="font-weight: 800; font-size: 15px; color: #0f1419;">Gemini Oneword</div>
      </div>
      <div id="go-body" style="padding: 16px; overflow-y: auto;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
          <span style="font-size: 14px; font-weight: 700; color: #0f1419;">ひとこと要約</span>
          <label style="position: relative; display: inline-block; width: 44px; height: 24px;">
            <input type="checkbox" id="go-toggle" checked style="opacity: 0; width: 0; height: 0;">
            <span style="position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #2ecc71; transition: .4s; border-radius: 24px;"></span>
            <span id="go-slider-knob" style="position: absolute; content: ''; height: 20px; width: 20px; left: 2px; bottom: 2px; background-color: white; transition: .4s; border-radius: 50%; transform: translateX(20px);"></span>
          </label>
        </div>

        <div style="background-color: #f7f9f9; padding: 12px 16px; border-radius: 12px; margin-bottom: 20px; border: 1px solid #eff3f4;">
          <div style="font-size: 11px; color: #536471; font-weight: 500;">推定コスト (モデル別目安)</div>
          <div id="go-cost" style="font-size: 22px; font-weight: 800; color: #0f1419; margin: 4px 0 8px 0;">$0.0000</div>
          <div style="font-size: 11px; color: #536471; display: flex; justify-content: space-between;">
            <span>In: <b id="go-input-chars" style="color: #0f1419;">0</b></span>
            <span>Out: <b id="go-output-chars" style="color: #0f1419;">0</b></span>
          </div>
        </div>

        <div style="margin-bottom: 15px;">
          <label style="display: block; font-size: 13px; margin-bottom: 6px; font-weight: 700; color: #0f1419;">要約長さ</label>
          <select id="go-length" style="width: 100%; appearance: none; -webkit-appearance: none; background-color: white; border: 1px solid #cfd9de; border-radius: 8px; padding: 10px 32px 10px 12px; font-size: 14px; color: #0f1419; font-weight: 500; cursor: pointer;">
            <option value="short">短め (10-15文字)</option>
            <option value="standard">標準 (15-25文字)</option>
            <option value="long">長め (25-40文字)</option>
          </select>
        </div>

        <button id="go-settings-toggle" style="width: 100%; text-align: left; background: none; border: none; padding: 0; cursor: pointer; display: flex; align-items: center; gap: 6px; color: #2ecc71; font-weight: 600; font-size: 13px;">
          <span style="font-size: 16px;">⚙️</span> 設定 (モデル・キー)
        </button>

        <div id="go-settings-content" style="display: none; margin-top: 15px;">
          <div style="margin-bottom: 15px;">
            <label style="display: block; font-size: 13px; margin-bottom: 6px; font-weight: 700; color: #0f1419;">モデル</label>
            <div style="position: relative;">
              <select id="go-model" style="width: 100%; appearance: none; -webkit-appearance: none; background-color: white; border: 1px solid #cfd9de; border-radius: 8px; padding: 10px 32px 10px 12px; font-size: 14px; color: #0f1419; font-weight: 500; cursor: pointer;">
                <option value="gemini-2.5-flash-lite">Gemini 2.5 Flash-Lite</option>
                <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
                <option value="gemini-2.0-flash-lite">Gemini 2.0 Flash-Lite</option>
                <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
              </select>
              <div style="position: absolute; right: 12px; top: 50%; transform: translateY(-50%); pointer-events: none; color: #536471;">
                <svg viewBox="0 0 24 24" aria-hidden="true" style="width: 16px; height: 16px; fill: currentColor;"><path d="M3.543 8.96l1.414-1.42L12 14.59l7.043-7.05 1.414 1.42L12 17.41 3.543 8.96z"></path></svg>
              </div>
            </div>
          </div>

          <div style="margin-bottom: 20px;">
            <label style="display: block; font-size: 13px; margin-bottom: 6px; font-weight: 700; color: #0f1419;">API Key</label>
            <input type="password" id="go-apikey" placeholder="AI Studio Key" style="width: 100%; border: 1px solid #cfd9de; border-radius: 8px; padding: 10px 12px; font-size: 14px; color: #0f1419; box-sizing: border-box; outline: none; transition: border 0.2s;">
          </div>
        </div>

        <button id="go-save" style="width: 100%; margin-top: 16px; background-color: #0f1419; color: white; border: none; padding: 12px; border-radius: 9999px; cursor: pointer; font-weight: 700; font-size: 14px; transition: background 0.2s;">保存</button>
        <div id="go-msg" style="text-align: center; font-size: 12px; margin-top: 8px; min-height: 16px; color: #00ba7c;"></div>
      </div>
    </div>

    <!-- MINIMIZED VIEW -->
    <div id="go-minimized-view" class="go-visible" style="display: block; cursor: pointer;">
      <div style="display: flex; flex-direction: column; gap: 8px; align-items: center;">
        <div id="go-minimize-main" class="css-175oi2r r-105ug2t r-1867qdf r-1upvrn0 r-13awgt0 r-1ce3o0f r-1udh08x r-u8s1d r-13qz1uu r-173mn98 r-1e5uvyk r-6026j r-1xsrhxi r-rs99b7 r-12jitg0" style="width: 50px; height: 50px; border-radius: 12px; color: #0f1419; box-shadow: rgba(101, 119, 134, 0.2) 0px 0px 8px, rgba(101, 119, 134, 0.25) 0px 1px 3px 1px; border: 2px solid transparent;">
          <button id="go-open-panel" role="button" type="button" style="align-items: center; justify-content: center; width: 100%; height: 100%; background: transparent; border: none; padding: 0; cursor: pointer;">${jIconSvg}</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(section);
  setupPanelLogic(section);
}

function setupPanelLogic(panel) {
  const expandedView = panel.querySelector('#go-expanded-view');
  const minimizedView = panel.querySelector('#go-minimized-view');
  const header = panel.querySelector('#go-header');
  const minimizeBtn = panel.querySelector('#go-minimize-btn');
  const toggle = panel.querySelector('#go-toggle');
  const knob = panel.querySelector('#go-slider-knob');
  const modelSelect = panel.querySelector('#go-model');
  const apiKeyInput = panel.querySelector('#go-apikey');
  const lengthSelect = panel.querySelector('#go-length');
  const saveBtn = panel.querySelector('#go-save');
  const msgEl = panel.querySelector('#go-msg');
  const costEl = panel.querySelector('#go-cost');
  const inputCharsEl = panel.querySelector('#go-input-chars');
  const outputCharsEl = panel.querySelector('#go-output-chars');
  const settingsToggle = panel.querySelector('#go-settings-toggle');
  const settingsContent = panel.querySelector('#go-settings-content');
  const minimizedMain = panel.querySelector('#go-open-panel');
  const minimizedMainWrap = panel.querySelector('#go-minimize-main');

  const setPanelFixedPosition = (topPx, rightPx) => {
    panel.style.setProperty('top', topPx, 'important');
    panel.style.setProperty('right', rightPx, 'important');
    panel.style.setProperty('bottom', 'auto', 'important');
    panel.style.setProperty('left', 'auto', 'important');
  };

  const setPanelState = (minimize) => {
    isPanelMinimized = minimize;
    if (minimize) {
      panel.style.zIndex = PANEL_Z_INDEX_MINIMIZED;
      setPanelFixedPosition(`${PANEL_MARGIN.top}px`, `${PANEL_MARGIN.right}px`);
      panel.style.width = 'auto';
      expandedView.style.display = 'none';
      expandedView.classList.remove('go-visible');
      expandedView.classList.add('go-hidden');
      minimizedView.style.display = 'block';
      requestAnimationFrame(() => {
        minimizedView.classList.remove('go-hidden');
        minimizedView.classList.add('go-visible');
      });
    } else {
      panel.style.zIndex = PANEL_Z_INDEX_EXPANDED;
      setPanelFixedPosition(`${PANEL_MARGIN.top}px`, `${PANEL_MARGIN.right}px`);
      panel.style.width = '300px';
      minimizedView.style.display = 'none';
      minimizedView.classList.remove('go-visible');
      minimizedView.classList.add('go-hidden');
      expandedView.style.display = 'flex';
      requestAnimationFrame(() => {
        expandedView.classList.remove('go-hidden');
        expandedView.classList.add('go-visible');
      });
    }
  };

  const updateToggleStyle = (checked) => {
    const slider = toggle.nextElementSibling;
    if (checked) {
      slider.style.backgroundColor = '#2ecc71';
      knob.style.transform = 'translateX(20px)';
      minimizedMainWrap.style.borderColor = '#2ecc71';
      minimizedMainWrap.style.boxShadow = 'rgba(46, 204, 113, 0.25) 0px 0px 8px, rgba(46, 204, 113, 0.18) 0px 1px 3px 1px';
    } else {
      slider.style.backgroundColor = '#cfd9de';
      knob.style.transform = 'translateX(2px)';
      minimizedMainWrap.style.borderColor = 'transparent';
      minimizedMainWrap.style.boxShadow = 'rgba(101, 119, 134, 0.2) 0px 0px 8px, rgba(101, 119, 134, 0.25) 0px 1px 3px 1px';
    }
  };

  const addFocusEffects = (el) => {
    el.addEventListener('focus', () => el.style.border = '1px solid #1d9bf0');
    el.addEventListener('blur', () => el.style.border = '1px solid #cfd9de');
  };
  addFocusEffects(apiKeyInput);
  addFocusEffects(modelSelect);
  addFocusEffects(lengthSelect);

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
    chrome.storage.local.set({ isOnewordEnabled: checked });
    if (checked) {
      scanExistingTweets();
      processQueue();
    }
  });

  saveBtn.addEventListener('click', () => {
    const key = apiKeyInput.value.trim();
    const model = modelSelect.value;
    const length = lengthSelect.value;
    saveBtn.textContent = '保存中...';

    chrome.storage.local.set({
      geminiApiKey: key,
      geminiModel: model,
      onewordLength: length
    }, () => {
      saveBtn.textContent = '保存';
      msgEl.textContent = '設定を保存しました';
      setTimeout(() => { msgEl.textContent = ''; }, 2000);
    });
  });

  chrome.storage.local.get(['isOnewordEnabled', 'geminiModel', 'geminiApiKey', 'onewordLength', 'modelStats'], (res) => {
    const isEnabled = res.isOnewordEnabled !== false;
    toggle.checked = isEnabled;
    updateToggleStyle(isEnabled);

    const currentModel = res.geminiModel || 'gemini-2.0-flash';
    modelSelect.value = currentModel;
    apiKeyInput.value = res.geminiApiKey || '';
    lengthSelect.value = res.onewordLength || 'standard';
    updateStatsUI(res.modelStats || {}, currentModel);

    setPanelState(true);
  });

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
  document.addEventListener('mouseup', () => { isDragging = false; });
}

function requestSummary(texts) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: 'SUMMARIZE_TEXT_BG',
      text: texts.join('\n---SEPARATOR---\n')
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[Gemini Oneword] Runtime error:', chrome.runtime.lastError.message);
        resolve(null);
        return;
      }
      if (response && response.success) {
        resolve(response.data);
      } else {
        console.error('[Gemini Oneword] API Error:', response?.error);
        resolve(null);
      }
    });
  });
}

function scheduleProcessing() {
  if (scheduledTimerId) return;
  if (isProcessingQueue || summaryQueue.length === 0) return;

  const queueSize = summaryQueue.length;
  const delay = Math.max(
    MIN_DELAY_MS,
    Math.min(MAX_DELAY_MS, MIN_DELAY_MS + queueSize * 40)
  );

  scheduledTimerId = setTimeout(() => {
    scheduledTimerId = null;
    processQueue();
  }, delay);
}

async function processQueue() {
  if (isProcessingQueue || summaryQueue.length === 0) return;
  isProcessingQueue = true;

  const batch = [];
  let totalChars = 0;
  while (summaryQueue.length > 0 && batch.length < MAX_BATCH_SIZE) {
    const item = summaryQueue[0];
    const projected = totalChars + item.text.length;
    if (batch.length > 0 && projected > MAX_BATCH_CHARS) break;
    totalChars = projected;
    batch.push(summaryQueue.shift());
  }

  const elements = batch.map(item => item.element);
  const texts = batch.map(item => item.text);

  try {
    const result = await requestSummary(texts);
    if (result) {
      const summaries = result.split(/\n?---SEPARATOR---\n?/);
      elements.forEach((el, index) => {
        const summaryText = summaries[index];
        if (summaryText) {
          applySummary(el, summaryText.trim());
        }
      });
    } else {
      batch.forEach((item) => {
        item.retry = (item.retry || 0) + 1;
        if (item.retry <= 2) {
          summaryQueue.unshift(item);
        } else {
          item.element.dataset.geminiOneword = 'failed';
        }
      });
    }
  } catch (e) {
    console.error('[Gemini Oneword] Batch process failed:', e);
    batch.forEach((item) => {
      item.retry = (item.retry || 0) + 1;
      if (item.retry <= 2) {
        summaryQueue.unshift(item);
      } else {
        item.element.dataset.geminiOneword = 'failed';
      }
    });
  } finally {
    isProcessingQueue = false;
    scheduleProcessing();
  }
}

function applySummary(element, summaryText) {
  const originalText = element.innerText;
  element.dataset.geminiOneword = 'true';
  element.dataset.geminiOnewordOriginal = originalText;
  element.dataset.geminiOnewordSummary = summaryText;
  element.dataset.geminiOnewordMode = 'summary';

  renderSummary(element);
}

function renderSummary(element) {
  const summary = element.dataset.geminiOnewordSummary || '';
  element.innerHTML = '';

  const summarySpan = document.createElement('span');
  summarySpan.textContent = summary;
  summarySpan.style.color = '#0f1419';

  const toggle = document.createElement('span');
  toggle.textContent = ' さらに表示';
  toggle.setAttribute('role', 'button');
  toggle.style.cursor = 'pointer';
  toggle.style.color = '#1d9bf0';
  toggle.style.fontSize = '12px';
  toggle.style.marginLeft = '6px';

  element.appendChild(summarySpan);
  element.appendChild(toggle);
}

function renderOriginal(element) {
  const original = element.dataset.geminiOnewordOriginal || '';
  element.innerHTML = '';

  const originalSpan = document.createElement('span');
  originalSpan.textContent = original;

  const toggle = document.createElement('span');
  toggle.textContent = ' 元に戻す';
  toggle.setAttribute('role', 'button');
  toggle.style.cursor = 'pointer';
  toggle.style.color = '#1d9bf0';
  toggle.style.fontSize = '12px';
  toggle.style.marginLeft = '6px';

  element.appendChild(originalSpan);
  element.appendChild(toggle);
}

function toggleMode(element) {
  const mode = element.dataset.geminiOnewordMode;
  if (mode === 'summary') {
    element.dataset.geminiOnewordMode = 'original';
    renderOriginal(element);
  } else {
    element.dataset.geminiOnewordMode = 'summary';
    renderSummary(element);
  }
}

function checkAndQueue(element) {
  if (element.dataset.geminiOneword === 'true' || element.dataset.geminiOneword === 'failed') return;
  const text = element.innerText;
  if (!text || text.trim().length < 5) return;
  if (!JAPANESE_REGEX.test(text)) return;

  summaryQueue.push({ element, text });
  scheduleProcessing();
}

function scanExistingTweets() {
  document.querySelectorAll('[data-testid="tweetText"]').forEach(checkAndQueue);
}

const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    if (mutation.type === 'childList') {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const tweets = node.querySelectorAll ? node.querySelectorAll('[data-testid="tweetText"]') : [];
          tweets.forEach(checkAndQueue);
          if (node.getAttribute && node.getAttribute('data-testid') === 'tweetText') {
            checkAndQueue(node);
          }
        }
      });
    }
  }
});

function startObserving() {
  createPanel();
  const target = document.body;
  if (!target) return;

  document.body.addEventListener('click', (e) => {
    const tweetEl = e.target.closest && e.target.closest('[data-testid="tweetText"]');
    if (!tweetEl) return;
    if (tweetEl.dataset.geminiOneword !== 'true') return;

    if (e.target && e.target.getAttribute('role') === 'button') {
      e.preventDefault();
      e.stopPropagation();
      toggleMode(tweetEl);
    }
  });

  observer.observe(target, { childList: true, subtree: true });
  document.querySelectorAll('[data-testid="tweetText"]').forEach(checkAndQueue);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startObserving);
} else {
  startObserving();
}
