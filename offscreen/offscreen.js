// Offscreen document for audio keepalive.
// Prevents macOS App Nap and Chrome background throttling during bulk export.
// Uses an <audio> element playing a silent MP3 — this is recognized by Chrome's
// audio mixer (unlike AudioContext oscillators below 20Hz) and signals to macOS
// that the app is producing audio output, disabling App Nap.

let keepAliveAudio = null;

chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'START_KEEPALIVE') {
        startKeepAlive();
    } else if (msg.action === 'STOP_KEEPALIVE') {
        stopKeepAlive();
    }
});

function startKeepAlive() {
    if (keepAliveAudio) return;
    try {
        const audio = document.createElement('audio');
        audio.src = chrome.runtime.getURL('assets/silence.wav');
        audio.loop = true;
        audio.volume = 0.05;
        document.body.appendChild(audio);
        audio.play().then(() => {
            console.log('[Offscreen] Audio keepalive started (playing silent MP3)');
        }).catch((e) => {
            console.warn('[Offscreen] Audio play failed:', e);
        });
        keepAliveAudio = audio;
    } catch (e) {
        console.warn('[Offscreen] Audio keepalive failed:', e);
    }
}

function stopKeepAlive() {
    if (keepAliveAudio) {
        try {
            keepAliveAudio.pause();
            keepAliveAudio.remove();
        } catch (e) { /* ignore */ }
        keepAliveAudio = null;
        console.log('[Offscreen] Audio keepalive stopped');
    }
}
