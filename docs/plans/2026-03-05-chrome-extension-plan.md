# Chrome Extension Bulk Export Implementation Plan

**Goal:** Convert the Google AI Studio Exporter UserScript into a Manifest V3 Chrome Extension that securely writes exported conversations directly to the user's local file system in bulk.

**Architecture:** 
- A **Service Worker** (`background.js`) orchestrates background API fetching, rate-limiting (polite sleeping), and Markdown generation.
- An **Options Page** (`options.html`) acts as the dashboard where the user grants "File System Access API" permissions.
- A **Content Script** (`content.js`) injects the "Bulk Sync" UI strictly into the `aistudio.google.com/library` page.
- Data persistence uses `IndexedDB` (for the directory handle) and `chrome.storage.local` (for the sync registry).

**Tech Stack:** Vanilla JavaScript (ES6 Modules), HTML/CSS, Chrome Extension MV3 API, File System Access API.

---

## Task 1: Scaffolding the Extension

**Files:**
- Create: `manifest.json`
- Create: `background/service-worker.js`
- Create: `content/content.js`
- Create: `options/options.html`

**Implementation Details:**
- `manifest.json` must be exactly `"manifest_version": 3`.
- Permissions must include `"storage"`.
- Host permissions must include `"https://aistudio.google.com/*"`.
- Background script must be declared as `"type": "module"`.

---

## Task 2: Options Page & File System API

**Files:**
- Modify: `options/options.html`
- Create: `options/options.js`
- Create: `utils/idb-storage.js`

**Implementation Details:**
- The Options UI must have a button: "Select Export Folder".
- `options.js` will trigger `async window.showDirectoryPicker({ mode: 'readwrite' })` when clicked.
- Since standard `chrome.storage.local` cannot store complex objects like `FileSystemDirectoryHandle`, we must implement a tiny `IndexedDB` wrapper (`idb-storage.js`) to save and load the handle.

---

## Task 3: Background Service Worker Sync Engine

**Files:**
- Modify: `background/service-worker.js`
- Create: `utils/bulk-export-registry.js`
- Create: `utils/markdown-parser.js`

**Implementation Details:**
- `bulk-export-registry.js` wraps `chrome.storage.local` to track `[conversationId]: lastModifiedTimestamp`.
- Listen for a message `START_BULK_SYNC` from the content script.
- When started: 
  1. Retrieve the `FileSystemDirectoryHandle` from IndexedDB. If missing, throw error asking user to configure Options.
  2. Request permission verification on the handle (`verifyPermission({mode: 'readwrite'})`).
  3. Enter a `for...of` loop over the provided list of discussions.
  4. Compare `lastModifiedTimestamp` against registry. If unchanged, skip.
  5. Fetch `https://aistudio.google.com/app/prompts/...` data.
  6. Pass data to `markdown-parser.js` (ported from the UserScript).
  7. Use `directoryHandle.getFileHandle(filename, {create: true})` and `createWritable()` to stream the text to the hard drive.
  8. Update the registry and **sleep for 3000ms - 5000ms** implicitly before continuing.

---

## Task 4: Content Script Integration

**Files:**
- Modify: `content/content.js`
- Create: `content/styles.css`

**Implementation Details:**
- Use a `MutationObserver` to watch for the `.view-all-history-link` or the loaded history table inside the `/library` route.
- Inject a visually distinct "🔄 Bulk Sync" button at the top/bottom of the page.
- On click, scrape the visible (or fetch the API behind) discussion IDs and their dates.
- Send the array to the Service Worker via `chrome.runtime.sendMessage({ action: "START_BULK_SYNC", items: [...] })`.
- Listen for progress updates from the Service Worker and display them in a floating UI overlay.
- Listen for `ESC` window events and send an `ABORT_SYNC` message to the Service Worker.

---

## Verification Plan

### Manual Verification Steps
1. Navigate to `chrome://extensions`, enable Developer Mode, and click "Load unpacked", selecting the project directory.
2. Click the extension "Details" -> "Extension options".
3. Click "Select Export Folder", grant access to a local folder (e.g., `Documents/AI-Studio-Vault`).
4. Close options and navigate to `https://aistudio.google.com/library`.
5. Verify the "Bulk Sync" button appears.
6. Click "Bulk Sync" and observe the progress overlay indicating fetching with 3+ second intervals.
7. Open the selected local folder and verify `.md` files are physically present and readable.
8. Reload the `/library` page and click "Bulk Sync" again. Verify that the UI immediately says "Skipping..." for the files just downloaded.

### Unit / Utility Verification
We will rely on manual exploratory testing inside Chrome for the DOM/API interactions due to the complexity of mocking Chrome APIs, but parsing utility inputs/outputs will be thoroughly vetted.
