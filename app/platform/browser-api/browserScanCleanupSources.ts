import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {BROWSER_PAGE_OPS_MAX_REQUEST_BYTES} from '@contracts/browserPageOpsLimits';
import {isBrowserPageOpsWasmFailure} from '@contracts/browserPageOpsWorker';
import {REQUEST_HEADER} from '@contracts/browserPageOpsWasm.generated';
import * as v from 'valibot';
import {decodePdfPageSizeRecord} from '@evb/scan-cleanup/core/policy/scanCleanupRasterPolicy';
import {
    reduceScanCleanupRasterRows,
    type IScanCleanupRasterRow,
} from '@evb/scan-cleanup/core/sourceRasterFacts';
import {browserDocumentStore} from '@app/platform/browserDocumentStore';
import {loadBrowserPdfjsDocument} from '@app/platform/browser-api/loadBrowserPdfjsDocument';
import {runBrowserPageOpsWorkerRequest} from '@app/platform/browser-api/browserPageOpsWorkerClient';
import type {IBrowserScanCleanupSource} from '@app/platform/browser-api/browserScanCleanupJob';

interface ISourceEntry {
    borrowers: number;
    controller: AbortController;
    promise: Promise<IBrowserScanCleanupSource>;
}

const sources = new Map<string, ISourceEntry>();

const count = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
/** What browser inspection adds to a page record: the facts desktop reads from pdfimages and the annotation index. */
const INSPECTED_PAGE_FACTS_SCHEMA = v.object({
    rasterUses: v.array(v.object({
        kind: v.picklist([
            'image',
            'stencil',
            'mask',
            'smask',
        ]),
        widthPx: count,
        heightPx: count,
        bitsPerComponent: count,
        objectNumber: count,
        xPpi: count,
        yPpi: count,
    })),
    rasterInventoryComplete: v.boolean(),
    hasAnnotations: v.boolean(),
});

/**
 * Opens one revision of a source: its page records, read once by the same
 * Rust reader desktop's page-size sidecar runs, and its PDF.js document.
 */
async function openSource(ref: string, revision: string, signal: AbortSignal): Promise<IBrowserScanCleanupSource> {
    const token = requireDocumentRevisionToken(revision);
    await browserDocumentStore.assertDocumentRevisionCurrent(ref, token);
    const data = await browserDocumentStore.read(ref, {maxBytes: BROWSER_PAGE_OPS_MAX_REQUEST_BYTES - REQUEST_HEADER.bytes});
    const inspected = await runBrowserPageOpsWorkerRequest('inspectScanCleanupPdf', {
        data,
        pages: [],
    }, {
        dedicated: true,
        signal,
    });
    if (isBrowserPageOpsWasmFailure(inspected)) {
        throw new Error(`Scan cleanup could not read the page geometry: ${inspected.error.message}`);
    }
    const pageSizes = inspected.pages.map((page, index) => decodePdfPageSizeRecord(page, inspected.pageCount, `page ${String(index + 1)}`));
    if (pageSizes.length !== inspected.pageCount || pageSizes.some((page, index) => page.pageNumber !== index + 1)) {
        throw new Error('Scan cleanup page geometry does not cover the document in page order');
    }
    const rasterRows: IScanCleanupRasterRow[] = [];
    const annotatedPages = new Set<number>();
    const incompleteRasterPages = new Set<number>();
    for (const [
        index,
        record,
    ] of inspected.pages.entries()) {
        const facts = v.parse(INSPECTED_PAGE_FACTS_SCHEMA, record);
        const pageNumber = index + 1;
        if (!facts.rasterInventoryComplete) incompleteRasterPages.add(pageNumber);
        if (facts.hasAnnotations) annotatedPages.add(pageNumber);
        for (const use of facts.rasterUses) {
            rasterRows.push({
                pageNumber,
                type: use.kind,
                width: use.widthPx,
                height: use.heightPx,
                bitsPerComponent: use.bitsPerComponent,
                objectId: use.objectNumber,
                xPpi: use.xPpi,
                yPpi: use.yPpi,
            });
        }
    }
    signal.throwIfAborted();
    const pdf = await loadBrowserPdfjsDocument(ref);
    try {
        signal.throwIfAborted();
        await browserDocumentStore.assertDocumentRevisionCurrent(ref, token);
    } catch (error) {
        await pdf.loadingTask.destroy();
        throw error;
    }
    return {
        ref,
        revision,
        pageSizes,
        rasterRows,
        incompleteRasterPages,
        rasterFacts: reduceScanCleanupRasterRows(rasterRows),
        annotatedPages,
        pdf,
    };
}

export function scanCleanupSourceKey(ref: string, revision: string) {
    return `${ref}\u0000${revision}`;
}

/**
 * Borrows one revision of a source. Preview and detection read the same
 * snapshot; it opens under its own signal, so canceling one borrower's work
 * never cancels another's open, and it closes when its last borrower releases
 * it. A failed open is not kept: the next borrow opens it again.
 */
export function borrowBrowserScanCleanupSource(ref: string, revision: string) {
    const key = scanCleanupSourceKey(ref, revision);
    let entry = sources.get(key);
    if (entry === undefined) {
        const controller = new AbortController();
        const promise = openSource(ref, revision, controller.signal);
        const created: ISourceEntry = {
            borrowers: 0,
            controller,
            promise,
        };
        promise.catch(() => {
            if (sources.get(key) === created) sources.delete(key);
        });
        sources.set(key, created);
        entry = created;
    }
    entry.borrowers += 1;
    const borrowed = entry;
    let released = false;
    return {
        key,
        ref,
        opened: borrowed.promise,
        /** The snapshot failed to open, or was closed; borrow again for a fresh one. */
        get stale() {
            return sources.get(key) !== borrowed;
        },
        release() {
            if (released) return;
            released = true;
            borrowed.borrowers -= 1;
            if (borrowed.borrowers > 0) return;
            if (sources.get(key) === borrowed) sources.delete(key);
            borrowed.controller.abort(new DOMException('Scan cleanup source was released.', 'AbortError'));
            void borrowed.promise.then(opened => opened.pdf.loadingTask.destroy()).catch(() => undefined);
        },
    };
}

export type TBrowserScanCleanupSourceBorrow = ReturnType<typeof borrowBrowserScanCleanupSource>;

function abortReason(signal: AbortSignal) {
    return signal.reason instanceof Error || signal.reason instanceof DOMException
        ? signal.reason
        : new DOMException('Scan cleanup was canceled.', 'AbortError');
}

/** Waits for a shared promise on behalf of one caller, who may stop waiting without canceling it. */
export function awaitScanCleanupSource<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(abortReason(signal));
    return new Promise<T>((resolve, reject) => {
        const abort = () => reject(abortReason(signal));
        signal.addEventListener('abort', abort, {once: true});
        promise.then(value => {
            signal.removeEventListener('abort', abort);
            resolve(value);
        }, (error: unknown) => {
            signal.removeEventListener('abort', abort);
            reject(error);
        });
    });
}
