import pdfjsLib from '@app/services/pdfjs/runtimeLib';
import { createPdfjsDocumentInitFromBrowserDocument } from '@app/platform/browser-api/browserPdfjsDocumentInit';
import { yieldToBrowser } from '@app/platform/browser-api/browserYield';
import { extractBrowserSearchPageText } from '@app/platform/browser-api/extractBrowserSearchPageText';
import {
    getBrowserSearchWorkerRequestId,
    parseBrowserSearchWorkerRequest,
    type IBrowserSearchWorkerRequest,
    type IBrowserSearchWorkerPageRecord,
    type TBrowserSearchWorkerResponse,
} from '@app/platform/browser-api/browserSearchWorker.types';
import { BROWSER_SEARCH_LEGACY_ARRAY_PAGE_LIMIT } from '@app/platform/browser-api/browserSearchLegacyArrayPageLimit';
import {validateBrowserSearchPageCount} from '@app/platform/browser-api/browserSearchLimits';
import { getErrorMessage } from '@app/utils/error';

const canceledRequestIds = new Set<number>();
const activeLoadCancellers = new Map<number, (error: Error) => void>();
const activePageStreamAckResolvers = new Map<number, () => void>();
const activePageStreamAckRejecters = new Map<number, (error: Error) => void>();

type TBrowserSearchDocumentRequest = IBrowserSearchWorkerRequest<
    'extractDocumentText' | 'streamDocumentText'
>;

async function loadBrowserSearchDocument(request: TBrowserSearchDocumentRequest) {
    let rejectRangeReadFailure: ((error: Error) => void) | null = null;
    const rangeReadFailure = new Promise<never>((_resolve, reject) => {
        rejectRangeReadFailure = reject;
    });
    let cancelLoad: ((error: Error) => void) | null = null;
    const loadCancellation = new Promise<never>((_resolve, reject) => {
        cancelLoad = reject;
    });
    // A cancel that arrives while the document is still loading must abort the
    // load itself; the page loop below only observes cancellation once loading
    // has resolved, which for a large ranged PDF can keep range reads alive.
    activeLoadCancellers.set(request.id, (error) => cancelLoad?.(error));
    const loadingTask = pdfjsLib.getDocument(await createPdfjsDocumentInitFromBrowserDocument(pdfjsLib, request.payload.pdfPath, {onRangeReadFailure: (error) => {
        const reject = rejectRangeReadFailure;
        rejectRangeReadFailure = null;
        reject?.(error);
    }}));
    try {
        return await Promise.race([
            loadingTask.promise,
            rangeReadFailure,
            loadCancellation,
        ]);
    } catch (error) {
        await loadingTask.destroy();
        canceledRequestIds.delete(request.id);
        throw error;
    } finally {
        rejectRangeReadFailure = null;
        cancelLoad = null;
        activeLoadCancellers.delete(request.id);
    }
}

async function handleExtractDocumentTextRequest(
    request: IBrowserSearchWorkerRequest<'extractDocumentText'>,
) {
    const pdfDocument = await loadBrowserSearchDocument(request);
    if (canceledRequestIds.has(request.id)) {
        await pdfDocument.destroy();
        canceledRequestIds.delete(request.id);
        throw new Error('ERR_BROWSER_SEARCH_CANCELED');
    }
    validateBrowserSearchPageCount(pdfDocument.numPages);
    if (pdfDocument.numPages > BROWSER_SEARCH_LEGACY_ARRAY_PAGE_LIMIT) {
        await pdfDocument.destroy();
        canceledRequestIds.delete(request.id);
        throw new Error('ERR_BROWSER_SEARCH_STREAM_REQUIRED');
    }

    const pageTexts = new Array<string>(pdfDocument.numPages);

    try {
        for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
            if (canceledRequestIds.has(request.id)) {
                throw new Error('ERR_BROWSER_SEARCH_CANCELED');
            }

            const page = await pdfDocument.getPage(pageNumber);
            pageTexts[pageNumber - 1] = await extractBrowserSearchPageText(page);
            const progress = {
                id: request.id,
                type: request.type,
                ok: true,
                progress: {
                    processed: pageNumber,
                    total: pdfDocument.numPages,
                },
            } satisfies TBrowserSearchWorkerResponse;
            self.postMessage(progress);
            await yieldToBrowser();
        }

        return {
            pageCount: pdfDocument.numPages,
            pageTexts,
        };
    } finally {
        canceledRequestIds.delete(request.id);
        await pdfDocument.destroy();
    }
}

function waitForPageAcknowledgement(requestId: number) {
    return new Promise<void>((resolve, reject) => {
        activePageStreamAckResolvers.set(requestId, resolve);
        activePageStreamAckRejecters.set(requestId, reject);
    });
}

function acknowledgePage(requestId: number) {
    const resolve = activePageStreamAckResolvers.get(requestId);
    if (!resolve) {
        return;
    }
    activePageStreamAckResolvers.delete(requestId);
    activePageStreamAckRejecters.delete(requestId);
    resolve();
}

async function handleStreamDocumentTextRequest(
    request: IBrowserSearchWorkerRequest<'streamDocumentText'>,
) {
    const pdfDocument = await loadBrowserSearchDocument(request);

    try {
        validateBrowserSearchPageCount(pdfDocument.numPages);
        for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
            if (canceledRequestIds.has(request.id)) {
                throw new Error('ERR_BROWSER_SEARCH_CANCELED');
            }

            const page = await pdfDocument.getPage(pageNumber);
            if (canceledRequestIds.has(request.id)) {
                throw new Error('ERR_BROWSER_SEARCH_CANCELED');
            }
            const text = await extractBrowserSearchPageText(page);
            if (canceledRequestIds.has(request.id)) {
                throw new Error('ERR_BROWSER_SEARCH_CANCELED');
            }
            const pageRecord: IBrowserSearchWorkerPageRecord = {
                pageNumber,
                pageCount: pdfDocument.numPages,
                text,
            };
            self.postMessage({
                id: request.id,
                type: request.type,
                ok: true,
                page: pageRecord,
            });
            await waitForPageAcknowledgement(request.id);
            await yieldToBrowser();
        }

        return {pageCount: pdfDocument.numPages};
    } finally {
        const reject = activePageStreamAckRejecters.get(request.id);
        activePageStreamAckResolvers.delete(request.id);
        activePageStreamAckRejecters.delete(request.id);
        reject?.(new Error('ERR_BROWSER_SEARCH_CANCELED'));
        canceledRequestIds.delete(request.id);
        await pdfDocument.destroy();
    }
}

function handleCancelRequest(
    request: IBrowserSearchWorkerRequest<'cancel'>,
) {
    const { requestId } = request.payload;
    canceledRequestIds.add(requestId);
    activeLoadCancellers.get(requestId)?.(new Error('ERR_BROWSER_SEARCH_CANCELED'));
    activePageStreamAckRejecters.get(requestId)?.(new Error('ERR_BROWSER_SEARCH_CANCELED'));
    return { canceled: true };
}

function handleAcknowledgePageRequest(
    request: IBrowserSearchWorkerRequest<'acknowledgePage'>,
) {
    acknowledgePage(request.payload.requestId);
}

self.addEventListener('message', async (event: MessageEvent<unknown>) => {
    const request = parseBrowserSearchWorkerRequest(event.data);
    if (request === null) {
        const id = getBrowserSearchWorkerRequestId(event.data);
        if (id !== null) {
            self.postMessage({
                id,
                ok: false,
                error: 'Invalid browser search worker request',
            } satisfies TBrowserSearchWorkerResponse);
        }
        return;
    }

    try {
        if (request.type === 'cancel') {
            const data = handleCancelRequest(request);
            const response = {
                id: request.id,
                type: request.type,
                ok: true,
                data,
            } satisfies TBrowserSearchWorkerResponse;
            self.postMessage(response);
            return;
        }

        if (request.type === 'acknowledgePage') {
            handleAcknowledgePageRequest(request);
            return;
        }

        if (request.type === 'streamDocumentText') {
            const data = await handleStreamDocumentTextRequest(request);
            const response = {
                id: request.id,
                type: request.type,
                ok: true,
                data,
            } satisfies TBrowserSearchWorkerResponse;
            self.postMessage(response);
            return;
        }

        const data = await handleExtractDocumentTextRequest(request);
        const response = {
            id: request.id,
            type: request.type,
            ok: true,
            data,
        } satisfies TBrowserSearchWorkerResponse;
        self.postMessage(response);
    } catch (error) {
        const response = {
            id: request.id,
            ok: false,
            error: getErrorMessage(error),
        } satisfies TBrowserSearchWorkerResponse;
        self.postMessage(response);
    }
});
