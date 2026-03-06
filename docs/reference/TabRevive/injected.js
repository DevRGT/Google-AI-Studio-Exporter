(function() {
    'use strict';
    
    let alwaysActiveEnabled = false;
    let originalAPIs = {};
    let keepAliveInterval = null;
    let audioContext = null;
    let silentAudioBuffer = null;
    let audioSource = null;
    let wakeLock = null;
    let observers = [];
    
    function storeOriginalAPIs() {
        originalAPIs = {
            hidden: Object.getOwnPropertyDescriptor(Document.prototype, 'hidden'),
            visibilityState: Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState'),
            hasFocus: Document.prototype.hasFocus,
            addEventListener: Document.prototype.addEventListener,
            removeEventListener: Document.prototype.removeEventListener,
            requestAnimationFrame: window.requestAnimationFrame,
            setTimeout: window.setTimeout,
            setInterval: window.setInterval,
            clearTimeout: window.clearTimeout,
            clearInterval: window.clearInterval,
            Date: window.Date,
            performance: window.performance,
            IntersectionObserver: window.IntersectionObserver,
            ResizeObserver: window.ResizeObserver,
            MutationObserver: window.MutationObserver
        };
    }
    
    function createSilentAudio() {
        try {
            if (!audioContext) {
                audioContext = new (window.AudioContext || window.webkitAudioContext)();
                
                const buffer = audioContext.createBuffer(1, 1, 22050);
                const source = audioContext.createBufferSource();
                const gainNode = audioContext.createGain();
                
                gainNode.gain.value = 0.001;
                source.buffer = buffer;
                source.connect(gainNode);
                gainNode.connect(audioContext.destination);
                source.loop = true;
                source.start(0);
                
                audioSource = source;
                
                setInterval(() => {
                    if (alwaysActiveEnabled && audioContext && audioContext.state === 'suspended') {
                        audioContext.resume().catch(() => {});
                    }
                }, 1000);
            }
        } catch (error) {
            console.log('Silent audio creation failed:', error);
        }
    }
    
    function requestWakeLock() {
        if ('wakeLock' in navigator) {
            navigator.wakeLock.request('screen').then(lock => {
                wakeLock = lock;
            }).catch(() => {});
        }
    }
    
    function overrideVisibilityAPI() {
        Object.defineProperty(Document.prototype, 'hidden', {
            get: function() {
                return alwaysActiveEnabled ? false : (originalAPIs.hidden ? originalAPIs.hidden.get.call(this) : false);
            },
            configurable: true
        });
        
        Object.defineProperty(Document.prototype, 'visibilityState', {
            get: function() {
                return alwaysActiveEnabled ? 'visible' : (originalAPIs.visibilityState ? originalAPIs.visibilityState.get.call(this) : 'visible');
            },
            configurable: true
        });
        
        Document.prototype.hasFocus = function() {
            return alwaysActiveEnabled ? true : originalAPIs.hasFocus.call(this);
        };
    }
    
    function overrideEventListeners() {
        const blockedEvents = ['visibilitychange', 'blur', 'pagehide', 'beforeunload', 'unload', 'freeze', 'resume'];
        const allowedEvents = ['focus', 'pageshow'];
        
        Document.prototype.addEventListener = function(type, listener, options) {
            if (alwaysActiveEnabled && blockedEvents.includes(type)) {
                const wrappedListener = function(event) {
                    if (!alwaysActiveEnabled) {
                        listener.call(this, event);
                    }
                };
                
                if (!this._alwaysActiveListeners) {
                    this._alwaysActiveListeners = new Map();
                }
                this._alwaysActiveListeners.set(listener, wrappedListener);
                
                return originalAPIs.addEventListener.call(this, type, wrappedListener, options);
            }
            return originalAPIs.addEventListener.call(this, type, listener, options);
        };
        
        window.addEventListener = function(type, listener, options) {
            if (alwaysActiveEnabled && blockedEvents.includes(type)) {
                const wrappedListener = function(event) {
                    if (!alwaysActiveEnabled || allowedEvents.includes(type)) {
                        listener.call(this, event);
                    }
                };
                return originalAPIs.addEventListener.call(this, type, wrappedListener, options);
            }
            return originalAPIs.addEventListener.call(this, type, listener, options);
        };
    }
    
    function overrideTimersAndRAF() {
        window.requestAnimationFrame = function(callback) {
            if (alwaysActiveEnabled) {
                const startTime = performance.now();
                return originalAPIs.requestAnimationFrame.call(this, function(timestamp) {
                    callback(timestamp || startTime + 16);
                }) || setTimeout(() => callback(performance.now()), 16);
            }
            return originalAPIs.requestAnimationFrame.call(this, callback);
        };
        
        window.setTimeout = function(callback, delay, ...args) {
            if (alwaysActiveEnabled) {
                delay = Math.max(delay || 0, 1);
                delay += Math.random() * 2;
            }
            return originalAPIs.setTimeout.call(this, callback, delay, ...args);
        };
        
        window.setInterval = function(callback, delay, ...args) {
            if (alwaysActiveEnabled) {
                delay = Math.max(delay || 0, 1);
                delay += Math.random() * 2;
            }
            return originalAPIs.setInterval.call(this, callback, delay, ...args);
        };
    }
    
    function overrideWebAudio() {
        if (window.AudioContext) {
            const originalAudioContext = window.AudioContext;
            window.AudioContext = function(...args) {
                const context = new originalAudioContext(...args);
                
                if (alwaysActiveEnabled) {
                    const originalSuspend = context.suspend.bind(context);
                    context.suspend = function() {
                        return Promise.resolve();
                    };
                    
                    setInterval(() => {
                        if (context.state === 'suspended' && alwaysActiveEnabled) {
                            context.resume().catch(() => {});
                        }
                    }, 1000);
                }
                
                return context;
            };
            
            Object.setPrototypeOf(window.AudioContext, originalAudioContext);
            Object.defineProperty(window.AudioContext, 'prototype', {
                value: originalAudioContext.prototype,
                writable: false
            });
        }
    }
    
    function overridePerformanceAPI() {
        if (window.performance && window.performance.now) {
            const originalNow = window.performance.now.bind(window.performance);
            let timeOffset = 0;
            
            window.performance.now = function() {
                const realTime = originalNow();
                if (alwaysActiveEnabled) {
                    timeOffset += Math.random() * 0.1;
                    return realTime + timeOffset;
                }
                return realTime;
            };
        }
    }
    
    function overrideIntersectionObserver() {
        if (window.IntersectionObserver) {
            const OriginalIntersectionObserver = window.IntersectionObserver;
            
            window.IntersectionObserver = function(callback, options) {
                const wrappedCallback = function(entries, observer) {
                    if (alwaysActiveEnabled) {
                        entries.forEach(entry => {
                            Object.defineProperty(entry, 'intersectionRatio', { value: 1, writable: false });
                            Object.defineProperty(entry, 'isIntersecting', { value: true, writable: false });
                            Object.defineProperty(entry, 'isVisible', { value: true, writable: false });
                        });
                    }
                    callback(entries, observer);
                };
                
                const observer = new OriginalIntersectionObserver(wrappedCallback, options);
                observers.push(observer);
                return observer;
            };
            
            window.IntersectionObserver.prototype = OriginalIntersectionObserver.prototype;
        }
    }
    
    function overrideDateAndTime() {
        const originalDate = Date;
        let timeOffset = 0;
        
        window.Date = function(...args) {
            if (args.length === 0) {
                const realTime = originalDate.now();
                if (alwaysActiveEnabled) {
                    timeOffset += Math.random() * 100;
                    return new originalDate(realTime + timeOffset);
                }
                return new originalDate();
            }
            return new originalDate(...args);
        };
        
        window.Date.now = function() {
            const realTime = originalDate.now();
            if (alwaysActiveEnabled) {
                timeOffset += Math.random() * 100;
                return realTime + timeOffset;
            }
            return realTime;
        };
        
        Object.setPrototypeOf(window.Date, originalDate);
        Object.defineProperty(window.Date, 'prototype', {
            value: originalDate.prototype,
            writable: false
        });
    }
    
    function overrideNetworkAPIs() {
        const originalFetch = window.fetch;
        window.fetch = function(...args) {
            if (alwaysActiveEnabled) {
                const url = args[0];
                if (typeof url === 'string' && url.includes('visibility') || url.includes('focus')) {
                    return Promise.resolve(new Response('{"visible": true, "focused": true}'));
                }
            }
            return originalFetch.apply(this, args);
        };
        
        const originalXHROpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url, ...args) {
            if (alwaysActiveEnabled && typeof url === 'string') {
                if (url.includes('visibility') || url.includes('focus') || url.includes('blur')) {
                    url = url.replace(/blur|hidden|background/g, 'focus');
                }
            }
            return originalXHROpen.call(this, method, url, ...args);
        };
    }
    
    function overrideUserActivity() {
        const events = ['mousemove', 'mousedown', 'mouseup', 'keydown', 'keyup', 'scroll', 'touchstart', 'touchend'];
        
        function simulateActivity() {
            if (!alwaysActiveEnabled) return;
            
            events.forEach(eventType => {
                const event = new Event(eventType, { bubbles: true });
                Object.defineProperty(event, 'isTrusted', { value: true, writable: false });
                document.dispatchEvent(event);
            });
        }
        
        setInterval(simulateActivity, 30000);
    }
    
    function startAggressiveKeepAlive() {
        if (keepAliveInterval) return;
        
        keepAliveInterval = setInterval(() => {
            if (!alwaysActiveEnabled) return;
            
            try {
                document.documentElement.scrollTop = document.documentElement.scrollTop;
                
                const event = new CustomEvent('alwaysActiveHeartbeat', { 
                    detail: { timestamp: Date.now() }
                });
                document.dispatchEvent(event);
                
                let heartbeat = document.getElementById('always-active-heartbeat');
                if (!heartbeat) {
                    heartbeat = document.createElement('div');
                    heartbeat.id = 'always-active-heartbeat';
                    heartbeat.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px;opacity:0;';
                    document.body.appendChild(heartbeat);
                }
                heartbeat.textContent = Date.now();
                
                if (audioContext && audioContext.state === 'suspended') {
                    audioContext.resume().catch(() => {});
                }
                
                requestAnimationFrame(() => {});
                
                if (wakeLock && wakeLock.released) {
                    requestWakeLock();
                }
                
                window.dispatchEvent(new Event('focus'));
                document.dispatchEvent(new Event('visibilitychange'));
                
            } catch (error) {
                console.error('Keep-alive error:', error);
            }
        }, 500);
    }
    
    function stopKeepAlive() {
        if (keepAliveInterval) {
            clearInterval(keepAliveInterval);
            keepAliveInterval = null;
        }
        
        if (audioSource) {
            try {
                audioSource.stop();
            } catch {}
            audioSource = null;
        }
        
        if (audioContext) {
            try {
                audioContext.close();
            } catch {}
            audioContext = null;
        }
        
        if (wakeLock) {
            wakeLock.release();
            wakeLock = null;
        }
    }
    
    function initializeAllOverrides() {
        storeOriginalAPIs();
        overrideVisibilityAPI();
        overrideEventListeners();
        overrideTimersAndRAF();
        overrideWebAudio();
        overridePerformanceAPI();
        overrideIntersectionObserver();
        overrideDateAndTime();
        overrideNetworkAPIs();
        overrideUserActivity();
    }
    
    window.addEventListener('message', function(event) {
        if (event.data && event.data.source === 'always-active-extension') {
            if (event.data.type === 'ALWAYS_ACTIVE_ENABLE') {
                alwaysActiveEnabled = true;
                
                startAggressiveKeepAlive();
                createSilentAudio();
                requestWakeLock();
                
                const focusEvent = new Event('focus');
                window.dispatchEvent(focusEvent);
                
                window.postMessage({
                    type: 'ALWAYS_ACTIVE_STATUS',
                    source: 'always-active-injected',
                    enabled: true
                }, '*');
                
            } else if (event.data.type === 'ALWAYS_ACTIVE_DISABLE') {
                alwaysActiveEnabled = false;
                stopKeepAlive();
                
                window.postMessage({
                    type: 'ALWAYS_ACTIVE_STATUS',
                    source: 'always-active-injected',
                    enabled: false
                }, '*');
            }
        }
    });
    
    initializeAllOverrides();
    
    window.alwaysActiveDebug = {
        getStatus: () => ({
            enabled: alwaysActiveEnabled,
            documentHidden: document.hidden,
            visibilityState: document.visibilityState,
            hasFocus: document.hasFocus(),
            audioContext: audioContext ? audioContext.state : 'none',
            keepAliveActive: !!keepAliveInterval,
            wakeLock: wakeLock ? 'active' : 'none'
        }),
        forceEnable: () => {
            window.postMessage({
                type: 'ALWAYS_ACTIVE_ENABLE',
                source: 'always-active-extension'
            }, '*');
        },
        forceDisable: () => {
            window.postMessage({
                type: 'ALWAYS_ACTIVE_DISABLE',
                source: 'always-active-extension'
            }, '*');
        }
    };
    
})();