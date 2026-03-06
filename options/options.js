import { setDirectoryHandle, getDirectoryHandle } from '../utils/idb-storage.js';

const HANDLE_KEY = 'export_directory';
const SETTINGS_KEY = 'exportSettings';

const DEFAULT_SETTINGS = {
    format: 'markdown',
    includeThoughts: true,
    fileNaming: 'title',
};

document.addEventListener('DOMContentLoaded', async () => {
    const btn = document.getElementById('selectFolderBtn');
    const statusPanel = document.getElementById('statusPanel');
    const statusText = document.getElementById('statusText');
    const dirNameEl = document.getElementById('directoryName');

    // --- Folder Configuration ---

    async function updateStatus() {
        try {
            const handle = await getDirectoryHandle(HANDLE_KEY);
            if (handle) {
                const permission = await handle.queryPermission({ mode: 'readwrite' });
                if (permission === 'granted') {
                    statusPanel.className = 'status-panel success';
                    statusText.textContent = 'Ready to export.';
                    dirNameEl.textContent = `Target Folder: ${handle.name}`;
                    btn.textContent = '📁 Select a Different Folder';
                    btn.dataset.action = 'change';
                } else {
                    statusPanel.className = 'status-panel error';
                    statusText.textContent = 'Access to this folder needs to be re-authorized.';
                    dirNameEl.textContent = `Current Folder: ${handle.name}`;
                    btn.textContent = '✅ Authorize This Folder';
                    btn.dataset.action = 'authorize';
                }
            } else {
                statusPanel.className = 'status-panel error';
                statusText.textContent = 'No export folder selected.';
                dirNameEl.textContent = '';
                btn.textContent = '📁 Select Export Folder';
                btn.dataset.action = 'new';
            }
        } catch (e) {
            console.error(e);
            statusPanel.className = 'status-panel error';
            statusText.textContent = 'Error checking status.';
        }
    }

    btn.addEventListener('click', async () => {
        try {
            const action = btn.dataset.action;
            const handle = await getDirectoryHandle(HANDLE_KEY);

            if (action === 'authorize' && handle) {
                const permission = await handle.requestPermission({ mode: 'readwrite' });
                if (permission === 'granted') {
                    await updateStatus();
                    return;
                }
            }

            const directoryHandle = await window.showDirectoryPicker({
                mode: 'readwrite'
            });
            await setDirectoryHandle(HANDLE_KEY, directoryHandle);
            await updateStatus();
        } catch (err) {
            if (err.name !== 'AbortError') {
                console.error("Directory picker error:", err);
                alert("Failed to select folder: " + err.message);
            }
        }
    });

    // Check if running in a popup
    if (window.innerWidth < 400 || window.innerHeight < 400) {
        const popupWarning = document.createElement('div');
        popupWarning.className = 'popup-warning';
        popupWarning.innerHTML = '<strong>Tip:</strong> Popups lose permission quickly. For a stable sync, <a href="#" id="openInTab">Open Options in a Full Tab</a>.';
        document.querySelector('.card').appendChild(popupWarning);

        document.getElementById('openInTab').addEventListener('click', (e) => {
            e.preventDefault();
            chrome.runtime.openOptionsPage();
        });
    }

    updateStatus();

    // --- Export Settings ---

    const includeThoughtsEl = document.getElementById('includeThoughts');
    const fileNamingEl = document.getElementById('fileNaming');
    const formatRadios = document.querySelectorAll('input[name="exportFormat"]');
    const radioOptions = document.querySelectorAll('.radio-option');
    const saveIndicator = document.getElementById('saveIndicator');

    // Load settings
    async function loadSettings() {
        try {
            const result = await chrome.storage.sync.get(SETTINGS_KEY);
            const settings = { ...DEFAULT_SETTINGS, ...(result[SETTINGS_KEY] || {}) };

            // Apply to UI
            formatRadios.forEach(radio => {
                if (radio.value === settings.format) {
                    radio.checked = true;
                }
            });
            updateRadioSelection();

            includeThoughtsEl.checked = settings.includeThoughts;
            fileNamingEl.value = settings.fileNaming;
        } catch (e) {
            console.error('Failed to load settings:', e);
        }
    }

    // Save settings
    async function saveSettings() {
        const selectedFormat = document.querySelector('input[name="exportFormat"]:checked')?.value || 'markdown';
        const settings = {
            format: selectedFormat,
            includeThoughts: includeThoughtsEl.checked,
            fileNaming: fileNamingEl.value,
        };

        try {
            await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
            showSaveIndicator();
        } catch (e) {
            console.error('Failed to save settings:', e);
        }
    }

    function showSaveIndicator() {
        saveIndicator.classList.add('visible');
        setTimeout(() => saveIndicator.classList.remove('visible'), 1500);
    }

    function updateRadioSelection() {
        radioOptions.forEach(opt => {
            const input = opt.querySelector('input[type="radio"]');
            if (input && !input.disabled) {
                opt.classList.toggle('selected', input.checked);
            }
        });
    }

    // Event listeners for auto-save
    formatRadios.forEach(radio => {
        radio.addEventListener('change', () => {
            updateRadioSelection();
            saveSettings();
        });
    });

    // Click on radio option label
    radioOptions.forEach(opt => {
        opt.addEventListener('click', (e) => {
            const input = opt.querySelector('input[type="radio"]');
            if (input && !input.disabled) {
                input.checked = true;
                input.dispatchEvent(new Event('change'));
            }
        });
    });

    includeThoughtsEl.addEventListener('change', saveSettings);
    fileNamingEl.addEventListener('change', saveSettings);

    loadSettings();
});
