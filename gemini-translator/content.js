// Content Script - X.com Auto Translator (Floating Panel Version)
console.log('[Gemini Trans] Translator & Panel loaded.');

// --- Constants & Config ---
const MIN_TRANSLATION_DELAY_MS = 300;
const MAX_TRANSLATION_DELAY_MS = 1500;
const MAX_BATCH_SIZE = 12;
const MAX_BATCH_CHARS = 4000;
const CHARS_PER_TOKEN = 4;
const JAPANESE_REGEX = /[ぁ-んァ-ン一-龠]/;

const PRICING = {
    'gemini-2.5-flash-lite': { input: 0.10, output: 0.40 },
    'gemini-2.0-flash-lite': { input: 0.075, output: 0.30 },
    'gemini-2.0-flash': { input: 0.10, output: 0.40 },
    'gemini-2.5-flash': { input: 0.30, output: 2.50 },
    'gemini-1.5-flash': { input: 0.075, output: 0.30 }, // Legacy
    'default': { input: 0.10, output: 0.40 }
};

// State
let translationQueue = [];
let isProcessingQueue = false;
let scheduledTimerId = null;
let isPanelMinimized = false;

// --- Floating Panel UI Construction ---
const PANEL_CLASS_EXPANDED = 'css-175oi2r r-105ug2t r-14lw9ot r-1867qdf r-1upvrn0 r-13awgt0 r-1ce3o0f r-1udh08x r-u8s1d r-13qz1uu';
const PANEL_CLASS_MINIMIZED = 'css-175oi2r r-105ug2t r-1867qdf r-1upvrn0 r-13awgt0 r-1ce3o0f r-1udh08x r-u8s1d r-13qz1uu r-173mn98 r-1e5uvyk r-6026j r-1xsrhxi r-rs99b7 r-12jitg0';
const PANEL_MARGIN = {
    expandedTop: 14,
    expandedRight: 20,
    minimizedTop: 70,
    minimizedRight: 70
};
const PANEL_Z_INDEX_EXPANDED = 2147483647;
const PANEL_Z_INDEX_MINIMIZED = 2147483000;
const MINIMIZED_LEFT_OFFSET_PX = 0;

function createPanel() {
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
    // 1. Minimized Icon (Gemini "G")
    const geminiIconSvg = `<span aria-hidden="true" style="display: inline-flex; align-items: center; justify-content: center; width: 100%; height: 100%; font-size: 24px; font-weight: 700; line-height: 1; font-family: system-ui, -apple-system, 'Segoe UI', Arial, sans-serif; color: currentColor;">G</span>`;

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
            
            <!-- Header -->
            <div id="gx-header" class="css-175oi2r" style="cursor: move; padding: 12px 16px 8px 16px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #eff3f4; min-height: 50px;">
                <div style="font-weight: 800; font-size: 15px; color: #0f1419;">Gemini Trans</div>
            </div>
            
            <!-- Body -->
            <div id="gx-body" style="padding: 16px; overflow-y: auto;">
                
                <!-- Auto Translate Toggle -->
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                    <span style="font-size: 14px; font-weight: 700; color: #0f1419;">自動翻訳</span>
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

                    <!-- API Key -->
                    <div style="margin-bottom: 20px;">
                        <label style="display: block; font-size: 13px; margin-bottom: 6px; font-weight: 700; color: #0f1419;">API Key</label>
                        <input type="password" id="gx-apikey" placeholder="AI Studio Key" style="width: 100%; border: 1px solid #cfd9de; border-radius: 8px; padding: 10px 12px; font-size: 14px; color: #0f1419; box-sizing: border-box; outline: none; transition: border 0.2s;">
                    </div>

                    <!-- Save Button -->
                    <button id="gx-save" style="width: 100%; background-color: #0f1419; color: white; border: none; padding: 12px; border-radius: 9999px; cursor: pointer; font-weight: 700; font-size: 14px; transition: background 0.2s;">保存</button>
                    <div id="gx-msg" style="text-align: center; font-size: 12px; margin-top: 8px; min-height: 16px; color: #00ba7c;"></div>
                </div>
            </div>
        </div>

        <!-- MINIMIZED VIEW (Grok Button Style - Square) -->
        <div id="gx-minimized-view" class="gx-visible" style="display: block; cursor: pointer;">
             <div id="gx-minimized-button" class="css-175oi2r r-105ug2t r-1867qdf r-1upvrn0 r-13awgt0 r-1ce3o0f r-1udh08x r-u8s1d r-13qz1uu r-173mn98 r-1e5uvyk r-6026j r-1xsrhxi r-rs99b7 r-12jitg0" style="width: 50px; height: 50px; border-radius: 12px; color: #0f1419; box-shadow: rgba(101, 119, 134, 0.2) 0px 0px 8px, rgba(101, 119, 134, 0.25) 0px 1px 3px 1px; border: 2px solid transparent;">
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

    // Draggable State
    let expandedPosition = null;

    // State Logic for Min/Max
    const setPanelFixedPosition = (topPx, rightPx) => {
        panel.style.setProperty('top', topPx, 'important');
        panel.style.setProperty('right', rightPx, 'important');
        panel.style.setProperty('bottom', 'auto', 'important');
        panel.style.setProperty('left', 'auto', 'important');
    };

    const setPanelState = (isMinimized) => {
        isPanelMinimized = isMinimized;
        if (isMinimized) {
            panel.style.zIndex = PANEL_Z_INDEX_MINIMIZED;
            // Save expanded position before hiding
            const rect = panel.getBoundingClientRect();
            expandedPosition = {
                top: rect.top,
                left: rect.left
            };

            // Move to Top Right for Minimized View (Fixed)
            setPanelFixedPosition(
                `${PANEL_MARGIN.minimizedTop}px`,
                `${PANEL_MARGIN.minimizedRight + MINIMIZED_LEFT_OFFSET_PX}px`
            );
            panel.style.width = 'auto';  // Auto width for button
            expandedView.style.display = 'none';
            expandedView.classList.remove('gx-visible');
            expandedView.classList.add('gx-hidden');
            minimizedView.style.display = 'block';
            requestAnimationFrame(() => {
                minimizedView.classList.remove('gx-hidden');
                minimizedView.classList.add('gx-visible');
            });

        } else {
            panel.style.zIndex = PANEL_Z_INDEX_EXPANDED;
            // Restore position
            setPanelFixedPosition(
                `calc(${PANEL_MARGIN.expandedTop}px + env(safe-area-inset-top, 0px))`,
                `calc(${PANEL_MARGIN.expandedRight + MINIMIZED_LEFT_OFFSET_PX}px + env(safe-area-inset-right, 0px))`
            );
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


    // Load State from Storage
    chrome.storage.local.get(['isAutoTranslateEnabled', 'geminiModel', 'modelStats', 'geminiApiKey'], (res) => {
        // Toggle
        const isEnabled = res.isAutoTranslateEnabled !== false;
        toggle.checked = isEnabled;
        updateToggleStyle(isEnabled);

        // Stats (Use modelStats now)
        const currentModel = res.geminiModel || 'gemini-2.0-flash';
        updateStatsUI(res.modelStats || {}, currentModel);

        // Settings
        modelSelect.value = currentModel;
        if (res.geminiApiKey) apiKeyInput.value = res.geminiApiKey;

        // Default to minimized on load (top-right, shifted left)
        setPanelState(true);
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
        saveBtn.textContent = '保存中...';

        chrome.storage.local.set({
            geminiApiKey: key,
            geminiModel: model
        }, () => {
            saveBtn.textContent = '保存';
            msgEl.textContent = '設定を保存しました';
            // Force stats update
            chrome.storage.local.get(['modelStats'], (r) => {
                updateStatsUI(r.modelStats || {}, model);
            });
            setTimeout(() => { msgEl.textContent = ''; }, 2000);
        });
    });

    // Listen for storage changes
    chrome.storage.onChanged.addListener((changes) => {
        if (changes.modelStats) {
            chrome.storage.local.get(['modelStats', 'geminiModel'], (r) => {
                updateStatsUI(r.modelStats || {}, r.geminiModel || 'gemini-2.0-flash');
            });
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
function requestTranslation(texts) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
            type: 'TRANSLATE_TEXT_BG',
            text: texts.join('\n---SEPARATOR---\n'),
            targetLang: 'Japanese'
        }, (response) => {
            if (chrome.runtime.lastError) {
                console.warn('[Gemini Trans] Runtime error:', chrome.runtime.lastError.message);
                resolve(null);
                return;
            }
            if (response && response.success) {
                resolve(response.data);
            } else {
                console.error('[Gemini Trans] API Error:', response?.error);
                resolve(null);
            }
        });
    });
}

// Process Queue
function scheduleProcessing() {
    if (scheduledTimerId) return;
    if (isProcessingQueue || translationQueue.length === 0) return;

    const queueSize = translationQueue.length;
    const delay = Math.max(
        MIN_TRANSLATION_DELAY_MS,
        Math.min(MAX_TRANSLATION_DELAY_MS, MIN_TRANSLATION_DELAY_MS + queueSize * 40)
    );

    scheduledTimerId = setTimeout(() => {
        scheduledTimerId = null;
        processQueue();
    }, delay);
}

async function processQueue() {
    if (isProcessingQueue || translationQueue.length === 0) return;

    // Check Auto Translate switch from DOM directly (fastest) or storage
    const toggle = document.getElementById('gx-toggle');
    if (toggle && !toggle.checked) {
        // Keep queue but don't process if disabled
        setTimeout(processQueue, TRANSLATION_DELAY_MS);
        return;
    }

    isProcessingQueue = true;
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

    try {
        const result = await requestTranslation(texts);
        if (result) {
            const translations = result.split(/\n?---SEPARATOR---\n?/);
            elements.forEach((el, index) => {
                const translatedText = translations[index];
                if (translatedText) {
                    applyTranslation(el, translatedText.trim());
                }
            });
        } else {
            // Retry once or twice if API returns null
            batch.forEach((item) => {
                item.retry = (item.retry || 0) + 1;
                if (item.retry <= 2) {
                    translationQueue.unshift(item);
                } else {
                    item.element.dataset.geminiTranslated = 'failed';
                }
            });
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
        isProcessingQueue = false;
        scheduleProcessing();
    }
}

function applyTranslation(element, translatedText) {
    element.style.color = '#1d9bf0';
    element.innerText = translatedText;
    element.dataset.geminiTranslated = 'true';
}

function checkAndQueue(element) {
    if (element.dataset.geminiTranslated) return;
    const text = element.innerText;
    if (!text || text.trim().length < 3) return;
    if (JAPANESE_REGEX.test(text)) {
        element.dataset.geminiTranslated = 'skipped';
        return;
    }
    translationQueue.push({ element, text });
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
    createPanel(); // Init Panel
    const target = document.body;
    if (!target) return;
    observer.observe(target, { childList: true, subtree: true });
    document.querySelectorAll('[data-testid="tweetText"]').forEach(checkAndQueue);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserving);
} else {
    startObserving();
}
