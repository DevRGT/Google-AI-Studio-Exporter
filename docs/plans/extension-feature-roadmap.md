# Google AI Studio Exporter — Chrome Extension Feature Roadmap

## Context

We migrated from an OrangeMonkey UserScript to a Chrome Extension (Manifest V3). The original UserScript was feature-rich (1826 lines). The extension now has **bulk export** (fixed) and **single-discussion export** functionality. This plan organizes all remaining work into incremental, testable phases.

---

## Current State & Gaps

| Area | UserScript ✅ | Extension |
|---|---|---|
| Single-discussion export button | ✅ Floating button on any `/prompts/` page | ✅ Phase 1 — Floating teal button with scroll-and-capture |
| Export format choice (Text / Full+attachments) | ✅ Mode selection dialog | ❌ No config at all |
| Attachment export (images, files → ZIP) | ✅ Full ZIP with images/ and files/ folders | ❌ Not implemented |
| Thoughts extraction (`ms-thought-chunk`) | ✅ Extracted and rendered | ✅ Phase 1 — Extracted via `dom-capture.js` |
| Role detection (User / Gemini / Thoughts) | ✅ DOM-based role detection | ✅ Phase 1 — DOM-based `data-turn-role` detection |
| Bulk export from Library | ✅ N/A (single-page only) | ✅ Phase 0 — Fixed with keepalive + error handling |
| ESC cancellation / abort | ✅ Full cancel/retry/text-only UX | ❌ Basic abort only |
| i18n (EN/ZH) | ✅ Full bilingual | ❌ Not started |

---

## Phase 0 — Fix Critical Bug: "Extension context invalidated"

> **Goal:** Make bulk export functional again.

The error at `content.js:94` (`chrome.runtime.sendMessage`) happens when the service worker has been unloaded (idle timeout) or the extension was reloaded/updated while the page was still open.

### Tasks

- [x] **P0.1** — Wrap all `chrome.runtime.sendMessage()` calls in a try/catch with user-friendly error message ("Please reload this page and try again")
- [x] **P0.2** — Add a connection health check before starting bulk sync (ping the service worker first)
- [x] **P0.3** — Add `chrome.runtime.onConnect` keepalive pattern in content script to prevent service worker idle shutdown during long syncs

#### Files
- [content.js](file:///Users/regisgesnot/DevProjects/Google-AI-Studio-Exporter/content/content.js) — Add error handling, keepalive
- [service-worker.js](file:///Users/regisgesnot/DevProjects/Google-AI-Studio-Exporter/background/service-worker.js) — Add keepalive port listener

#### Verification
1. Load the extension in Chrome → Navigate to `aistudio.google.com/library`
2. Click "Bulk Sync" → should work without the "Extension context invalidated" error
3. Wait 5+ minutes idle, then click Bulk Sync → should still work (keepalive test)

---

## Phase 1 — Single-Discussion Export Button

> **Goal:** Add a floating "Export" button when viewing any individual discussion (`/prompts/...`).

### Tasks

- [x] **P1.1** — Detect when user is on a single discussion page (`/prompts/` or `/app/prompts/`)
- [x] **P1.2** — Inject a floating "📥 Export Discussion" button (similar style to the bulk button)
- [x] **P1.3** — On click: extract the current page's conversation data from the DOM (port the `captureData()` logic from the UserScript)
- [x] **P1.4** — Generate Markdown from captured data and trigger a browser download
- [x] **P1.5** — Handle the scroll-and-capture flow for long conversations (port from UserScript)

#### Files
- [content.js](file:///Users/regisgesnot/DevProjects/Google-AI-Studio-Exporter/content/content.js) — Page detection + button injection + scroll-and-capture flow
- [styles.css](file:///Users/regisgesnot/DevProjects/Google-AI-Studio-Exporter/content/styles.css) — Teal export button + animated overlay with spinner
- **[NEW]** [dom-capture.js](file:///Users/regisgesnot/DevProjects/Google-AI-Studio-Exporter/utils/dom-capture.js) — Reusable DOM capture module (ported from UserScript)

#### Verification
1. Navigate to any discussion at `aistudio.google.com/prompts/...`
2. The "Export Discussion" button should appear
3. Click it → A `.md` file is downloaded with the conversation content
4. Contents should have correct User/Gemini role assignments

---

## Phase 2 — Export Configuration (Options & Pre-Export Dialog)

> **Goal:** Let users configure export format, attachment handling, and other settings.

### Tasks

- [x] **P2.1** — Add export settings to the Options page:
  - Export format: "Markdown only" / "ZIP with attachments"
  - Include Gemini thoughts: Yes / No
  - Include attachments: Yes / No
  - File naming pattern
- [x] **P2.2** — Store settings in `chrome.storage.sync`
- [x] **P2.3** — Add a pre-export dialog (similar to UserScript's `showModeSelection()`) that shows before both single-export and bulk-export
- [x] **P2.4** — Wire settings into the export pipeline

#### Files
- [options.html](file:///Users/regisgesnot/DevProjects/Google-AI-Studio-Exporter/options/options.html) — Add settings UI
- **[NEW]** `options/options.js` — Handle settings save/load
- [content.js](file:///Users/regisgesnot/DevProjects/Google-AI-Studio-Exporter/content/content.js) — Read settings before export, show pre-export dialog
- [service-worker.js](file:///Users/regisgesnot/DevProjects/Google-AI-Studio-Exporter/background/service-worker.js) — Use settings during bulk export

#### Verification
1. Open extension Options → configure format and attachment toggle
2. Export a single discussion → output respects the settings
3. Run bulk export → output respects the settings
4. Change settings → re-export → different output format

---

## Phase 3 — Robust Data Extraction (Port from UserScript)

> **Goal:** Achieve feature parity with the UserScript for data extraction quality.

### Tasks

- [x] **P3.1** — Port the DOM-based `captureData()` with proper role detection (`data-turn-role`, `model-prompt-container`, etc.)
- [x] **P3.2** — Port Gemini thoughts extraction (`ms-thought-chunk`)
- [x] **P3.3** — Port the turn ordering logic (`updateTurnOrder`, `mergeWithOverlap`)
- [x] **P3.4** — Port the conversation normalization (`normalizeConversation()` — merge thoughts-only entries)
- [x] **P3.5** — Port attachment link extraction (`extractDownloadLinksFromTurn`)
- [x] **P3.6** — Improve the `extractJsonFromHtml()` in `markdown-parser.js` for bulk export (current regex approach is fragile)

#### Files
- [content.js](file:///Users/regisgesnot/DevProjects/Google-AI-Studio-Exporter/content/content.js) — Core capture logic
- [markdown-parser.js](file:///Users/regisgesnot/DevProjects/Google-AI-Studio-Exporter/utils/markdown-parser.js) — Improved parsing
- **[NEW]** `utils/data-capture.js` — Extracted capture utilities (reusable for single & bulk)

#### Verification
1. Export a discussion with Gemini thoughts → thoughts should appear as a separate section
2. Export a long conversation → all turns present, correct role assignment
3. Export a conversation with images → attachment links preserved in Markdown
4. Compare output with UserScript output for the same conversation → should be equivalent

---

## Phase 4 — Attachment & ZIP Export

> **Goal:** Download images and files, package everything into a ZIP.

### Tasks

- [x] **P4.1** — Bundle JSZip library (or use a CDN-compatible approach for MV3)
- [x] **P4.2** — Port `processImages()` — download images and add to ZIP
- [x] **P4.3** — Port `processFiles()` — download linked files and add to ZIP
- [x] **P4.4** — Port `fetchResource()` — download with timeout and progress
- [x] **P4.5** — Port `generateMarkdownContent()` with URL replacement (images → local paths)
- [x] **P4.6** — Final ZIP generation and download via `chrome.downloads` API

#### Files
- **[NEW]** `libs/jszip.min.js` — Bundled JSZip
- **[NEW]** `utils/attachment-handler.js` — Image/file download + ZIP packaging
- [service-worker.js](file:///Users/regisgesnot/DevProjects/Google-AI-Studio-Exporter/background/service-worker.js) — Orchestrate ZIP generation for bulk
- [content.js](file:///Users/regisgesnot/DevProjects/Google-AI-Studio-Exporter/content/content.js) — Orchestrate ZIP generation for single export
- [manifest.json](file:///Users/regisgesnot/DevProjects/Google-AI-Studio-Exporter/manifest.json) — Add `downloads` permission

#### Verification
1. Export a discussion that contains images → ZIP downloaded with `images/` folder
2. Open the ZIP → `chat_history.md` references `images/image_0.png` etc.
3. Export a discussion with file attachments → `files/` folder present in ZIP
4. Bulk export with "ZIP" mode → each discussion gets its own ZIP

---

## Phase 5 — Polish & UX

> **Goal:** Improve the user experience to match or exceed the UserScript.

### Tasks

- [x] **P5.1** — Add progress feedback for single-export (countdown, scrolling %, packaging %)
- [x] **P5.2** — Port the cancel/retry/text-only UX for mid-export interruption (ESC key)
- [x] **P5.3** — Better error handling and user-friendly error messages throughout
- [x] **P5.4** — Add a badge or notification count on the extension icon during sync
- [x] **P5.5** — Add i18n support (English + Chinese, matching UserScript)
- [x] **P5.6** — Update popup UI to show extension status, quick actions, and last sync info
- [x] **P5.7** — Update README and documentation

#### Files
- Various existing files
- **[NEW]** `_locales/en/messages.json` — English translations
- **[NEW]** `_locales/zh_CN/messages.json` — Chinese translations
- [manifest.json](file:///Users/regisgesnot/DevProjects/Google-AI-Studio-Exporter/manifest.json) — Add `default_locale`

#### Verification
1. Press ESC during export → cancel/retry dialog appears
2. Switch Chrome language → extension UI switches language
3. Check extension badge during bulk sync → shows progress count

---

## Recommended Implementation Order

```
P0 (Bug Fix) → P1 (Single Export) → P2 (Config) → P3 (Extraction) → P4 (ZIP) → P5 (Polish)
```

Each phase is **independently shippable** and can be committed/released on its own. This allows testing at each step before moving forward.

---

## Verification Plan (Overall)

### Manual Testing (per phase)
Each phase has its own verification steps listed above. After each phase:
1. Reload the extension in `chrome://extensions`
2. Navigate to AI Studio and perform the verification steps
3. Check the Chrome DevTools console for errors

### Final Smoke Test (after all phases)
1. Single export a short discussion → Markdown file correct
2. Single export a long discussion with attachments → ZIP file correct
3. Bulk export from Library → all discussions exported
4. Change settings → re-export → output reflects settings
5. ESC during export → cancel dialog works
6. Reload extension mid-sync → graceful error, no crash
