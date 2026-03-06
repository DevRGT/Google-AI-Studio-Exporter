let isAlwaysActive = false;
let injectedScript = null;
let heartbeatInterval = null;
let performanceMonitor = null;
let lastActivityTime = Date.now();
let tabStats = {
    startTime: Date.now(),
    activationTime: null,
    pageLoads: 0,
    errors: 0,
    memoryUsage: 0
};

(async function initialize() {
    try {
        const response = await chrome.runtime.sendMessage({ 
            action: 'checkTabActive' 
        });
        
        if (response && response.shouldStayActive) {
            enableAlwaysActive();
        }
        
        startPerformanceMonitoring();
        tabStats.pageLoads++;
        
    } catch (error) {
        tabStats.errors++;
    }
})();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
        switch (message.action) {
            case 'enableAlwaysActive':
                enableAlwaysActive();
                sendResponse({ success: true, stats: tabStats });
                break;
                
            case 'disableAlwaysActive':
                disableAlwaysActive();
                sendResponse({ success: true, stats: tabStats });
                break;
                
            case 'getStatus':
                sendResponse({ 
                    isAlwaysActive, 
                    stats: tabStats,
                    lastActivity: lastActivityTime
                });
                break;
                
            case 'ping':
                updateActivity();
                sendResponse({ 
                    alive: true, 
                    timestamp: Date.now(),
                    stats: tabStats
                });
                break;
                
            case 'getPerformanceStats':
                sendResponse({
                    stats: tabStats,
                    performance: getPerformanceMetrics()
                });
                break;
                
            default:
                sendResponse({ error: 'Unknown action' });
        }
    } catch (error) {
        tabStats.errors++;
        sendResponse({ error: error.message });
    }
    
    return true;
});

function enableAlwaysActive() {
    if (isAlwaysActive) return;
    
    isAlwaysActive = true;
    tabStats.activationTime = Date.now();
    
    injectAlwaysActiveScript();
    startHeartbeat();
    
    window.postMessage({ 
        type: 'ALWAYS_ACTIVE_ENABLE',
        source: 'always-active-extension'
    }, '*');
    
    updateActivity();
    
    try {
        chrome.runtime.sendMessage({
            action: 'tabActivated',
            tabStats: tabStats
        });
    } catch (error) {}
}

function disableAlwaysActive() {
    if (!isAlwaysActive) return;
    
    isAlwaysActive = false;
    tabStats.activationTime = null;
    
    stopHeartbeat();
    
    window.postMessage({ 
        type: 'ALWAYS_ACTIVE_DISABLE',
        source: 'always-active-extension'
    }, '*');
    
    if (injectedScript) {
        injectedScript.remove();
        injectedScript = null;
    }
    
    try {
        chrome.runtime.sendMessage({
            action: 'tabDeactivated',
            tabStats: tabStats
        });
    } catch (error) {}
    
    if (confirm('Always Active disabled. Reload page to restore normal behavior?')) {
        window.location.reload();
    }
}

function injectAlwaysActiveScript() {
    if (document.querySelector('script[data-always-active="true"]')) {
        return;
    }
    
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('injected.js');
    script.setAttribute('data-always-active', 'true');
    script.onload = function() {
        this.remove();
    };
    script.onerror = function() {
        tabStats.errors++;
        this.remove();
    };
    
    (document.head || document.documentElement).appendChild(script);
    injectedScript = script;
}

function startHeartbeat() {
    if (heartbeatInterval) return;
    
    heartbeatInterval = setInterval(() => {
        if (!isAlwaysActive) return;
        
        try {
            updateActivity();
            
            document.documentElement.scrollTop = document.documentElement.scrollTop;
            
            const heartbeatEvent = new CustomEvent('activetab-heartbeat', {
                detail: { 
                    timestamp: Date.now(),
                    tabId: chrome.runtime.id,
                    stats: tabStats
                }
            });
            document.dispatchEvent(heartbeatEvent);
            
            if (document.hidden) {
                injectAlwaysActiveScript();
            }
            
            if (Math.random() < 0.05) {
                fetch(window.location.href, { 
                    method: 'HEAD',
                    cache: 'no-cache'
                }).catch(() => {});
            }
            
            requestAnimationFrame(() => {});
            
            updatePerformanceStats();
            
        } catch (error) {
            tabStats.errors++;
        }
    }, 1000);
}

function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
}

function updateActivity() {
    lastActivityTime = Date.now();
}

function startPerformanceMonitoring() {
    if (performanceMonitor) return;
    
    performanceMonitor = setInterval(() => {
        try {
            updatePerformanceStats();
            
            if (performance.memory) {
                const memoryMB = performance.memory.usedJSHeapSize / 1024 / 1024;
                tabStats.memoryUsage = Math.round(memoryMB);
                
                if (memoryMB > 500) {
                    console.warn(`High memory usage: ${memoryMB.toFixed(1)}MB`);
                }
            }
            
        } catch (error) {
            tabStats.errors++;
        }
    }, 10000);
}

function updatePerformanceStats() {
    try {
        if (performance.memory) {
            tabStats.memoryUsage = Math.round(performance.memory.usedJSHeapSize / 1024 / 1024);
        }
        
        const navigation = performance.getEntriesByType('navigation')[0];
        if (navigation) {
            tabStats.loadTime = Math.round(navigation.loadEventEnd - navigation.fetchStart);
        }
        
    } catch (error) {
        tabStats.errors++;
    }
}

function getPerformanceMetrics() {
    try {
        const metrics = {
            memoryUsage: tabStats.memoryUsage,
            uptime: Date.now() - tabStats.startTime,
            activeTime: tabStats.activationTime ? Date.now() - tabStats.activationTime : 0,
            pageLoads: tabStats.pageLoads,
            errors: tabStats.errors,
            lastActivity: lastActivityTime
        };
        
        if (performance.memory) {
            metrics.heapSize = Math.round(performance.memory.totalJSHeapSize / 1024 / 1024);
            metrics.heapLimit = Math.round(performance.memory.jsHeapSizeLimit / 1024 / 1024);
        }
        
        return metrics;
    } catch (error) {
        return { error: error.message };
    }
}

document.addEventListener('visibilitychange', function(e) {
    if (isAlwaysActive) {
        updateActivity();
    }
});

window.addEventListener('blur', function(e) {
    if (isAlwaysActive) {
        updateActivity();
    }
});

window.addEventListener('focus', function(e) {
    updateActivity();
});

window.addEventListener('beforeunload', function(e) {
    if (isAlwaysActive) {
        try {
            chrome.runtime.sendMessage({
                action: 'tabUnloading',
                tabStats: tabStats
            });
        } catch (error) {}
    }
});

window.addEventListener('message', function(event) {
    if (event.data && event.data.source === 'always-active-injected') {
        updateActivity();
    }
});

setInterval(() => {
    if (isAlwaysActive) {
        const checks = {
            documentHidden: document.hidden === false,
            visibilityState: document.visibilityState === 'visible',
            hasFocus: document.hasFocus() === true
        };
        
        const failedChecks = Object.entries(checks)
            .filter(([check, passed]) => !passed)
            .map(([check]) => check);
        
        if (failedChecks.length > 0) {
            injectAlwaysActiveScript();
            tabStats.errors++;
        }
        
        updateActivity();
    }
}, 15000);

window.addEventListener('error', function(e) {
    if (isAlwaysActive) {
        tabStats.errors++;
    }
});

window.addEventListener('unhandledrejection', function(e) {
    if (isAlwaysActive) {
        tabStats.errors++;
    }
});

let originalFetch = window.fetch;
window.fetch = function(...args) {
    if (isAlwaysActive) {
        updateActivity();
    }
    return originalFetch.apply(this, args);
};

let originalXHROpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function(...args) {
    if (isAlwaysActive) {
        updateActivity();
    }
    return originalXHROpen.apply(this, args);
};

if (typeof window !== 'undefined') {
    window.activeTabDebug = {
        getStats: () => tabStats,
        getStatus: () => ({
            isAlwaysActive,
            lastActivity: new Date(lastActivityTime),
            heartbeatActive: !!heartbeatInterval,
            performanceMonitorActive: !!performanceMonitor
        }),
        forceEnable: () => enableAlwaysActive(),
        forceDisable: () => disableAlwaysActive(),
        triggerHeartbeat: () => {
            if (isAlwaysActive && heartbeatInterval) {
                updateActivity();
            }
        },
        testOverrides: () => ({
            hidden: document.hidden,
            visibilityState: document.visibilityState,
            hasFocus: document.hasFocus()
        })
    };
}