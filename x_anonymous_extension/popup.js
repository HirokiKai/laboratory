// --- REPLICATED GENERATOR LOGIC ---
function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash = hash & hash;
    }
    return Math.abs(hash);
}

// --- SMART GENERATOR ---
const ADJECTIVES = ['眠そうな', '踊る', '勇気ある', '静かな', '謎の', '光る', '幸せな', '高速の', '歌う', '空飛ぶ', '派手な', '小さな', '賢い', '腹ペコの', '最強の'];
const ANIMALS = ['パンダ', '猫', 'サボテン', 'ライオン', 'ペンギン', '幽霊', 'ロボット', 'トマト', 'ウサギ', 'ドラゴン', 'キリン', 'ゴリラ', '魔法使い', '忍者', '侍'];

function getRandomIdentity(username) {
    const hash = simpleHash(username);
    const avatarUrl = `https://api.dicebear.com/7.x/pixel-art/svg?seed=${username}`;

    // Smart Name
    const adjIndex = hash % ADJECTIVES.length;
    const animalIndex = (hash >> 4) % ANIMALS.length; // Shift
    const displayName = `${ADJECTIVES[adjIndex]}${ANIMALS[animalIndex]}`;

    return { avatarUrl, displayName };
}

function renderRanking() {
    chrome.storage.local.get(['interactionStats'], (result) => {
        const stats = result.interactionStats || {};
        const container = document.getElementById('rankingList');

        // Convert to array and sort
        // Weight: Like=1, Reply=2, RT=2, Bookmark=1 ? Or just total interactions.
        // Let's use simple Sum for now.
        const list = Object.keys(stats).map(handle => {
            const s = stats[handle];
            const total = (s.like || 0) + (s.rt || 0) + (s.reply || 0) + (s.bookmark || 0);
            return { handle, stats: s, total };
        }).filter(item => item.total > 0)
            .sort((a, b) => b.total - a.total)
            .slice(0, 10);

        if (list.length === 0) {
            container.innerHTML = '<div style="text-align: center; color: #999; font-size: 11px;">データがありません</div>';
            return;
        }

        container.innerHTML = '';
        list.forEach(item => {
            const { avatarUrl, displayName } = getRandomIdentity(item.handle);

            // Build stats string
            let parts = [];
            if (item.stats.like) parts.push(`♥${item.stats.like}`);
            if (item.stats.rt) parts.push(`RP${item.stats.rt}`);
            if (item.stats.reply) parts.push(`↩${item.stats.reply}`);
            if (item.stats.bookmark) parts.push(`🔖${item.stats.bookmark}`);

            const a = document.createElement('a');
            a.className = 'rank-item';
            a.href = `https://x.com/${item.handle}`;
            a.target = '_blank';
            a.style.textDecoration = 'none';
            a.style.color = 'inherit';
            a.style.display = 'flex'; // Restore flex display for <a>

            a.innerHTML = `
                <img src="${avatarUrl}" class="rank-avatar">
                <div class="rank-info">
                    <div class="rank-name">${displayName}</div>
                    <div class="rank-stats">${parts.join(' ')}</div>
                </div>
            `;
            container.appendChild(a);
        });
    });
}

document.addEventListener('DOMContentLoaded', () => {
    // Render Ranking immediately
    renderRanking();

    // Load saved settings
    chrome.storage.sync.get(['mode'], (result) => {
        const mode = result.mode || 'blur'; // Default to blur
        const radio = document.getElementById(mode);
        if (radio) radio.checked = true;
    });

    // Save settings on change
    document.querySelectorAll('input[name="mode"]').forEach((radio) => {
        radio.addEventListener('change', (e) => {
            const mode = e.target.value;
            chrome.storage.sync.set({ mode: mode }, () => {
                // Send message to active tab to update immediately
                chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                    if (tabs[0]) {
                        chrome.tabs.sendMessage(tabs[0].id, { type: 'MODE_UPDATE', mode: mode }, (response) => {
                            if (chrome.runtime.lastError) {
                                // Ignore error if tab is not ready or unsupported
                                console.log('Communication error (expected on system pages):', chrome.runtime.lastError.message);
                            }
                        });
                    }
                });
            });
        });
    });

    // Reset Button
    const resetBtn = document.getElementById('resetBtn');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            if (confirm('本当にすべての計測データを削除しますか？')) {
                chrome.storage.local.remove('interactionStats', () => {
                    renderRanking(); // Refresh UI
                    // Notify tabs
                    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                        if (tabs[0]) {
                            chrome.tabs.sendMessage(tabs[0].id, { type: 'STATS_RESET' }, (response) => {
                                if (chrome.runtime.lastError) {
                                    // Suppress "Receiving end does not exist"
                                }
                            });
                        }
                    });
                    alert('削除しました');
                });
            }
        });
    }
});
