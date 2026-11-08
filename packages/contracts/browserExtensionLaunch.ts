// How the Chrome extension hands a document to its viewer page. The service
// worker's redirect rule sends a PDF or DjVu navigation to the open page with
// the document's URL as the raw query; the open page moves it into the viewer
// page's `file` parameter, and the viewer fetches the document. When the
// viewer cannot, it asks the service worker to let Chrome open that URL itself.

export const BROWSER_EXTENSION_OPEN_PAGE = 'open.html';
export const BROWSER_EXTENSION_VIEWER_PAGE = 'index.html';
export const BROWSER_EXTENSION_OPEN_NATIVELY_MESSAGE = 'evb-viewer:open-natively';

const DOCUMENT_URL_PARAM = 'file';
const WEB_PROTOCOLS = new Set([
    'http:',
    'https:',
]);
const VIEWER_PROTOCOLS = new Set([
    ...WEB_PROTOCOLS,
    'file:',
]);

export interface IBrowserExtensionOpenNativelyRequest {
    type: typeof BROWSER_EXTENSION_OPEN_NATIVELY_MESSAGE;
    url: string;
}

function parseDocumentUrl(value: string | null | undefined, protocols: ReadonlySet<string>) {
    if (!value) {
        return null;
    }
    try {
        const url = new URL(value);
        return protocols.has(url.protocol) ? url.href : null;
    } catch {
        return null;
    }
}

/** The viewer page that opens `documentUrl`, resolved against any extension page URL. */
export function createBrowserExtensionViewerUrl(baseUrl: string, documentUrl: string) {
    const url = new URL(BROWSER_EXTENSION_VIEWER_PAGE, baseUrl);
    url.searchParams.set(DOCUMENT_URL_PARAM, documentUrl);
    return url.href;
}

/**
 * The web document the open page was redirected with. The redirect appends
 * the requested URL unencoded, so the whole query is that URL, and the browser
 * carries the link's fragment over to the open page. Only web URLs come this
 * way: the open page is reachable from any site, and a local file must not be.
 */
export function readBrowserExtensionOpenPageDocumentUrl(openPageUrl: string) {
    const url = new URL(openPageUrl);
    return parseDocumentUrl(`${url.search.slice(1)}${url.hash}`, WEB_PROTOCOLS);
}

/** The web or local document the viewer page was asked to open, if any. */
export function readBrowserExtensionDocumentUrl(viewerUrl: string) {
    return parseDocumentUrl(new URL(viewerUrl).searchParams.get(DOCUMENT_URL_PARAM), VIEWER_PROTOCOLS);
}

/** The viewer page URL without its document, so a reload or a new window does not fetch it again. */
export function removeBrowserExtensionDocumentUrl(viewerUrl: string) {
    const url = new URL(viewerUrl);
    url.searchParams.delete(DOCUMENT_URL_PARAM);
    return url.href;
}

export function isBrowserExtensionOpenNativelyRequest(value: unknown): value is IBrowserExtensionOpenNativelyRequest {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const url: unknown = Reflect.get(value, 'url');
    return Reflect.get(value, 'type') === BROWSER_EXTENSION_OPEN_NATIVELY_MESSAGE
        && typeof url === 'string'
        && parseDocumentUrl(url, VIEWER_PROTOCOLS) !== null;
}
