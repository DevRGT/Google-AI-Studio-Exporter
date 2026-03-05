# Google AI Studio Exporter — Usage Guide

This document explains how to install and use the Google AI Studio Exporter UserScript with the latest security hardening.

## 1. Prerequisites
You need a UserScript manager extension installed in your browser.
*   **Highly Recommended:** [OrangeMonkey](https://chromewebstore.google.com/detail/orangemonkey/pgaenmmpgojjbkohdbmgebednoaoalep)
*   **Alternatives:** [Tampermonkey](https://www.tampermonkey.net/), [Violentmonkey](https://violentmonkey.github.io/)

## 2. Installation
1.  Open your UserScript manager's dashboard.
2.  Select **Create a New Script** (or "Add Script").
3.  Copy the entire content of `google-ai-studio-exporter.user.js` from this repository.
4.  Paste it into the editor and **Save**.

> [!IMPORTANT]
> This version is hardened for safety. It **bundles JSZip internally**, meaning it never downloads external code from CDNs (like `cdnjs` or `jsdelivr`) during operation.

## 3. How to Export
1.  Go to [Google AI Studio](https://aistudio.google.com/).
2.  Open any chat conversation.
3.  Look for the **🚀 Export** button in the top-right corner of the interface (near the "Get Code" or "Share" buttons).
4.  Click the button to reveal the export options.

## 4. Export Formats
*   **Text Only (.md):** Instantly downloads the chat transcript as a single Markdown file.
*   **With Attachments (.zip):** 
    1.  The script scrapes the text.
    2.  It identifies images or files attached to the chat.
    3.  It downloads these files directly from Google's servers.
    4.  It creates a ZIP archive containing the Markdown file and an `attachments/` folder.

## 5. Tips & Controls
*   **Monitoring Progress:** During an attachment export, progress status appears in the bottom-left corner or console.
*   **Cancellation:** Press the **`ESC`** key at any time to cancel an ongoing export.
*   **Security Check:** You can verify safety by opening DevTools (F12) -> Network tab. You will see that **zero** requests are made to third-party CDNs when clicking Export.

## 6. Troubleshooting
If the button doesn't appear:
1.  Ensure the UserScript is enabled in your manager.
2.  Refresh the Google AI Studio page.
3.  Check if Google has updated their UI (in which case the script's selectors may need updating).
