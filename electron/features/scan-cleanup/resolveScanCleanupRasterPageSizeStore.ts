import type {
    IPdfPageSize,
    IPdfPageSizeStore,
} from '@electron/pdf/pdfPageSizes';
import {createArrayBackedPdfPageSizeStore} from '@evb/scan-cleanup/core/pdfPageSizes';
import {
    PAGE_SIZE_COMPATIBILITY_CHUNK_PAGES,
    type IRetainedDocument,
    type IScanCleanupRasterDependencies,
} from '@electron/features/scan-cleanup/scanCleanupPreviewShared';
import {logScanCleanupMessage} from '@electron/features/scan-cleanup/scanCleanupRasterRetentionIo';

export async function resolveScanCleanupRasterPageSizeStore(input: {
    dependencies: IScanCleanupRasterDependencies;
    document: IRetainedDocument;
    signal: AbortSignal;
    disposed: () => boolean;
    generation: number;
    currentGeneration: () => number;
    resolvePageCount: (document: IRetainedDocument, signal: AbortSignal) => Promise<number>;
    resolvePreviewPageSizes: (document: IRetainedDocument, signal: AbortSignal) => Promise<IPdfPageSize[]>;
    observePageSizeStore: (document: IRetainedDocument, store: IPdfPageSizeStore) => IPdfPageSizeStore;
}): Promise<IPdfPageSizeStore> {
    const {
        dependencies,
        document,
        signal,
    } = input;
    signal.throwIfAborted();
    const isStale = () => document.lifetime.signal.aborted
        || input.disposed()
        || input.currentGeneration() !== input.generation
        || document.removeWhenIdle;
    if (dependencies.getPageSizeStore === undefined) {
        const pageCount = await input.resolvePageCount(document, signal);
        if (pageCount > PAGE_SIZE_COMPATIBILITY_CHUNK_PAGES) {
            throw new Error('Scan cleanup page geometry requires a bounded page-size store for large documents');
        }
        const store = createArrayBackedPdfPageSizeStore(
            await input.resolvePreviewPageSizes(document, signal),
            pageCount,
        );
        if (isStale()) {
            await store.close();
            throw document.lifetime.signal.reason ?? new DOMException(
                'Scan cleanup page geometry was released',
                'AbortError',
            );
        }
        const observedStore = input.observePageSizeStore(document, store);
        document.pageSizeStores.add(observedStore);
        return observedStore;
    }
    if (!dependencies.resolveQpdfBinary) {
        throw new Error('Scan cleanup page geometry requires injected qpdf resolution');
    }
    const pdfPageOpsBinary = dependencies.resolvePageOpsBinary();
    const pdfinfoBinary = dependencies.resolvePdfInfoBinary?.();
    if (!pdfPageOpsBinary && !pdfinfoBinary) {
        throw new Error('no PDF tool is available to read page geometry');
    }
    const store = await dependencies.getPageSizeStore(document.sourcePdfPath, {
        ...(pdfPageOpsBinary ? {pdfPageOpsBinary} : {}),
        ...(pdfinfoBinary ? {pdfinfoBinary} : {}),
        qpdfBinary: dependencies.resolveQpdfBinary(),
        tempDir: await document.dir,
        signal: document.lifetime.signal,
        log: logScanCleanupMessage,
    });
    if (isStale()) {
        await store.close();
        throw document.lifetime.signal.reason ?? new DOMException(
            'Scan cleanup page geometry was released',
            'AbortError',
        );
    }
    const observedStore = input.observePageSizeStore(document, store);
    document.pageSizeStores.add(observedStore);
    return observedStore;
}
