import { getDirectoryHandle } from '../utils/idb-storage.js';
import { needsExport, markAsExported } from '../utils/bulk-export-registry.js';
import { parseApiPayloadToMarkdown, extractJsonFromHtml } from '../utils/markdown-parser.js';

let isSyncInProgress = false;
let abortController = null;

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
            abortController = null;
        }
        sendResponse({ success: true });
    }
    return true; // Keep channel open for async
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
            if (abortController.signal.aborted) {
                sendUpdate({ state: 'ABORTED', message: 'Sync cancelled by user.' });
                break;
            }

            processed++;
            const { id, title, timestamp } = item;

            // 3. Check differential registry
            const shouldExport = await needsExport(id, timestamp);
            if (!shouldExport) {
                skipped++;
                sendUpdate({ state: 'PROGRESS', processed, total, message: `Skipped (no changes): ${title}` });
                continue;
            }

            sendUpdate({ state: 'PROGRESS', processed, total, message: `Fetching: ${title}` });
            setBadge(`${processed}`);

            // 4. Fetch the data from Google's API
            // The exact API endpoint format from the original script UI interception
            try {
                // Determine sleep time (polite 3s - 5s)
                const delayMs = Math.floor(Math.random() * 2000) + 3000;
                sendUpdate({ state: 'PROGRESS', processed, total, message: `Sleeping for ${delayMs / 1000}s before fetching ${title}...` });
                await sleep(delayMs);

                if (abortController.signal.aborted) break;

                const url = `https://aistudio.google.com/app/prompts/${id}`;
                const response = await fetch(url, { signal: abortController.signal });
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

                const html = await response.text();

                // 5. Extract and Parse
                const jsonData = extractJsonFromHtml(html);
                const mdContent = parseApiPayloadToMarkdown(jsonData, title, settings);

                // 6. Write to File System
                const safeTitle = title.replace(/[/\\?%*:|"<>]/g, '-').trim() || `Untitled_${id}`;
                const filename = `${safeTitle}.md`;

                const fileHandle = await handle.getFileHandle(filename, { create: true });
                const writable = await fileHandle.createWritable();
                await writable.write(mdContent);
                await writable.close();

                // 6. Update Registry
                await markAsExported(id, timestamp);
                downloaded++;

            } catch (err) {
                console.error(`Failed to export ${id}:`, err);
                errors++;
                sendUpdate({ state: 'PROGRESS', processed, total, message: `Error on ${title}: ${err.message}` });
            }
        }

        if (!abortController.signal.aborted) {
            sendUpdate({ state: 'FINISHED', downloaded, skipped, errors, message: `Sync complete! Downloaded: ${downloaded}, Skipped: ${skipped}, Errors: ${errors}` });
        }

    } catch (err) {
        console.error("Bulk sync error: ", err);
        sendUpdate({ state: 'ERROR', message: err.message });
    } finally {
        isSyncInProgress = false;
        abortController = null;
        clearBadge();
    }
}
