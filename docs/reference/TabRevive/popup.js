let currentTabId = null;
let extensionStartTime = Date.now();
let performanceData = {};
let updateInterval = null;

document.addEventListener('DOMContentLoaded', async () => {
    await initializePopup();
    setupEventListeners();
    startPerformanceMonitoring();
    
    updateInterval = setInterval(updateDynamicElements, 1000);
});

window.addEventListener('beforeunload', () => {
    if (updateInterval) clearInterval(updateInterval);
});

async function initializePopup() {
    try {
        const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        currentTabId = currentTab.id;
        
        const allTabs = await chrome.tabs.query({});
        
        const result = await chrome.storage.local.get(['alwaysActiveTabs', 'extensionSettings']);
        const alwaysActiveTabs = result.alwaysActiveTabs || {};
        const settings = result.extensionSettings || getDefaultSettings();
        
        await updateCurrentTabInfo(currentTab);
        updateStats(alwaysActiveTabs, allTabs);
        await updateActiveTabsList(alwaysActiveTabs, allTabs);
        updateToggleButton(currentTab.id, alwaysActiveTabs);
        updateGlobalStatus(alwaysActiveTabs);
        
    } catch (error) {
        console.error('Failed to initialize popup:', error);
        showNotification('Failed to load extension data', 'error');
    }
}

async function updateCurrentTabInfo(tab) {
    const titleEl = document.getElementById('currentTitle');
    const urlEl = document.getElementById('currentUrl');
    const faviconEl = document.getElementById('currentFavicon');
    const memoryEl = document.getElementById('tabMemory');
    const ageEl = document.getElementById('tabAge');
    const statusEl = document.getElementById('tabStatus');
    
    titleEl.textContent = tab.title || 'Unknown Title';
    
    try {
        const url = new URL(tab.url);
        urlEl.textContent = url.hostname;
    } catch {
        urlEl.textContent = 'Invalid URL';
    }
    
    if (tab.favIconUrl) {
        faviconEl.src = tab.favIconUrl;
        faviconEl.style.display = 'block';
        faviconEl.onerror = () => {
            faviconEl.style.display = 'none';
        };
    } else {
        faviconEl.style.display = 'none';
    }
    
    try {
        const processes = await chrome.processes.getProcessInfo([tab.id]);
        if (processes[tab.id]) {
            const memoryMB = Math.round(processes[tab.id].privateMemory / 1024 / 1024);
            memoryEl.textContent = `${memoryMB}MB`;
        } else {
            memoryEl.textContent = 'N/A';
        }
    } catch {
        memoryEl.textContent = 'N/A';
    }
    
    const tabAge = getTabAge(tab);
    ageEl.textContent = tabAge;
    
    const isActive = await isTabAlwaysActive(tab.id);
    statusEl.textContent = isActive ? 'Always Active' : 'Normal';
    statusEl.style.color = isActive ? '#00ff88' : '#666666';
}

function getTabAge(tab) {
    return '< 1h';
}

async function updateStats(alwaysActiveTabs, allTabs) {
    const activeCount = Object.keys(alwaysActiveTabs).filter(
        tabId => !alwaysActiveTabs[tabId].closed
    ).length;
    const totalCount = allTabs.length;
    
    document.getElementById('activeCount').textContent = activeCount;
    document.getElementById('totalTabs').textContent = totalCount;
    
    const uptime = Math.floor((Date.now() - extensionStartTime) / 1000);
    document.getElementById('uptime').textContent = formatDuration(uptime);
}

function formatDuration(seconds) {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h`;
}

async function updateActiveTabsList(alwaysActiveTabs, allTabs) {
    const listEl = document.getElementById('activeTabsList');
    const countEl = document.getElementById('activeTabsCount');
    
    const activeTabs = Object.entries(alwaysActiveTabs).filter(
        ([tabId, tabInfo]) => !tabInfo.closed
    );
    
    countEl.textContent = activeTabs.length;
    
    if (activeTabs.length === 0) {
        listEl.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">●</div>
                <div class="empty-state-text">No tabs are always active yet</div>
                <div class="empty-state-subtext">Click "Make Always Active" to start</div>
            </div>
        `;
        return;
    }
    
    listEl.innerHTML = '';
    
    for (const [tabId, tabInfo] of activeTabs) {
        const tabExists = allTabs.find(tab => tab.id.toString() === tabId);
        
        const itemEl = document.createElement('div');
        itemEl.className = 'active-tab-item';
        
        const hostname = tabInfo.url ? getHostname(tabInfo.url) : 'Unknown';
        const age = getTimeSince(tabInfo.timestamp);
        const isActive = tabExists && await isTabResponding(parseInt(tabId));
        
        itemEl.innerHTML = `
            <div class="active-tab-info">
                <div class="activity-indicator ${isActive ? '' : 'inactive'}"></div>
                <img class="tab-favicon-small" src="${tabInfo.favIconUrl || ''}" alt="" onerror="this.style.display='none'">
                <div style="flex: 1; min-width: 0;">
                    <div class="active-tab-title">
                        ${tabInfo.title || 'Unknown Title'}
                    </div>
                    <div class="active-tab-url">
                        ${hostname} • ${age}${!tabExists ? ' (closed)' : ''}
                    </div>
                </div>
            </div>
            <button class="remove-button" data-tab-id="${tabId}" title="Remove from always active">×</button>
        `;
        
        const removeBtn = itemEl.querySelector('.remove-button');
        removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            removeAlwaysActive(tabId);
        });
        
        itemEl.addEventListener('click', () => {
            if (tabExists) {
                chrome.tabs.update(parseInt(tabId), { active: true });
                window.close();
            }
        });
        
        listEl.appendChild(itemEl);
    }
}

function getHostname(url) {
    try {
        return new URL(url).hostname;
    } catch {
        return 'Invalid URL';
    }
}

function getTimeSince(timestamp) {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) return `${days}d`;
    if (hours > 0) return `${hours}h`;
    if (minutes > 0) return `${minutes}m`;
    return 'now';
}

async function isTabAlwaysActive(tabId) {
    const result = await chrome.storage.local.get(['alwaysActiveTabs']);
    const alwaysActiveTabs = result.alwaysActiveTabs || {};
    return alwaysActiveTabs.hasOwnProperty(tabId.toString()) && 
           !alwaysActiveTabs[tabId.toString()].closed;
}

async function isTabResponding(tabId) {
    try {
        const response = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
        return response && response.alive;
    } catch {
        return false;
    }
}

function updateToggleButton(currentTabId, alwaysActiveTabs) {
    const toggleBtn = document.getElementById('toggleButton');
    const isActive = alwaysActiveTabs.hasOwnProperty(currentTabId.toString()) &&
                    !alwaysActiveTabs[currentTabId.toString()].closed;
    
    if (isActive) {
        toggleBtn.textContent = 'Disable Always Active';
        toggleBtn.classList.add('active');
    } else {
        toggleBtn.textContent = 'Make Always Active';
        toggleBtn.classList.remove('active');
    }
}

function updateGlobalStatus(alwaysActiveTabs) {
    const statusIndicator = document.getElementById('globalStatus');
    const statusText = document.getElementById('statusText');
    
    const activeCount = Object.keys(alwaysActiveTabs).filter(
        tabId => !alwaysActiveTabs[tabId].closed
    ).length;
    
    if (activeCount > 0) {
        statusIndicator.classList.remove('inactive');
        statusText.textContent = `${activeCount} tabs active`;
    } else {
        statusIndicator.classList.add('inactive');
        statusText.textContent = 'No active tabs';
    }
}

function setupEventListeners() {
    document.getElementById('toggleButton').addEventListener('click', () => {
        toggleAlwaysActive(currentTabId);
    });
    
    document.getElementById('refreshAllBtn').addEventListener('click', refreshAllActiveTabs);
    document.getElementById('muteAllBtn').addEventListener('click', muteAllActiveTabs);
    document.getElementById('exportBtn').addEventListener('click', exportActiveTabsList);
    document.getElementById('settingsBtn').addEventListener('click', openSettings);
    
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        if (changeInfo.status === 'complete') {
            setTimeout(() => {
                location.reload();
            }, 100);
        }
    });
    
    chrome.tabs.onRemoved.addListener(() => {
        setTimeout(() => {
            location.reload();
        }, 100);
    });
}

async function toggleAlwaysActive(tabId) {
    try {
        const result = await chrome.storage.local.get(['alwaysActiveTabs']);
        const alwaysActiveTabs = result.alwaysActiveTabs || {};
        
        if (alwaysActiveTabs.hasOwnProperty(tabId.toString()) && 
            !alwaysActiveTabs[tabId.toString()].closed) {
            delete alwaysActiveTabs[tabId.toString()];
            
            try {
                await chrome.tabs.sendMessage(tabId, { action: 'disableAlwaysActive' });
                showNotification('Always Active disabled', 'success');
            } catch (error) {
                console.log('Could not send disable message to tab:', error);
            }
        } else {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            alwaysActiveTabs[tabId.toString()] = {
                title: tab.title,
                url: tab.url,
                favIconUrl: tab.favIconUrl,
                timestamp: Date.now(),
                closed: false
            };
            
            try {
                await chrome.tabs.sendMessage(tabId, { action: 'enableAlwaysActive' });
                showNotification('Always Active enabled', 'success');
            } catch (error) {
                console.log('Could not send enable message to tab:', error);
                showNotification('Warning: Content script not ready', 'warning');
            }
        }
        
        await chrome.storage.local.set({ alwaysActiveTabs });
        
        chrome.runtime.sendMessage({ 
            action: 'updateAlwaysActive', 
            tabId: tabId.toString(),
            isActive: alwaysActiveTabs.hasOwnProperty(tabId.toString())
        });
        
        setTimeout(() => location.reload(), 100);
        
    } catch (error) {
        console.error('Failed to toggle always active:', error);
        showNotification('Failed to toggle always active', 'error');
    }
}

async function removeAlwaysActive(tabId) {
    try {
        const result = await chrome.storage.local.get(['alwaysActiveTabs']);
        const alwaysActiveTabs = result.alwaysActiveTabs || {};
        
        delete alwaysActiveTabs[tabId];
        
        try {
            await chrome.tabs.sendMessage(parseInt(tabId), { action: 'disableAlwaysActive' });
        } catch (error) {
            console.log('Could not send disable message to tab:', error);
        }
        
        await chrome.storage.local.set({ alwaysActiveTabs });
        
        chrome.runtime.sendMessage({ 
            action: 'updateAlwaysActive', 
            tabId: tabId,
            isActive: false
        });
        
        showNotification('Tab removed from always active', 'success');
        
        setTimeout(() => location.reload(), 100);
        
    } catch (error) {
        console.error('Failed to remove always active:', error);
        showNotification('Failed to remove tab', 'error');
    }
}

async function refreshAllActiveTabs() {
    try {
        const result = await chrome.storage.local.get(['alwaysActiveTabs']);
        const alwaysActiveTabs = result.alwaysActiveTabs || {};
        
        const refreshPromises = Object.keys(alwaysActiveTabs)
            .filter(tabId => !alwaysActiveTabs[tabId].closed)
            .map(async (tabId) => {
                try {
                    await chrome.tabs.reload(parseInt(tabId));
                } catch (error) {
                    console.log(`Could not refresh tab ${tabId}:`, error);
                }
            });
        
        await Promise.all(refreshPromises);
        showNotification('All active tabs refreshed', 'success');
        
    } catch (error) {
        console.error('Failed to refresh tabs:', error);
        showNotification('Failed to refresh tabs', 'error');
    }
}

async function muteAllActiveTabs() {
    try {
        const result = await chrome.storage.local.get(['alwaysActiveTabs']);
        const alwaysActiveTabs = result.alwaysActiveTabs || {};
        
        const mutePromises = Object.keys(alwaysActiveTabs)
            .filter(tabId => !alwaysActiveTabs[tabId].closed)
            .map(async (tabId) => {
                try {
                    const tab = await chrome.tabs.get(parseInt(tabId));
                    await chrome.tabs.update(parseInt(tabId), { muted: !tab.mutedInfo.muted });
                } catch (error) {
                    console.log(`Could not toggle mute for tab ${tabId}:`, error);
                }
            });
        
        await Promise.all(mutePromises);
        showNotification('Tab audio toggled', 'success');
        
    } catch (error) {
        console.error('Failed to mute tabs:', error);
        showNotification('Failed to toggle audio', 'error');
    }
}

async function exportActiveTabsList() {
    try {
        const result = await chrome.storage.local.get(['alwaysActiveTabs']);
        const alwaysActiveTabs = result.alwaysActiveTabs || {};
        
        const exportData = Object.entries(alwaysActiveTabs)
            .filter(([tabId, tabInfo]) => !tabInfo.closed)
            .map(([tabId, tabInfo]) => ({
                title: tabInfo.title,
                url: tabInfo.url,
                timestamp: new Date(tabInfo.timestamp).toISOString()
            }));
        
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { 
            type: 'application/json' 
        });
        
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `activetab-pro-export-${Date.now()}.json`;
        a.click();
        
        URL.revokeObjectURL(url);
        showNotification('Export downloaded', 'success');
        
    } catch (error) {
        console.error('Failed to export:', error);
        showNotification('Failed to export', 'error');
    }
}

function openSettings() {
    chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
}

function startPerformanceMonitoring() {
    setInterval(updatePerformanceIndicator, 5000);
    updatePerformanceIndicator();
}

async function updatePerformanceIndicator() {
    const perfDot = document.getElementById('perfDot');
    const perfText = document.getElementById('perfText');
    
    try {
        if (chrome.system && chrome.system.memory) {
            const memInfo = await chrome.system.memory.getInfo();
            const usagePercent = (memInfo.usedCapacity / memInfo.capacity) * 100;
            
            if (usagePercent > 90) {
                perfDot.className = 'performance-dot error';
                perfText.textContent = 'High';
            } else if (usagePercent > 70) {
                perfDot.className = 'performance-dot warning';
                perfText.textContent = 'Medium';
            } else {
                perfDot.className = 'performance-dot';
                perfText.textContent = 'Normal';
            }
        } else {
            perfDot.className = 'performance-dot';
            perfText.textContent = 'Normal';
        }
    } catch (error) {
        perfDot.className = 'performance-dot';
        perfText.textContent = 'Normal';
    }
}

function updateDynamicElements() {
    const uptime = Math.floor((Date.now() - extensionStartTime) / 1000);
    document.getElementById('uptime').textContent = formatDuration(uptime);
}

function showNotification(message, type = 'info') {
    const notification = document.getElementById('notification');
    
    switch (type) {
        case 'success':
            notification.style.background = '#00ff88';
            notification.style.color = '#000000';
            break;
        case 'warning':
            notification.style.background = '#ffa502';
            notification.style.color = '#000000';
            break;
        case 'error':
            notification.style.background = '#ff4757';
            notification.style.color = '#ffffff';
            break;
        default:
            notification.style.background = '#00ccff';
            notification.style.color = '#000000';
    }
    
    notification.textContent = message;
    notification.classList.add('show');
    
    setTimeout(() => {
        notification.classList.remove('show');
    }, 3000);
}

function getDefaultSettings() {
    return {
        autoRefresh: false,
        autoRefreshInterval: 300000,
        enableNotifications: true,
        enablePerformanceMonitoring: true,
        maxActiveTabs: 25,
        aggressiveMode: true,
        enableSilentAudio: true,
        enableHeartbeat: true,
        heartbeatInterval: 1000,
        enableMemoryMonitoring: true,
        memoryWarningThreshold: 500,
        autoDisableOnLowBattery: false
    };
}