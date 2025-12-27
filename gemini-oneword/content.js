// Content Script - Gemini Oneword (Japanese -> Japanese one-line gist)
console.log('[Gemini Oneword] Loaded.');

const MIN_DELAY_MS = 300;
const MAX_DELAY_MS = 1500;
const MAX_BATCH_SIZE = 12;
const MAX_BATCH_CHARS = 4000;
const MAX_PARALLEL_REQUESTS = 2;
const JAPANESE_REGEX = /[ぁ-んァ-ン一-龠]/;
const CHARS_PER_TOKEN = 4;
const SHIMMER_STYLE = `
  @keyframes go-shimmer {
    0% { background-position: -200px 0; }
    100% { background-position: 200px 0; }
  }
  .go-shimmer {
    position: relative;
    color: transparent !important;
    background: linear-gradient(90deg, #f1f3f4 0%, #e6ecf0 50%, #f1f3f4 100%);
    background-size: 200px 100%;
    animation: go-shimmer 1.1s linear infinite;
    border-radius: 6px;
  }
  @keyframes go-flash {
    0% { background-color: #e8f5fd; }
    100% { background-color: transparent; }
  }
  .go-done { animation: go-flash 0.8s ease; }
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

const PANEL_MARGIN = {
  expandedTop: 110,
  expandedRight: 12,
  minimizedBottom: 130,
  minimizedRight: 12
};
const PANEL_Z_INDEX_EXPANDED = 2147483647;
const PANEL_Z_INDEX_MINIMIZED = 2147483000;

// Shared Dock Logic
function ensureDock() {
  let dock = document.getElementById('gemini-dock');
  if (!dock) {
    dock = document.createElement('div');
    dock.id = 'gemini-dock';
    dock.style.cssText = 'position:fixed; right:16px; top:80px; z-index:2147483600; display:flex; flex-direction:column; gap:12px; align-items:flex-end; pointer-events:none;';
    document.body.appendChild(dock);
  }
  return dock;
}

function attachToDock(panel, order = 2) {
  const dock = ensureDock();
  panel.dataset.gemDockOrder = order;
  dock.appendChild(panel);
  Array.from(dock.children)
    .sort((a, b) => (parseInt(a.dataset.gemDockOrder || '0', 10) - parseInt(b.dataset.gemDockOrder || '0', 10)))
    .forEach((el) => dock.appendChild(el));

  // Reset styles first to ensure clean slate
  panel.style.cssText = '';

  // Apply strict styles from standard template
  panel.style.setProperty('position', 'static', 'important');
  panel.style.setProperty('width', '56px', 'important');
  panel.style.setProperty('height', '56px', 'important');
  panel.style.setProperty('min-width', '56px', 'important');
  panel.style.setProperty('margin', '0', 'important');
  panel.style.setProperty('padding', '0', 'important');
  panel.style.setProperty('box-sizing', 'border-box', 'important');
  panel.style.setProperty('display', 'block', 'important');
  panel.style.setProperty('align-self', 'flex-end', 'important');
  panel.style.setProperty('pointer-events', 'auto', 'important');
  panel.style.setProperty('z-index', 'auto', 'important');
  panel.style.setProperty('float', 'none', 'important');
  panel.style.setProperty('clear', 'none', 'important');
  panel.style.setProperty('inset', 'auto', 'important');

  dock.style.pointerEvents = 'none';
}

let summaryQueue = [];
let inFlightRequests = 0;
let scheduledTimerId = null;
let isPanelMinimized = true;
let cachedApiKey = '';
const summaryCache = new Map();
const originalTextCache = new Map();
const summaryByTweetId = new Map();
const expandedResummarized = new Set();
let threadSummaryResult = '';

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

function injectShimmerStyleOnce() {
  if (document.getElementById('go-shimmer-style')) return;
  const style = document.createElement('style');
  style.id = 'go-shimmer-style';
  style.textContent = SHIMMER_STYLE;
  document.head.appendChild(style);
}

function createPill(label) {
  const pill = document.createElement('span');
  pill.textContent = label;
  pill.className = 'go-pill';
  pill.style.cssText = 'display:inline-flex;align-items:center;padding:2px 6px;margin-left:6px;font-size:11px;font-weight:700;border-radius:10px;border:1px solid #cfd9de;color:#1d9bf0;cursor:pointer;user-select:none;';
  pill.addEventListener('mouseenter', () => pill.style.borderColor = '#1d9bf0');
  pill.addEventListener('mouseleave', () => pill.style.borderColor = '#cfd9de');
  return pill;
}

function ensureBlocks(element) {
  if (!element.dataset.geminiOnewordHtml) {
    element.dataset.geminiOnewordHtml = element.innerHTML;
  }
  const hasOriginal = element.querySelector('.go-original-block');
  const hasSummary = element.querySelector('.go-summary-block');
  if (!hasOriginal || !hasSummary) {
    const html = element.dataset.geminiOnewordHtml;
    element.innerHTML = '';
    const ob = document.createElement('div');
    ob.className = 'go-original-block';
    ob.innerHTML = html;
    const sb = document.createElement('div');
    sb.className = 'go-summary-block';
    sb.style.whiteSpace = 'pre-wrap';
    element.appendChild(ob);
    element.appendChild(sb);
  }
}

function setDisplayMode(element, mode) {
  const ob = element.querySelector('.go-original-block');
  const sb = element.querySelector('.go-summary-block');
  if (!ob || !sb) return;
  if (mode === 'summary') {
    ob.style.display = 'none';
    sb.style.display = 'block';
  } else {
    ob.style.display = 'block';
    sb.style.display = 'none';
  }
  element.dataset.geminiOnewordMode = mode;
}

function setShimmer(element, on) {
  if (on) {
    element.classList.add('go-shimmer');
  } else {
    element.classList.remove('go-shimmer');
  }
}

function flashDone(element) {
  const sb = element.querySelector('.go-summary-block');
  if (!sb) return;
  sb.classList.add('go-done');
  setTimeout(() => sb.classList.remove('go-done'), 700);
}

function getCacheKey(text) {
  return text.trim();
}

function getTweetId(element) {
  const article = element.closest && element.closest('article');
  if (!article) return '';
  const link = article.querySelector('a[href*="/status/"]');
  if (!link) return '';
  const href = link.getAttribute('href') || '';
  const match = href.match(/\/status\/(\d+)/);
  return match ? match[1] : '';
}

function queueResummary(element, text) {
  const tweetId = getTweetId(element);
  if (tweetId && expandedResummarized.has(tweetId)) return;
  if (tweetId) expandedResummarized.add(tweetId);
  element.dataset.geminiOneword = 'pending';
  summaryQueue.push({ element, text });
  scheduleProcessing();
}

function createPanel() {
  // Cleanup duplicates first
  const existing = document.querySelectorAll('[id^="gemini-oneword-panel"]');
  existing.forEach(p => p.remove());

  const section = document.createElement('div');
  section.id = 'gemini-oneword-panel';
  section.style.cssText = `
    position: fixed;
    z-index: ${PANEL_Z_INDEX_MINIMIZED};
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  `;
  section.style.top = `${PANEL_MARGIN.expandedTop}px`;
  section.style.right = `${PANEL_MARGIN.expandedRight}px`;
  section.style.bottom = 'auto';
  section.style.left = 'auto';
  section.style.width = 'auto';

  const jIconSvg = `<span aria-hidden="true" style="display: inline-flex; align-items: center; justify-content: center; width: 100%; height: 100%; font-size: 24px; font-weight: 700; line-height: 1; font-family: system-ui, -apple-system, 'Segoe UI', Arial, sans-serif; color: currentColor;">1</span>`;
  const closeIconSvg = `<svg viewBox="0 0 24 24" aria-hidden="true" style="color: #536471; width: 20px; height: 20px;"><g><path d="M12 15.41l-7.29-7.29 1.41-1.42L12 12.59l5.88-5.89 1.41 1.42L12 15.41z" fill="currentColor"></path></g></svg>`;

  section.innerHTML = `
    <style>
      ${SHIMMER_STYLE}
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
        <div style="font-weight: 800; font-size: 15px; color: #0f1419;">Gemini 1word</div>
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
                <option value="gemini-2.0-flash-lite">Gemini 2.0 Flash-Lite</option>
                <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
                <option value="gemini-2.5-flash-lite">Gemini 2.5 Flash-Lite</option>
                <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                <option value="gemini-3-flash-preview">Gemini 3 Flash Preview</option>
              </select>
              <div style="position: absolute; right: 12px; top: 50%; transform: translateY(-50%); pointer-events: none; color: #536471;">
                <svg viewBox="0 0 24 24" aria-hidden="true" style="width: 16px; height: 16px; fill: currentColor;"><path d="M3.543 8.96l1.414-1.42L12 14.59l7.043-7.05 1.414 1.42L12 17.41 3.543 8.96z"></path></svg>
              </div>
            </div>
          </div>
          <div style="margin: 0 0 15px 0; padding: 10px 12px; border: 1px solid #eff3f4; border-radius: 8px; background-color: #f7f9f9;">
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
            <input type="password" id="go-apikey" placeholder="AI Studio Key" style="width: 100%; border: 1px solid #cfd9de; border-radius: 8px; padding: 10px 12px; font-size: 14px; color: #0f1419; box-sizing: border-box; outline: none; transition: border 0.2s;">
          </div>
        </div>

        <button id="go-save" style="width: 100%; margin-top: 16px; background-color: #0f1419; color: white; border: none; padding: 12px; border-radius: 9999px; cursor: pointer; font-weight: 700; font-size: 14px; transition: background 0.2s;">保存</button>
        <div id="go-msg" style="text-align: center; font-size: 12px; margin-top: 8px; min-height: 16px; color: #00ba7c;"></div>
      </div>
    </div>

    <!-- MINIMIZED VIEW -->
    <div id="go-minimized-view" class="go-visible" style="display: block; cursor: pointer;">
        <div id="go-minimize-main" class="css-175oi2r r-105ug2t r-1867qdf r-1upvrn0 r-13awgt0 r-1ce3o0f r-1udh08x r-u8s1d r-13qz1uu r-173mn98 r-1e5uvyk r-6026j r-1xsrhxi r-rs99b7 r-12jitg0" style="width: 56px; height: 56px; border-radius: 12px; color: #0f1419; box-shadow: rgba(101, 119, 134, 0.2) 0px 0px 8px, rgba(101, 119, 134, 0.25) 0px 1px 3px 1px; border: 2px solid transparent;">
          <button id="go-open-panel" role="button" type="button" style="align-items: center; justify-content: center; width: 100%; height: 100%; background: transparent; border: none; padding: 0; cursor: pointer;">${jIconSvg}</button>
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

  const setPanelFixedPosition = ({ topPx = null, rightPx = '12px', bottomPx = null }) => {
    if (bottomPx !== null) {
      panel.style.setProperty('bottom', bottomPx, 'important');
      panel.style.setProperty('top', 'auto', 'important');
    } else if (topPx !== null) {
      panel.style.setProperty('top', topPx, 'important');
      panel.style.setProperty('bottom', 'auto', 'important');
    }
    panel.style.setProperty('right', rightPx, 'important');
    panel.style.setProperty('left', 'auto', 'important');
  };

  const applyResponsiveLayout = () => {
    const isMobile = window.innerWidth < 768;
    if (isMobile) {
      panel.style.width = 'calc(100% - 24px)';
      panel.style.left = '12px';
      panel.style.right = '12px';
      panel.style.top = 'auto';
      panel.style.bottom = '16px';
    } else {
      panel.style.left = 'auto';
      panel.style.bottom = 'auto';
      setPanelFixedPosition({ topPx: `${PANEL_MARGIN.expandedTop}px`, rightPx: `${PANEL_MARGIN.expandedRight}px` });
      panel.style.width = '300px';
    }
  };

  const setPanelState = (minimize) => {
    isPanelMinimized = minimize;
    if (minimize) {
      panel.style.zIndex = PANEL_Z_INDEX_MINIMIZED;

      // Remove placeholder if it exists
      const placeholder = document.getElementById('go-dock-placeholder');
      if (placeholder) placeholder.remove();

      attachToDock(panel, 2);
      expandedView.style.display = 'none';
      expandedView.classList.remove('go-visible');
      expandedView.classList.add('go-hidden');
      minimizedView.style.display = 'block';
      requestAnimationFrame(() => {
        minimizedView.classList.remove('go-hidden');
        minimizedView.classList.add('go-visible');
      });
    } else {
      // Capture current position while docked (before moving)
      const rect = panel.getBoundingClientRect();
      const currentTop = rect.top;
      const currentRight = window.innerWidth - rect.right;

      if (panel.parentElement && panel.parentElement.id === 'gemini-dock') {
        // Insert placeholder to prevent shift
        const placeholder = document.createElement('div');
        placeholder.id = 'go-dock-placeholder';
        placeholder.style.cssText = 'width: 56px; height: 56px; margin: 0; padding: 0; display: block; flex-shrink: 0;';

        // Insert placeholder before moving panel
        panel.parentElement.insertBefore(placeholder, panel);

        // Move panel to body
        document.body.appendChild(panel);
      }

      // Clear strict docking styles and restore base panel styles
      panel.style.cssText = '';
      panel.style.cssText = `
        position: fixed;
        z-index: ${PANEL_Z_INDEX_EXPANDED};
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      `;

      const isMobile = window.innerWidth < 768;
      if (isMobile) {
        applyResponsiveLayout();
      } else {
        // Desktop: align right shoulders
        const topPx = (currentTop > 0) ? currentTop : (PANEL_MARGIN.expandedTop + 80);
        const rightPx = (currentRight >= 0) ? currentRight : PANEL_MARGIN.expandedRight;

        setPanelFixedPosition({ topPx: `${topPx}px`, rightPx: `${rightPx}px` });
        panel.style.width = '300px';
      }

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
      cachedApiKey = key;
      saveBtn.textContent = '保存';
      msgEl.textContent = '設定を保存しました';
      setTimeout(() => { msgEl.textContent = ''; }, 2000);
    });
  });

  chrome.storage.local.get(['isOnewordEnabled', 'geminiModel', 'geminiApiKey', 'onewordLength', 'modelStats', MODEL_MIGRATION_KEY], (res) => {
    const isEnabled = res.isOnewordEnabled !== false;
    toggle.checked = isEnabled;
    updateToggleStyle(isEnabled);

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
        updateStatsUI(r.modelStats || {}, r.geminiModel || DEFAULT_MODEL);
      });
    }
    if (changes.geminiApiKey) {
      cachedApiKey = (changes.geminiApiKey.newValue || '').trim();
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
  window.addEventListener('resize', () => {
    if (!isPanelMinimized) applyResponsiveLayout();
  });
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
  if (summaryQueue.length === 0) return;
  if (inFlightRequests >= MAX_PARALLEL_REQUESTS) return;

  const queueSize = summaryQueue.length;
  const delay = queueSize <= 2
    ? 0
    : Math.max(
      MIN_DELAY_MS,
      Math.min(MAX_DELAY_MS, MIN_DELAY_MS + queueSize * 40)
    );

  scheduledTimerId = setTimeout(() => {
    scheduledTimerId = null;
    processQueue();
  }, delay);
}

async function processQueue() {
  if (summaryQueue.length === 0) return;
  if (inFlightRequests >= MAX_PARALLEL_REQUESTS) return;
  const toggle = document.getElementById('go-toggle');
  if (toggle && !toggle.checked) return;
  const apiKey = await ensureApiKey();
  if (!apiKey) return;
  inFlightRequests += 1;

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
  elements.forEach(el => setShimmer(el, true));

  try {
    const result = await requestSummary(texts);
    if (result) {
      const summaries = result.split(/\n?---SEPARATOR---\n?/);
      elements.forEach((el, index) => {
        const summaryText = summaries[index];
        if (summaryText) {
          const trimmed = summaryText.trim();
          applySummary(el, trimmed);
          summaryCache.set(getCacheKey(texts[index]), trimmed);
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
    elements.forEach(el => setShimmer(el, false));
    inFlightRequests = Math.max(0, inFlightRequests - 1);
    scheduleProcessing();
  }
}

function applySummary(element, summaryText) {
  const tweetId = getTweetId(element);
  const cachedOriginal = tweetId ? originalTextCache.get(tweetId) : '';
  const originalText = cachedOriginal || element.innerText;
  element.dataset.geminiOneword = 'true';
  element.dataset.geminiOnewordOriginal = originalText;
  element.dataset.geminiOnewordSummary = summaryText;
  element.dataset.geminiOnewordMode = 'summary';
  if (!element.dataset.geminiOnewordHtml) {
    element.dataset.geminiOnewordHtml = element.innerHTML;
  }
  if (tweetId) {
    element.dataset.geminiOnewordTweetId = tweetId;
    originalTextCache.set(tweetId, originalText);
    summaryByTweetId.set(tweetId, summaryText);
  }
  ensureBlocks(element);
  renderSummary(element);
}

function renderSummary(element) {
  const summary = element.dataset.geminiOnewordSummary || '';
  ensureBlocks(element);
  const summaryBlock = element.querySelector('.go-summary-block');
  summaryBlock.textContent = summary;
  const pill = createPill('開く');
  pill.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMode(element);
  });
  summaryBlock.appendChild(pill);
  setDisplayMode(element, 'summary');
  flashDone(element);
}

function renderOriginal(element) {
  let original = element.dataset.geminiOnewordOriginal || '';
  if (!original) {
    const tweetId = element.dataset.geminiOnewordTweetId || getTweetId(element);
    if (tweetId) {
      original = originalTextCache.get(tweetId) || '';
    }
  }
  ensureBlocks(element);
  const originalBlock = element.querySelector('.go-original-block');
  originalBlock.innerHTML = element.dataset.geminiOnewordHtml || original;
  const pill = createPill('要約に戻す');
  pill.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMode(element);
  });
  originalBlock.appendChild(pill);
  setDisplayMode(element, 'original');
}

function toggleMode(element) {
  const mode = element.dataset.geminiOnewordMode;
  if (mode === 'summary') {
    element.dataset.geminiOnewordMode = 'original';
    setDisplayMode(element, 'original');
  } else {
    element.dataset.geminiOnewordMode = 'summary';
    setDisplayMode(element, 'summary');
  }
}

function checkAndQueue(element) {
  if (element.dataset.geminiOneword === 'true' || element.dataset.geminiOneword === 'failed') return;
  const tweetId = getTweetId(element);
  if (tweetId) {
    const summaryForTweet = summaryByTweetId.get(tweetId);
    if (summaryForTweet) {
      applySummary(element, summaryForTweet);
      return;
    }
  }
  const text = element.innerText;
  if (!text || text.trim().length < 5) return;
  if (tweetId) {
    const cachedOriginal = originalTextCache.get(tweetId);
    if (cachedOriginal && text.length > cachedOriginal.length + 10) {
      queueResummary(element, text);
      return;
    }
  }
  if (!JAPANESE_REGEX.test(text)) return;
  const cacheKey = getCacheKey(text);
  const cached = summaryCache.get(cacheKey);
  if (cached) {
    applySummary(element, cached);
    return;
  }

  summaryQueue.push({ element, text });
  scheduleProcessing();
}

function scanExistingTweets() {
  getTweetTextElements(document).forEach(checkAndQueue);
}

const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    if (mutation.type === 'childList') {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const tweets = node.querySelectorAll ? node.querySelectorAll('[data-testid="tweetText"]') : [];
          if (tweets.length) {
            tweets.forEach(checkAndQueue);
          } else {
            getTweetTextElements(node).forEach(checkAndQueue);
          }
          if (node.getAttribute && node.getAttribute('data-testid') === 'tweetText') {
            checkAndQueue(node);
          }
        }
      });
    }
  }
});

function startObserving() {
  injectShimmerStyleOnce();
  createPanel();
  const target = document.body;
  if (!target) return;

  document.body.addEventListener('click', (e) => {
    const tweetEl = e.target.closest && e.target.closest('[data-testid="tweetText"]');
    if (!tweetEl) return;
    if (tweetEl.dataset.geminiOneword !== 'true') return;

    if (e.target && e.target.classList && e.target.classList.contains('go-pill')) {
      e.preventDefault();
      e.stopPropagation();
      toggleMode(tweetEl);
    }
  });

  document.body.addEventListener('click', (e) => {
    const targetEl = e.target;
    if (!targetEl || targetEl.getAttribute('role') !== 'button') return;
    const label = (targetEl.textContent || '').trim();
    if (label !== 'さらに表示') return;
    const tweetEl = targetEl.closest && targetEl.closest('article')?.querySelector('[data-testid="tweetText"]');
    if (!tweetEl) return;
    setTimeout(() => {
      const tweetId = getTweetId(tweetEl);
      const currentText = tweetEl.innerText || '';
      const cachedOriginal = tweetId ? (originalTextCache.get(tweetId) || '') : (tweetEl.dataset.geminiOnewordOriginal || '');
      if (!currentText || currentText.length <= cachedOriginal.length + 5) return;
      queueResummary(tweetEl, currentText);
    }, 0);
  });

  observer.observe(target, { childList: true, subtree: true });
  getTweetTextElements(document).forEach(checkAndQueue);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startObserving);
} else {
  startObserving();
}

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
  if (tag === 'input' || tag === 'textarea' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.shiftKey && (e.key === 'O' || e.key === 'o')) {
    const toggle = document.getElementById('go-toggle');
    if (toggle) {
      toggle.checked = !toggle.checked;
      toggle.dispatchEvent(new Event('change'));
      e.preventDefault();
    }
  }
});
