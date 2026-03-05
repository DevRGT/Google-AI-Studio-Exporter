// ============================================================================
// Attachment Handler — Downloads images/files and packages into a ZIP
// Loaded as a content_script, exposes functions on `window.AttachmentHandler`.
// Depends on JSZip being loaded before this script (via libs/jszip.min.js).
// ============================================================================

(function () {
    'use strict';

    const FETCH_TIMEOUT = 15000; // 15s per resource
    const MAX_CONCURRENT = 3;

    /**
     * Fetch a resource with timeout. Returns { url, blob, ok, error? }
     */
    async function fetchResource(url, timeoutMs = FETCH_TIMEOUT) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetch(url, {
                signal: controller.signal,
                credentials: 'include', // Send cookies for same-origin resources
            });
            clearTimeout(timer);

            if (!response.ok) {
                return { url, blob: null, ok: false, error: `HTTP ${response.status}` };
            }

            const blob = await response.blob();
            return { url, blob, ok: true };
        } catch (err) {
            clearTimeout(timer);
            return { url, blob: null, ok: false, error: err.name === 'AbortError' ? 'Timeout' : err.message };
        }
    }

    /**
     * Download resources in batches with concurrency control.
     * @param {string[]} urls
     * @param {Function} onProgress - Called with (completed, total)
     * @returns {Promise<Map<string, {blob, ok, error?}>>}
     */
    async function downloadBatch(urls, onProgress = null) {
        const results = new Map();
        const unique = [...new Set(urls)];
        let completed = 0;

        for (let i = 0; i < unique.length; i += MAX_CONCURRENT) {
            const batch = unique.slice(i, i + MAX_CONCURRENT);
            const batchResults = await Promise.all(batch.map(url => fetchResource(url)));

            batchResults.forEach(result => {
                results.set(result.url, result);
                completed++;
                if (onProgress) onProgress(completed, unique.length);
            });
        }

        return results;
    }

    /**
     * Guess a filename from a URL.
     */
    function filenameFromUrl(url, index, prefix = 'file') {
        try {
            const u = new URL(url);
            const pathname = u.pathname;
            const basename = pathname.split('/').pop();
            if (basename && basename.includes('.') && basename.length < 100) {
                return basename;
            }
        } catch (_) { }
        return `${prefix}_${index}`;
    }

    /**
     * Determine if a URL points to an image based on extension or MIME in blob.
     */
    function isImageUrl(url) {
        const lower = (url || '').toLowerCase();
        return /\.(png|jpe?g|gif|webp|svg|bmp|ico)(\?|#|$)/i.test(lower);
    }

    /**
     * Package a Markdown string + attachments into a ZIP.
     * @param {string} markdown - The Markdown content
     * @param {string[]} attachmentUrls - URLs to download and include
     * @param {string} mdFilename - Name for the Markdown file in the ZIP
     * @param {Function} onProgress - Progress callback (message)
     * @returns {Promise<Blob>} - ZIP blob
     */
    async function packageAsZip(markdown, attachmentUrls, mdFilename = 'chat_history.md', onProgress = null) {
        if (typeof JSZip === 'undefined') {
            throw new Error('JSZip not loaded. Please reload the extension.');
        }

        const zip = new JSZip();
        let finalMarkdown = markdown;

        if (attachmentUrls.length > 0) {
            if (onProgress) onProgress(`Downloading ${attachmentUrls.length} attachment(s)...`);

            const results = await downloadBatch(attachmentUrls, (done, total) => {
                if (onProgress) onProgress(`Downloading attachments (${done}/${total})...`);
            });

            let imageIdx = 0;
            let fileIdx = 0;

            for (const [url, result] of results) {
                if (!result.ok || !result.blob) continue;

                if (isImageUrl(url) || (result.blob.type && result.blob.type.startsWith('image/'))) {
                    const name = filenameFromUrl(url, imageIdx, 'image');
                    const localPath = `images/${name}`;
                    zip.file(localPath, result.blob);
                    // Replace URL in markdown with local path
                    finalMarkdown = finalMarkdown.split(url).join(localPath);
                    imageIdx++;
                } else {
                    const name = filenameFromUrl(url, fileIdx, 'file');
                    const localPath = `files/${name}`;
                    zip.file(localPath, result.blob);
                    finalMarkdown = finalMarkdown.split(url).join(localPath);
                    fileIdx++;
                }
            }

            if (onProgress) onProgress('Packaging ZIP...');
        }

        // Add the markdown file
        zip.file(mdFilename, finalMarkdown);

        // Generate the ZIP
        const zipBlob = await zip.generateAsync({
            type: 'blob',
            compression: 'DEFLATE',
            compressionOptions: { level: 6 },
        });

        return zipBlob;
    }

    // --- Public API ---

    window.AttachmentHandler = {
        fetchResource,
        downloadBatch,
        packageAsZip,
        filenameFromUrl,
        isImageUrl,
    };
})();
