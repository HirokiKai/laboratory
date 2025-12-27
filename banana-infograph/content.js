
// Constants
const PANEL_MARGIN = { expandedTop: 20, expandedRight: 12 };
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

function attachToDock(panel, order = 4) {
  const dock = ensureDock();
  panel.dataset.gemDockOrder = order;
  dock.appendChild(panel);
  Array.from(dock.children)
    .sort((a, b) => (parseInt(a.dataset.gemDockOrder || '0', 10) - parseInt(b.dataset.gemDockOrder || '0', 10)))
    .forEach((el) => dock.appendChild(el));

  // Reset styles first to ensure clean slate
  panel.style.cssText = '';

  // Apply strict styles for docked state
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

  // Override ID-based styles from stylesheet to prevent square background
  panel.style.setProperty('background', 'transparent', 'important');
  panel.style.setProperty('border', 'none', 'important');
  panel.style.setProperty('box-shadow', 'none', 'important');
}

class GeminiUI {
  constructor() {
    this.panel = null;
    this.isMinimized = false;
    this.init();
  }

  async init() {
    this.injectStyles();
    await this.createPanel();
    this.loadState();
    this.setupUrlObserver();
    this.insertTriggerButtonSafe();
  }

  injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      #gemini-banana-panel {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        display: flex;
        flex-direction: column;
        /* transition removed to prevent dock layout glitches */
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
        border: 1px solid rgba(255, 255, 255, 0.1);
        backdrop-filter: blur(10px);
        background: rgba(15, 20, 25, 0.95);
        color: #ffffff;
        overflow: hidden;
      }
      
      /* Minimized Content */
      .minimized-content {
        display: none;
        width: 100%;
        height: 100%;
        font-size: 24px;
        justify-content: center;
        align-items: center;
        cursor: pointer;
        border-radius: 12px;
        border: 2px solid transparent;
        background-color: #0f1419;
        box-shadow: rgba(101, 119, 134, 0.2) 0px 0px 8px, rgba(101, 119, 134, 0.25) 0px 1px 3px 1px;
        color: #fff;
      }
      
      /* Animation Classes */
      .nb-hidden { opacity: 0; transform: scale(0.92); pointer-events: none; }
      .nb-visible { opacity: 1; transform: scale(1); }
      
      .maximized-content {
        transform-origin: top right;
        transition: opacity 220ms ease, transform 260ms cubic-bezier(0.2, 0.9, 0.2, 1);
      }
      .minimized-content {
        transition: opacity 180ms ease, transform 220ms cubic-bezier(0.2, 0.9, 0.2, 1);
      }

      /* Header */
      .gx-header {
        display: flex;
        align-items: center;
        padding: 14px 16px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        background: rgba(255, 255, 255, 0.03);
        flex-shrink: 0;
        cursor: grab;
      }
      
      .gx-logo {
        font-size: 16px;
        font-weight: 800;
        background: linear-gradient(135deg, #FFE135 0%, #FFD700 100%);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        margin-right: auto;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      
      .gx-controls {
        display: flex;
        gap: 8px;
      }
      
      .gx-icon-btn {
        background: transparent;
        border: none;
        color: #8b98a5;
        cursor: pointer;
        padding: 4px;
        border-radius: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s;
      }
      
      .gx-icon-btn:hover {
        background: rgba(255, 255, 255, 0.1);
        color: #ffffff;
      }

      /* Content */
      .gx-content {
        flex: 1;
        overflow-y: auto;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      
      /* Form Elements */
      .gx-label {
        font-size: 12px;
        font-weight: 700;
        color: #8b98a5;
        margin-bottom: 6px;
        display: block;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      
      .gx-input, .gx-textarea {
        width: 100%;
        background: rgba(0, 0, 0, 0.3);
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 8px;
        padding: 10px;
        color: #fff;
        font-size: 13px;
        transition: all 0.2s;
        box-sizing: border-box;
      }
      
      .gx-input:focus, .gx-textarea:focus {
        border-color: #FFE135;
        outline: none;
        background: rgba(0, 0, 0, 0.5);
      }

      .gx-textarea {
        resize: vertical;
        min-height: 300px;
        line-height: 1.5;
        font-family: monospace;
      }
      
      .gx-btn-primary {
        width: 100%;
        background: linear-gradient(135deg, #FFE135 0%, #FFD700 100%);
        color: #000;
        border: none;
        border-radius: 20px;
        padding: 10px;
        font-weight: 700;
        font-size: 14px;
        cursor: pointer;
        transition: all 0.2s;
        margin-top: auto;
      }
      
      .gx-btn-primary:hover {
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(255, 215, 0, 0.3);
      }

      #nanobanana-button {
        border: none;
        background: transparent;
        cursor: pointer;
        font-size: 20px;
        line-height: 1;
        padding: 8px;
        border-radius: 50%;
        transition: background 0.2s;
      }
      #nanobanana-button:hover {
        background: rgba(255, 215, 0, 0.1);
      }
    `;
    document.head.appendChild(style);
  }

  async createPanel() {
    // Cleanup ALL existing panels/ghosts to prevent duplicates
    const existingPanels = document.querySelectorAll('[id^="gemini-banana-panel"]');
    existingPanels.forEach(p => p.remove());

    this.panel = document.createElement('div');
    this.panel.id = 'gemini-banana-panel';
    // Initial state setup will happens in loadState, but create as hidden first
    this.panel.style.display = 'none';

    const { geminiApiKey, customPrompt } = await chrome.storage.local.get(['geminiApiKey', 'customPrompt']);
    const defaultPrompt = `あなたはグラフィックデザイナーです。以下のテキストを1枚の正方形インフォグラフィックにしてください。
- フォント: 丸めサンセリフ、太め
- 配色: ダークネイビー背景 + バナナイエローのアクセント
- レイアウト: 大見出し + 3箇条書き + 右下に小アイコンスペース
- 余白多め、コントラスト強め、読みやすさ優先
- 出力は1:1の画像のみ
テキスト: 「{text}」`;

    this.panel.innerHTML = `
      <!-- Minimized View -->
      <div class="minimized-content">🍌</div>

      <!-- Maximized View -->
      <div class="maximized-content" style="height: 100%; display: flex; flex-direction: column;">
        <div class="gx-header">
          <div class="gx-logo">🍌 NanoBanana</div>
          <div class="gx-controls">
            <button class="gx-icon-btn" id="nb-minimize">－</button>
          </div>
        </div>
        
        <div class="gx-content">
          <div>
            <label class="gx-label">API KEY</label>
            <input type="password" id="nb-apikey" class="gx-input" placeholder="Gemini API Key" value="${geminiApiKey || ''}">
          </div>

          <div>
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <label class="gx-label">INSTRUCTION</label>
              <button id="nb-reset-prompt" style="background:none; border:none; color:#FFE135; font-size:11px; cursor:pointer; text-decoration:underline;">Reset</button>
            </div>
            <textarea id="nb-prompt" class="gx-textarea" placeholder="Use {text} placeholder for the tweet content">${customPrompt || defaultPrompt}</textarea>
            <div style="font-size:11px; color:#8b98a5; margin-top:4px;">※ <code>{text}</code> の部分にポスト内容が入ります</div>
          </div>

          <button id="nb-save" class="gx-btn-primary">Save Settings</button>
        </div>
      </div>
    `;

    // Listeners
    this.panel.querySelector('#nb-minimize').addEventListener('click', (e) => {
      e.stopPropagation();
      this.setPanelState(true);
    });

    this.panel.querySelector('.minimized-content').addEventListener('click', (e) => {
      e.stopPropagation();
      this.setPanelState(false);
    });

    this.panel.querySelector('#nb-save').addEventListener('click', () => {
      const apiKey = this.panel.querySelector('#nb-apikey').value.trim();
      const prompt = this.panel.querySelector('#nb-prompt').value.trim();
      chrome.storage.local.set({ geminiApiKey: apiKey, customPrompt: prompt }, () => {
        this.showToast('設定を保存しました', 'success');
      });
    });

    this.panel.querySelector('#nb-reset-prompt').addEventListener('click', () => {
      this.panel.querySelector('#nb-prompt').value = defaultPrompt;
    });

    // Drag Functionality
    const header = this.panel.querySelector('.gx-header');
    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    header.addEventListener('mousedown', (e) => {
      // Ignore clicks on buttons/controls in header
      if (e.target.closest('button')) return;

      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;

      const rect = this.panel.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;

      // Switch from right-based to left-based positioning for dragging
      this.panel.style.right = 'auto';
      this.panel.style.bottom = 'auto';
      this.panel.style.left = `${initialLeft}px`;
      this.panel.style.top = `${initialTop}px`;
      this.panel.style.cursor = 'grabbing';

      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      this.panel.style.left = `${initialLeft + dx}px`;
      this.panel.style.top = `${initialTop + dy}px`;
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        this.panel.style.cursor = 'auto';
        header.style.cursor = 'grab';
      }
    });
  }

  setPanelState(minimize) {
    this.isMinimized = minimize;
    const minimizedContent = this.panel.querySelector('.minimized-content');
    const maximizedContent = this.panel.querySelector('.maximized-content');

    if (minimize) {
      // Minimized State
      this.panel.style.zIndex = PANEL_Z_INDEX_MINIMIZED + 10;

      // Remove dock placeholder if exists
      const placeholder = document.getElementById('nb-dock-placeholder');
      if (placeholder) placeholder.remove();

      attachToDock(this.panel, 4); // Order 4 to sit at the bottom

      // Styles are now handled by .minimized-content css class

      maximizedContent.style.display = 'none';
      maximizedContent.classList.remove('nb-visible');
      maximizedContent.classList.add('nb-hidden');

      minimizedContent.style.display = 'flex';
      requestAnimationFrame(() => {
        minimizedContent.classList.remove('nb-hidden');
        minimizedContent.classList.add('nb-visible');
      });

    } else {
      // Expanded State
      // Capture current position while docked (before moving)
      const rect = this.panel.getBoundingClientRect();
      const currentTop = rect.top;

      const dock = document.getElementById('gemini-dock');
      if (this.panel.parentElement === dock) {
        // Insert placeholder to prevent shift
        const placeholder = document.createElement('div');
        placeholder.id = 'nb-dock-placeholder';
        placeholder.style.cssText = 'width: 56px; height: 56px; margin: 0; padding: 0; display: block; flex-shrink: 0;';
        dock.insertBefore(placeholder, this.panel);

        // Move to body
        document.body.appendChild(this.panel);
      }

      // Calculate Top Position (ReRT style)
      const topPx = (currentTop > 0) ? currentTop : 140;

      // Reset styles from dock
      this.panel.style.cssText = '';
      this.panel.style.cssText = `
        position: fixed;
        z-index: ${PANEL_Z_INDEX_EXPANDED};
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        top: ${topPx}px;
        right: 12px;
        width: 320px;
        height: min(600px, 80vh);
        border-radius: 16px;
        display: flex;
        flex-direction: column;
        background: rgba(15, 20, 25, 0.95);
        color: #ffffff;
        backdrop-filter: blur(10px);
        border: 1px solid rgba(255, 255, 255, 0.1);
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
      `;
      // Restored shadow for expanded state

      minimizedContent.style.display = 'none';
      minimizedContent.classList.remove('nb-visible');
      minimizedContent.classList.add('nb-hidden');

      maximizedContent.style.display = 'flex';
      requestAnimationFrame(() => {
        maximizedContent.classList.remove('nb-hidden');
        maximizedContent.classList.add('nb-visible');
      });
    }

    // Save State
    chrome.storage.local.set({ 'nanobanana_minimized': minimize });
  }

  async loadState() {
    const { nanobanana_minimized } = await chrome.storage.local.get('nanobanana_minimized');
    // Default to minimized if not set, or true/false
    const shouldMinimize = nanobanana_minimized !== false;
    // Wait, let's default to expanded first time? No, minimizing is less intrusive.
    // user said "panel is not small", so they want it minimized capable.
    // Let's default to minimized.
    this.setPanelState(!!shouldMinimize);
  }

  showToast(message, type = 'info') {
    let box = document.getElementById('nanobanana-toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'nanobanana-toast';
      box.style.cssText = 'position:fixed;top:12px;right:80px;z-index:2147483647;padding:10px 16px;background:#0f1419;color:#fff;border-radius:10px;font-size:13px;box-shadow:0 6px 16px rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1);transition:opacity 0.3s;';
      document.body.appendChild(box);
    }
    box.textContent = message;
    box.style.borderLeft = type === 'success' ? '4px solid #FFE135' : '4px solid #e74c3c';
    box.style.opacity = '1';
    setTimeout(() => { if (box) box.style.opacity = '0'; }, 3000);
  }

  setupUrlObserver() {
    const observer = new MutationObserver(() => {
      this.insertTriggerButtonSafe();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  insertTriggerButtonSafe() {
    // Attach a button to every toolbar instance (main composer, reply modal, RT modal, etc.)
    const toolbars = document.querySelectorAll('[data-testid="toolBar"]');
    toolbars.forEach((toolbar, idx) => {
      if (toolbar.dataset.nanobananaAttached === '1') return;
      toolbar.dataset.nanobananaAttached = '1';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '🍌';
      btn.title = 'Generate Infograph';
      btn.className = 'nanobanana-btn';
      // Save a weak reference to the toolbar for lookup when clicked
      btn.addEventListener('click', () => this.generate(toolbar));

      const firstIcon = toolbar.querySelector('button');
      if (firstIcon?.parentElement) {
        firstIcon.parentElement.insertAdjacentElement('afterend', btn);
      } else {
        toolbar.prepend(btn);
      }
    });
  }

  findTextareaForToolbar(toolbar) {
    // Search upwards for a container that holds the textarea closest to this toolbar
    let node = toolbar;
    while (node && node !== document.body) {
      const textarea = node.querySelector('[data-testid="tweetTextarea_0"]');
      if (textarea) return textarea;
      node = node.parentElement;
    }
    // Fallback: first textarea in document
    return document.querySelector('[data-testid="tweetTextarea_0"]');
  }

  async generate(toolbar) {
    const textEl = this.findTextareaForToolbar(toolbar || document);
    const text = textEl?.innerText?.trim();
    if (!text) {
      this.showToast('テキストを入力してください', 'error');
      return;
    }
    const btn = (toolbar || document).querySelector?.('.nanobanana-btn');
    if (btn) {
      btn.textContent = '⏳';
      btn.disabled = true;
      btn.style.opacity = '0.7';
    }
    try {
      this.showToast('インフォグラフィックを生成中...', 'info');
      const response = await this.sendGenerateRequest(text);
      if (!response.ok) throw new Error(response.error);
      const file = this.base64ToFile(response.data, response.mimeType, response.fileName);
      this.attachFile(file);
      this.showToast('添付完了！', 'success');
    } catch (e) {
      console.error(e);
      this.showToast(`エラー: ${e.message}`, 'error');
    } finally {
      if (btn) {
        btn.textContent = '🍌';
        btn.disabled = false;
        btn.style.opacity = '1';
      }
    }
  }

  sendGenerateRequest(text) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'generateInfograph', text }, (resp) => {
        resolve(resp || { ok: false, error: 'No response from background' });
      });
    });
  }

  base64ToFile(b64, mime, name) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], name, { type: mime });
  }

  attachFile(file) {
    const input = document.querySelector('input[data-testid="fileInput"]');
    if (!input) return;
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

new GeminiUI();
