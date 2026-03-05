let bulkSyncBtnOptions = null;
let overlayDiv = null;
let keepalivePort = null;
let singleExportInProgress = false;
let singleExportAborted = false;
let preExportDialog = null;

const SETTINGS_KEY = 'exportSettings';
const DEFAULT_SETTINGS = {
    format: 'markdown',
    includeThoughts: true,
    fileNaming: 'title',
};

async function loadExportSettings() {
    try {
        const result = await chrome.storage.sync.get(SETTINGS_KEY);
        return { ...DEFAULT_SETTINGS, ...(result[SETTINGS_KEY] || {}) };
    } catch (e) {
        return { ...DEFAULT_SETTINGS };
    }
}

async function saveExportSettings(settings) {
    try {
        await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
    } catch (e) {
        console.warn('Failed to save settings:', e);
    }
}

function generateFilename(title, settings) {
    const safeName = title.replace(/[/\\?%*:|"<>]/g, '-').trim() || 'Untitled';
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    switch (settings.fileNaming) {
        case 'title_date': return `${safeName}_${date}.md`;
        case 'date_title': return `${date}_${safeName}.md`;
        default: return `${safeName}.md`;
    }
}

// --- Helpers for safe messaging ---
function safeSendMessage(message, callback) {
    try {
        if (!chrome.runtime?.id) {
            throw new Error('Extension context invalidated');
        }
        chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) {
                console.warn('Message send failed:', chrome.runtime.lastError.message);
                if (callback) callback(null);
                return;
            }
            if (callback) callback(response);
        });
    } catch (e) {
        console.error('Extension context lost:', e);
        showContextInvalidatedError();
        if (callback) callback(null);
    }
}

function showContextInvalidatedError() {
    // Remove any existing error banner
    const existing = document.getElementById('ai-context-error');
    if (existing) existing.remove();

    const banner = document.createElement('div');
    banner.id = 'ai-context-error';
    banner.style.cssText = `
        position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
        background: #d93025; color: white; padding: 14px 28px;
        border-radius: 8px; z-index: 99999; font-family: "Google Sans", sans-serif;
        font-size: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        display: flex; align-items: center; gap: 12px;
    `;
    banner.innerHTML = `
        <span>⚠️ Extension was reloaded. Please <strong>refresh this page</strong> (F5) and try again.</span>
        <button onclick="this.parentElement.remove()" style="
            background: transparent; border: 1px solid white; color: white;
            padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 12px;
        ">Dismiss</button>
    `;
    document.body.appendChild(banner);
    setTimeout(() => banner.remove(), 15000);
}

// Keepalive port to prevent service worker idle shutdown during long operations
function establishKeepalive() {
    try {
        if (!chrome.runtime?.id) return;
        keepalivePort = chrome.runtime.connect({ name: 'keepalive' });
        keepalivePort.onDisconnect.addListener(() => {
            keepalivePort = null;
            // Reconnect after a short delay if the extension is still valid
            setTimeout(() => {
                if (chrome.runtime?.id) {
                    establishKeepalive();
                }
            }, 1000);
        });
    } catch (e) {
        keepalivePort = null;
    }
}

function releaseKeepalive() {
    if (keepalivePort) {
        try { keepalivePort.disconnect(); } catch (e) { /* ignore */ }
        keepalivePort = null;
    }
}

// --- Page detection ---

function isDiscussionPage() {
    const path = window.location.pathname;
    return (path.includes('/prompts/') || path.includes('/app/prompts/'))
        && !path.includes('/library');
}

function isLibraryPage() {
    return window.location.pathname.includes('/library');
}

// --- Inject CSS and setup observer ---

function initContentScript() {
    const observer = new MutationObserver((mutations) => {
        if (isLibraryPage()) {
            injectBulkSyncButton();
            removeSingleExportButton();
        } else if (isDiscussionPage()) {
            injectSingleExportButton();
            removeBulkSyncButton();
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Check immediately on load
    if (isLibraryPage()) {
        injectBulkSyncButton();
    } else if (isDiscussionPage()) {
        injectSingleExportButton();
    }

    // Also listen for SPA navigation (URL changes without full reload)
    let lastPath = window.location.pathname;
    setInterval(() => {
        const currentPath = window.location.pathname;
        if (currentPath !== lastPath) {
            lastPath = currentPath;
            if (isLibraryPage()) {
                injectBulkSyncButton();
                removeSingleExportButton();
            } else if (isDiscussionPage()) {
                injectSingleExportButton();
                removeBulkSyncButton();
            } else {
                removeBulkSyncButton();
                removeSingleExportButton();
            }
        }
    }, 500);
}

// ============================================================
// BULK SYNC BUTTON (Library page)
// ============================================================

function injectBulkSyncButton() {
    if (document.getElementById('ai-bulk-sync-btn')) return;

    const headerRow = document.querySelector('header') || document.body;

    const btn = document.createElement('button');
    btn.id = 'ai-bulk-sync-btn';
    btn.className = 'ai-studio-bulk-btn';
    btn.innerHTML = '🔄 Bulk Sync to Local Path';

    btn.addEventListener('click', handleBulkSyncClick);

    headerRow.appendChild(btn);
}

function removeBulkSyncButton() {
    const btn = document.getElementById('ai-bulk-sync-btn');
    if (btn) btn.remove();
}

function extractDiscussionsFromDOM() {
    const items = [];
    const rows = document.querySelectorAll('tr.mat-mdc-row, .mat-mdc-row');

    rows.forEach(row => {
        const linkEl = row.querySelector('a[href^="/prompts/"]');
        if (!linkEl) return;

        const href = linkEl.getAttribute('href');
        const id = href.split('/').pop();
        const title = linkEl.textContent.trim();

        const cells = row.querySelectorAll('td.mat-mdc-cell, .mat-mdc-cell');
        let timestamp = Date.now();

        if (cells.length >= 2) {
            const dateStr = cells[cells.length - 2]?.textContent.trim() || cells[cells.length - 1]?.textContent.trim();
            const parsed = Date.parse(dateStr);
            if (!isNaN(parsed)) {
                timestamp = parsed;
            } else if (dateStr) {
                timestamp = dateStr;
            }
        }

        items.push({ id, title, timestamp });
    });

    const uniqueMap = new Map();
    items.forEach(item => uniqueMap.set(item.id, item));

    return Array.from(uniqueMap.values());
}

function handleBulkSyncClick() {
    const itemsToSync = extractDiscussionsFromDOM();
    if (itemsToSync.length === 0) {
        alert("No discussions found on the page. Please ensure you are on the Library tab and discussions are visible.");
        return;
    }

    if (!chrome.runtime?.id) {
        showContextInvalidatedError();
        return;
    }

    showProgressOverlay(itemsToSync.length);

    establishKeepalive();

    safeSendMessage({ action: 'START_BULK_SYNC', items: itemsToSync }, (response) => {
        if (!response || !response.success) {
            hideProgressOverlay();
            releaseKeepalive();
            if (response && response.error) {
                alert("Bulk Sync Error: " + response.error);
            }
        }
    });
}

// ============================================================
// SINGLE EXPORT BUTTON (Discussion page)
// ============================================================

function injectSingleExportButton() {
    if (document.getElementById('ai-single-export-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'ai-single-export-btn';
    btn.className = 'ai-studio-export-btn';
    btn.innerHTML = '📥 Export Discussion';

    btn.addEventListener('click', handleSingleExportClick);

    document.body.appendChild(btn);
}

function removeSingleExportButton() {
    const btn = document.getElementById('ai-single-export-btn');
    if (btn) btn.remove();
}

// ============================================================
// PRE-EXPORT DIALOG
// ============================================================

function showPreExportDialog() {
    return new Promise(async (resolve) => {
        const settings = await loadExportSettings();

        // Remove existing dialog if any
        const existing = document.getElementById('ai-pre-export-dialog');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'ai-pre-export-dialog';
        overlay.className = 'ai-pre-export-overlay';

        overlay.innerHTML = `
            <div class="pre-export-card">
                <div class="pre-export-header">
                    <span class="pre-export-icon">📥</span>
                    <h2>Export Discussion</h2>
                </div>

                <div class="pre-export-settings">
                    <div class="pre-export-row">
                        <div class="pre-export-row-label">
                            <span>Format</span>
                        </div>
                        <div class="pre-export-row-value">
                            <select id="pre-export-format" class="pre-export-select">
                                <option value="markdown" ${settings.format === 'markdown' ? 'selected' : ''}>📄 Markdown</option>
                                <option value="zip" ${settings.format === 'zip' ? 'selected' : ''}>📦 ZIP + Attachments</option>
                            </select>
                        </div>
                    </div>

                    <div class="pre-export-row">
                        <div class="pre-export-row-label">
                            <span>Include Thoughts</span>
                            <span class="pre-export-hint">Gemini's thinking process</span>
                        </div>
                        <div class="pre-export-row-value">
                            <label class="pre-export-toggle">
                                <input type="checkbox" id="pre-export-thoughts" ${settings.includeThoughts ? 'checked' : ''}>
                                <span class="pre-export-toggle-slider"></span>
                            </label>
                        </div>
                    </div>

                    <div class="pre-export-row">
                        <div class="pre-export-row-label">
                            <span>File Name</span>
                        </div>
                        <div class="pre-export-row-value">
                            <select id="pre-export-naming" class="pre-export-select">
                                <option value="title" ${settings.fileNaming === 'title' ? 'selected' : ''}>Title.md</option>
                                <option value="title_date" ${settings.fileNaming === 'title_date' ? 'selected' : ''}>Title_Date.md</option>
                                <option value="date_title" ${settings.fileNaming === 'date_title' ? 'selected' : ''}>Date_Title.md</option>
                            </select>
                        </div>
                    </div>
                </div>

                <div class="pre-export-actions">
                    <button id="pre-export-cancel" class="pre-export-btn-cancel">Cancel</button>
                    <button id="pre-export-confirm" class="pre-export-btn-confirm">📥 Export</button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        // Wire buttons
        document.getElementById('pre-export-cancel').addEventListener('click', () => {
            overlay.remove();
            resolve(null);
        });

        document.getElementById('pre-export-confirm').addEventListener('click', async () => {
            const updatedSettings = {
                format: document.getElementById('pre-export-format').value,
                includeThoughts: document.getElementById('pre-export-thoughts').checked,
                fileNaming: document.getElementById('pre-export-naming').value,
            };
            await saveExportSettings(updatedSettings);
            overlay.remove();
            resolve(updatedSettings);
        });

        // ESC to cancel
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                document.removeEventListener('keydown', escHandler);
                overlay.remove();
                resolve(null);
            }
        };
        document.addEventListener('keydown', escHandler);
    });
}

async function handleSingleExportClick() {
    if (singleExportInProgress) return;

    const DC = window.DOMCapture;
    if (!DC) {
        alert('Export module not loaded. Please reload the page.');
        return;
    }

    // Show pre-export dialog and wait for user confirmation
    const dialogResult = await showPreExportDialog();
    if (!dialogResult) return; // User cancelled

    singleExportInProgress = true;
    singleExportAborted = false;
    const settings = dialogResult;

    // Reset capture state for a fresh export
    DC.resetState();

    showSingleExportOverlay();
    updateSingleExportStatus('Preparing to capture...');

    try {
        // 1. Find the scroller
        let scroller = DC.findRealScroller();

        if (!scroller || scroller.scrollHeight <= scroller.clientHeight) {
            // Try activating: scroll window slightly
            window.scrollBy(0, 1);
            await DC.sleep(100);
            scroller = DC.findRealScroller();
        }

        // If still no scroller, try touch activation
        if (!scroller || scroller.scrollHeight <= scroller.clientHeight) {
            const bubble = document.querySelector('ms-chat-turn');
            if (bubble) {
                bubble.scrollIntoView({ behavior: 'instant' });
                await DC.sleep(200);
                scroller = DC.findRealScroller();
            }
        }

        if (!scroller) {
            updateSingleExportStatus('❌ Could not find the chat container. Please try again.');
            await DC.sleep(3000);
            hideSingleExportOverlay();
            singleExportInProgress = false;
            return;
        }

        updateSingleExportStatus('Scrolling to the top...');

        // 2. Use scrollbar buttons to jump to first conversation (fast path)
        const scrollbarButtons = document.querySelectorAll('button[id^="scrollbar-item-"]');
        if (scrollbarButtons.length > 0) {
            scrollbarButtons[0].click();
            await DC.sleep(1500);
        }

        // Fallback: manually scroll up if not near top
        if (scroller.scrollTop > 500) {
            let currentPos = scroller.scrollTop;
            let upwardAttempts = 0;
            const maxUpwardAttempts = 15;

            while (currentPos > 100 && upwardAttempts < maxUpwardAttempts) {
                upwardAttempts++;
                const scrollAmount = Math.min(window.innerHeight, currentPos);
                scroller.scrollBy({ top: -scrollAmount, behavior: 'smooth' });
                await DC.sleep(500);

                const newPos = scroller.scrollTop;
                if (Math.abs(newPos - currentPos) < 10) {
                    scroller.scrollTop = Math.max(0, currentPos - scrollAmount);
                    await DC.sleep(300);
                }

                currentPos = scroller.scrollTop;
                if (currentPos < 100) break;
            }
        }

        // Final scroll to top
        scroller.scrollTop = 0;
        await DC.sleep(500);
        if (scroller.scrollTop > 10) {
            scroller.scrollTo({ top: 0, behavior: 'instant' });
            await DC.sleep(500);
        }

        // Wait for DOM to stabilize
        await DC.sleep(800);

        // Register ESC handler for mid-export abort
        const exportEscHandler = (e) => {
            if (e.key === 'Escape') {
                singleExportAborted = true;
                updateSingleExportStatus('⏹️ Stopping... saving captured content.');
            }
        };
        document.addEventListener('keydown', exportEscHandler);

        // 3. Scroll-and-capture loop
        updateSingleExportStatus('Capturing conversation... (press ESC to stop)');

        let lastScrollTop = -9999;
        let stuckCount = 0;

        while (true) {
            if (singleExportAborted) break;

            DC.captureData(scroller);
            updateSingleExportStatus(`Capturing... (${DC.getCollectedCount()} turns found) — press ESC to stop`);

            scroller.scrollBy({ top: window.innerHeight * 0.7, behavior: 'smooth' });
            await DC.sleep(900);

            const currentScroll = scroller.scrollTop;
            if (Math.abs(currentScroll - lastScrollTop) <= 2) {
                stuckCount++;
                if (stuckCount >= 3) break;
            } else {
                stuckCount = 0;
            }
            lastScrollTop = currentScroll;
        }

        document.removeEventListener('keydown', exportEscHandler);

        // 4. Normalize
        DC.normalizeConversation();

        // 5. Generate Markdown
        const title = extractDiscussionTitle();
        const abortLabel = singleExportAborted ? ' (partial)' : '';
        updateSingleExportStatus(`Generating export for "${title}"${abortLabel}...`);

        const markdown = DC.generateMarkdownExport(title, settings);

        // 6. Download — format-aware
        if (settings.format === 'zip' && window.AttachmentHandler) {
            // ZIP mode: collect attachment URLs, download, and package
            updateSingleExportStatus('Preparing ZIP with attachments...');

            // Collect all attachment URLs from captured data
            const allAttachments = [];
            for (const [, item] of DC.getCollectedData()) {
                if (Array.isArray(item.attachments)) {
                    allAttachments.push(...item.attachments);
                }
            }
            const uniqueAttachments = [...new Set(allAttachments)];

            const safeName = title.replace(/[/\\?%*:|"<>]/g, '-').trim() || 'Untitled';
            const zipBlob = await window.AttachmentHandler.packageAsZip(
                markdown,
                uniqueAttachments,
                `${safeName}.md`,
                (msg) => updateSingleExportStatus(msg)
            );

            const zipUrl = URL.createObjectURL(zipBlob);
            const zipFilename = generateFilename(title, settings).replace(/\.md$/, '.zip');
            const link = document.createElement('a');
            link.href = zipUrl;
            link.download = zipFilename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(zipUrl);

            updateSingleExportStatus(`✅ Exported ${DC.getTurnCount()} turns + ${uniqueAttachments.length} attachment(s) to "${zipFilename}"`);
        } else {
            // Markdown-only mode
            const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const filename = generateFilename(title, settings);

            const link = document.createElement('a');
            link.href = url;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);

            updateSingleExportStatus(`✅ Exported ${DC.getTurnCount()} turns to "${filename}"`);
        }
        await DC.sleep(3000);

    } catch (err) {
        console.error('Single export error:', err);
        updateSingleExportStatus(`❌ Export failed: ${err.message}`);
        await DC.sleep(5000);
    } finally {
        hideSingleExportOverlay();
        singleExportInProgress = false;
    }
}

function extractDiscussionTitle() {
    // Try the page title first (usually "Discussion Name - Google AI Studio")
    const pageTitle = document.title.replace(' - Google AI Studio', '').trim();
    if (pageTitle && pageTitle !== 'Google AI Studio') {
        return pageTitle;
    }

    // Fallback: look for a title in the discussion header
    const headerEl = document.querySelector('.prompt-title, [data-test-id="prompt-title"], h1');
    if (headerEl) {
        return headerEl.textContent.trim();
    }

    // Last resort
    const promptId = window.location.pathname.split('/').pop();
    return `Discussion_${promptId}`;
}

// ============================================================
// SINGLE EXPORT OVERLAY
// ============================================================

let singleExportOverlay = null;

function showSingleExportOverlay() {
    if (!singleExportOverlay) {
        singleExportOverlay = document.createElement('div');
        singleExportOverlay.id = 'ai-single-export-overlay';
        singleExportOverlay.className = 'ai-export-overlay';

        singleExportOverlay.innerHTML = `
            <div class="export-card">
                <div class="export-card-icon">📥</div>
                <h2>Exporting Discussion</h2>
                <div class="export-progress-indicator">
                    <div class="export-spinner"></div>
                </div>
                <p id="single-export-status">Preparing...</p>
            </div>
        `;
        document.body.appendChild(singleExportOverlay);
    }
    singleExportOverlay.style.display = 'flex';
}

function hideSingleExportOverlay() {
    if (singleExportOverlay) {
        singleExportOverlay.style.display = 'none';
    }
}

function updateSingleExportStatus(message) {
    const statusEl = document.getElementById('single-export-status');
    if (statusEl) statusEl.textContent = message;
}

// ============================================================
// BULK SYNC OVERLAY
// ============================================================

function showProgressOverlay(total) {
    if (!overlayDiv) {
        overlayDiv = document.createElement('div');
        overlayDiv.id = 'ai-bulk-sync-overlay';

        overlayDiv.innerHTML = `
            <div class="sync-card">
                <h2>Bulk Syncing...</h2>
                <div class="progress-bar-container">
                    <div id="sync-progress-bar" style="width: 0%"></div>
                </div>
                <p id="sync-status-text">Starting sync for ${total} items...</p>
                <div class="stats">
                    <span id="sync-downloaded">0</span> Downloaded | 
                    <span id="sync-skipped">0</span> Skipped | 
                    <span id="sync-errors-count">0</span> Errors
                </div>
                <button id="sync-abort-btn">Abort (ESC)</button>
            </div>
        `;
        document.body.appendChild(overlayDiv);

        document.getElementById('sync-abort-btn').addEventListener('click', abortSync);

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && overlayDiv.style.display !== 'none') {
                abortSync();
            }
        });
    }
    overlayDiv.style.display = 'flex';
}

function hideProgressOverlay() {
    if (overlayDiv) {
        setTimeout(() => {
            overlayDiv.style.display = 'none';
        }, 3000);
    }
}

function updateProgressUI(payload) {
    if (!overlayDiv) return;

    const { state, processed, total, message, downloaded, skipped, errors } = payload;

    const statusText = document.getElementById('sync-status-text');
    const progressBar = document.getElementById('sync-progress-bar');

    statusText.textContent = message;

    if (state === 'PROGRESS' && processed && total) {
        const percent = (processed / total) * 100;
        progressBar.style.width = `${percent}%`;
    } else if (state === 'FINISHED') {
        progressBar.style.width = '100%';
        progressBar.style.backgroundColor = '#188038';
        document.getElementById('sync-downloaded').textContent = downloaded;
        document.getElementById('sync-skipped').textContent = skipped;
        document.getElementById('sync-errors-count').textContent = errors;
        releaseKeepalive();
        hideProgressOverlay();
    } else if (state === 'ERROR' || state === 'ABORTED') {
        progressBar.style.backgroundColor = '#c5221f';
        releaseKeepalive();
        setTimeout(() => { overlayDiv.style.display = 'none'; }, 5000);
    }
}

function abortSync() {
    safeSendMessage({ action: 'ABORT_SYNC' }, () => {
        const statusText = document.getElementById('sync-status-text');
        if (statusText) statusText.textContent = 'Aborting...';
        releaseKeepalive();
    });
}

// Listen for updates from Service Worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'SYNC_UPDATE') {
        updateProgressUI(message.payload);
        sendResponse({ received: true });
    }
});

// Run
initContentScript();
