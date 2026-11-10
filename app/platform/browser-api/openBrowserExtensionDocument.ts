import {
    BROWSER_EXTENSION_OPEN_NATIVELY_MESSAGE,
    readBrowserExtensionDocumentUrl,
    type IBrowserExtensionOpenNativelyRequest,
} from '@contracts/browserExtensionLaunch';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import { browserDocumentStore } from '@app/platform/browserDocumentStore';
import {
    browserWindowTabsCapability,
    getBrowserWindowRecoveryOwnerId,
} from '@app/platform/browserWindowTabs';
import { openBrowserExternalPaths } from '@app/platform/browser-api/browserExternalOpenQueue';
import { BrowserLogger } from '@app/utils/browserLogger';
import { isBrowserExtensionPage } from '@app/utils/isBrowserExtensionPage';
import {
    detectDocumentFormat, DOCUMENT_HEADER_BYTES,
} from '@pdf-core/documentOpenFileTypes';

// The Chrome extension's viewer page opens the document the extension
// redirected here (packages/chrome-extension). Anything it cannot open as a
// PDF or DjVu document, Chrome opens itself.

type TLaunchDocumentKind = 'pdf' | 'djvu';

interface ILaunchResponse {
    blob: Blob;
    contentDisposition: string | null;
    url: string;
}

// The page's history entry remembers the document it opened, so a reload or a
// return to the entry shows it again without fetching it. A window the
// workspace opens starts a new history and does not inherit it.
const LAUNCHED_DOCUMENT_STATE_KEY = 'evbExtensionDocument';
const FILE_EXTENSION: Record<TLaunchDocumentKind, string> = {
    pdf: '.pdf',
    djvu: '.djvu',
};
const FILE_EXTENSION_PATTERN: Record<TLaunchDocumentKind, RegExp> = {
    pdf: /\.pdf$/iu,
    djvu: /\.djvu?$/iu,
};

async function detectDocumentKind(blob: Blob): Promise<TLaunchDocumentKind | null> {
    const format = detectDocumentFormat(new Uint8Array(await blob.slice(0, DOCUMENT_HEADER_BYTES).arrayBuffer()), blob.size);
    // A truncated DjVu still goes to the DjVu decoder, which can show the pages it holds.
    if (format === 'invalid-djvu') return 'djvu';
    return format === 'pdf' || format === 'djvu' ? format : null;
}

function decodeFileName(value: string) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

/** The name a server gave the file, preferring the RFC 6266 extended form. */
function readDispositionFileName(contentDisposition: string | null) {
    if (!contentDisposition) return null;
    const extended = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/iu.exec(contentDisposition)?.[1];
    if (extended) return decodeFileName(extended.trim());
    return /filename\s*=\s*(?:"([^"]+)"|([^;]+))/iu.exec(contentDisposition)?.slice(1).find(Boolean)?.trim() ?? null;
}

function readUrlFileName(url: string) {
    const segment = new URL(url).pathname.split('/').findLast(Boolean);
    return segment ? decodeFileName(segment) : null;
}

function resolveLaunchFileName(response: Pick<ILaunchResponse, 'contentDisposition' | 'url'>, kind: TLaunchDocumentKind) {
    const name = (readDispositionFileName(response.contentDisposition) ?? readUrlFileName(response.url) ?? 'document')
        .replaceAll(/[\\/]/gu, '_');
    return FILE_EXTENSION_PATTERN[kind].test(name) ? name : `${name}${FILE_EXTENSION[kind]}`;
}

// fetch() cannot read file URLs; an extension that may read local files can with XHR.
function readLocalFile(url: string) {
    return new Promise<ILaunchResponse>((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open('GET', url);
        request.responseType = 'blob';
        request.onload = () => {
            if (request.response instanceof Blob) {
                resolve({
                    blob: request.response,
                    contentDisposition: null,
                    url,
                });
            } else {
                reject(new Error('The local file could not be read'));
            }
        };
        request.onerror = () => reject(new Error('The local file could not be read'));
        request.send();
    });
}

async function readLaunchDocument(url: string): Promise<ILaunchResponse> {
    if (new URL(url).protocol === 'file:') {
        return readLocalFile(url);
    }
    const response = await fetch(url, {credentials: 'include'});
    if (!response.ok) {
        throw new Error(`The document request failed with HTTP ${String(response.status)}`);
    }
    return {
        blob: await response.blob(),
        contentDisposition: response.headers.get('content-disposition'),
        url: response.url || url,
    };
}

async function openNatively(url: string) {
    const chromeApi: unknown = Reflect.get(globalThis, 'chrome');
    const runtime: unknown = typeof chromeApi === 'object' && chromeApi !== null ? Reflect.get(chromeApi, 'runtime') : null;
    const sendMessage: unknown = typeof runtime === 'object' && runtime !== null ? Reflect.get(runtime, 'sendMessage') : null;
    if (typeof sendMessage !== 'function') {
        return;
    }
    const request: IBrowserExtensionOpenNativelyRequest = {
        type: BROWSER_EXTENSION_OPEN_NATIVELY_MESSAGE,
        url,
    };
    await Reflect.apply(sendMessage, runtime, [request]);
}

function readHistoryState(): Record<string, unknown> {
    const state: unknown = history.state;
    return typeof state === 'object' && state !== null ? {...state} : {};
}

function rememberLaunchedDocument(ref: TDocumentRef) {
    history.replaceState({
        ...readHistoryState(),
        [LAUNCHED_DOCUMENT_STATE_KEY]: ref,
    }, '');
}

async function fetchLaunchDocument(documentUrl: string) {
    const response = await readLaunchDocument(documentUrl);
    const kind = await detectDocumentKind(response.blob);
    if (!kind) {
        throw new Error('The response is not a PDF or DjVu document');
    }
    return browserDocumentStore.registerFile(new File([response.blob], resolveLaunchFileName(response, kind), {type: kind === 'pdf' ? 'application/pdf' : 'image/vnd.djvu'}));
}

// A window with unsaved work restores its own tabs, the launched document among them.
async function hasWindowRecovery() {
    const ownerId = getBrowserWindowRecoveryOwnerId();
    return ownerId !== null && await browserWindowTabsCapability.browserRecovery?.load(ownerId) != null;
}

/** The document this history entry already opened, while the browser still stores it. */
async function readLaunchedDocument() {
    const launched = parseDocumentRef(readHistoryState()[LAUNCHED_DOCUMENT_STATE_KEY]);
    return launched && (await browserDocumentStore.ensureEntryAvailability(launched)).available ? launched : null;
}

/**
 * Opens the document the page was launched with. The launch parameter stays
 * in the URL, so the address bar shows the document's source and a bookmark
 * opens it again; a reload reuses the copy this history entry stored.
 */
export async function openBrowserExtensionDocument() {
    if (!isBrowserExtensionPage()) {
        return;
    }
    const launched = await readLaunchedDocument();
    if (launched) {
        if (!await hasWindowRecovery()) {
            openBrowserExternalPaths([launched]);
        }
        return;
    }
    const documentUrl = readBrowserExtensionDocumentUrl(location.href);
    if (!documentUrl) {
        return;
    }
    try {
        const ref = await fetchLaunchDocument(documentUrl);
        rememberLaunchedDocument(ref);
        openBrowserExternalPaths([ref]);
    } catch (error) {
        BrowserLogger.warn('browserExtensionLaunch', 'Chrome opens the document instead', error);
        await openNatively(documentUrl);
    }
}
