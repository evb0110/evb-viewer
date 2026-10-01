import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {
    createPdfjsDocumentInitFromBrowserDocument,
    getPdfjsLib,
} from '@app/platform/browser-api/browserPdfjsDocumentInit';

/**
 * Opens a stored browser document with PDF.js. The runtime of the current
 * realm is prepared first, so no caller can load without it. A failed load
 * or range read destroys the loading task here; after a successful load the
 * caller disposes the document through `document.loadingTask.destroy()`.
 */
export async function loadBrowserPdfjsDocument(path: string): Promise<IPdfDocument> {
    const pdfjsLib = await getPdfjsLib();
    let rejectRangeReadFailure: ((error: Error) => void) | null = null;
    let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | null = null;
    let destroyPromise: Promise<void> | null = null;
    let destroyTask: (() => Promise<void>) | null = null;
    const rangeReadFailure = new Promise<never>((_resolve, reject) => {
        rejectRangeReadFailure = reject;
    });
    const task = loadingTask = pdfjsLib.getDocument(await createPdfjsDocumentInitFromBrowserDocument(pdfjsLib, path, {onRangeReadFailure: (error) => {
        const reject = rejectRangeReadFailure;
        reject?.(error);
        void destroyTask?.().catch(() => {});
    }}));
    destroyTask = () => destroyPromise ??= loadingTask.destroy();
    try {
        return await Promise.race([
            task.promise,
            rangeReadFailure,
        ]);
    } catch (error) {
        try {
            await destroyTask();
        } catch {
            // Preserve the original load or range-read failure.
        }
        throw error;
    }
}
