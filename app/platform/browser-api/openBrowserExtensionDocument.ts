import {
    BROWSER_EXTENSION_OPEN_NATIVELY_MESSAGE,
    readBrowserExtensionDocumentUrl,
    type IBrowserExtensionOpenNativelyRequest,
} from '@contracts/browserExtensionLaunch';
import {parseDocumentRef, type TDocumentRef} from '@contracts/documentRef';
import {browserDocumentStore} from '@app/platform/browserDocumentStore';
import {getBrowserWindowId} from '@app/platform/browserWindowTabs';
import {hasBrowserWorkspaceCheckpoint} from '@app/platform/browser/browserWorkspaceRecovery';
import {openBrowserExternalPaths} from '@app/platform/browser-api/browserExternalOpenQueue';
import {BrowserLogger} from '@app/utils/browserLogger';
import {isBrowserExtensionPage} from '@app/utils/isBrowserExtensionPage';
import {detectDocumentFormat, DOCUMENT_HEADER_BYTES} from '@pdf-core/documentOpenFileTypes';

// The Chrome extension's viewer page opens the document the extension
// redirected here (packages/chrome-extension). Anything it cannot open as a
// PDF or DjVu document, Chrome opens itself.

type TLaunchDocumentKind = 'pdf' | 'djvu';

interface ILaunchResponse {
    /** The document's bytes as they arrive; nothing holds them whole. */
    body: ReadableStream<Uint8Array>;
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

/**
 * Reads the start of `body` far enough to know what it is, and returns a stream of all of it from its first byte:
 * the chunks read so far, then the rest as it arrives. Only the header's chunks are held.
 */
async function peekDocumentHeader(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    let ended = false;
    while (length < DOCUMENT_HEADER_BYTES) {
        const next = await reader.read();
        if (next.done) {
            ended = true;
            break;
        }
        chunks.push(next.value);
        length += next.value.byteLength;
    }
    const header = new Uint8Array(Math.min(length, DOCUMENT_HEADER_BYTES));
    let offset = 0;
    for (const chunk of chunks) {
        if (offset === header.byteLength) {
            break;
        }
        const part = chunk.subarray(0, header.byteLength - offset);
        header.set(part, offset);
        offset += part.byteLength;
    }
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(chunk);
            }
            chunks.length = 0;
            if (ended) {
                controller.close();
            }
        },
        async pull(controller) {
            const next = await reader.read();
            if (next.done) {
                controller.close();
            } else {
                controller.enqueue(next.value);
            }
        },
        cancel: (reason) => reader.cancel(reason),
    });
    // A body that ended within its header has that size; any other is longer than a DjVu header can claim.
    return {header, size: ended ? length : Number.MAX_SAFE_INTEGER, stream};
}

function detectDocumentKind(header: Uint8Array, size: number): TLaunchDocumentKind | null {
    const format = detectDocumentFormat(header, size);
    // A truncated DjVu still goes to the DjVu decoder, which can show the pages it holds.
    if (format === 'invalid-djvu') {
        return 'djvu';
    }
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
    if (!contentDisposition) {
        return null;
    }
    const extended = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/iu.exec(contentDisposition)?.[1];
    if (extended) {
        return decodeFileName(extended.trim());
    }
    return /filename\s*=\s*(?:"([^"]+)"|([^;]+))/iu.exec(contentDisposition)?.slice(1).find(Boolean)?.trim() ?? null;
}

function readUrlFileName(url: string) {
    const segment = new URL(url).pathname.split('/').findLast(Boolean);
    return segment ? decodeFileName(segment) : null;
}

function resolveLaunchFileName(response: Pick<ILaunchResponse, 'contentDisposition' | 'url'>, kind: TLaunchDocumentKind) {
    const name = (readDispositionFileName(response.contentDisposition) ?? readUrlFileName(response.url) ?? 'document').replaceAll(
        /[\\/]/gu,
        '_',
    );
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
                    body: request.response.stream(),
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
    // An error page is not the document, nor is a range of it: storing that would keep, and reopen, a truncated
    // copy. A refused response's body is cancelled, so its connection does not go on downloading it.
    const refusal = !response.ok
        ? `The document request failed with HTTP ${String(response.status)}`
        : response.status === 206 || response.headers.has('content-range')
          ? 'The server sent part of the document'
          : null;
    if (refusal !== null) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(refusal);
    }
    return {
        body: response.body ?? new Blob().stream(),
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
    history.replaceState(
        {
            ...readHistoryState(),
            [LAUNCHED_DOCUMENT_STATE_KEY]: ref,
        },
        '',
    );
}

async function fetchLaunchDocument(documentUrl: string) {
    const response = await readLaunchDocument(documentUrl);
    const {header, size, stream} = await peekDocumentHeader(response.body);
    const kind = detectDocumentKind(header, size);
    if (!kind) {
        await stream.cancel().catch(() => undefined);
        throw new Error('The response is not a PDF or DjVu document');
    }
    const fileName = resolveLaunchFileName(response, kind);
    // The body streams into the stored copy as it downloads. That copy is locked before it exists, so no window's
    // startup collection takes it; a download that fails part way leaves no document, and Chrome opens the URL.
    // A store that fails before it reads the body still lets it go, so the connection stops downloading it.
    try {
        return await browserDocumentStore.createStoredDocument(fileName, stream, {
            kind: 'source',
            retention: 'durable',
            mimeType: kind === 'pdf' ? 'application/pdf' : 'image/vnd.djvu',
        });
    } catch (error) {
        await stream.cancel().catch(() => undefined);
        throw error;
    }
}

// A window with unsaved work restores its own tabs, the launched document among them.
async function hasWindowRecovery() {
    const windowId = getBrowserWindowId();
    return windowId !== null && (await hasBrowserWorkspaceCheckpoint(windowId));
}

/** The document this history entry already opened, while the browser still stores it. */
async function readLaunchedDocument() {
    const launched = parseDocumentRef(readHistoryState()[LAUNCHED_DOCUMENT_STATE_KEY]);
    return launched && (await browserDocumentStore.exists(launched)) ? launched : null;
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
        if (!(await hasWindowRecovery())) {
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
