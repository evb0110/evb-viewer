/** The Chrome extension's pages (packages/chrome-extension) run the browser workspace from the extension. */
export function isBrowserExtensionPage() {
    return typeof location !== 'undefined' && location.protocol === 'chrome-extension:';
}
