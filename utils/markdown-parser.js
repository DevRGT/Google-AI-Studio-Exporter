// --------------------------------------------------------------------------------------
// Ported from UserScript htmlToMarkdown
// --------------------------------------------------------------------------------------

export function htmlToMarkdown(node, listContext = null, indent = 0) {
    if (!node) return '';
    if (node.nodeType === 3) { // Node.TEXT_NODE
        return node.textContent;
    }

    if (node.nodeType !== 1) return ''; // Node.ELEMENT_NODE

    const tag = node.tagName.toLowerCase();

    // Images
    if (tag === 'img') {
        const alt = node.getAttribute('alt') || '';
        const src = node.getAttribute('src') || '';
        return `![${alt}](${src})`;
    }

    // Code blocks
    if (tag === 'pre') {
        const codeEl = node.querySelector('code');
        if (codeEl) {
            const language = Array.from(codeEl.classList).find(c => c.startsWith('language-'))?.replace('language-', '') || '';
            const code = codeEl.textContent;
            return `\n\`\`\`${language}\n${code}\n\`\`\`\n`;
        }
    }

    // Inline code
    if (tag === 'code') {
        const text = node.textContent;
        // Handle backticks inside inline code for correct Markdown rendering.
        if (text.includes('`')) {
            return `\`\` ${text.trim()} \`\``;
        }
        return `\`${text}\``;
    }

    // Headings
    if (/^h[1-6]$/.test(tag)) {
        const level = parseInt(tag[1]);
        return '\n' + '#'.repeat(level) + ' ' + getChildrenText(node, listContext, indent) + '\n';
    }

    // Bold
    if (tag === 'strong' || tag === 'b') {
        return `**${getChildrenText(node, listContext, indent)}**`;
    }

    // Italic
    if (tag === 'em' || tag === 'i') {
        return `*${getChildrenText(node, listContext, indent)}*`;
    }

    // Links
    if (tag === 'a') {
        const href = node.getAttribute('href') || '';
        const text = getChildrenText(node, listContext, indent);
        return `[${text}](${href})`;
    }

    // Lists - pass context to children
    if (tag === 'ul' || tag === 'ol') {
        const listType = tag; // 'ul' or 'ol'
        let index = 0;
        let result = '\n';

        for (const child of node.childNodes) {
            if (child.nodeType === 1 && child.tagName.toLowerCase() === 'li') {
                index++;
                // Pass indent + 1 to children
                result += htmlToMarkdown(child, { type: listType, index: index }, indent + 1);
            } else {
                // Pass indent + 1 to children even if not li (e.g. nested ul)
                result += htmlToMarkdown(child, listContext, indent + 1);
            }
        }

        return result + '\n';
    }

    // List items - use context to determine format
    if (tag === 'li') {
        // Children of li are at the same indent level as the li itself (which is already indented by parent)
        const content = getChildrenText(node, listContext, indent).trim();
        if (!content) return '';
        // Render bullet at indent - 1
        const indentStr = '  '.repeat(Math.max(0, indent - 1));
        if (listContext && listContext.type === 'ol') {
            return `${indentStr}${listContext.index}. ${content}\n`;
        } else {
            return `${indentStr}- ${content}\n`;
        }
    }

    // Line breaks
    if (tag === 'br') {
        return '  \n';
    }

    // Blockquotes - prefix each line with >
    if (tag === 'blockquote') {
        const content = getChildrenText(node, listContext, indent).trim();
        // Split by lines and prefix each with "> "
        return '\n' + content.split('\n')
            .map(line => `> ${line}`)
            .join('\n') + '\n';
    }

    // Block elements
    if (['div', 'p'].includes(tag)) {
        return '\n' + getChildrenText(node, listContext, indent) + '\n';
    }

    return getChildrenText(node, listContext, indent);
}

function getChildrenText(node, listContext = null, indent = 0) {
    return Array.from(node.childNodes).map(child => htmlToMarkdown(child, listContext, indent)).join('');
}

export function cleanMarkdown(str) {
    if (!str) return '';
    return str.trim().replace(/\n{3,}/g, '\n\n');
}

/**
 * Extracts the conversation JSON from the raw HTML of a Google AI Studio prompt page.
 */
export function extractJsonFromHtml(html) {
    if (!html) return null;

    let candidates = [];

    // Pattern 1: AF_initDataCallback({key: '...', data: [...]});
    const regex1 = /AF_initDataCallback\s*\(\s*{\s*key:\s*['"]([^'"]+)['"]\s*,\s*hash:\s*['"][^'"]*['"]\s*,\s*data:\s*(\[[\s\S]*?\])\s*}\s*\)\s*;/g;
    let match;
    while ((match = regex1.exec(html)) !== null) {
        try {
            const data = JSON.parse(match[2]);
            const stringCount = JSON.stringify(data).split('"').length / 2;
            candidates.push({ key: match[1], data, stringCount });
        } catch (e) { }
    }

    // Pattern 2: AF_initDataCallback["key"] = function() { return [...] };
    const regex2 = /AF_initDataCallback\s*\[\s*['"]([^'"]+)['"]\s*\]\s*=\s*function\s*\(.*?\)\s*{\s*return\s*(\[[\s\S]*?\])\s*;?\s*};/g;
    while ((match = regex2.exec(html)) !== null) {
        try {
            const data = JSON.parse(match[2]);
            const stringCount = JSON.stringify(data).split('"').length / 2;
            candidates.push({ key: match[1], data, stringCount });
        } catch (e) { }
    }

    // Fallback: Just look for any script tag containing a very large array if nothing found so far
    if (candidates.length === 0) {
        const regexFallback = /<script.*?>[\s\S]*?(\[\[[\s\S]{500,}\]\])[\s\S]*?<\/script>/g;
        while ((match = regexFallback.exec(html)) !== null) {
            try {
                const data = JSON.parse(match[1]);
                const stringCount = JSON.stringify(data).split('"').length / 2;
                candidates.push({ key: 'fallback', data, stringCount });
            } catch (e) { }
        }
    }

    if (candidates.length === 0) return null;

    // Pick the candidate with the most strings (likely the conversation content)
    candidates.sort((a, b) => b.stringCount - a.stringCount);
    return candidates[0].data;
}

/**
 * Robustly parses Google's nested RPC array format into structured chat history Markdown.
 * Google AI Studio uses a deeply nested array format where conversation data
 * is typically at specific array indices. This function attempts multiple
 * strategies to locate and parse the conversation.
 */
export function parseApiPayloadToMarkdown(data, title, settings = {}) {
    const includeThoughts = settings.includeThoughts !== false;

    let content = `# ${title || 'Google AI Studio Chat History'}\n\n`;
    content += `**Exported:** ${new Date().toLocaleString()}\n\n`;
    content += `---\n\n`;

    if (!data) return content + "No data found.";

    // Strategy 1: Look for structured conversation turns in the nested arrays.
    // Google AI Studio typically stores turns in arrays where:
    // - Element at some level contains an array of turn objects
    // - Each turn has: [role_indicator, content_parts, ...]
    // - Role: 0 = user, 1 = model
    const structuredTurns = findStructuredTurns(data);

    if (structuredTurns.length > 0) {
        content += `**Turns:** ${structuredTurns.length}\n\n---\n\n`;

        structuredTurns.forEach(turn => {
            if (includeThoughts && turn.thoughts) {
                content += `## 💭 Gemini Thoughts\n\n${turn.thoughts}\n\n---\n\n`;
            }

            const roleName = turn.role === 'model' ? '🤖 Gemini' : '👤 User';
            if (turn.text) {
                content += `## ${roleName}\n\n${turn.text}\n\n---\n\n`;
            }
        });

        return content;
    }

    // Strategy 2 (Fallback): Walk the entire tree and extract strings heuristically,
    // looking for role indicators near content.
    const turns = [];

    function walk(node, path = [], parentRole = null) {
        if (!node) return;

        if (typeof node === 'string') {
            const trimmed = node.trim();
            // Filter out short metadata strings, IDs, GUIDs, and URLs
            if (trimmed.length > 10 &&
                !trimmed.match(/^[a-z0-9_-]+$/i) &&
                !trimmed.startsWith('http') &&
                !trimmed.match(/^[0-9a-f]{8}-/) &&
                trimmed.length < 50000) {
                turns.push({ content: trimmed, path: [...path], role: parentRole });
            }
        } else if (Array.isArray(node)) {
            // Check if this looks like a turn array: [role_int, [[text_array]]]
            if (node.length >= 2 && (node[0] === 0 || node[0] === 1)) {
                const role = node[0] === 0 ? 'user' : 'model';
                node.forEach((child, i) => walk(child, [...path, i], role));
                return;
            }
            node.forEach((child, i) => walk(child, [...path, i], parentRole));
        } else if (typeof node === 'object') {
            Object.entries(node).forEach(([k, v]) => walk(v, [...path, k], parentRole));
        }
    }

    walk(data);

    if (turns.length === 0) {
        content += "> [!WARNING]\n> Could not automatically parse chat history from this payload structure.\n\n";
        content += "```json\n" + JSON.stringify(data, null, 2).substring(0, 500) + "...\n```\n";
        return content;
    }

    // Deduplicate
    const uniqueContent = new Set();
    const filteredTurns = turns.filter(t => {
        if (uniqueContent.has(t.content)) return false;
        uniqueContent.add(t.content);
        return true;
    });

    content += `**Turns:** ${filteredTurns.length}\n\n---\n\n`;

    filteredTurns.forEach((t, i) => {
        // Use detected role if available, otherwise alternate
        let role;
        if (t.role) {
            role = t.role === 'model' ? '🤖 Gemini' : '👤 User';
        } else {
            role = (i % 2 === 0) ? '👤 User' : '🤖 Gemini';
        }
        content += `## ${role}\n\n`;
        content += `${t.content}\n\n`;
        content += `---\n\n`;
    });

    return content;
}

/**
 * Attempts to find structured conversation turns in Google's nested array format.
 * Returns an array of { role: 'user'|'model', text: string, thoughts?: string }
 */
function findStructuredTurns(data) {
    const turns = [];

    function searchForTurnArray(node, depth = 0) {
        if (!node || depth > 8) return false;
        if (!Array.isArray(node)) return false;

        // Check if this is an array of turns.
        // A turn array typically contains elements where each element is an array
        // with [role_int, parts_array, ...] and role_int is 0 (user) or 1 (model).
        const possibleTurns = node.filter(el =>
            Array.isArray(el) &&
            el.length >= 2 &&
            (el[0] === 0 || el[0] === 1)
        );

        if (possibleTurns.length >= 2 && possibleTurns.length === node.length) {
            // This looks like a turn array
            for (const turn of possibleTurns) {
                const role = turn[0] === 0 ? 'user' : 'model';
                const text = extractTextFromParts(turn[1]);
                const thoughts = turn.length > 4 ? extractTextFromParts(turn[4]) : null;

                if (text || thoughts) {
                    turns.push({ role, text, thoughts });
                }
            }
            return true;
        }

        // Recurse into child arrays
        for (const child of node) {
            if (searchForTurnArray(child, depth + 1)) return true;
        }
        return false;
    }

    function extractTextFromParts(parts) {
        if (!parts) return '';
        if (typeof parts === 'string') return parts.trim();
        if (Array.isArray(parts)) {
            return parts
                .map(p => {
                    if (typeof p === 'string') return p;
                    if (Array.isArray(p)) return extractTextFromParts(p);
                    if (p && typeof p === 'object' && p.text) return p.text;
                    return '';
                })
                .filter(Boolean)
                .join('\n');
        }
        if (typeof parts === 'object' && parts.text) return parts.text;
        return '';
    }

    searchForTurnArray(data);
    return turns;
}
