import type { TDocumentRef } from '@contracts/documentRef';
import {
    createRequestId,
    type TRequestId,
} from '@contracts/shared';
import { BrowserLogger } from '@app/utils/browserLogger';
import type {
    IDocumentTextCatalogPage,
    IDocumentTextCatalogWindow,
} from '@contracts/documentTextCatalog';
import { getOcrCapability } from '@app/utils/getOcrCapability';
import {
    parseDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';

function throwIfAborted(signal?: AbortSignal) {
    signal?.throwIfAborted();
}

function abortErrorFromSignal(signal: AbortSignal) {
    return signal.reason instanceof Error
        ? signal.reason
        : new DOMException('DOCX export was canceled.', 'AbortError');
}

function createCatalogRequestId() {
    return createRequestId('ocr-catalog');
}

async function withAbort<T>(
    start: (requestId?: TRequestId) => Promise<T>,
    cancelRequest: ((requestId: TRequestId) => Promise<unknown>) | undefined,
    signal?: AbortSignal,
) {
    if (!signal) {
        return start();
    }
    throwIfAborted(signal);
    return new Promise<T>((resolve, reject) => {
        const requestId = createCatalogRequestId();
        let settled = false;
        let cancelPromise: Promise<unknown> | null = null;
        const cancelOnce = () => {
            if (cancelPromise === null) {
                if (!cancelRequest) {
                    cancelPromise = Promise.resolve();
                } else {
                    try {
                        cancelPromise = Promise.resolve(cancelRequest(requestId)).catch(() => undefined);
                    } catch {
                        cancelPromise = Promise.resolve();
                    }
                }
            }
            return cancelPromise;
        };
        const handleAbort = () => {
            settled = true;
            void cancelOnce();
            cleanup();
            reject(abortErrorFromSignal(signal));
        };
        const cleanup = () => signal.removeEventListener('abort', handleAbort);
        signal.addEventListener('abort', handleAbort, {once: true});
        let promise: Promise<T>;
        try {
            promise = start(requestId);
        } catch (error) {
            cleanup();
            reject(error);
            return;
        }
        promise.then(
            value => {
                cleanup();
                if (!settled) {
                    resolve(value);
                }
            },
            error => {
                cleanup();
                if (!settled) {
                    reject(error);
                }
            },
        );
    });
}

function loadDocumentTextCatalogWindow(
    capability: ReturnType<typeof getOcrCapability>,
    workingCopyPath: TDocumentRef,
    revision: TDocumentRevisionToken,
    firstPage: number,
    lastPage: number,
    pageCount: number,
    signal?: AbortSignal,
): Promise<IDocumentTextCatalogWindow> {
    return withAbort(
        requestId => {
            if (signal === undefined) {
                return capability.resolveDocumentTextCatalogWindow(
                    workingCopyPath,
                    revision,
                    firstPage,
                    lastPage,
                    pageCount,
                );
            }
            if (requestId === undefined) {
                throw new Error('OCR catalog request ID was not allocated');
            }
            return capability.resolveDocumentTextCatalogWindow(
                workingCopyPath,
                revision,
                firstPage,
                lastPage,
                pageCount,
                requestId,
            );
        },
        typeof capability.cancel === 'function'
            ? requestId => capability.cancel(requestId)
            : undefined,
        signal,
    );
}

/**
 * Reads the revision-keyed DocumentTextCatalog used by viewer and search.
 * Export deliberately has no search-index or legacy fallback: a stale or
 * malformed catalog is absence, never text for the current document.
 */
export async function loadOcrText(
    workingCopyPath: TDocumentRef,
    documentRevisionToken: string,
    signal?: AbortSignal,
) {
    const pages = await loadDocumentTextCatalogPages(
        workingCopyPath,
        documentRevisionToken,
        undefined,
        signal,
    );
    if (!pages) {
        return null;
    }
    const merged = pages.map(page => page.text.trim()).filter(Boolean).join('\n\n');
    return merged.length > 0 ? merged : null;
}

export async function loadDocumentTextCatalogPages(
    workingCopyPath: TDocumentRef,
    documentRevisionToken: string,
    pageCount?: number,
    signal?: AbortSignal,
): Promise<readonly IDocumentTextCatalogPage[] | null> {
    try {
        throwIfAborted(signal);
        const revision = parseDocumentRevisionToken(documentRevisionToken);
        if (revision === null) {
            return null;
        }
        const capability = getOcrCapability();
        const snapshot = await withAbort(
            requestId => {
                if (signal === undefined) {
                    return pageCount === undefined
                        ? capability.resolveDocumentTextCatalog(workingCopyPath, revision)
                        : capability.resolveDocumentTextCatalog(workingCopyPath, revision, pageCount);
                }
                if (requestId === undefined) {
                    throw new Error('OCR catalog request ID was not allocated');
                }
                return pageCount === undefined
                    ? capability.resolveDocumentTextCatalog(workingCopyPath, revision, undefined, requestId)
                    : capability.resolveDocumentTextCatalog(workingCopyPath, revision, pageCount, requestId);
            },
            typeof capability.cancel === 'function'
                ? requestId => capability.cancel(requestId)
                : undefined,
            signal,
        );
        throwIfAborted(signal);
        return snapshot.pages;
    } catch (error) {
        if (signal?.aborted) {
            throw error;
        }
        BrowserLogger.warn('ocr', 'Failed to load DocumentTextCatalog for DOCX export', error);
        return null;
    }
}

const DOCUMENT_TEXT_CATALOG_PAGE_WINDOW = 64;

/**
 * Streams canonical text windows from the desktop main process. The caller
 * receives one page at a time while each IPC response stays bounded.
 */


/**
 * Prepares a replayable text-page stream after checking for at least one
 * non-empty page. Only the current IPC window is retained while the stream
 * advances through the remaining windows.
 */
export async function prepareDocumentTextCatalogTextPages(
    workingCopyPath: TDocumentRef,
    documentRevisionToken: string,
    pageCount: number,
    signal?: AbortSignal,
): Promise<AsyncIterable<Pick<IDocumentTextCatalogPage, 'text' | 'layout'>> | null> {
    throwIfAborted(signal);
    const revision = parseDocumentRevisionToken(documentRevisionToken);
    if (revision === null || !Number.isSafeInteger(pageCount) || pageCount < 1) {
        return null;
    }
    const capability = getOcrCapability();
    const loadWindow = (firstPage: number, lastPage: number) => loadDocumentTextCatalogWindow(
        capability,
        workingCopyPath,
        revision,
        firstPage,
        lastPage,
        pageCount,
        signal,
    );
    let bufferedWindow: IDocumentTextCatalogWindow | null = null;
    let bufferedFirstPage = 1;
    for (; bufferedFirstPage <= pageCount; bufferedFirstPage += DOCUMENT_TEXT_CATALOG_PAGE_WINDOW) {
        throwIfAborted(signal);
        const lastPage = Math.min(pageCount, bufferedFirstPage + DOCUMENT_TEXT_CATALOG_PAGE_WINDOW - 1);
        const candidate = await loadWindow(bufferedFirstPage, lastPage);
        throwIfAborted(signal);
        if (candidate.pages.some(page => page.text.trim().length > 0)) {
            bufferedWindow = candidate;
            break;
        }
    }
    if (!bufferedWindow) {
        return null;
    }
    const firstWindow = bufferedWindow;

    return (async function* () {
        const emitWindow = function* (window: IDocumentTextCatalogWindow) {
            for (const page of window.pages) {
                throwIfAborted(signal);
                const text = page.text.trim();
                if (text) {
                    yield {
                        text,
                        ...(page.layout === undefined ? {} : {layout: page.layout}),
                    };
                }
            }
        };
        throwIfAborted(signal);
        yield* emitWindow(firstWindow);
        for (
            let firstPage = bufferedFirstPage + DOCUMENT_TEXT_CATALOG_PAGE_WINDOW;
            firstPage <= pageCount;
            firstPage += DOCUMENT_TEXT_CATALOG_PAGE_WINDOW
        ) {
            throwIfAborted(signal);
            const lastPage = Math.min(pageCount, firstPage + DOCUMENT_TEXT_CATALOG_PAGE_WINDOW - 1);
            yield* emitWindow(await loadWindow(firstPage, lastPage));
        }
    })();
}
