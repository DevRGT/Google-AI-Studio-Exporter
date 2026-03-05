// ============================================================================
// DOM Capture Module — Ported from the UserScript's captureData() logic
// Shared between single-export and future features.
// Loaded as a content_script (no ES modules), exposes functions on `window.DOMCapture`.
// ============================================================================

(function () {
    'use strict';

    const ROLE_USER = 'User';
    const ROLE_GEMINI = 'Gemini';
    const ROLE_GEMINI_THOUGHTS = 'Gemini-Thoughts';

    // --- State ---
    let collectedData = new Map();
    let turnOrder = [];
    let processedTurnIds = new Set();

    function resetState() {
        collectedData = new Map();
        turnOrder = [];
        processedTurnIds = new Set();
    }

    // --- HTML → Markdown conversion ---

    function htmlToMarkdown(node, listContext = null, indent = 0) {
        if (!node) return '';
        if (node.nodeType === Node.TEXT_NODE) {
            return node.textContent;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return '';

        const tag = node.tagName.toLowerCase();

        if (tag === 'img') {
            const alt = node.getAttribute('alt') || '';
            const src = node.getAttribute('src') || '';
            return `![${alt}](${src})`;
        }

        if (tag === 'pre') {
            const codeEl = node.querySelector('code');
            if (codeEl) {
                const language = Array.from(codeEl.classList).find(c => c.startsWith('language-'))?.replace('language-', '') || '';
                const code = codeEl.textContent;
                return `\n\`\`\`${language}\n${code}\n\`\`\`\n`;
            }
        }

        if (tag === 'code') {
            const text = node.textContent;
            if (text.includes('`')) {
                return `\`\` ${text.trim()} \`\``;
            }
            return `\`${text}\``;
        }

        if (/^h[1-6]$/.test(tag)) {
            const level = parseInt(tag[1]);
            return '\n' + '#'.repeat(level) + ' ' + getChildrenText(node, listContext, indent) + '\n';
        }

        if (tag === 'strong' || tag === 'b') {
            return `**${getChildrenText(node, listContext, indent)}**`;
        }

        if (tag === 'em' || tag === 'i') {
            return `*${getChildrenText(node, listContext, indent)}*`;
        }

        if (tag === 'a') {
            const href = node.getAttribute('href') || '';
            const text = getChildrenText(node, listContext, indent);
            return `[${text}](${href})`;
        }

        if (tag === 'ul' || tag === 'ol') {
            const listType = tag;
            let index = 0;
            let result = '\n';
            for (const child of node.childNodes) {
                if (child.nodeType === Node.ELEMENT_NODE && child.tagName.toLowerCase() === 'li') {
                    index++;
                    result += htmlToMarkdown(child, { type: listType, index: index }, indent + 1);
                } else {
                    result += htmlToMarkdown(child, listContext, indent + 1);
                }
            }
            return result + '\n';
        }

        if (tag === 'li') {
            const content = getChildrenText(node, listContext, indent).trim();
            if (!content) return '';
            const indentStr = '  '.repeat(Math.max(0, indent - 1));
            if (listContext && listContext.type === 'ol') {
                return `${indentStr}${listContext.index}. ${content}\n`;
            } else {
                return `${indentStr}- ${content}\n`;
            }
        }

        if (tag === 'br') {
            return '  \n';
        }

        if (tag === 'blockquote') {
            const content = getChildrenText(node, listContext, indent).trim();
            return '\n' + content.split('\n')
                .map(line => `> ${line}`)
                .join('\n') + '\n';
        }

        if (['div', 'p'].includes(tag)) {
            return '\n' + getChildrenText(node, listContext, indent) + '\n';
        }

        return getChildrenText(node, listContext, indent);
    }

    function getChildrenText(node, listContext = null, indent = 0) {
        return Array.from(node.childNodes).map(child => htmlToMarkdown(child, listContext, indent)).join('');
    }

    function cleanMarkdown(str) {
        if (!str) return '';
        return str.trim().replace(/\n{3,}/g, '\n\n');
    }

    // --- Scroller detection ---

    function findRealScroller() {
        const bubble = document.querySelector('main ms-chat-turn') || document.querySelector('ms-chat-turn');
        if (!bubble) {
            return document.querySelector('div[class*="scroll"]') || document.body;
        }
        let el = bubble.parentElement;
        while (el && el !== document.body) {
            const style = window.getComputedStyle(el);
            if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight >= el.clientHeight) {
                return el;
            }
            el = el.parentElement;
        }
        return document.documentElement;
    }

    // --- Turn ordering ---

    function mergeWithOverlap(oldOrder, newIds) {
        const oldIdSet = new Set(oldOrder);
        const result = [...oldOrder];
        newIds.forEach((newId, index) => {
            if (!oldIdSet.has(newId)) {
                let prevInOldIdx = -1;
                for (let i = index - 1; i >= 0; i--) {
                    const neighborId = newIds[i];
                    const pos = result.indexOf(neighborId);
                    if (pos !== -1) { prevInOldIdx = pos; break; }
                }
                result.splice(prevInOldIdx + 1, 0, newId);
            }
        });
        return result;
    }

    function updateTurnOrder(newIds) {
        if (!newIds || newIds.length === 0) return;
        if (turnOrder.length === 0) {
            turnOrder = [...newIds];
            return;
        }
        const firstCommonIdx = newIds.findIndex(id => turnOrder.includes(id));
        if (firstCommonIdx !== -1) {
            turnOrder = mergeWithOverlap(turnOrder, newIds);
        } else {
            turnOrder = [...turnOrder, ...newIds];
        }
        turnOrder = [...new Set(turnOrder)];
    }

    // --- Core capture ---

    function getTurnId(el) {
        if (el.id) return el.id;
        const chunk = el.querySelector('ms-prompt-chunk[id], ms-response-chunk[id], ms-thought-chunk[id]');
        return chunk ? chunk.id : null;
    }

    function captureData(scroller = document) {
        const turns = scroller.querySelectorAll('ms-chat-turn');

        const visibleTurnIds = Array.from(new Set(Array.from(turns)
            .filter(t => t.offsetParent !== null && window.getComputedStyle(t).visibility !== 'hidden')
            .map(t => getTurnId(t))
            .filter(id => !!id)));
        updateTurnOrder(visibleTurnIds);

        for (const turn of turns) {
            if (turn.offsetParent === null || window.getComputedStyle(turn).visibility === 'hidden') continue;

            const turnId = getTurnId(turn);
            if (!turnId) continue;

            const role = (turn.querySelector('[data-turn-role="Model"]') || turn.querySelector('[class*="model-prompt-container"]')) ? ROLE_GEMINI : ROLE_USER;
            const existing = collectedData.get(turnId) || { role };
            const hasThoughtChunkNow = role === ROLE_GEMINI && !!turn.querySelector('ms-thought-chunk');

            if (processedTurnIds.has(turnId) && !(role === ROLE_GEMINI && !existing.thoughts && hasThoughtChunkNow)) continue;

            // Clone and strip UI-only elements
            const clone = turn.cloneNode(true);
            const trash = ['.actions-container', '.turn-footer', 'button', 'mat-icon', 'ms-grounding-sources', 'ms-search-entry-point', '.role-label', '.ms-role-tag', 'svg', '.author-label'];
            trash.forEach(s => clone.querySelectorAll(s).forEach(e => e.remove()));

            // Extract Gemini thoughts
            if (role === ROLE_GEMINI) {
                const thoughtChunk = clone.querySelector('ms-thought-chunk');
                if (thoughtChunk) {
                    const thoughtsText = cleanMarkdown(htmlToMarkdown(thoughtChunk));
                    thoughtChunk.remove();
                    if (thoughtsText.length > 0 && !existing.thoughts) {
                        existing.thoughts = thoughtsText;
                    }
                }
            }

            const text = cleanMarkdown(htmlToMarkdown(clone));
            if (text.length > 0 && !existing.text) {
                existing.text = text;
            }

            if (existing.text || existing.thoughts) {
                collectedData.set(turnId, existing);
                if (role === ROLE_USER || (role === ROLE_GEMINI && !!existing.text)) {
                    processedTurnIds.add(turnId);
                }
            }
        }
    }

    // --- Normalization ---

    function normalizeConversation() {
        if (turnOrder.length === 0 || collectedData.size === 0) return;
        const newOrder = [];
        const newMap = new Map();

        for (let i = 0; i < turnOrder.length; i++) {
            const id = turnOrder[i];
            const item = collectedData.get(id);
            if (!item) continue;

            if (item.role === ROLE_GEMINI && item.thoughts && !item.text) {
                let merged = false;
                for (let j = i + 1; j < turnOrder.length; j++) {
                    const nextId = turnOrder[j];
                    const nextItem = collectedData.get(nextId);
                    if (!nextItem) continue;
                    if (nextItem.role === ROLE_USER) break;
                    if (nextItem.role === ROLE_GEMINI && nextItem.text) {
                        nextItem.thoughts = nextItem.thoughts
                            ? (item.thoughts + '\n\n' + nextItem.thoughts)
                            : item.thoughts;
                        collectedData.set(nextId, nextItem);
                        merged = true;
                        break;
                    }
                }
                if (merged) continue;
            }

            newOrder.push(id);
            newMap.set(id, item);
        }

        turnOrder = newOrder;
        collectedData = newMap;
    }

    // --- Markdown export generation ---

    function generateMarkdownExport(title) {
        let content = `# ${title || 'Google AI Studio Chat History'}\n\n`;
        content += `**Exported:** ${new Date().toLocaleString()}\n\n`;
        content += `**Turns:** ${turnOrder.length}\n\n`;
        content += `---\n\n`;

        for (const id of turnOrder) {
            const item = collectedData.get(id);
            if (!item) continue;

            // Thoughts section (before Gemini response)
            if (item.role === ROLE_GEMINI && item.thoughts) {
                content += `## 💭 Gemini Thoughts\n\n${item.thoughts}\n\n`;
                content += `---\n\n`;
            }

            const roleName = item.role === ROLE_GEMINI ? '🤖 Gemini' : '👤 User';
            const textOut = (item.text || '').trim();

            if (textOut.length > 0) {
                content += `## ${roleName}\n\n${textOut}\n\n`;
                content += `---\n\n`;
            }
        }

        return content;
    }

    // --- Utility ---

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function getCollectedCount() {
        return collectedData.size;
    }

    function getTurnCount() {
        return turnOrder.length;
    }

    // --- Public API ---

    window.DOMCapture = {
        resetState,
        findRealScroller,
        captureData,
        normalizeConversation,
        generateMarkdownExport,
        sleep,
        getCollectedCount,
        getTurnCount,
    };
})();
