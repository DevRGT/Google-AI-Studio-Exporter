# Safety Hardening — Design Document

**Date**: 2026-03-05  
**Scope**: Harden the Google AI Studio Exporter UserScript against supply-chain and injection risks  
**Approach**: In-place hardening — fix unsafe patterns without breaking existing functionality

---

## Problem Statement

The script loads the JSZip library from external CDNs **at runtime**, without integrity verification. This creates a supply-chain risk: if a CDN is compromised, malicious code would execute with full UserScript privileges (access to Google session, DOM, cross-origin requests). Additionally, a CSP bypass mechanism exists to dynamically inject downloaded scripts via blob URLs.

## User Priority

> "Be sure that we are not taking stuff unsafe — after, we should not break it."

The user prioritizes **safety of external dependencies** while preserving full functionality.

---

## Design

### Change 1: Bundle JSZip from Official Source

**What**: Download JSZip `3.10.1` from the **official npm registry** (`registry.npmjs.org`), verify its integrity hash, and inline the minified source directly at the top of the UserScript.

**Why**: Eliminates all runtime dependency loading. The code becomes self-contained — no CDN requests, no trust in third-party infrastructure at runtime.

**Verification**: 
- Official npm registry tarball: `https://registry.npmjs.org/jszip/-/jszip-3.10.1.tgz`
- Integrity: `sha512-xXDvecyTpGLrqFrvkrUSoxxfJI5AH7U8zxxtVclpsUtMCq4JQ290LY8AW5c7Ggnr/Y/oK+bQMbqK2qmtk3pN4g==`
- Author: Stuart Knightley (Stuk) — [github.com/Stuk/jszip](https://github.com/Stuk/jszip)
- License: MIT OR GPL-3.0-or-later
- PGP-signed npm release

**How**: 
1. Download the tarball from npm, extract `dist/jszip.min.js`
2. Verify the integrity hash matches
3. Wrap the source in an IIFE and place it at the top of the UserScript, before the main script body
4. Replace `@require` directive with a comment referencing the bundled version
5. Simplify `getJSZip()` to simply return the globally available `JSZip`

### Change 2: Remove Dynamic Script Injection (`ensureJSZip`)

**What**: Delete the entire `ensureJSZip()` function (lines 1648-1708) and the `JSZIP_URLS` constant (lines 435-440).

**Why**: This function downloads JS from CDNs and injects it via blob URLs to bypass CSP. With JSZip bundled, it's unnecessary. The `DISABLE_SCRIPT_INJECTION` flag (currently `true`) and `EMBED_JSZIP_BASE64` empty constant are also removed.

### Change 3: Remove `unsafeWindow`

**What**: Remove `// @grant unsafeWindow` from the header and all `unsafeWindow` references in `getJSZip()`.

**Why**: `unsafeWindow` breaks the UserScript sandbox. With JSZip bundled, there's no need to reach into the page's JavaScript context.

### Change 4: Tighten `@connect` Permissions

**What**: Remove 3 CDN domains from `@connect`:
- `cdnjs.cloudflare.com`
- `cdn.jsdelivr.net`  
- `unpkg.com`

Keep the 4 Google domains needed for attachment downloads.

**Why**: These CDNs were only needed for the JSZip fallback loading. Removing them reduces the cross-origin request surface.

---

## What We Do NOT Change

| Area | Reason |
|------|--------|
| DOM scraping logic | Core feature, works correctly |
| `GM_xmlhttpRequest` for attachments | Required for downloading user's own files |
| UI/overlay system | No security concern |
| Export formats (MD, ZIP) | No security concern |
| `@connect` Google domains | Required for attachment downloads |

---

## Verification Plan

Since this is a UserScript (no test framework, no build system), verification is **manual**:

1. **Integrity check**: After downloading JSZip from npm, verify the sha512 hash matches the official registry value
2. **Script loads**: Install the modified script in OrangeMonkey, open Google AI Studio — the export button should appear
3. **Text export**: Start a conversation, click Export → Text Only → verify the `.md` file downloads correctly
4. **ZIP export**: Click Export → With Attachments → verify the `.zip` file downloads with JSZip working from the bundled source
5. **No external requests**: Check the browser Network tab — the script should NOT make any requests to cdnjs, jsdelivr, or unpkg
