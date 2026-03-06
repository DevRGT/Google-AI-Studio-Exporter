/**
 * The registry manages progress and timestamps for bulk exports.
 * Data is stored in chrome.storage.local under the key 'BulkExportRegistry'
 * Structure:
 * {
 *   "conversationId1": {
 *     "lastModifiedMs": 1700000000000,
 *     "lastExportedAt": 1700000000000
 *   }
 * }
 */

const REGISTRY_KEY = 'BulkExportRegistry';

export async function getRegistry() {
    const data = await chrome.storage.local.get(REGISTRY_KEY);
    return data[REGISTRY_KEY] || {};
}

export async function saveRegistry(registry) {
    await chrome.storage.local.set({ [REGISTRY_KEY]: registry });
}

export async function markAsExported(conversationId, lastModifiedMs) {
    const registry = await getRegistry();
    registry[conversationId] = {
        lastModifiedMs: lastModifiedMs,
        lastExportedAt: Date.now()
    };
    await saveRegistry(registry);
}

export async function needsExport(conversationId, currentModifiedMs) {
    const registry = await getRegistry();
    const entry = registry[conversationId];
    if (!entry) return true; // Never exported

    // If current modified time is strictly greater than what we have recorded
    return currentModifiedMs > entry.lastModifiedMs;
}
