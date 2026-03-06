let currentSettings = {};

document.addEventListener('DOMContentLoaded', async () => {
    await loadSettings();
    await loadStatistics();
    setupEventListeners();
    startStatsUpdater();
});

async function loadSettings() {
    try {
        const result = await chrome.storage.local.get(['extensionSettings']);
        currentSettings = result.extensionSettings || getDefaultSettings();
        
        applySettingsToUI();
    } catch (error) {
        console.error('Failed to load settings:', error);
        showNotification('Failed to load settings', 'error');
    }
}

function applySettingsToUI() {
    Object.entries(currentSettings).forEach(([key, value]) => {
        const element = document.querySelector(`[data-setting="${key}"]`);
        if (!element) return;
        
        if (element.classList.contains('toggle-switch')) {
            if (value) {
                element.classList.add('active');
            } else {
                element.classList.remove('active');
            }
        } else if (element.type === 'number') {
            element.value = value;
        } else if (element.tagName === 'SELECT') {
            element.value = value;
        }
    });
}

async function loadStatistics() {
    try {
        const response = await chrome.runtime.sendMessage({ action: 'getExtensionStats' });
        if (response.extensionStats) {
            updateStatisticsDisplay(response.extensionStats);
        }
        
        const result = await chrome.storage.local.get(['alwaysActiveTabs']);
        const alwaysActiveTabs = result.alwaysActiveTabs || {};
        const currentActive = Object.keys(alwaysActiveTabs).filter(
            tabId => !alwaysActiveTabs[tabId].closed
        ).length;
        
        document.getElementById('currentActive').textContent = currentActive;
        
    } catch (error) {
        console.error('Failed to load statistics:', error);
    }
}

function updateStatisticsDisplay(stats) {
    document.getElementById('totalActivations').textContent = stats.totalActivations || 0;
    
    const avgTime = stats.averageActiveTime || 0;
    const avgMinutes = Math.round(avgTime / 60000);
    document.getElementById('averageActiveTime').textContent = avgMinutes > 0 ? `${avgMinutes}m` : '0m';
    
    const uptime = stats.uptime || 0;
    const uptimeHours = Math.round(uptime / 3600000);
    document.getElementById('extensionUptime').textContent = uptimeHours > 0 ? `${uptimeHours}h` : '< 1h';
}

function setupEventListeners() {
    document.querySelectorAll('.toggle-switch').forEach(toggle => {
        toggle.addEventListener('click', () => {
            const setting = toggle.dataset.setting;
            const isActive = toggle.classList.contains('active');
            
            toggle.classList.toggle('active');
            currentSettings[setting] = !isActive;
            
            if (setting === 'aggressiveMode' && !isActive) {
                enableAggressiveMode();
            }
        });
    });
    
    document.querySelectorAll('.number-input').forEach(input => {
        input.addEventListener('change', () => {
            const setting = input.dataset.setting;
            currentSettings[setting] = parseInt(input.value);
        });
    });
    
    document.querySelectorAll('.select-input').forEach(select => {
        select.addEventListener('change', () => {
            const setting = select.dataset.setting;
            currentSettings[setting] = parseInt(select.value);
        });
    });
    
    document.getElementById('saveBtn').addEventListener('click', saveSettings);
    document.getElementById('cancelBtn').addEventListener('click', () => window.close());
    document.getElementById('resetSettingsBtn').addEventListener('click', resetSettings);
    document.getElementById('clearDataBtn').addEventListener('click', clearAllData);
    document.getElementById('exportSettingsBtn').addEventListener('click', exportSettings);
    document.getElementById('importSettingsBtn').addEventListener('click', () => {
        document.getElementById('importFileInput').click();
    });
    
    document.getElementById('importFileInput').addEventListener('change', importSettings);
}

function enableAggressiveMode() {
    currentSettings.aggressiveMode = true;
    currentSettings.enableSilentAudio = true;
    currentSettings.enableHeartbeat = true;
    currentSettings.heartbeatInterval = 1000;
    currentSettings.enablePerformanceMonitoring = true;
    currentSettings.enableMemoryMonitoring = true;
    
    applySettingsToUI();
    showNotification('Aggressive mode enabled with optimal settings', 'success');
}

async function saveSettings() {
    try {
        await chrome.storage.local.set({ extensionSettings: currentSettings });
        
        await chrome.runtime.sendMessage({
            action: 'updateSettings',
            settings: currentSettings
        });
        
        showNotification('Settings saved successfully', 'success');
        
        setTimeout(() => {
            window.close();
        }, 1500);
        
    } catch (error) {
        console.error('Failed to save settings:', error);
        showNotification('Failed to save settings', 'error');
    }
}

async function resetSettings() {
    if (!confirm('Reset all settings to default values? This cannot be undone.')) {
        return;
    }
    
    try {
        currentSettings = getDefaultSettings();
        applySettingsToUI();
        showNotification('Settings reset to defaults', 'success');
    } catch (error) {
        console.error('Failed to reset settings:', error);
        showNotification('Failed to reset settings', 'error');
    }
}

async function clearAllData() {
    if (!confirm('Clear ALL extension data including active tabs and statistics? This cannot be undone.')) {
        return;
    }
    
    if (!confirm('Are you absolutely sure? This will remove all your active tabs and statistics permanently.')) {
        return;
    }
    
    try {
        await chrome.storage.local.clear();
        
        await chrome.runtime.sendMessage({ action: 'clearAllData' });
        
        showNotification('All data cleared successfully', 'success');
        
        setTimeout(() => {
            location.reload();
        }, 2000);
        
    } catch (error) {
        console.error('Failed to clear data:', error);
        showNotification('Failed to clear data', 'error');
    }
}

async function exportSettings() {
    try {
        const exportData = {
            settings: currentSettings,
            exportDate: new Date().toISOString(),
            version: '2.0.0'
        };
        
        const blob = new Blob([JSON.stringify(exportData, null, 2)], {
            type: 'application/json'
        });
        
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `activetab-pro-settings-${Date.now()}.json`;
        a.click();
        
        URL.revokeObjectURL(url);
        showNotification('Settings exported successfully', 'success');
        
    } catch (error) {
        console.error('Failed to export settings:', error);
        showNotification('Failed to export settings', 'error');
    }
}

async function importSettings(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    try {
        const text = await file.text();
        const importData = JSON.parse(text);
        
        if (importData.settings) {
            currentSettings = { ...getDefaultSettings(), ...importData.settings };
            applySettingsToUI();
            showNotification('Settings imported successfully', 'success');
        } else {
            throw new Error('Invalid settings file format');
        }
        
    } catch (error) {
        console.error('Failed to import settings:', error);
        showNotification('Failed to import settings - invalid file', 'error');
    }
    
    event.target.value = '';
}

function startStatsUpdater() {
    setInterval(loadStatistics, 5000);
}

function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = 'notification show';
    notification.textContent = message;
    
    switch (type) {
        case 'success':
            notification.style.background = '#00ff88';
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
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.classList.remove('show');
        setTimeout(() => {
            notification.remove();
        }, 300);
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