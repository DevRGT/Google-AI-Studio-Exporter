# Safety Hardening Implementation Plan

**Goal:** Eliminate supply-chain risks by bundling JSZip from an official verified source and removing all dynamic external code loading, `unsafeWindow` access, and unnecessary `@connect` permissions.

**Architecture:** The UserScript is a single self-contained `.js` file with no build system or test framework. All changes are in-place edits to `google-ai-studio-exporter.user.js`. JSZip's minified source (~27KB) will be inlined at the top of the file inside an IIFE.

**Tech Stack:** Vanilla JavaScript (UserScript), JSZip 3.10.1 from official npm registry

---

### Task 1: Download & Verify Official JSZip

**Files:**
- Create: `/tmp/jszip-verify/` (temporary workspace)

**Step 1: Download the official npm tarball**
```bash
mkdir -p /tmp/jszip-verify
curl -o /tmp/jszip-verify/jszip-3.10.1.tgz https://registry.npmjs.org/jszip/-/jszip-3.10.1.tgz
```

**Step 2: Verify the integrity hash**
```bash
# Expected sha512: xXDvecyTpGLrqFrvkrUSoxxfJI5AH7U8zxxtVclpsUtMCq4JQ290LY8AW5c7Ggnr/Y/oK+bQMbqK2qmtk3pN4g==
shasum -a 512 /tmp/jszip-verify/jszip-3.10.1.tgz | xxd -r -p | base64
# OR use openssl:
openssl dgst -sha512 -binary /tmp/jszip-verify/jszip-3.10.1.tgz | base64
```
Expected outcome: hash matches `xXDvecyTpGLrqFrvkrUSoxxfJI5AH7U8zxxtVclpsUtMCq4JQ290LY8AW5c7Ggnr/Y/oK+bQMbqK2qmtk3pN4g==`

**Step 3: Extract the minified dist file**
```bash
cd /tmp/jszip-verify
tar xzf jszip-3.10.1.tgz
cp package/dist/jszip.min.js ./jszip.min.js
wc -c jszip.min.js  # should be ~96KB
```

---

### Task 2: Bundle JSZip Into the UserScript

**Files:**
- Modify: `google-ai-studio-exporter.user.js:1-30`

**Step 1: Replace the `@require` directive with a source comment**
```diff
-// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
+// @note         JSZip 3.10.1 is bundled below (source: npm registry, integrity verified)
```

**Step 2: Insert the JSZip source after the UserScript header block**
After line 26 (`// ==/UserScript==`), insert:
```javascript
// ==/UserScript==

// --- BEGIN BUNDLED JSZip 3.10.1 ---
// Source: https://registry.npmjs.org/jszip/-/jszip-3.10.1.tgz
// Integrity: sha512-xXDvecyTpGLrqFrvkrUSoxxfJI5AH7U8zxxtVclpsUtMCq4JQ290LY8AW5c7Ggnr/Y/oK+bQMbqK2qmtk3pN4g==
// License: MIT OR GPL-3.0-or-later
// Repository: https://github.com/Stuk/jszip
<contents of jszip.min.js here>
// --- END BUNDLED JSZip 3.10.1 ---
```

**Step 3: Update the `_JSZipRef` capture line (line 30)**
The existing line should still work since the bundled JSZip will define `JSZip` globally:
```javascript
const _JSZipRef = (typeof JSZip !== 'undefined') ? JSZip : null;
```
No change needed — this line will now capture the bundled JSZip.

---

### Task 3: Remove Dynamic Script Injection Code

**Files:**
- Modify: `google-ai-studio-exporter.user.js:429-440, 1648-1708`

**Step 1: Remove unused constants**
```diff
-    const EMBED_JSZIP_BASE64 = '';
-    const DISABLE_SCRIPT_INJECTION = true;
```

```diff
-    const JSZIP_URLS = [
-        'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
-        'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.js',
-        'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
-        'https://unpkg.com/jszip@3.10.1/dist/jszip.min.js'
-    ];
```

**Step 2: Delete the entire `ensureJSZip()` function (lines 1648-1708)**
Remove the full function including both the `GM_xmlhttpRequest` blob-URL injection path and the direct `<script>` injection fallback path.

**Step 3: Update `downloadCollectedData()` to remove `ensureJSZip` calls**
In the function at line 1713, replace:
```diff
     let JSZipLib = getJSZip();
-    if (!JSZipLib) {
-        try { JSZipLib = await ensureJSZip(); } catch (e) { console.error('ensureJSZip failed:', e); debugLog('ensureJSZip failed: ' + (e && e.message ? e.message : 'error'), 'error'); }
-    }
```
With simply:
```javascript
     let JSZipLib = getJSZip();
```

And in the retry path (line 1736), replace:
```diff
-            try { JSZipLib = await ensureJSZip(); } catch (e) { console.error('ensureJSZip retry failed:', e); }
+            JSZipLib = getJSZip();
```

---

### Task 4: Remove `unsafeWindow`

**Files:**
- Modify: `google-ai-studio-exporter.user.js:18, 40, 1636-1638`

**Step 1: Remove the grant directive**
```diff
-// @grant        unsafeWindow
```

**Step 2: Remove the debug log reference**
```diff
-        dlog('[AI Studio Exporter] unsafeWindow.JSZip:', typeof unsafeWindow !== 'undefined' ? unsafeWindow.JSZip : 'unsafeWindow not available');
```

**Step 3: Remove the `unsafeWindow` check from `getJSZip()`**
```diff
     function getJSZip() {
         if (_JSZipRef) {
             return _JSZipRef;
         }
         if (typeof JSZip !== 'undefined') {
             return JSZip;
         }
-        // 3. 检查页面上下文（通过 script 标签注入的）
-        if (typeof unsafeWindow !== 'undefined' && typeof unsafeWindow.JSZip !== 'undefined') {
-            return unsafeWindow.JSZip;
-        }
-        // 4. 检查 window 对象
         if (typeof window !== 'undefined' && typeof window.JSZip !== 'undefined') {
             return window.JSZip;
         }
         return null;
     }
```

---

### Task 5: Tighten `@connect` Permissions

**Files:**
- Modify: `google-ai-studio-exporter.user.js:19-21`

**Step 1: Remove CDN domains**
```diff
-// @connect      cdnjs.cloudflare.com
-// @connect      cdn.jsdelivr.net
-// @connect      unpkg.com
```

Keep the 4 Google domains (required for attachment downloads):
```
// @connect      lh3.googleusercontent.com
// @connect      googleusercontent.com
// @connect      storage.googleapis.com
// @connect      gstatic.com
```

---

### Task 6: Commit

**Step 1: Stage and commit**
```bash
cd /Users/regisgesnot/DevProjects/Google-AI-Studio-Exporter
git add google-ai-studio-exporter.user.js
git commit -m "security: bundle JSZip from official npm source and remove unsafe patterns

- Bundle JSZip 3.10.1 directly (source: npm registry, integrity verified)
- Remove @require from external CDN (no SRI was used)
- Remove ensureJSZip() dynamic script injection / CSP bypass
- Remove unsafeWindow grant and usage
- Remove CDN @connect permissions (cdnjs, jsdelivr, unpkg)
- Keep Google @connect domains for attachment downloads"
```

---

## Verification Plan

> [!IMPORTANT]
> This is a standalone UserScript with no automated test framework. All verification is manual.

### Manual Verification (by user)

After installing the modified script in OrangeMonkey:

1. **Script loads correctly**: Open [Google AI Studio](https://aistudio.google.com/) → verify the "🚀 Export" button appears in the bottom-right corner
2. **Text-only export works**: Open any conversation → click Export → choose "📄 Text Only" → verify a `.md` file downloads with the conversation content
3. **ZIP export works** (if conversation has attachments): Click Export → choose "📦 With Attachments" → verify a `.zip` file downloads containing `chat_history.md` and any images/files
4. **No external CDN requests**: Open DevTools → Network tab → filter for `cdnjs`, `jsdelivr`, `unpkg` → verify **zero** requests to these domains
5. **ESC cancel works**: During export, press ESC → verify the cancel prompt appears and options work

### Integrity Verification (during Task 1)

```bash
# Verify the npm tarball hash matches the official registry
openssl dgst -sha512 -binary /tmp/jszip-verify/jszip-3.10.1.tgz | base64
# Must match: xXDvecyTpGLrqFrvkrUSoxxfJI5AH7U8zxxtVclpsUtMCq4JQ290LY8AW5c7Ggnr/Y/oK+bQMbqK2qmtk3pN4g==
```
