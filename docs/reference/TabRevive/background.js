let extensionStats = {
    startTime: Date.now(),
    totalActivations: 0,
    totalDeactivations: 0,
    averageActiveTime: 0,
    memoryUsage: 0,
    errors: 0
};

let activeTabsPerformance = {};
let cleanupInterval = null;
let performanceInterval = null;

chrome.runtime.onInstalled.addListener(async (details) => {
    try {
        const existingData = await chrome.storage.local.get(['alwaysActiveTabs', 'extensionSettings', 'extensionStats']);
        
        const optimalSettings = getOptimalSettings();
        
        await chrome.storage.local.set({
            alwaysActiveTabs: existingData.alwaysActiveTabs || {},
            extensionSettings: optimalSettings,
            extensionStats: existingData.extensionStats || extensionStats
        });
        
        if (details.reason === 'install') {
            showWelcomeNotification();
        }
        
        startBackgroundMonitoring();
        
    } catch (error) {
        extensionStats.errors++;
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
        switch (message.action) {
            case 'updateAlwaysActive':
                handleAlwaysActiveUpdate(message.tabId, message.isActive);
                sendResponse({ success: true });
                break;
                
            case 'getAlwaysActiveStatus':
                getAlwaysActiveStatus(message.tabId, sendResponse);
                return true;
                
            case 'checkTabActive':
                handleTabActiveCheck(sender.tab.id, sendResponse);
                return true;
                
            case 'tabActivated':
                handleTabActivated(sender.tab.id, message.tabStats);
                sendResponse({ success: true });
                break;
                
            case 'tabDeactivated':
                handleTabDeactivated(sender.tab.id, message.tabStats);
                sendResponse({ success: true });
                break;
                
            case 'tabUnloading':
                handleTabUnloading(sender.tab.id, message.tabStats);
                sendResponse({ success: true });
                break;
                
            case 'getExtensionStats':
                sendResponse({
                    extensionStats,
                    activeTabsPerformance,
                    activeCount: Object.keys(activeTabsPerformance).length
                });
                break;
                
            case 'updateSettings':
                updateSettings(message.settings);
                sendResponse({ success: true });
                break;
                
            case 'clearAllData':
                clearAllData();
                sendResponse({ success: true });
                break;
                
            default:
                sendResponse({ error: 'Unknown action' });
        }
    } catch (error) {
        extensionStats.errors++;
        sendResponse({ error: error.message });
    }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    try {
        if (changeInfo.status === 'complete') {
            const result = await chrome.storage.local.get(['alwaysActiveTabs']);
            const alwaysActiveTabs = result.alwaysActiveTabs || {};
            
            if (alwaysActiveTabs.hasOwnProperty(tabId.toString())) {
                alwaysActiveTabs[tabId.toString()] = {
                    ...alwaysActiveTabs[tabId.toString()],
                    title: tab.title,
                    url: tab.url,
                    favIconUrl: tab.favIconUrl,
                    lastUpdated: Date.now(),
                    closed: false
                };
                
                await chrome.storage.local.set({ alwaysActiveTabs });
                
                await injectAlwaysActiveScript(tabId);
                
                setTimeout(async () => {
                    try {
                        await chrome.tabs.sendMessage(tabId, { action: 'enableAlwaysActive' });
                    } catch (error) {}
                }, 1000);
            }
        }
        
        if (changeInfo.url && activeTabsPerformance[tabId]) {
            activeTabsPerformance[tabId].urlChanges = (activeTabsPerformance[tabId].urlChanges || 0) + 1;
        }
        
    } catch (error) {
        extensionStats.errors++;
    }
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
    try {
        const result = await chrome.storage.local.get(['alwaysActiveTabs']);
        const alwaysActiveTabs = result.alwaysActiveTabs || {};
        
        if (alwaysActiveTabs.hasOwnProperty(tabId.toString())) {
            alwaysActiveTabs[tabId.toString()].closed = true;
            alwaysActiveTabs[tabId.toString()].closedAt = Date.now();
            
            await chrome.storage.local.set({ alwaysActiveTabs });
            
            if (activeTabsPerformance[tabId]) {
                const sessionTime = Date.now() - activeTabsPerformance[tabId].startTime;
                extensionStats.totalDeactivations++;
                updateAverageActiveTime(sessionTime);
                
                delete activeTabsPerformance[tabId];
            }
        }
        
        updateBadge();
        
    } catch (error) {
        extensionStats.errors++;
    }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
    try {
        if (activeTabsPerformance[activeInfo.tabId]) {
            activeTabsPerformance[activeInfo.tabId].lastFocused = Date.now();
            activeTabsPerformance[activeInfo.tabId].focusCount = 
                (activeTabsPerformance[activeInfo.tabId].focusCount || 0) + 1;
        }
    } catch (error) {
        extensionStats.errors++;
    }
});

async function injectAlwaysActiveScript(tabId) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: ['injected.js']
        });
        
    } catch (error) {
        extensionStats.errors++;
        throw error;
    }
}

async function handleAlwaysActiveUpdate(tabId, isActive) {
    try {
        if (isActive) {
            activeTabsPerformance[tabId] = {
                startTime: Date.now(),
                activationCount: (activeTabsPerformance[tabId]?.activationCount || 0) + 1,
                lastActivity: Date.now(),
                memoryUsage: 0,
                errors: 0,
                focusCount: 0,
                urlChanges: 0
            };
            
            extensionStats.totalActivations++;
            
            await injectAlwaysActiveScript(parseInt(tabId));
            
        } else {
            if (activeTabsPerformance[tabId]) {
                const sessionTime = Date.now() - activeTabsPerformance[tabId].startTime;
                extensionStats.totalDeactivations++;
                updateAverageActiveTime(sessionTime);
                
                delete activeTabsPerformance[tabId];
            }
        }
        
        updateBadge();
        
    } catch (error) {
        extensionStats.errors++;
    }
}

async function getAlwaysActiveStatus(tabId, sendResponse) {
    try {
        const result = await chrome.storage.local.get(['alwaysActiveTabs']);
        const alwaysActiveTabs = result.alwaysActiveTabs || {};
        
        sendResponse({
            isActive: alwaysActiveTabs.hasOwnProperty(tabId.toString()) && 
                     !alwaysActiveTabs[tabId.toString()].closed
        });
    } catch (error) {
        sendResponse({ error: error.message });
    }
}

async function handleTabActiveCheck(tabId, sendResponse) {
    try {
        const result = await chrome.storage.local.get(['alwaysActiveTabs']);
        const alwaysActiveTabs = result.alwaysActiveTabs || {};
        
        const shouldStayActive = alwaysActiveTabs.hasOwnProperty(tabId.toString()) && 
                                !alwaysActiveTabs[tabId.toString()].closed;
        
        sendResponse({ shouldStayActive });
        
        if (shouldStayActive && !activeTabsPerformance[tabId]) {
            activeTabsPerformance[tabId] = {
                startTime: Date.now(),
                activationCount: 1,
                lastActivity: Date.now(),
                memoryUsage: 0,
                errors: 0,
                focusCount: 0,
                urlChanges: 0
            };
        }
        
    } catch (error) {
        sendResponse({ error: error.message });
    }
}

function handleTabActivated(tabId, tabStats) {
    if (activeTabsPerformance[tabId]) {
        activeTabsPerformance[tabId].lastActivity = Date.now();
        if (tabStats) {
            activeTabsPerformance[tabId].memoryUsage = tabStats.memoryUsage || 0;
            activeTabsPerformance[tabId].errors = tabStats.errors || 0;
        }
    }
}

function handleTabDeactivated(tabId, tabStats) {
    if (activeTabsPerformance[tabId]) {
        const sessionTime = Date.now() - activeTabsPerformance[tabId].startTime;
        updateAverageActiveTime(sessionTime);
        delete activeTabsPerformance[tabId];
    }
}

function handleTabUnloading(tabId, tabStats) {
    if (activeTabsPerformance[tabId]) {
        activeTabsPerformance[tabId].lastActivity = Date.now();
        activeTabsPerformance[tabId].urlChanges = 
            (activeTabsPerformance[tabId].urlChanges || 0) + 1;
    }
}

function updateAverageActiveTime(sessionTime) {
    const totalSessions = extensionStats.totalDeactivations;
    if (totalSessions === 1) {
        extensionStats.averageActiveTime = sessionTime;
    } else {
        extensionStats.averageActiveTime = 
            (extensionStats.averageActiveTime * (totalSessions - 1) + sessionTime) / totalSessions;
    }
}

async function updateBadge() {
    try {
        const result = await chrome.storage.local.get(['alwaysActiveTabs']);
        const alwaysActiveTabs = result.alwaysActiveTabs || {};
        const activeCount = Object.keys(alwaysActiveTabs).filter(
            tabId => !alwaysActiveTabs[tabId].closed
        ).length;
        
        if (activeCount > 0) {
            chrome.action.setBadgeText({ text: activeCount.toString() });
            chrome.action.setBadgeBackgroundColor({ color: '#00ff88' });
            chrome.action.setTitle({ 
                title: `TabRevive – Keep Tabs Alive - ${activeCount} tabs always active` 
            });
        } else {
            chrome.action.setBadgeText({ text: '' });
            chrome.action.setTitle({ title: 'TabRevive – Keep Tabs Alive - No active tabs' });
        }
    } catch (error) {
        extensionStats.errors++;
    }
}

function startBackgroundMonitoring() {
    cleanupInterval = setInterval(cleanupOldRecords, 300000);
    performanceInterval = setInterval(updatePerformanceStats, 30000);
}

async function cleanupOldRecords() {
    try {
        const result = await chrome.storage.local.get(['alwaysActiveTabs']);
        const alwaysActiveTabs = result.alwaysActiveTabs || {};
        const now = Date.now();
        const oneHour = 60 * 60 * 1000;
        const oneDay = 24 * oneHour;
        
        let cleanedCount = 0;
        
        for (const [tabId, tabInfo] of Object.entries(alwaysActiveTabs)) {
            if (tabInfo.closed && tabInfo.closedAt && (now - tabInfo.closedAt) > oneDay) {
                delete alwaysActiveTabs[tabId];
                cleanedCount++;
            }
            else if (!tabInfo.closed && tabInfo.lastUpdated && 
                    (now - tabInfo.lastUpdated) > oneHour) {
                try {
                    await chrome.tabs.get(parseInt(tabId));
                } catch {
                    tabInfo.closed = true;
                    tabInfo.closedAt = now;
                }
            }
        }
        
        if (cleanedCount > 0) {
            await chrome.storage.local.set({ alwaysActiveTabs });
        }
        
        updateBadge();
        
    } catch (error) {
        extensionStats.errors++;
    }
}

async function updatePerformanceStats() {
    try {
        extensionStats.uptime = Date.now() - extensionStats.startTime;
        extensionStats.activeTabCount = Object.keys(activeTabsPerformance).length;
        
        await chrome.storage.local.set({ extensionStats });
        
        for (const [tabId, perfData] of Object.entries(activeTabsPerformance)) {
            try {
                const response = await chrome.tabs.sendMessage(parseInt(tabId), {
                    action: 'getPerformanceStats'
                });
                
                if (response && response.stats) {
                    perfData.memoryUsage = response.stats.memoryUsage || 0;
                    perfData.errors = response.stats.errors || 0;
                    perfData.lastActivity = Date.now();
                }
            } catch (error) {
                perfData.errors = (perfData.errors || 0) + 1;
            }
        }
        
    } catch (error) {
        extensionStats.errors++;
    }
}

async function updateSettings(newSettings) {
    try {
        await chrome.storage.local.set({ extensionSettings: newSettings });
    } catch (error) {
        extensionStats.errors++;
    }
}

async function clearAllData() {
    try {
        await chrome.storage.local.clear();
        extensionStats = {
            startTime: Date.now(),
            totalActivations: 0,
            totalDeactivations: 0,
            averageActiveTime: 0,
            memoryUsage: 0,
            errors: 0
        };
        activeTabsPerformance = {};
        
        const optimalSettings = getOptimalSettings();
        await chrome.storage.local.set({
            alwaysActiveTabs: {},
            extensionSettings: optimalSettings,
            extensionStats: extensionStats
        });
        
        updateBadge();
    } catch (error) {
        extensionStats.errors++;
    }
}

function showWelcomeNotification() {
    chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'TabRevive – Keep Tabs Alive Installed!',
        message: 'Optimized settings applied. Click the extension icon to start.'
    });
}

function getOptimalSettings() {
    return {
        autoRefresh: false,
        autoRefreshInterval: 300000,
        enableNotifications: true,
        enablePerformanceMonitoring: true,
        maxActiveTabs: 25,
        aggressiveMode: true,
        enableSilentAudio: true,
        enableHeartbeat: true,
        heartbeatInterval: 500,
        enableMemoryMonitoring: true,
        memoryWarningThreshold: 750,
        autoDisableOnLowBattery: false
    };
}

chrome.commands.onCommand.addListener(async (command) => {
    try {
        if (command === 'toggle-current-tab') {
            const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (currentTab) {
                const result = await chrome.storage.local.get(['alwaysActiveTabs']);
                const alwaysActiveTabs = result.alwaysActiveTabs || {};
                
                if (alwaysActiveTabs.hasOwnProperty(currentTab.id.toString()) && 
                    !alwaysActiveTabs[currentTab.id.toString()].closed) {
                    delete alwaysActiveTabs[currentTab.id.toString()];
                    
                    try {
                        await chrome.tabs.sendMessage(currentTab.id, { action: 'disableAlwaysActive' });
                    } catch (error) {}
                    
                    chrome.notifications.create({
                        type: 'basic',
                        iconUrl: 'icons/icon48.png',
                        title: 'Always Active Disabled',
                        message: `Disabled for: ${currentTab.title}`
                    });
                } else {
                    alwaysActiveTabs[currentTab.id.toString()] = {
                        title: currentTab.title,
                        url: currentTab.url,
                        favIconUrl: currentTab.favIconUrl,
                        timestamp: Date.now(),
                        closed: false
                    };
                    
                    try {
                        await chrome.tabs.sendMessage(currentTab.id, { action: 'enableAlwaysActive' });
                    } catch (error) {}
                    
                    chrome.notifications.create({
                        type: 'basic',
                        iconUrl: 'icons/icon48.png',
                        title: 'Always Active Enabled',
                        message: `Enabled for: ${currentTab.title}`
                    });
                }
                
                await chrome.storage.local.set({ alwaysActiveTabs });
                handleAlwaysActiveUpdate(currentTab.id.toString(), alwaysActiveTabs.hasOwnProperty(currentTab.id.toString()));
            }
        } else if (command === 'disable-all-tabs') {
            const result = await chrome.storage.local.get(['alwaysActiveTabs']);
            const alwaysActiveTabs = result.alwaysActiveTabs || {};
            const activeTabIds = Object.keys(alwaysActiveTabs).filter(
                tabId => !alwaysActiveTabs[tabId].closed
            );
            
            if (activeTabIds.length === 0) {
                chrome.notifications.create({
                    type: 'basic',
                    iconUrl: 'icons/icon48.png',
                    title: 'No Active Tabs',
                    message: 'No tabs are currently always active'
                });
                return;
            }
            
            for (const tabId of activeTabIds) {
                try {
                    await chrome.tabs.sendMessage(parseInt(tabId), { action: 'disableAlwaysActive' });
                } catch (error) {}
                delete alwaysActiveTabs[tabId];
            }
            
            await chrome.storage.local.set({ alwaysActiveTabs });
            
            chrome.notifications.create({
                type: 'basic',
                iconUrl: 'icons/icon48.png',
                title: 'All Tabs Disabled',
                message: `Disabled always active for ${activeTabIds.length} tabs`
            });
            
            updateBadge();
        }
    } catch (error) {
        extensionStats.errors++;
    }
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
    try {
        if (windowId === chrome.windows.WINDOW_ID_NONE) return;
        
        const result = await chrome.storage.local.get(['alwaysActiveTabs']);
        const alwaysActiveTabs = result.alwaysActiveTabs || {};
        
        for (const [tabId, tabInfo] of Object.entries(alwaysActiveTabs)) {
            if (!tabInfo.closed) {
                try {
                    await chrome.tabs.sendMessage(parseInt(tabId), { action: 'ping' });
                } catch (error) {}
            }
        }
    } catch (error) {
        extensionStats.errors++;
    }
});

if (chrome.system && chrome.system.cpu && chrome.system.cpu.onUpdated) {
    chrome.system.cpu.onUpdated.addListener((cpuInfo) => {
        try {
            if (cpuInfo.usage > 90) {
                chrome.storage.local.get(['extensionSettings']).then(result => {
                    const settings = result.extensionSettings || getOptimalSettings();
                    if (settings.enablePerformanceMonitoring) {
                        chrome.notifications.create({
                            type: 'basic',
                            iconUrl: 'icons/icon48.png',
                            title: 'High CPU Usage Detected',
                            message: 'Consider reducing active tabs for better performance'
                        });
                    }
                });
            }
        } catch (error) {
            extensionStats.errors++;
        }
    });
}

if (chrome.system && chrome.system.memory && chrome.system.memory.onUpdated) {
    chrome.system.memory.onUpdated.addListener((memoryInfo) => {
        try {
            const usagePercent = (memoryInfo.usedCapacity / memoryInfo.capacity) * 100;
            if (usagePercent > 95) {
                chrome.storage.local.get(['extensionSettings']).then(result => {
                    const settings = result.extensionSettings || getOptimalSettings();
                    if (settings.enableMemoryMonitoring) {
                        chrome.notifications.create({
                            type: 'basic',
                            iconUrl: 'icons/icon48.png',
                            title: 'Critical Memory Usage',
                            message: 'System memory is critically low. Consider closing some active tabs.'
                        });
                    }
                });
            }
        } catch (error) {
            extensionStats.errors++;
        }
    });
}

if (chrome.idle && chrome.idle.onStateChanged) {
    chrome.idle.onStateChanged.addListener((state) => {
        try {
            chrome.storage.local.get(['extensionSettings', 'alwaysActiveTabs']).then(result => {
                const settings = result.extensionSettings || getOptimalSettings();
                const alwaysActiveTabs = result.alwaysActiveTabs || {};
                
                if (state === 'idle' && settings.autoDisableOnLowBattery) {
                    if (navigator.getBattery) {
                        navigator.getBattery().then(battery => {
                            if (battery.level < 0.2 && !battery.charging) {
                                const activeTabIds = Object.keys(alwaysActiveTabs).filter(
                                    tabId => !alwaysActiveTabs[tabId].closed
                                );
                                
                                if (activeTabIds.length > 0) {
                                    chrome.notifications.create({
                                        type: 'basic',
                                        iconUrl: 'icons/icon48.png',
                                        title: 'Battery Saver Mode',
                                        message: 'Disabling active tabs to preserve battery'
                                    });
                                    
                                    activeTabIds.forEach(async (tabId) => {
                                        try {
                                            await chrome.tabs.sendMessage(parseInt(tabId), { action: 'disableAlwaysActive' });
                                            delete alwaysActiveTabs[tabId];
                                        } catch (error) {}
                                    });
                                    
                                    chrome.storage.local.set({ alwaysActiveTabs });
                                    updateBadge();
                                }
                            }
                        });
                    }
                }
            });
        } catch (error) {
            extensionStats.errors++;
        }
    });
}

setInterval(async () => {
    try {
        const result = await chrome.storage.local.get(['alwaysActiveTabs', 'extensionSettings']);
        const alwaysActiveTabs = result.alwaysActiveTabs || {};
        const settings = result.extensionSettings || getOptimalSettings();
        
        if (settings.autoRefresh) {
            const activeTabIds = Object.keys(alwaysActiveTabs).filter(
                tabId => !alwaysActiveTabs[tabId].closed
            );
            
            for (const tabId of activeTabIds) {
                const tabInfo = alwaysActiveTabs[tabId];
                const timeSinceUpdate = Date.now() - (tabInfo.lastUpdated || tabInfo.timestamp);
                
                if (timeSinceUpdate > settings.autoRefreshInterval) {
                    try {
                        await chrome.tabs.reload(parseInt(tabId));
                        tabInfo.lastUpdated = Date.now();
                    } catch (error) {}
                }
            }
            
            await chrome.storage.local.set({ alwaysActiveTabs });
        }
    } catch (error) {
        extensionStats.errors++;
    }
}, 60000);

setInterval(() => {
    try {
        chrome.storage.local.set({ extensionStats });
    } catch (error) {
        extensionStats.errors++;
    }
}, 30000);

if (chrome.runtime.onSuspend) {
    chrome.runtime.onSuspend.addListener(() => {
        try {
            chrome.storage.local.set({ extensionStats });
        } catch (error) {}
    });
}

chrome.runtime.onStartup.addListener(() => {
    extensionStats.startTime = Date.now();
    updateBadge();
    startBackgroundMonitoring();
});

chrome.management.onEnabled.addListener((info) => {
    if (info.id === chrome.runtime.id) {
        startBackgroundMonitoring();
    }
});

chrome.management.onDisabled.addListener((info) => {
    if (info.id === chrome.runtime.id) {
        if (cleanupInterval) clearInterval(cleanupInterval);
        if (performanceInterval) clearInterval(performanceInterval);
    }
});

updateBadge();
startBackgroundMonitoring();