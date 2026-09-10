import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {
    createPdfjsDocumentInitFromBrowserDocument,
    type getPdfjsLib,
} from '@app/platform/browser-api/browserPdfjsDocumentInit';
import {adaptPdfjsDocument} from '@app/services/pdfjs/pdfjsCompatibility';

type TBrowserPdfjsLib = Awaited<ReturnType<typeof getPdfjsLib>>;

export async function loadBrowserPdfjsDocument(
    pdfjsLib: TBrowserPdfjsLib,
    path: string,
): Promise<IPdfDocument> {
    let rejectRangeReadFailure: ((error: Error) => void) | null = null;
    let loadingTask: ReturnType<TBrowserPdfjsLib['getDocument']> | null = null;
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
    destroyTask = () => destroyPromise ??= loadingTask!.destroy();
    try {
        const loadedDocument = await Promise.race([
            task.promise,
            rangeReadFailure,
        ]);
        return adaptPdfjsDocument(loadedDocument, () => destroyTask!());
    } catch (error) {
        try {
            await destroyTask!();
        } catch {
            // Preserve the original load or range-read failure.
        }
        throw error;
    }
}
