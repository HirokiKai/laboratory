let currentMode = 'off';
let observer = null;
let intervalId = null;
let interactionStats = {}; // Cache for stats: { 'username': { like: 0, rt: 0, reply: 0 } }

// --- SMART GENERATOR ---
const ADJECTIVES = ['眠そうな', '踊る', '勇気ある', '静かな', '謎の', '光る', '幸せな', '高速の', '歌う', '空飛ぶ', '派手な', '小さな', '賢い', '腹ペコの', '最強の'];
const ANIMALS = ['パンダ', '猫', 'サボテン', 'ライオン', 'ペンギン', '幽霊', 'ロボット', 'トマト', 'ウサギ', 'ドラゴン', 'キリン', 'ゴリラ', '魔法使い', '忍者', '侍'];

// --- UTILS ---
function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash = hash & hash;
    }
    return Math.abs(hash);
}

function getRandomIdentity(username) {
    const hash = simpleHash(username);

    // Avatar
    const avatarUrl = `https://api.dicebear.com/7.x/pixel-art/svg?seed=${username}`;

    // Smart Name
    const adjIndex = hash % ADJECTIVES.length;
    const animalIndex = (hash >> 4) % ANIMALS.length; // Shift to get different bit
    const displayName = `${ADJECTIVES[adjIndex]}${ANIMALS[animalIndex]}`;

    return { avatarUrl, displayName };
}

function getStatsString(username) {
    const stats = interactionStats[username];
    if (!stats) return '';

    let parts = [];
    if (stats.like > 0) parts.push(`♥${stats.like}`);
    if (stats.rt > 0) parts.push(`RP${stats.rt}`);
    if (stats.reply > 0) parts.push(`↩${stats.reply}`);
    if (stats.bookmark > 0) parts.push(`🔖${stats.bookmark}`);

    if (parts.length === 0) return '';
    return ' ' + parts.join(' ');
}

// --- CORE FUNCTIONS ---

function applyMode(mode) {
    currentMode = mode;
    document.body.classList.remove('xa-blur-mode', 'xa-random-mode');

    if (observer) { observer.disconnect(); observer = null; }
    if (intervalId) { clearInterval(intervalId); intervalId = null; }

    restoreOriginalContent(); // Always clean up first

    if (mode === 'blur') {
        document.body.classList.add('xa-blur-mode');
    } else if (mode === 'random') {
        document.body.classList.add('xa-random-mode');

        // Use Interval + MutationObserver for maximum robustness against React
        runRandomReplacement();

        observer = new MutationObserver(() => {
            runRandomReplacement();
        });
        observer.observe(document.body, { childList: true, subtree: true });

        // Periodic check to catch re-renders that MutationObserver might miss or be slow on
        intervalId = setInterval(runRandomReplacement, 1000);
    }
}

function runRandomReplacement() {
    if (currentMode !== 'random') return;

    // --- 1. AVATARS ---
    const avatars = document.querySelectorAll('[data-testid="Tweet-User-Avatar"] img, [data-testid="User-Avatar-Container-Unknown"] img');
    avatars.forEach(img => {
        if (img.classList.contains('xa-swapped-img')) return;

        // Find Username
        const link = img.closest('a');
        const username = link ? link.getAttribute('href') : null;

        if (username) {
            const cleanUser = username.replace('/', '');
            const { avatarUrl } = getRandomIdentity(cleanUser);

            if (img.src !== avatarUrl && !img.src.includes('dicebear.com')) {
                img.dataset.xaOriginalSrc = img.src;
                if (img.srcset) img.dataset.xaOriginalSrcset = img.srcset;

                img.src = avatarUrl;
                img.removeAttribute('srcset');
                img.classList.add('xa-swapped-img');
            }
        }
    });

    // --- 2. NAMES ---
    const nameContainers = document.querySelectorAll('[data-testid="User-Name"]');
    nameContainers.forEach(container => {
        const handleLink = container.querySelector('a[href^="/"]');
        const handle = handleLink ? handleLink.getAttribute('href').replace('/', '') : null;

        if (handle) {
            const { displayName } = getRandomIdentity(handle);
            const statsStr = getStatsString(handle);
            const fullDisplayName = displayName + statsStr;

            // Target Display Name Parent to avoid duplicates
            // We want to hide ALL original text nodes and spans that make up the name, and replace them with ONE pseudo element

            // Strategy: Find the parent that actually holds the name parts. 
            // The structure is usually: User-Name -> div -> div -> a -> div -> div -> span (Name) + span (Verified)
            // Or roughly that.

            // We want to target the element that contains the visual name.
            // Let's find the span that acts as the "name" part (no @, no dot).
            const spans = Array.from(container.querySelectorAll('span'));
            const namePartSpan = spans.find(span => {
                const text = span.innerText;
                return text && !text.includes('@') && text !== '·' && !span.closest('time');
            });

            if (namePartSpan) {
                // We target the DIRECT PARENT of the name text to be the replacement container
                // This usually holds the name + emoji parts.
                const nameParent = namePartSpan.parentElement;

                // Safety check: Don't accidentally target the handle container if logic failed
                if (nameParent && !nameParent.innerText.includes('@')) {
                    if (nameParent.getAttribute('data-xa-fake-name') !== fullDisplayName) {
                        nameParent.setAttribute('data-xa-fake-name', fullDisplayName);
                        nameParent.classList.add('xa-name-replaced'); // Add class for CSS targeting
                    }
                }
            }
        }
    });
}

function restoreOriginalContent() {
    // Restore Images
    const avatars = document.querySelectorAll('img.xa-swapped-img');
    avatars.forEach(img => {
        if (img.dataset.xaOriginalSrc) {
            img.src = img.dataset.xaOriginalSrc;
            if (img.dataset.xaOriginalSrcset) {
                img.setAttribute('srcset', img.dataset.xaOriginalSrcset);
            }
        }
        img.classList.remove('xa-swapped-img');
    });

    // Restore Text
    const fakeSpans = document.querySelectorAll('[data-xa-fake-name]');
    fakeSpans.forEach(span => {
        span.removeAttribute('data-xa-fake-name');
        span.classList.remove('xa-name-replaced');
    });
}

// --- INTERACTION TRACKING ---

// State to track pending actions
let pendingAction = {
    type: null, // 'reply' | 'rt' | 'quote'
    handle: null
};

function updateStats(handle, type, delta = 1) {
    if (!interactionStats[handle]) {
        interactionStats[handle] = { like: 0, rt: 0, reply: 0, bookmark: 0 };
    }

    const current = interactionStats[handle][type] || 0;
    let next = current + delta;
    if (next < 0) next = 0;

    interactionStats[handle][type] = next;

    // Save
    chrome.storage.local.set({ interactionStats: interactionStats }, () => {
        runRandomReplacement();
    });
}

function getHandleFromTarget(target) {
    const article = target.closest('article');
    if (!article) return null;

    const userNameNode = article.querySelector('[data-testid="User-Name"]');
    if (!userNameNode) return null;

    const link = userNameNode.querySelector('a[href^="/"]');
    if (!link) return null;

    return link.getAttribute('href').replace('/', '');
}

document.addEventListener('click', (e) => {
    // Track in both Random and Blur modes (as long as extension is active/on)
    if (currentMode === 'off') return;

    const target = e.target;

    // 1. LIKE / UNLIKE
    const likeBtn = target.closest('[data-testid="like"]');
    const unlikeBtn = target.closest('[data-testid="unlike"]');
    if (likeBtn || unlikeBtn) {
        const handle = getHandleFromTarget(likeBtn || unlikeBtn);
        if (handle) {
            const btn = likeBtn || unlikeBtn;
            const label = btn.getAttribute('aria-label') || '';
            const isUnlike = /unlike|取り消す/i.test(label) || btn.getAttribute('data-testid') === 'unlike';
            updateStats(handle, 'like', isUnlike ? -1 : 1);
        }
        return;
    }

    // 2. BOOKMARK
    const bookmarkBtn = target.closest('[data-testid="bookmark"]');
    const removeBookmarkBtn = target.closest('[data-testid="removeBookmark"]');
    if (bookmarkBtn || removeBookmarkBtn) {
        const handle = getHandleFromTarget(bookmarkBtn || removeBookmarkBtn);
        if (handle) {
            updateStats(handle, 'bookmark', removeBookmarkBtn ? -1 : 1);
        }
        return;
    }

    // 3. PENDING ACTIONS: REPLY & RETWEET (Clicking the initial icon)
    const rtBtn = target.closest('[data-testid="retweet"]');
    const replyBtn = target.closest('[data-testid="reply"]');

    if (rtBtn) {
        const handle = getHandleFromTarget(rtBtn);
        if (handle) pendingAction = { type: 'rt', handle: handle }; // Wait for Confirm or Quote
        // Don't return, as rtBtn might also be a direct action in some contexts? Usually not.
        return;
    }

    if (replyBtn) {
        const handle = getHandleFromTarget(replyBtn);
        if (handle) pendingAction = { type: 'reply', handle: handle };
        return;
    }

    // 4. CONFIRM ACTIONS

    // A. Retweet Confirm (Menu -> Retweet)
    const rtConfirmBtn = target.closest('[data-testid="retweetConfirm"]');
    if (rtConfirmBtn && pendingAction.type === 'rt' && pendingAction.handle) {
        updateStats(pendingAction.handle, 'rt', 1);
        pendingAction = { type: null, handle: null }; // Reset
        return;
    }

    // B. Quote Retweet (Menu -> Quote)
    // Refined strategy: If we click the Quote menu item, we extend the pending state.
    const menuItem = target.closest('[role="menuitem"]');
    if (menuItem && pendingAction.type === 'rt') {
        const text = menuItem.innerText;
        if (text.includes('引用') || text.includes('Quote')) {
            pendingAction.type = 'quote'; // Now waiting for Tweet Button
            return;
        }
    }

    // C. Undo Retweet
    // Case 1: Direct Undo (on timeline)
    const unretweetBtn = target.closest('[data-testid="unretweet"]');
    if (unretweetBtn) {
        const handle = getHandleFromTarget(unretweetBtn);
        if (handle) updateStats(handle, 'rt', -1);
        return;
    }
    // Case 2: Menu Undo ([data-testid="unretweetConfirm"])
    const unretweetConfirmBtn = target.closest('[data-testid="unretweetConfirm"]');
    if (unretweetConfirmBtn && pendingAction.handle) {
        // We might have handle from pendingAction if user clicked "Retweet" (green) then "Undo Retweet"
        updateStats(pendingAction.handle, 'rt', -1);
        pendingAction = { type: null, handle: null };
        return;
    }


    // D. Final Send (Tweet Button) -> For Reply OR Quote
    const tweetBtn = target.closest('[data-testid="tweetButton"]');
    if (tweetBtn && pendingAction.handle) {
        if (pendingAction.type === 'reply') {
            updateStats(pendingAction.handle, 'reply', 1);
        } else if (pendingAction.type === 'quote') {
            updateStats(pendingAction.handle, 'rt', 1); // Connect Quote to RT count
        }
        pendingAction = { type: null, handle: null };
        return;
    }
}, true);


// --- EVENT LISTENERS ---

chrome.runtime.onMessage.addListener((request) => {
    if (request.type === 'MODE_UPDATE') {
        applyMode(request.mode);
    } else if (request.type === 'STATS_RESET') {
        interactionStats = {};
        runRandomReplacement();
    }
});

// Load Settings & Stats
chrome.storage.sync.get(['mode'], (result) => {
    // Load stats from local storage (larger capacity)
    chrome.storage.local.get(['interactionStats'], (statsResult) => {
        if (statsResult.interactionStats) {
            interactionStats = statsResult.interactionStats;
        }
        applyMode(result.mode || 'blur');
    });
});

// Listen for stats changes (if multiple tabs open)
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.interactionStats) {
        interactionStats = changes.interactionStats.newValue || {};
        runRandomReplacement();
    }
});
