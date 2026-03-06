# Luna V12: Iron Dome — Reverse Engineering Study

> **Date**: 2026-03-06  
> **Source**: `docs/reference/Luna-V12-Iron-Dome/Luna-V12-Iron-Dome/`  
> **Files analyzed**: `manifest.json` (24 lines), `background.js` (90 lines), `icon.png`

---

## 1. Overview

Luna V12: Iron Dome is a minimal Chrome Extension (Manifest V3) designed to **prevent tab throttling** when a user switches away from a browser tab. It uses Chrome's **Debugger API** to emulate focus, CPU, and visibility states, plus injected JavaScript to override the page's own visibility checks.

**Problem it solves**: Chrome aggressively throttles background tabs — it pauses `requestAnimationFrame`, delays `setTimeout`/`setInterval` to 1Hz, and fires `visibilitychange` events. Websites that rely on focus detection (mouse tracking, blur events, Visibility API) will pause or break when the tab loses focus. This is exactly what breaks our bulk export scraping in Google AI Studio.

---

## 2. Architecture

```
┌─────────────────────────────────────┐
│           manifest.json             │
│  permissions: debugger, scripting,  │
│               activeTab             │
│  background: service_worker         │
│  action: browser icon (toggle)      │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│          background.js              │
│                                     │
│  ┌─ action.onClicked ─────────────┐ │
│  │  Toggle: attach/detach debugger│ │
│  │                                │ │
│  │  ON ATTACH:                    │ │
│  │  1. Page.enable                │ │
│  │  2. Runtime.enable             │ │
│  │  3. setCPUThrottlingRate(1)    │ │
│  │  4. setFocusEmulationEnabled   │ │
│  │  5. setAutoDarkModeOverride    │ │
│  │  6. Inject activateShield()   │ │
│  │  7. setInterval(500ms) refresh │ │
│  └────────────────────────────────┘ │
│                                     │
│  ┌─ activateShield() ────────────┐  │
│  │  Runs in page context:        │  │
│  │  • Trap mouseout/mouseleave   │  │
│  │  • Override document.hidden   │  │
│  │  • Override visibilityState   │  │
│  │  • Override hasFocus()        │  │
│  │  • Null out onblur, etc.      │  │
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
```

---

## 3. Manifest Analysis

```json
{
  "manifest_version": 3,
  "name": "Luna V12: Iron Dome",
  "version": "12.0",
  "permissions": ["debugger", "scripting", "activeTab"],
  "background": { "service_worker": "background.js" },
  "action": { "default_title": "Activate Dome" }
}
```

### Key Permissions

| Permission   | Purpose |
|-------------|---------|
| `debugger`  | Attach to tabs via Chrome DevTools Protocol (CDP). Gives access to `Emulation.*` domain commands. Displays a yellow "debugging" banner at the top of the tab. |
| `scripting` | Inject JavaScript into the page via `chrome.scripting.executeScript()`. |
| `activeTab` | Limits tab interaction to the currently active tab when the user clicks the extension icon. |

> [!IMPORTANT]
> The `debugger` permission is the critical one. It's the **only way** for an extension to override Chrome's internal tab throttling (CPU scheduling, focus state) from outside the page sandbox.

---

## 4. Detailed Code Analysis — `background.js`

### 4.1 State Management

```javascript
let attachedTabs = {};
```

A simple dictionary `{ tabId: true }` tracks which tabs have the "dome" active. This is used to:
- Toggle on/off via the browser action icon click
- Clean up when tabs close
- Control the 500ms refresh interval

### 4.2 Toggle Mechanism — `chrome.action.onClicked`

```javascript
chrome.action.onClicked.addListener((tab) => {
    const tabId = tab.id;
    const debuggee = { tabId: tabId };

    if (attachedTabs[tabId]) {
        // Already ON → detach and turn off
        chrome.debugger.detach(debuggee);
        delete attachedTabs[tabId];
        chrome.action.setBadgeText({tabId, text: ""});
        return;
    }
    // Not ON → attach and activate
    chrome.debugger.attach(debuggee, "1.3", () => { ... });
});
```

**Toggle behavior**: Clicking the icon either attaches or detaches the debugger. When attached, a green `"ON"` badge appears on the icon.

### 4.3 Debugger Commands (CDP — Chrome DevTools Protocol)

After attaching the debugger, 5 CDP commands are sent:

#### 4.3.1 `Page.enable` and `Runtime.enable`

```javascript
chrome.debugger.sendCommand(debuggee, "Page.enable");
chrome.debugger.sendCommand(debuggee, "Runtime.enable");
```

These enable the **Page** and **Runtime** debugging domains. They're required before using `Emulation.*` commands.

#### 4.3.2 `Emulation.setCPUThrottlingRate`

```javascript
chrome.debugger.sendCommand(debuggee, "Emulation.setCPUThrottlingRate", { rate: 1 });
```

Sets CPU throttling rate to `1` (no throttling). Chrome normally throttles background tabs' CPU to ~1% of foreground. This command tells Chrome: **"treat this tab as if it has full CPU"**.

> [!NOTE]
> A `rate` of `1` means "1x speed" (normal). Values > 1 would slow the tab down. By explicitly setting it to 1, we override Chrome's background tab throttling.

#### 4.3.3 `Emulation.setFocusEmulationEnabled`

```javascript
chrome.debugger.sendCommand(debuggee, "Emulation.setFocusEmulationEnabled", { enabled: true });
```

**This is the most critical command.** It tells Chrome to emulate that the page has focus, even when it doesn't. This:
- Prevents `document.hidden` from becoming `true`
- Prevents `visibilitychange` events from firing
- Keeps `requestAnimationFrame` running at full speed
- Prevents `setTimeout`/`setInterval` throttling

#### 4.3.4 `Emulation.setAutoDarkModeOverride`

```javascript
chrome.debugger.sendCommand(debuggee, "Emulation.setAutoDarkModeOverride", { enabled: false });
```

Prevents Chrome's automatic dark mode from interfering. Minor — mostly defensive.

### 4.4 Focus Refresh Interval

```javascript
const interval = setInterval(() => {
    if (!attachedTabs[tabId]) {
        clearInterval(interval);
        return;
    }
    chrome.debugger.sendCommand(debuggee, "Emulation.setFocusEmulationEnabled", { enabled: true });
}, 500);
```

Every 500ms, the extension re-sends `setFocusEmulationEnabled`. This is because **Chrome may internally re-evaluate focus** when you switch tabs/windows. The interval ensures the emulation is always re-applied.

### 4.5 Tab Cleanup

```javascript
chrome.tabs.onRemoved.addListener((tabId) => {
    if (attachedTabs[tabId]) delete attachedTabs[tabId];
});
```

Removes the tab from the tracking dictionary when closed (the debugger auto-detaches when a tab closes).

---

## 5. Shield Function — `activateShield()`

This function is injected directly into the **page's JavaScript context** via `chrome.scripting.executeScript()`. It provides a secondary layer of protection by lying to the page's own code.

### 5.1 Visual Indicator

```javascript
document.body.style.border = "4px solid #fdfeff";
```

Almost-white border — barely visible, just enough to confirm the shield is active.

### 5.2 Mouse Exit Event Trap

```javascript
const trap = (e) => {
    if (e.type === 'mouseout' || e.type === 'mouseleave') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        return false;
    }
};

// Registered on window, document, and documentElement — all in CAPTURE phase
window.addEventListener('mouseout', trap, true);
window.addEventListener('mouseleave', trap, true);
document.addEventListener('mouseout', trap, true);
document.addEventListener('mouseleave', trap, true);
document.documentElement.addEventListener('mouseout', trap, true);
document.documentElement.addEventListener('mouseleave', trap, true);
```

**Purpose**: Some websites detect when the mouse cursor leaves the page and react (pause video, show popup, etc.). By intercepting these events at the capture phase across all DOM layers, the page never sees them.

### 5.3 Visibility API Falsification

```javascript
Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
Object.defineProperty(document, 'hasFocus', { value: () => true, configurable: true });
```

**Purpose**: Overrides the three standard APIs that pages use to detect background state:
- `document.hidden` → always `false`
- `document.visibilityState` → always `'visible'`
- `document.hasFocus()` → always `true`

> [!NOTE]
> This is a page-level defense (JavaScript shimming). The Debugger-based `setFocusEmulationEnabled` handles the same thing at the **browser engine level**. Together they create a two-layer approach — the engine never fires the events in the first place AND the page's checks lie anyway.

### 5.4 Event Handler Nullification

```javascript
window.onblur = null;
window.onmouseleave = null;
document.onvisibilitychange = null;
```

**Purpose**: Some pages set direct `onblur` / `onvisibilitychange` handlers. This nukes them. Note: this **only clears inline handlers**, not listeners added via `addEventListener`.

---

## 6. Defense Layers Summary

The extension implements a **multi-layered** anti-throttle/anti-detection strategy:

| Layer | Mechanism | What it prevents |
|-------|-----------|-----------------|
| **L1** | `Emulation.setCPUThrottlingRate(1)` | CPU throttling of background tab |
| **L2** | `Emulation.setFocusEmulationEnabled(true)` | Browser-level focus loss detection, `rAF` pausing, timer throttling |
| **L3** | `setInterval(500ms)` re-applying L2 | Chrome re-evaluating focus state over time |
| **L4** | `Object.defineProperty` on visibility/hidden/hasFocus | JavaScript-level visibility checks by the page |
| **L5** | Mouse exit event capture/blocking | Mouse-leave detection by the page |
| **L6** | `window.onblur = null` etc. | Direct event handler tripwires |
| **L7** | `Emulation.setAutoDarkModeOverride` | Dark mode interference (minor) |

---

## 7. Relevance to Google AI Studio Exporter

### Current Problems in Bulk Export
1. Chrome throttles background tabs → `scrollBy({behavior:'smooth'})` pauses
2. Angular detects `visibilitychange` → SPA freezes rendering
3. `requestAnimationFrame` stops → scroll-based DOM loading halts
4. Export windows that lose focus produce **incomplete scrapes**

### What the Exporter Already Has (Partial)
The service-worker.js (L192-208) already injects Visibility API overrides:
```javascript
Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
Object.defineProperty(document, 'hidden', { get: () => false });
document.addEventListener('visibilitychange', (e) => { e.stopImmediatePropagation(); }, true);
```

This is equivalent to Iron Dome's **Layer 4** only. The critical L1-L3 Debugger-based layers are missing.

### What Needs to Be Added
1. **`debugger` permission** in manifest.json
2. **Debugger attach/detach** in service-worker.js (auto-activated, no icon click)
3. **Full shield injection** including mouse traps and handler nullification
4. **500ms focus-emulation refresh** interval
5. **Auto-activate on Google AI pages** instead of requiring a manual click

### UX Impact
- The `debugger` permission causes a **yellow "debugging" banner** at the top of the page → this is expected and unavoidable
- The banner appears only during active export, not during normal browsing
- This is a fair trade-off for reliable background exports

---

## 8. Files Inventory

| File | Size | Purpose |
|------|------|---------|
| `manifest.json` | 479 bytes | Extension configuration, permissions |
| `background.js` | 3,694 bytes | All extension logic (toggle, debugger, shield injection) |
| `icon.png` | 15,444 bytes | Extension icon (single icon for all sizes) |
