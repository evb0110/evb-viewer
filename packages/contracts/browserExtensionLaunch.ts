// How the Chrome extension hands a document to its viewer page. The service
// worker's redirect rule sends a PDF or DjVu navigation to the open page with
// the document's URL as the raw query; the open page moves it into the viewer
// page's `file` parameter, and the viewer fetches the document. The parameter
// stays, so the address bar shows where the document came from and a bookmark
// opens it again. When the viewer cannot open the document, it asks the
// service worker to let Chrome open that URL itself.

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

// The document URL is written into the viewer URL as it is, so the address
// bar shows it readably. Only its `#` must change, because the viewer page's
// own fragment starts there: it becomes `%23`, and an escaped `#` the URL
// already holds (`%23`, `%2523`, ...) gains one more `25`, so reading the
// parameter undoes exactly that and gives the URL back unchanged.
const ESCAPED_HASH = /%((?:25)*)23/giu;
// The document parameter comes last and runs to the end of the query, so the
// `&` and `=` inside it belong to the document URL.
const DOCUMENT_URL_QUERY = new RegExp(`(?:^|&)${DOCUMENT_URL_PARAM}=(.*)$`, 'u');

function readDocumentUrlQuery(viewerUrl: URL) {
    const match = DOCUMENT_URL_QUERY.exec(viewerUrl.search.slice(1));
    return match ? {
        index: match.index,
        value: match[1] ?? '',
    } : null;
}

/**
 * The viewer page that opens `documentUrl`, resolved against any extension
 * page URL. The address bar shows the document's URL after `?file=`.
 */
export function createBrowserExtensionViewerUrl(baseUrl: string, documentUrl: string) {
    const url = new URL(BROWSER_EXTENSION_VIEWER_PAGE, baseUrl);
    url.search = '';
    url.hash = '';
    const value = documentUrl.replaceAll(ESCAPED_HASH, '%25$123').replaceAll('#', '%23');
    return `${url.href}?${DOCUMENT_URL_PARAM}=${value}`;
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
    const value = readDocumentUrlQuery(new URL(viewerUrl))?.value.replaceAll(
        ESCAPED_HASH,
        (_escape, extra: string) => (extra ? `%${extra.slice(2)}23` : '#'),
    );
    return parseDocumentUrl(value, VIEWER_PROTOCOLS);
}

/** The viewer page URL without its document, for a new window that must not open it again. */
export function removeBrowserExtensionDocumentUrl(viewerUrl: string) {
    const url = new URL(viewerUrl);
    const query = readDocumentUrlQuery(url);
    if (query) {
        url.search = url.search.slice(1, query.index + 1);
    }
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
