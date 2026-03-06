// ============================================================
// Iron Dome — Anti-Throttle Module (based on Luna V12: Iron Dome)
//
// Uses Chrome Debugger API (CDP) to prevent Chrome from throttling
// background tabs during export operations.
//
// Three layers:
//   L1: Debugger-level — CPU rate, focus emulation (engine-level)
//   L2: Refresh interval — Re-assert focus every 500ms
//   L3: Page-level shield — Visibility API + event traps (JS-level)
// ============================================================

const _domeState = {};  // { tabId: { interval, debuggee } }

/**
 * Attach the debugger to a tab and enable anti-throttle protections.
 * Must be called AFTER the tab has finished loading.
 *
 * @param {number} tabId - The Chrome tab ID to protect
 * @returns {Promise<void>}
 */
export async function engageDome(tabId) {
    if (_domeState[tabId]) {
        console.log(`[IronDome] Already engaged on tab ${tabId}`);
        return;
    }

    const debuggee = { tabId };

    await new Promise((resolve, reject) => {
        chrome.debugger.attach(debuggee, "1.3", () => {
            if (chrome.runtime.lastError) {
                console.warn(`[IronDome] Failed to attach debugger to tab ${tabId}:`, chrome.runtime.lastError.message);
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            resolve();
        });
    });

    // Enable required debugging domains
    await _sendCommand(debuggee, "Page.enable");
    await _sendCommand(debuggee, "Runtime.enable");

    // L1: Disable CPU throttling (rate 1 = normal speed)
    await _sendCommand(debuggee, "Emulation.setCPUThrottlingRate", { rate: 1 });

    // L1: Emulate focus — prevents rAF pausing, timer throttling, visibility events
    await _sendCommand(debuggee, "Emulation.setFocusEmulationEnabled", { enabled: true });

    // L1: Prevent dark mode interference
    await _sendCommand(debuggee, "Emulation.setAutoDarkModeOverride", { enabled: false });

    // L2: Re-assert focus emulation every 500ms (Chrome may re-evaluate)
    const interval = setInterval(() => {
        if (!_domeState[tabId]) {
            clearInterval(interval);
            return;
        }
        chrome.debugger.sendCommand(debuggee, "Emulation.setFocusEmulationEnabled", { enabled: true }, () => {
            if (chrome.runtime.lastError) {
                // Tab was closed or debugger detached — clean up
                clearInterval(interval);
                delete _domeState[tabId];
            }
        });
    }, 500);

    _domeState[tabId] = { interval, debuggee };
    console.log(`[IronDome] ✅ Engaged on tab ${tabId}`);
}

/**
 * Detach the debugger and clean up all anti-throttle protections.
 *
 * @param {number} tabId - The Chrome tab ID to release
 * @returns {Promise<void>}
 */
export async function disengageDome(tabId) {
    const state = _domeState[tabId];
    if (!state) return;

    // Clear the refresh interval
    if (state.interval) {
        clearInterval(state.interval);
    }

    // Detach debugger (safe to call even if already detached)
    try {
        await new Promise((resolve) => {
            chrome.debugger.detach(state.debuggee, () => {
                if (chrome.runtime.lastError) {
                    // Already detached — that's fine
                    console.log(`[IronDome] Debugger already detached from tab ${tabId}`);
                }
                resolve();
            });
        });
    } catch (_) {
        // Ignore errors on cleanup
    }

    delete _domeState[tabId];
    console.log(`[IronDome] 🛑 Disengaged from tab ${tabId}`);
}

/**
 * Inject the page-level shield into the tab's MAIN world.
 * This overrides Visibility API, traps mouse-exit events, and nulls blur handlers.
 *
 * @param {number} tabId - The Chrome tab ID to inject into
 * @returns {Promise<void>}
 */
export async function injectShield(tabId) {
    await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: _shieldFunction
    });
    console.log(`[IronDome] 🛡️ Shield injected into tab ${tabId}`);
}

/**
 * Check if a tab currently has the dome engaged.
 * @param {number} tabId
 * @returns {boolean}
 */
export function isDomeEngaged(tabId) {
    return !!_domeState[tabId];
}

// ============================================================
// Internal helpers
// ============================================================

function _sendCommand(debuggee, method, params) {
    return new Promise((resolve) => {
        chrome.debugger.sendCommand(debuggee, method, params || {}, (result) => {
            if (chrome.runtime.lastError) {
                console.warn(`[IronDome] CDP ${method} failed:`, chrome.runtime.lastError.message);
            }
            resolve(result);
        });
    });
}

/**
 * Shield function — injected into the PAGE's JS context (MAIN world).
 * Provides multi-layer JavaScript-level anti-detection.
 */
function _shieldFunction() {
    // Skip if already injected
    if (window.__ironDomeShieldActive) return;
    window.__ironDomeShieldActive = true;

    console.log('[IronDome] 🛡️ Page-level shield active');

    // --- L3a: Visibility API falsification ---
    Object.defineProperty(document, 'hidden', {
        get: () => false,
        configurable: true
    });
    Object.defineProperty(document, 'visibilityState', {
        get: () => 'visible',
        configurable: true
    });
    Object.defineProperty(document, 'hasFocus', {
        value: () => true,
        configurable: true
    });

    // --- L3b: Suppress visibilitychange events ---
    document.addEventListener('visibilitychange', (e) => {
        e.stopImmediatePropagation();
    }, true);

    // --- L3c: Mouse exit event traps ---
    const trap = (e) => {
        if (e.type === 'mouseout' || e.type === 'mouseleave') {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            return false;
        }
    };

    // Register on all DOM layers in CAPTURE phase
    window.addEventListener('mouseout', trap, true);
    window.addEventListener('mouseleave', trap, true);
    document.addEventListener('mouseout', trap, true);
    document.addEventListener('mouseleave', trap, true);
    document.documentElement.addEventListener('mouseout', trap, true);
    document.documentElement.addEventListener('mouseleave', trap, true);

    // --- L3d: Null out direct event handler tripwires ---
    window.onblur = null;
    window.onmouseleave = null;
    document.onvisibilitychange = null;
}
