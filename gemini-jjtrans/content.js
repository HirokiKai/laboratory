// Content Script - X.com 日日日翻訳 (やさしい日本語リライト)
console.log('[Nichinichi Honyaku] Plain Japanese Rewriter loaded.');

// --- Constants & Config ---
const MIN_TRANSLATION_DELAY_MS = 300;
const MAX_TRANSLATION_DELAY_MS = 1500;
const MAX_BATCH_SIZE = 12;
const MAX_BATCH_CHARS = 4000;
const MAX_PARALLEL_REQUESTS = 2;
const CHARS_PER_TOKEN = 4;
const JAPANESE_REGEX = /[ぁ-んァ-ン一-龠]/;
const DIR_JA_SIMPLIFY = 'ja_simplify';

// Shimmer effect for "translating" state
const SHIMMER_STYLE = `
  @keyframes gx-shimmer {
    0% { background-position: -200px 0; }
    100% { background-position: 200px 0; }
  }
  .gx-shimmer {
    position: relative;
    color: transparent !important;
    background: linear-gradient(90deg, #f1f3f4 0%, #e6ecf0 50%, #f1f3f4 100%);
    background-size: 200px 100%;
    animation: gx-shimmer 1.1s linear infinite;
    border-radius: 6px;
  }
  @keyframes gx-flash {
    0% { background-color: #e8f5fd; }
    100% { background-color: transparent; }
  }
  .gx-done {
    animation: gx-flash 0.8s ease;
  }
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
const API_KEY_REGEX = /^AIza[0-9A-Za-z\-_]{35}$/;
const TEST_TIMEOUT_MS = 5000;
const CACHE_LIMIT = 500;
const validateApiKey = (key) => API_KEY_REGEX.test(key);

// State
let translationQueue = [];
let inFlightRequests = 0;
let scheduledTimerId = null;
let isPanelMinimized = false;
let cachedApiKey = '';
const translationCache = new Map();
const originalTextCache = new Map();
const translationByTweetId = new Map();
const expandedRetranslated = new Set();
let triggerOnboarding = null; // populated inside panel logic
// Single direction: Japanese -> easier Japanese
let translationDirection = DIR_JA_SIMPLIFY;

const isKeyError = (msg = '') => {
    const m = msg.toLowerCase();
    return m.includes('api key') || m.includes('permission_denied') || m.includes('invalid api key') || m.includes('request had insufficient authentication');
};
const toastQueue = [];

// Panel control hooks (populated after panel init)
const panelControl = {
    togglePanel: null,
    setPanelState: null,
    getPanelState: null
};

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

function getCacheKey(text) {
    return text.trim();
}

function getTweetId(element) {
    const article = element.closest && element.closest('article');
    if (!article) return '';
    const link = article.querySelector('a[href*="/status/"]');
    if (!link) return '';
    const href = link.getAttribute('href') || '';
    const match = href.match(/status\/(\d+)/);
    return match ? match[1] : '';
}

// Expand truncated tweets ("Show more") before translating so we don't lose trailing text
function expandIfTruncated(element) {
    // Twitter/X adds a small button/link at the end of long tweets
    const showMore = element.querySelector(
        '[data-testid="tweet-text-show-more-link"], [data-testid="show-more-link"], div[role="button"][data-testid$="show-more"]'
    );

    // Only click once per element to avoid loops
    if (showMore && element.dataset.geminiShowMoreExpanded !== 'true') {
        element.dataset.geminiShowMoreExpanded = 'true';
        // Simulate a user click so X loads the remaining text inline
        showMore.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        // Re-run the queue logic after the DOM updates with full text
        setTimeout(() => checkAndQueue(element), 250);
        return true;
    }

    return false;
}

function queueRetranslation(element, text) {
    const tweetId = getTweetId(element);
    if (tweetId && expandedRetranslated.has(tweetId)) return;
    if (tweetId) expandedRetranslated.add(tweetId);
    if (tweetId && text) {
        originalTextCache.set(tweetId, text);
        element.dataset.geminiTranslatedOriginal = text;
    }
    element.dataset.geminiTranslated = 'pending';
    translationQueue.push({ element, text });
    scheduleProcessing();
}

function pruneCache(map) {
    while (map.size > CACHE_LIMIT) {
        const firstKey = map.keys().next().value;
        if (firstKey !== undefined) map.delete(firstKey);
        else break;
    }
}

// --- Floating Panel UI Construction ---
const PANEL_CLASS_EXPANDED = 'css-175oi2r r-105ug2t r-14lw9ot r-1867qdf r-1upvrn0 r-13awgt0 r-1ce3o0f r-1udh08x r-u8s1d r-13qz1uu';
const PANEL_CLASS_MINIMIZED = 'css-175oi2r r-105ug2t r-1867qdf r-1upvrn0 r-13awgt0 r-1ce3o0f r-1udh08x r-u8s1d r-13qz1uu r-173mn98 r-1e5uvyk r-6026j r-1xsrhxi r-rs99b7 r-12jitg0';
const PANEL_MARGIN = {
    expandedTop: 18,
    expandedRight: 12,
    minimizedBottom: 200,
    minimizedRight: 12
};
const PANEL_Z_INDEX_EXPANDED = 2147483647;
const PANEL_Z_INDEX_MINIMIZED = 2147483000;
const MINIMIZED_LEFT_OFFSET_PX = 0;

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

function attachToDock(panel, order = 1) {
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

function createPanel() {
    // Cleanup duplicates first
    const existing = document.querySelectorAll('[id^="gemini-x-panel"]');
    existing.forEach(p => p.remove());

    const section = document.createElement('div');
    section.id = 'gemini-x-panel';
    // Base generic classes for container
    section.style.cssText = `
        position: fixed;
        z-index: ${PANEL_Z_INDEX_MINIMIZED};
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    `;
    // Default to minimized position to avoid initial flicker
    section.style.top = `${PANEL_MARGIN.minimizedTop}px`;
    section.style.right = `${PANEL_MARGIN.minimizedRight + MINIMIZED_LEFT_OFFSET_PX}px`;
    section.style.bottom = 'auto';
    section.style.left = 'auto';
    section.style.width = 'auto';

    // Icons
    // 1. Minimized Icon (易)
    const geminiIconSvg = `<span aria-hidden="true" style="display: inline-flex; align-items: center; justify-content: center; width: 100%; height: 100%; font-size: 24px; font-weight: 800; line-height: 1; font-family: system-ui, -apple-system, 'Segoe UI', Arial, sans-serif; color: currentColor;">易</span>`;

    // 2. Close/Minimize Icon (Down Arrow)
    const closeIconSvg = `<svg viewBox="0 0 24 24" aria-hidden="true" style="color: #536471; width: 20px; height: 20px;"><g><path d="M12 15.41l-7.29-7.29 1.41-1.42L12 12.59l5.88-5.89 1.41 1.42L12 15.41z" fill="currentColor"></path></g></svg>`;

    section.innerHTML = `
        <style>
            #gx-expanded-view {
                transform-origin: top right;
                transition: opacity 220ms ease, transform 260ms cubic-bezier(0.2, 0.9, 0.2, 1);
            }
            #gx-minimized-view {
                transform-origin: top right;
                transition: opacity 180ms ease, transform 220ms cubic-bezier(0.2, 0.9, 0.2, 1);
            }
            .gx-hidden {
                opacity: 0;
                transform: scale(0.92);
                pointer-events: none;
            }
            .gx-visible {
                opacity: 1;
                transform: scale(1);
            }
        </style>
        <!-- EXPANDED VIEW -->
        <div id="gx-expanded-view" class="css-175oi2r r-105ug2t r-14lw9ot r-1867qdf r-1upvrn0 r-13awgt0 r-1ce3o0f r-1udh08x r-u8s1d r-13qz1uu gx-hidden" style="width: 300px; max-height: 80vh; display: none; flex-direction: column; box-shadow: rgba(101, 119, 134, 0.2) 0px 0px 15px, rgba(101, 119, 134, 0.15) 0px 0px 3px 1px; border-radius: 16px; background-color: white; position: relative;">
            <button id="gx-minimize-btn" type="button" style="position: absolute; top: 8px; right: 8px; background: rgba(0,0,0,0.05); border: none; border-radius: 50%; width: 32px; height: 32px; display: flex; justify-content: center; align-items: center; cursor: pointer; transition: background 0.2s; z-index: 1;">
                 ${closeIconSvg}
            </button>
            <!-- Onboarding Overlay -->
            <div id="gx-onboard" style="display:none; position:absolute; inset:0; background: rgba(255,255,255,0.98); border-radius:16px; padding:20px 18px 18px 18px; z-index:2; box-shadow: rgba(0,0,0,0.06) 0 8px 30px;">
                <div style="font-weight:800; font-size:16px; margin-bottom:8px; color:#0f1419;">はじめに</div>
                <div style="font-size:13px; color:#536471; line-height:1.5; margin-bottom:14px;">GeminiのAPIキーを入力してモデルを選ぶと自動翻訳が始まります。</div>
                <label style="display:block; font-size:12px; font-weight:700; color:#0f1419; margin-bottom:6px;">API Key</label>
                <input type="password" id="gx-onboard-key" placeholder="AI Studio Key" style="width:100%; border:1px solid #cfd9de; border-radius:8px; padding:10px 12px; font-size:14px; margin-bottom:14px; outline:none;">
                <label style="display:block; font-size:12px; font-weight:700; color:#0f1419; margin-bottom:6px;">モデル</label>
                <select id="gx-onboard-model" style="width:100%; border:1px solid #cfd9de; border-radius:8px; padding:10px 12px; font-size:14px; margin-bottom:18px; background:white; appearance:none; -webkit-appearance:none;">
                    <option value="gemini-2.0-flash-lite">Gemini 2.0 Flash-Lite</option>
                    <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
                    <option value="gemini-2.5-flash-lite">Gemini 2.5 Flash-Lite</option>
                    <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                    <option value="gemini-3-flash-preview">Gemini 3 Flash Preview</option>
                </select>
                <button id="gx-onboard-save" style="width:100%; background:#0f1419; color:white; border:none; padding:12px; border-radius:9999px; font-weight:800; cursor:pointer;">保存して開始</button>
                <div id="gx-onboard-msg" style="font-size:12px; color:#00ba7c; margin-top:8px; min-height:16px;"></div>
            </div>
            
            <!-- Header -->
            <div id="gx-header" class="css-175oi2r" style="cursor: move; padding: 12px 16px 8px 16px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #eff3f4; min-height: 50px;">
                <div style="font-weight: 800; font-size: 15px; color: #0f1419;">日日翻訳｜やさしい日本語</div>
            </div>

            
            <!-- Body -->
            <div id="gx-body" style="padding: 16px; overflow-y: auto;">
                
                <!-- Auto Translate Toggle -->
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                    <span style="font-size: 14px; font-weight: 700; color: #0f1419;">自動リライト</span>
                    <label style="position: relative; display: inline-block; width: 44px; height: 24px;">
                        <input type="checkbox" id="gx-toggle" checked style="opacity: 0; width: 0; height: 0;">
                        <span style="position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: rgb(29, 155, 240); transition: .4s; border-radius: 24px;"></span>
                        <span id="gx-slider-knob" style="position: absolute; content: ''; height: 20px; width: 20px; left: 2px; bottom: 2px; background-color: white; transition: .4s; border-radius: 50%; transform: translateX(20px);"></span>
                    </label>
                </div>

                <!-- Stats Card -->
                <div style="background-color: #f7f9f9; padding: 12px 16px; border-radius: 12px; margin-bottom: 20px; border: 1px solid #eff3f4;">
                    <div style="font-size: 11px; color: #536471; font-weight: 500;">推定コスト (モデル別目安)</div>
                    <div id="gx-cost" style="font-size: 22px; font-weight: 800; color: #0f1419; margin: 4px 0 8px 0;">$0.0000</div>
                    <div style="font-size: 11px; color: #536471; display: flex; justify-content: space-between;">
                        <span>In: <b id="gx-input-chars" style="color: #0f1419;">0</b></span>
                        <span>Out: <b id="gx-output-chars" style="color: #0f1419;">0</b></span>
                    </div>
                </div>

                <!-- Settings Section -->
                <button id="gx-settings-toggle" style="width: 100%; text-align: left; background: none; border: none; padding: 0; cursor: pointer; display: flex; align-items: center; gap: 6px; color: #2ecc71; font-weight: 600; font-size: 13px;">
                     <span style="font-size: 16px;">⚙️</span> 設定 (モデル・キー)
                </button>
                
                <div id="gx-settings-content" style="display: none; margin-top: 15px;">
                    
                    <!-- Model Select -->
                    <div style="margin-bottom: 15px;">
                        <label style="display: block; font-size: 13px; margin-bottom: 6px; font-weight: 700; color: #0f1419;">モデル</label>
                        <div style="position: relative;">
                            <select id="gx-model" style="width: 100%; appearance: none; -webkit-appearance: none; background-color: white; border: 1px solid #cfd9de; border-radius: 8px; padding: 10px 32px 10px 12px; font-size: 14px; color: #0f1419; font-weight: 500; cursor: pointer;">
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

                    <!-- API Key -->
                    <div style="margin-bottom: 20px;">
                        <label style="display: block; font-size: 13px; margin-bottom: 6px; font-weight: 700; color: #0f1419;">API Key</label>
                        <input type="password" id="gx-apikey" placeholder="AI Studio Key" style="width: 100%; border: 1px solid #cfd9de; border-radius: 8px; padding: 10px 12px; font-size: 14px; color: #0f1419; box-sizing: border-box; outline: none; transition: border 0.2s;">
                    </div>
                </div>

                <!-- Save Button -->
                <button id="gx-save" style="width: 100%; margin-top: 16px; background-color: #0f1419; color: white; border: none; padding: 12px; border-radius: 9999px; cursor: pointer; font-weight: 700; font-size: 14px; transition: background 0.2s;">保存して開始</button>
                <div id="gx-msg" style="text-align: center; font-size: 12px; margin-top: 8px; min-height: 16px; color: #00ba7c;"></div>
            </div>
        </div>

        <!-- MINIMIZED VIEW (Grok Button Style - Square) -->
        <div id="gx-minimized-view" class="gx-visible" style="display: block; cursor: pointer;">
             <div id="gx-minimized-button" class="css-175oi2r r-105ug2t r-1867qdf r-1upvrn0 r-13awgt0 r-1ce3o0f r-1udh08x r-u8s1d r-13qz1uu r-173mn98 r-1e5uvyk r-6026j r-1xsrhxi r-rs99b7 r-12jitg0" style="width: 56px; height: 56px; border-radius: 12px; color: #0f1419; box-shadow: rgba(101, 119, 134, 0.2) 0px 0px 8px, rgba(101, 119, 134, 0.25) 0px 1px 3px 1px; border: 2px solid transparent;">
                <button role="button" class="css-175oi2r r-6koalj r-eqz5dr r-16y2uox r-1pi2tsx r-1loqt21 r-o7ynqc r-6416eg r-1ny4l3l" type="button" style="align-items: center; justify-content: center; width: 100%; height: 100%; background: transparent; border: none; padding: 0; cursor: pointer;">
                    <div class="css-175oi2r" style="color: currentColor;">
                        ${geminiIconSvg}
                    </div>
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(section);
    setupPanelLogic(section);
}

// --- Panel Logic ---
function setupPanelLogic(panel) {
    // Elements
    const expandedView = panel.querySelector('#gx-expanded-view');
    const minimizedView = panel.querySelector('#gx-minimized-view');
    const header = panel.querySelector('#gx-header');
    const minimizeBtn = panel.querySelector('#gx-minimize-btn');
    const minimizedButton = panel.querySelector('#gx-minimized-button');
    const toggle = panel.querySelector('#gx-toggle');
    const knob = panel.querySelector('#gx-slider-knob');
    const costEl = panel.querySelector('#gx-cost');
    const inputCharsEl = panel.querySelector('#gx-input-chars');
    const outputCharsEl = panel.querySelector('#gx-output-chars');
    const settingsToggle = panel.querySelector('#gx-settings-toggle');
    const settingsContent = panel.querySelector('#gx-settings-content');
    const modelSelect = panel.querySelector('#gx-model');
    const apiKeyInput = panel.querySelector('#gx-apikey');
    const saveBtn = panel.querySelector('#gx-save');
    const msgEl = panel.querySelector('#gx-msg');
    const onboard = panel.querySelector('#gx-onboard');
    const onboardKey = panel.querySelector('#gx-onboard-key');
    const onboardModel = panel.querySelector('#gx-onboard-model');
    const onboardSave = panel.querySelector('#gx-onboard-save');
    const onboardMsg = panel.querySelector('#gx-onboard-msg');


    // Draggable State
    let expandedPosition = null;

    // State Logic for Min/Max
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

    const setPanelState = (isMinimized) => {
        isPanelMinimized = isMinimized;
        if (isMinimized) {
            panel.style.zIndex = PANEL_Z_INDEX_MINIMIZED;

            // Remove placeholder if it exists
            const placeholder = document.getElementById('gx-dock-placeholder');
            if (placeholder) placeholder.remove();

            attachToDock(panel, 1);
            expandedView.style.display = 'none';
            expandedView.classList.remove('gx-visible');
            expandedView.classList.add('gx-hidden');
            minimizedView.style.display = 'block';
            requestAnimationFrame(() => {
                minimizedView.classList.remove('gx-hidden');
                minimizedView.classList.add('gx-visible');
            });

        } else {
            // Capture current position while docked (before moving)
            const rect = panel.getBoundingClientRect();
            const currentTop = rect.top;
            const currentRight = window.innerWidth - rect.right;

            if (panel.parentElement && panel.parentElement.id === 'gemini-dock') {
                // Insert placeholder to prevent shift
                const placeholder = document.createElement('div');
                placeholder.id = 'gx-dock-placeholder';
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

            // Apply dynamic position (align right shoulders)
            const topPx = (currentTop > 0) ? currentTop : (PANEL_MARGIN.expandedTop + 80);
            const rightPx = (currentRight >= 0) ? currentRight : PANEL_MARGIN.expandedRight;

            setPanelFixedPosition({
                topPx: `${topPx}px`,
                rightPx: `${rightPx}px`
            });
            panel.style.width = '300px';
            minimizedView.style.display = 'none';
            minimizedView.classList.remove('gx-visible');
            minimizedView.classList.add('gx-hidden');
            expandedView.style.display = 'flex';
            requestAnimationFrame(() => {
                expandedView.classList.remove('gx-hidden');
                expandedView.classList.add('gx-visible');
            });
        }
    };

    // expose for keyboard shortcuts
    panelControl.togglePanel = () => setPanelState(!isPanelMinimized);
    panelControl.setPanelState = setPanelState;
    panelControl.getPanelState = () => isPanelMinimized;

    // Minimize Button Handler
    minimizeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        setPanelState(true);
    });

    // Restore Handler (Clicking the minimized icon)
    minimizedView.addEventListener('click', () => {
        setPanelState(false);
    });

    // Draggable Logic (Only active in Expanded mode for now)
    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    const handleMouseDown = (e) => {
        if (isPanelMinimized) return; // Disallow dragging icon as it's fixed to top-right
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

    // Toggle Style Update helper
    const updateToggleStyle = (checked) => {
        const slider = toggle.nextElementSibling;
        if (checked) {
            slider.style.backgroundColor = '#2ecc71';
            knob.style.transform = 'translateX(20px)';
        } else {
            slider.style.backgroundColor = '#cfd9de';
            knob.style.transform = 'translateX(2px)';
        }

        // Minimized icon state (green when auto-translate is ON)
        if (minimizedButton) {
            if (checked) {
                minimizedButton.style.borderColor = '#2ecc71';
                minimizedButton.style.boxShadow = 'rgba(46, 204, 113, 0.25) 0px 0px 8px, rgba(46, 204, 113, 0.18) 0px 1px 3px 1px';
            } else {
                minimizedButton.style.borderColor = 'transparent';
                minimizedButton.style.boxShadow = 'rgba(101, 119, 134, 0.2) 0px 0px 8px, rgba(101, 119, 134, 0.25) 0px 1px 3px 1px';
            }
        }
    };

    // Focus effects for inputs
    const addFocusEffects = (el) => {
        el.addEventListener('focus', () => el.style.border = '1px solid #1d9bf0');
        el.addEventListener('blur', () => el.style.border = '1px solid #cfd9de');
    };
    addFocusEffects(apiKeyInput);
    addFocusEffects(modelSelect);
    addFocusEffects(onboardKey);
    addFocusEffects(onboardModel);

    // Lightweight toast helper using existing message nodes
    const setMsg = (el, text, ok = true) => {
        el.textContent = text;
        el.style.color = ok ? '#00ba7c' : '#f4212e';
    };

    const testApiKey = async (key, model) => {
        // Use low-cost countTokens endpoint for a quick live check
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
        try {
            const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:countTokens?key=${key}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: [{ parts: [{ text: 'ping' }] }] }),
                signal: controller.signal
            });
            clearTimeout(timer);
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                if (resp.status === 403) throw new Error('キーが無効か権限がありません (403)');
                if (resp.status === 429) throw new Error('リクエスト上限に達しました (429)');
                throw new Error(err.error?.message || `HTTP ${resp.status}`);
            }
        } catch (e) {
            clearTimeout(timer);
            if (e.name === 'AbortError') throw new Error('キー確認がタイムアウトしました (5秒)');
            throw e;
        }
    };



    const showOnboarding = (prefillModel) => {
        // Prefill model choice and keep key empty to encourage fresh input
        onboardModel.value = prefillModel || DEFAULT_MODEL;
        onboardKey.value = '';
        onboardMsg.textContent = '';
        // Force expanded view to ensure visibility
        setPanelState(false);
        expandedView.style.display = 'flex';
        requestAnimationFrame(() => {
            onboard.style.display = 'block';
        });
    };
    triggerOnboarding = showOnboarding;

    const hideOnboarding = () => {
        onboard.style.display = 'none';
    };

    const resetTranslations = () => {
        translationCache.clear();
        translationByTweetId.clear();
        expandedRetranslated.clear();
        const translatedEls = document.querySelectorAll('[data-testid="tweetText"][data-gemini-translated], div[lang][data-gemini-translated]');
        translatedEls.forEach((el) => {
            if (el.dataset.geminiOriginalHtml) {
                el.innerHTML = el.dataset.geminiOriginalHtml;
            }
            delete el.dataset.geminiTranslated;
            delete el.dataset.geminiTranslatedOriginal;
            delete el.dataset.geminiTranslatedText;
            delete el.dataset.geminiTranslatedMode;
            delete el.dataset.geminiOriginalHtml;
            delete el.dataset.geminiTranslatedTweetId;
        });
        scanExistingTweets();
    };


    // Load State from Storage
    chrome.storage.local.get(['isAutoTranslateEnabled', 'geminiModel', 'modelStats', 'geminiApiKey', MODEL_MIGRATION_KEY], (res) => {
        // Toggle
        const isEnabled = res.isAutoTranslateEnabled !== false;
        toggle.checked = isEnabled && !!res.geminiApiKey;
        updateToggleStyle(toggle.checked);

        // Stats (Use modelStats now)
        let currentModel = res.geminiModel || DEFAULT_MODEL;
        if (!res[MODEL_MIGRATION_KEY]) {
            currentModel = DEFAULT_MODEL;
            chrome.storage.local.set({
                geminiModel: DEFAULT_MODEL,
                [MODEL_MIGRATION_KEY]: true
            });
        }
        updateStatsUI(res.modelStats || {}, currentModel);

        // Settings
        modelSelect.value = currentModel;
        if (res.geminiApiKey) apiKeyInput.value = res.geminiApiKey;
        cachedApiKey = (res.geminiApiKey || '').trim();
        translationDirection = DIR_JA_SIMPLIFY;

        // Default to minimized on load (top-right, shifted left)
        setPanelState(true);

        // If no API key yet, guide user with inline onboarding
        if (!res.geminiApiKey) {
            showOnboarding(currentModel);
        }
    });

    // Event Listeners
    toggle.addEventListener('change', (e) => {
        const checked = e.target.checked;
        updateToggleStyle(checked);
        chrome.storage.local.set({ isAutoTranslateEnabled: checked });
        if (checked) {
            scanExistingTweets();
            processQueue();
        }
    });

    modelSelect.addEventListener('change', (e) => {
        const newModel = e.target.value;
        // Update stats display immediately when model changes
        chrome.storage.local.get(['modelStats'], (r) => {
            updateStatsUI(r.modelStats || {}, newModel);
        });
    });

    settingsToggle.addEventListener('click', () => {
        const isHidden = settingsContent.style.display === 'none';
        settingsContent.style.display = isHidden ? 'block' : 'none';
    });



    saveBtn.addEventListener('click', () => {
        const key = apiKeyInput.value.trim();
        const model = modelSelect.value;
        if (!validateApiKey(key)) {
            setMsg(msgEl, 'APIキーの形式が正しくありません', false);
            return;
        }
        saveBtn.textContent = '保存中...';
        setMsg(msgEl, 'キー確認中...', true);

        testApiKey(key, model).then(() => {
            chrome.storage.local.set({
                geminiApiKey: key,
                geminiModel: model
            }, () => {
                cachedApiKey = key;
                saveBtn.textContent = '保存';
                setMsg(msgEl, '設定を保存しました', true);
                // Force stats update
                chrome.storage.local.get(['modelStats'], (r) => {
                    updateStatsUI(r.modelStats || {}, model);
                });
                setTimeout(() => { msgEl.textContent = ''; }, 2000);
            });
        }).catch((err) => {
            saveBtn.textContent = '保存';
            setMsg(msgEl, `保存失敗: ${err.message}`, false);
        });
    });

    onboardSave.addEventListener('click', () => {
        const key = onboardKey.value.trim();
        const model = onboardModel.value;
        if (!key) {
            setMsg(onboardMsg, 'APIキーを入力してください', false);
            return;
        }
        if (!validateApiKey(key)) {
            setMsg(onboardMsg, 'APIキーの形式が正しくありません', false);
            return;
        }
        onboardSave.textContent = '保存中...';
        setMsg(onboardMsg, 'キー確認中...', true);

        testApiKey(key, model).then(() => {
            chrome.storage.local.set({
                geminiApiKey: key,
                geminiModel: model,
                isAutoTranslateEnabled: true
            }, () => {
                cachedApiKey = key;
                apiKeyInput.value = key;
                modelSelect.value = model;
                toggle.checked = true;
                updateToggleStyle(true);
                setMsg(onboardMsg, '設定を保存しました', true);
                setTimeout(() => {
                    onboardSave.textContent = '保存して開始';
                    hideOnboarding();
                    scanExistingTweets();
                    processQueue();
                }, 600);
            });
        }).catch((err) => {
            onboardSave.textContent = '保存して開始';
            setMsg(onboardMsg, `保存失敗: ${err.message}`, false);
        });
    });

    // Listen for storage changes
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
        // Get stats for specific model, default to 0
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
}

// --- Translation Logic (Same as before, adapted for Panel) ---

// requestTranslation: Send to background
function requestTranslation(texts, direction) {
    if (!(chrome && chrome.runtime && chrome.runtime.sendMessage)) {
        console.warn('[Gemini Trans] runtime unavailable');
        return Promise.resolve({ error: 'runtime unavailable' });
    }
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
            type: 'TRANSLATE_TEXT_BG',
            text: texts.join('\n---SEPARATOR---\n'),
            direction
        }, (response) => {
            if (chrome.runtime.lastError) {
                console.warn('[Gemini Trans] Runtime error:', chrome.runtime.lastError.message);
                resolve({ error: chrome.runtime.lastError.message });
                return;
            }
            if (response && response.success) {
                resolve({ translation: response.data });
            } else {
                console.error('[Gemini Trans] API Error:', response?.error);
                if (response?.error && isKeyError(response.error) && triggerOnboarding) {
                    triggerOnboarding();
                }
                resolve({ error: response?.error || 'Unknown error' });
            }
        });
    });
}

// Process Queue
function scheduleProcessing() {
    if (scheduledTimerId) return;
    if (translationQueue.length === 0) return;
    if (inFlightRequests >= MAX_PARALLEL_REQUESTS) return;

    const queueSize = translationQueue.length;
    const delay = queueSize <= 2
        ? 0
        : Math.max(
            MIN_TRANSLATION_DELAY_MS,
            Math.min(MAX_TRANSLATION_DELAY_MS, MIN_TRANSLATION_DELAY_MS + queueSize * 40)
        );

    scheduledTimerId = setTimeout(() => {
        scheduledTimerId = null;
        processQueue();
    }, delay);
}

async function processQueue() {
    if (translationQueue.length === 0) return;
    if (inFlightRequests >= MAX_PARALLEL_REQUESTS) return;

    // Check Auto Translate switch from DOM directly (fastest) or storage
    const toggle = document.getElementById('gx-toggle');
    if (toggle && !toggle.checked) {
        // Keep queue but don't process if disabled
        setTimeout(processQueue, MIN_TRANSLATION_DELAY_MS);
        return;
    }
    const apiKey = await ensureApiKey();
    if (!apiKey || !validateApiKey(apiKey)) {
        if (triggerOnboarding) triggerOnboarding();
        showToast('APIキーを設定または確認してください', 'error');
        return;
    }

    inFlightRequests += 1;
    const batch = [];
    let totalChars = 0;
    while (translationQueue.length > 0 && batch.length < MAX_BATCH_SIZE) {
        const item = translationQueue[0];
        const projected = totalChars + item.text.length;
        if (batch.length > 0 && projected > MAX_BATCH_CHARS) break;
        totalChars = projected;
        batch.push(translationQueue.shift());
    }
    const elements = batch.map(item => item.element);
    const texts = batch.map(item => item.text);

    elements.forEach(el => setTranslatingState(el, true));

    try {
        const result = await requestTranslation(texts, translationDirection);
        if (result.translation) {
            const translations = result.translation.split(/\n?---SEPARATOR---\n?/);
            elements.forEach((el, index) => {
                const translatedText = translations[index];
                if (translatedText) {
                    const trimmed = translatedText.trim();
                    applyTranslation(el, trimmed);
                    translationCache.set(getCacheKey(texts[index]), trimmed);
                }
            });
        } else if (result.error) {
            // Check for critical runtime errors
            if (result.error.includes('runtime unavailable') ||
                result.error.includes('Extension context invalidated') ||
                result.error.includes('context invalidated')) {
                showToast('拡張機能が更新されました。ページを再読み込みしてください。', 'error', 10000);
                translationQueue.length = 0; // Clear queue
                inFlightRequests = 0;
                return; // Stop processing
            }

            if (result.error.includes('Translation disabled by user')) {
                // Suppress visual error for this expected case, but stop processing loop
                translationQueue.length = 0;
                inFlightRequests = 0;
                return;
            }

            const is429 = result.error.includes('429');
            if (isKeyError(result.error) && triggerOnboarding) {
                triggerOnboarding();
            }
            showToast(`翻訳エラー: ${result.error}`, 'error');
            batch.forEach((item) => {
                item.retry = (item.retry || 0) + 1;
                if (item.retry <= 2) {
                    translationQueue.unshift(item);
                } else {
                    item.element.dataset.geminiTranslated = 'failed';
                }
            });
            const delay = is429 ? 2000 : MIN_TRANSLATION_DELAY_MS;
            setTimeout(processQueue, delay);
            return;
        }
    } catch (e) {
        console.error('[Gemini Trans] Batch process failed:', e);
        batch.forEach((item) => {
            item.retry = (item.retry || 0) + 1;
            if (item.retry <= 2) {
                translationQueue.unshift(item);
            } else {
                item.element.dataset.geminiTranslated = 'failed';
            }
        });
    } finally {
        elements.forEach(el => setTranslatingState(el, false));
        inFlightRequests = Math.max(0, inFlightRequests - 1);
        scheduleProcessing();
    }
}

function renderTranslation(element) {
    const translated = element.dataset.geminiTranslatedText || '';
    ensureDualBlocks(element);
    const translationBlock = element.querySelector('.gx-translation-block');
    translationBlock.textContent = translated;
    const pill = createPill('元の文');
    pill.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMode(element);
    });
    translationBlock.appendChild(pill);
    setDisplayByMode(element, 'translation');
    flashDone(element);
}

function renderOriginal(element) {
    ensureDualBlocks(element);
    const originalBlock = element.querySelector('.gx-original-block');
    const pill = createPill('やさしい文');
    pill.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMode(element);
    });
    // Keep original markup intact; just ensure pill exists
    const existingPill = originalBlock.querySelector('.gx-pill');
    if (existingPill) existingPill.remove();
    originalBlock.appendChild(pill);
    setDisplayByMode(element, 'original');
}

function toggleMode(element) {
    const mode = element.dataset.geminiTranslatedMode;
    if (mode === 'translation') {
        element.dataset.geminiTranslatedMode = 'original';
        setDisplayByMode(element, 'original');
    } else {
        element.dataset.geminiTranslatedMode = 'translation';
        setDisplayByMode(element, 'translation');
    }
}

function applyTranslation(element, translatedText) {
    const tweetId = getTweetId(element);
    const cachedOriginal = tweetId ? originalTextCache.get(tweetId) : '';
    const originalText = cachedOriginal || element.innerText;
    element.dataset.geminiTranslated = 'true';
    element.dataset.geminiTranslatedOriginal = originalText;
    element.dataset.geminiTranslatedText = translatedText;
    element.dataset.geminiTranslatedMode = 'translation';
    if (!element.dataset.geminiOriginalHtml) {
        element.dataset.geminiOriginalHtml = element.innerHTML;
    }
    if (tweetId) {
        element.dataset.geminiTranslatedTweetId = tweetId;
        originalTextCache.set(tweetId, originalText);
        pruneCache(originalTextCache);
        translationByTweetId.set(tweetId, translatedText);
        pruneCache(translationByTweetId);
    }
    ensureDualBlocks(element);
    renderTranslation(element);
    pruneCache(translationCache);
}

function setTranslatingState(element, isTranslating) {
    if (isTranslating) {
        element.dataset.geminiTranslating = 'true';
        element.classList.add('gx-shimmer');
    } else {
        element.dataset.geminiTranslating = 'false';
        element.classList.remove('gx-shimmer');
    }
}

function createPill(label) {
    const pill = document.createElement('span');
    pill.textContent = label;
    pill.style.cssText = 'display:inline-flex;align-items:center;padding:2px 6px;margin-left:6px;font-size:11px;font-weight:700;border-radius:10px;border:1px solid #cfd9de;color:#536471;cursor:pointer;user-select:none;';
    pill.addEventListener('mouseenter', () => pill.style.borderColor = '#1d9bf0');
    pill.addEventListener('mouseleave', () => pill.style.borderColor = '#cfd9de');
    pill.className = 'gx-pill';
    return pill;
}

function flashDone(element) {
    const tb = element.querySelector('.gx-translation-block');
    if (!tb) return;
    tb.classList.add('gx-done');
    setTimeout(() => tb.classList.remove('gx-done'), 700);
}

function ensureDualBlocks(element) {
    // Keep original markup intact by separating original and translation blocks
    if (!element.dataset.geminiOriginalHtml) {
        element.dataset.geminiOriginalHtml = element.innerHTML;
    }
    const hasOriginalBlock = element.querySelector('.gx-original-block');
    const hasTranslationBlock = element.querySelector('.gx-translation-block');
    if (!hasOriginalBlock) {
        const originalBlock = document.createElement('div');
        originalBlock.className = 'gx-original-block';
        originalBlock.innerHTML = element.dataset.geminiOriginalHtml;
        element.innerHTML = '';
        element.appendChild(originalBlock);
    }
    if (!hasTranslationBlock) {
        const translationBlock = document.createElement('div');
        translationBlock.className = 'gx-translation-block';
        translationBlock.style.color = '#1d9bf0';
        translationBlock.style.whiteSpace = 'pre-wrap';
        element.appendChild(translationBlock);
    }
}

function setDisplayByMode(element, mode) {
    const ob = element.querySelector('.gx-original-block');
    const tb = element.querySelector('.gx-translation-block');
    if (!ob || !tb) return;
    if (mode === 'original') {
        ob.style.display = 'block';
        tb.style.display = 'none';
    } else {
        ob.style.display = 'none';
        tb.style.display = 'block';
    }
    element.dataset.geminiTranslatedMode = mode;
}

function injectShimmerStyleOnce() {
    if (document.getElementById('gx-shimmer-style')) return;
    const style = document.createElement('style');
    style.id = 'gx-shimmer-style';
    style.textContent = SHIMMER_STYLE;
    document.head.appendChild(style);
}

function showToast(message, tone = 'info', duration = 2200) {
    const containerId = 'gx-toast-container';
    let container = document.getElementById(containerId);
    if (!container) {
        container = document.createElement('div');
        container.id = containerId;
        container.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483646;display:flex;flex-direction:column;gap:8px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.cssText = 'padding:10px 12px;border-radius:10px;box-shadow:rgba(0,0,0,0.12) 0 6px 16px; background:' +
        (tone === 'error' ? '#ffe6e6' : tone === 'success' ? '#e6ffed' : '#f7f9f9') +
        '; color:#0f1419; min-width: 200px; font-size: 13px; font-weight: 600;';
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 160ms ease';
        setTimeout(() => toast.remove(), 200);
    }, duration);
}

function checkAndQueue(element) {
    const tweetId = getTweetId(element);
    // If tweet is truncated, expand first; queue will be retriggered after expansion
    if (expandIfTruncated(element)) return;

    if (tweetId) {
        const cachedTranslation = translationByTweetId.get(tweetId);
        const cachedOriginal = originalTextCache.get(tweetId);
        const currentText = element.innerText;

        // If previously translated text differs from current visible text (e.g., after "Show more"),
        // retranslate to include the newly revealed portion.
        const needsRetranslate =
            cachedOriginal &&
            currentText &&
            currentText.trim().length > cachedOriginal.trim().length + 1; // minor whitespace tolerance

        if (needsRetranslate) {
            queueRetranslation(element, currentText);
            return;
        }

        // If we have a translation AND the underlying text hasn't changed, reuse it
        if (cachedTranslation && cachedOriginal && currentText === cachedOriginal) {
            applyTranslation(element, cachedTranslation);
            return;
        }
    }
    const text = element.innerText;
    if (!text || text.trim().length < 3) return;
    if (tweetId) {
        const cachedOriginal = originalTextCache.get(tweetId);
        if (cachedOriginal && text !== cachedOriginal) {
            queueRetranslation(element, text);
            return;
        }
    }
    if (element.dataset.geminiTranslated) return;
    const hasJapanese = JAPANESE_REGEX.test(text);
    // Only process Japanese text; skip others
    if (!hasJapanese) {
        element.dataset.geminiTranslated = 'skipped';
        return;
    }
    const cacheKey = getCacheKey(text);
    const cached = translationCache.get(cacheKey);
    if (cached) {
        applyTranslation(element, cached);
        return;
    }
    translationQueue.push({ element, text });
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
    // Check for Felosearch forced translation
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('felosearch_translate') === '1') {
        chrome.storage.local.set({ isAutoTranslateEnabled: true });
    }

    injectShimmerStyleOnce();
    createPanel(); // Init Panel
    const target = document.body;
    if (!target) return;
    observer.observe(target, { childList: true, subtree: true });
    getTweetTextElements(document).forEach(checkAndQueue);
}

// Keyboard shortcuts (Shift+J: パネル表示/非表示, Shift+T: 自動翻訳トグル)
document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.shiftKey && (e.key === 'J' || e.key === 'j')) {
        if (panelControl.togglePanel) {
            e.preventDefault();
            panelControl.togglePanel();
        }
    }
    if (e.shiftKey && (e.key === 'T' || e.key === 't')) {
        const toggle = document.getElementById('gx-toggle');
        if (toggle) {
            e.preventDefault();
            toggle.click();
        }
    }
});

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserving);
} else {
    startObserving();
}
