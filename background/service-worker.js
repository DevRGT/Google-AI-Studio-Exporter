import { getDirectoryHandle } from '../utils/idb-storage.js';
import { needsExport, markAsExported } from '../utils/bulk-export-registry.js';
import { parseApiPayloadToMarkdown, extractJsonFromHtml } from '../utils/markdown-parser.js';

let isSyncInProgress = false;
let abortController = null;

// ⚙️ DEBUG FLAG — Set to true to add iteration markers in exported markdown
const DEBUG_SCRAPE = true;

// Badge configuration
const BADGE_COLOR = '#1a73e8';
function setBadge(text) {
    chrome.action.setBadgeText({ text: String(text || '') });
    chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
}
function clearBadge() {
    chrome.action.setBadgeText({ text: '' });
}

// Keepalive: content script connects a port to prevent idle shutdown during sync
chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'keepalive') {
        // Simply holding the port reference keeps the service worker alive.
        // The port automatically disconnects when the content script disconnects.
        port.onDisconnect.addListener(() => {
            // Cleanup if needed — no-op for keepalive
        });
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'START_BULK_SYNC') {
        if (isSyncInProgress) {
            sendResponse({ success: false, error: 'Sync already in progress.' });
            return true;
        }
        startBulkSync(message.items, sender.tab.id);
        sendResponse({ success: true });
    } else if (message.action === 'ABORT_SYNC') {
        if (abortController) {
            abortController.abort();
            // Send immediate UI feedback
            chrome.runtime.sendMessage({
                action: 'SYNC_UPDATE',
                payload: {
                    state: 'ABORTED',
                    message: 'Sync cancelled by user.',
                    logEntry: '\n⏹️ Aborted by user.',
                    logType: 'error'
                }
            }).catch(() => { });
        }
        sendResponse({ success: true });
    }
    return true; // Keep channel open for async
});

const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    if (signal) {
        signal.addEventListener('abort', () => {
            clearTimeout(timeout);
            reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
    }
});

async function startBulkSync(items, tabId) {
    isSyncInProgress = true;
    abortController = new AbortController();
    setBadge('...');

    // Load settings
    let settings = {};
    try {
        const result = await chrome.storage.sync.get('exportSettings');
        settings = result.exportSettings || {};
    } catch (_) { }

    const sendUpdate = (status) => {
        chrome.tabs.sendMessage(tabId, { action: 'SYNC_UPDATE', payload: status }).catch(() => { });
    };

    try {
        // 1. Get Directory Handle
        const handle = await getDirectoryHandle('export_directory');
        if (!handle) {
            throw new Error("No export folder configured. Please click the extension icon and configure Options.");
        }

        // 2. Verify permission
        const permission = await handle.queryPermission({ mode: 'readwrite' });
        if (permission !== 'granted') {
            throw new Error("Folder access permission is currently 'prompt' or 'denied'. \n\nIMPORTANT: Please open the Extension Options page in a FULL TAB, click 'Authorize', and KEEP THE TAB OPEN while syncing.");
        }

        let total = items.length;
        let processed = 0;
        let skipped = 0;
        let downloaded = 0;
        let errors = 0;

        for (const item of items) {
            if (abortController?.signal?.aborted) {
                sendUpdate({ state: 'ABORTED', message: 'Sync cancelled by user.', processed, total, downloaded, skipped, errors });
                break;
            }

            processed++;
            const { id, title, timestamp } = item;

            const sendProgress = (msg, logEntry, logType) => {
                sendUpdate({ state: 'PROGRESS', processed, total, message: msg, downloaded, skipped, errors, logEntry, logType });
                setBadge(`${processed}`);
            };

            // 3. Check differential registry
            const shouldExport = await needsExport(id, timestamp);
            if (!shouldExport) {
                skipped++;
                sendProgress(`Skipped (no changes): ${title}`, `⏭️ Skipped: ${title} (No changes since last export)`, 'skip');
                continue;
            }

            sendProgress(`Fetching: ${title}`, `\n📥 Fetching: ${title}`, 'info');

            // 4. Fetch the data via content script in a dedicated window
            try {
                // Determine sleep time (polite 3s - 5s)
                const delayMs = Math.floor(Math.random() * 2000) + 3000;
                sendProgress(`Sleeping for ${(delayMs / 1000).toFixed(1)}s before fetching ${title}...`);
                await sleep(delayMs, abortController.signal);

                if (abortController?.signal?.aborted) throw new DOMException("Aborted", "AbortError");

                const url = `https://aistudio.google.com/app/prompts/${id}`;

                // --- DEDICATED WINDOW ---
                // Open each discussion in its own browser window.
                // Same profile/auth, but fully isolated from user's browsing.
                // MUST be focused:true — Chrome won't hydrate the SPA or allow
                // scrolling in an unfocused window.
                const exportWindow = await chrome.windows.create({
                    url,
                    focused: true,
                    type: 'normal'
                });
                const scrapeTabId = exportWindow.tabs[0].id;

                let mdContent = '';
                let isIncomplete = false;
                try {
                    // Wait for the page to load
                    await new Promise((resolve, reject) => {
                        const onAbort = () => {
                            chrome.tabs.onUpdated.removeListener(listener);
                            clearTimeout(timeoutId);
                            reject(new DOMException("Aborted", "AbortError"));
                        };
                        abortController?.signal.addEventListener('abort', onAbort, { once: true });

                        let timeoutId = setTimeout(() => {
                            abortController?.signal.removeEventListener('abort', onAbort);
                            chrome.tabs.onUpdated.removeListener(listener);
                            reject(new Error("Timeout waiting for page to load"));
                        }, 30000);

                        function listener(updatedTabId, info) {
                            if (updatedTabId === scrapeTabId && info.status === 'complete') {
                                abortController?.signal.removeEventListener('abort', onAbort);
                                clearTimeout(timeoutId);
                                chrome.tabs.onUpdated.removeListener(listener);
                                resolve();
                            }
                        }
                        chrome.tabs.onUpdated.addListener(listener);
                    });

                    if (abortController?.signal?.aborted) throw new DOMException("Aborted", "AbortError");

                    // Ensure window is fully focused and normal before scraping.
                    // Retry up to 3 times — Chrome may not honor focus immediately.
                    for (let focusTry = 0; focusTry < 3; focusTry++) {
                        await chrome.windows.update(exportWindow.id, { state: 'normal', focused: true });
                        await chrome.tabs.update(scrapeTabId, { active: true });
                        await sleep(500, abortController.signal);
                    }

                    // --- ANTI-THROTTLE INJECTION ---
                    // 2. Fake visibility in the PAGE's JS context (Angular anti-throttle)
                    await chrome.scripting.executeScript({
                        target: { tabId: scrapeTabId },
                        world: 'MAIN',
                        func: () => {
                            Object.defineProperty(document, 'visibilityState', {
                                get: () => 'visible',
                                configurable: true
                            });
                            Object.defineProperty(document, 'hidden', {
                                get: () => false,
                                configurable: true
                            });
                            document.addEventListener('visibilitychange', (e) => {
                                e.stopImmediatePropagation();
                            }, true);
                        }
                    });

                    // Wait for SPA hydration after focus + visibility override
                    await sleep(2500, abortController.signal);

                    // --- FOCUS GUARD ---
                    // Only monitors if the active TAB within the export window changes.
                    // Switching to another app or another Chrome window is fine —
                    // Chrome doesn't fully throttle windows that lose focus.
                    // We only care about someone opening a new tab
                    // WITHIN the export window.
                    let focusLost = false;
                    const focusGuard = (activeInfo) => {
                        if (activeInfo.windowId === exportWindow.id && activeInfo.tabId !== scrapeTabId) {
                            focusLost = true;
                        }
                    };
                    chrome.tabs.onActivated.addListener(focusGuard);

                    sendProgress(`Scraping: ${title}`, `\n🔍 Scraping DOM for: ${title}`, 'info');

                    // Ask content.js to scrape it
                    const scrapeResult = await new Promise((resolve, reject) => {
                        const onAbort = () => {
                            reject(new DOMException("Aborted", "AbortError"));
                        };
                        abortController?.signal.addEventListener('abort', onAbort, { once: true });

                        setTimeout(() => {
                            if (abortController?.signal?.aborted) {
                                abortController?.signal.removeEventListener('abort', onAbort);
                                return reject(new DOMException("Aborted", "AbortError"));
                            }
                            chrome.tabs.sendMessage(scrapeTabId, {
                                action: 'SCRAPE_CURRENT_PAGE',
                                title,
                                settings,
                                bulkMode: true,
                                debugMode: DEBUG_SCRAPE
                            }, (response) => {
                                abortController?.signal.removeEventListener('abort', onAbort);
                                if (chrome.runtime.lastError) {
                                    reject(new Error(chrome.runtime.lastError.message));
                                } else if (response && response.error) {
                                    reject(new Error(response.error));
                                } else if (response) {
                                    resolve(response);
                                } else {
                                    reject(new Error("Unknown error from scraping script"));
                                }
                            });
                        }, 1500);
                    });

                    // Remove focus guard listener
                    chrome.tabs.onActivated.removeListener(focusGuard);

                    mdContent = scrapeResult.content || '';
                    // Check if content script flagged as incomplete OR our focus guard triggered
                    isIncomplete = !!(scrapeResult.incomplete || focusLost);

                } finally {
                    // Always close the dedicated export window
                    await chrome.windows.remove(exportWindow.id).catch(() => { });
                }

                if (abortController?.signal?.aborted) throw new DOMException("Aborted", "AbortError");

                // 5. Write to File System
                const safeTitle = title.replace(/[/\\?%*:|"<>]/g, '-').trim() || `Untitled_${id}`;

                if (isIncomplete) {
                    // Save as _INCOMPLETE — do NOT mark as exported (will retry next time)
                    const incompleteFilename = `${safeTitle}_INCOMPLETE.md`;
                    const fileHandle = await handle.getFileHandle(incompleteFilename, { create: true });
                    const writable = await fileHandle.createWritable();
                    await writable.write(mdContent);
                    await writable.close();

                    errors++;
                    const capturedInfo = scrapeResult.turnCount !== undefined
                        ? ` (captured ${scrapeResult.turnCount} of ~${scrapeResult.domTurnCount || '?'} turns)`
                        : '';
                    sendProgress(
                        `Incomplete: ${title}`,
                        `⚠️ Incomplete: ${title}${capturedInfo}. Saved as ${incompleteFilename} (will retry next time)`,
                        'error'
                    );
                } else {
                    // Full success — save clean file
                    const filename = `${safeTitle}.md`;
                    const fileHandle = await handle.getFileHandle(filename, { create: true });
                    const writable = await fileHandle.createWritable();
                    await writable.write(mdContent);
                    await writable.close();

                    // Delete stale _INCOMPLETE file if it exists from a previous failed attempt
                    try {
                        await handle.removeEntry(`${safeTitle}_INCOMPLETE.md`);
                    } catch (_) { /* file doesn't exist — that's fine */ }

                    // Mark as exported in registry
                    await markAsExported(id, timestamp);
                    downloaded++;
                    sendProgress(`Downloaded: ${title}`, `✅ Success: Saved as ${filename}`, 'success');
                }

            } catch (e) {
                if (e.name === 'AbortError') {
                    console.log(`Fetch aborted for ${title}`);
                    continue;
                }
                console.error(`Failed to export ${id}:`, e);
                errors++;
                sendProgress(`Error on ${title}: ${e.message}`, `❌ Error: Failed to export ${title} - ${e.message}`, 'error');
            }
        }

        if (abortController?.signal?.aborted) {
            sendUpdate({
                state: 'ABORTED',
                processed, total, downloaded, skipped, errors,
                message: 'Sync cancelled by user.',
                logEntry: `\n⏹️ Sync Aborted! Summary: ${downloaded} Downloaded, ${skipped} Skipped, ${errors} Errors.`,
                logType: 'error'
            });
        } else {
            sendUpdate({
                state: 'FINISHED',
                processed, total, downloaded, skipped, errors,
                message: `Sync complete! Downloaded: ${downloaded}, Skipped: ${skipped}, Errors: ${errors}`,
                logEntry: `\n🎉 Sync Finished! Summary: ${downloaded} Downloaded, ${skipped} Skipped, ${errors} Errors.`,
                logType: 'success'
            });
        }

    } catch (err) {
        console.warn("Bulk sync stopped: ", err.message);
        sendUpdate({ state: 'ERROR', message: err.message });
    } finally {
        isSyncInProgress = false;
        abortController = null;
        clearBadge();
    }
}
