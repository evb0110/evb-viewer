import type {IPdfPageSizeStore} from '@electron/pdf/pdfPageSizes';
import type {
    IRetainedDocument,
    IScanCleanupRasterDependencies,
} from '@electron/features/scan-cleanup/scanCleanupPreviewShared';
import {logScanCleanupMessage} from '@electron/features/scan-cleanup/scanCleanupRasterRetentionIo';

export async function resolveScanCleanupRasterPageSizeStore(input: {
    dependencies: IScanCleanupRasterDependencies;
    document: IRetainedDocument;
    signal: AbortSignal;
    disposed: () => boolean;
    generation: number;
    currentGeneration: () => number;
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
