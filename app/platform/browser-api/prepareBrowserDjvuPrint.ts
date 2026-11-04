import type {
    IDjvuPrintOptions,
    IDjvuPrintResult,
} from '@contracts/electronApiDjvu';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TJobId } from '@contracts/shared';
import { browserDocumentStore } from '@app/platform/browserDocumentStore';
import { getDocumentRefBaseName } from '@app/utils/documentRef';
import { runBrowserDjvuConversion } from '@app/platform/browser-api/browserDjvuConversionPipeline';
import { layoutPdfForPrint } from '@app/platform/browser-api/browserPageOpsCore';
import { BROWSER_PAGE_OPS_MAX_REQUEST_BYTES } from '@contracts/browserPageOpsLimits';

// Each print's cancellation, from conversion through layout and publication.
const printCancellations = new Map<string, AbortController>();

/** Cancels the print preparation of `jobId`, if one is running. */
export function cancelBrowserDjvuPrint(jobId: string) {
    const controller = printCancellations.get(jobId);
    controller?.abort();
    return controller !== undefined;
}

function createPrintDocument(name: string, data: Uint8Array) {
    return browserDocumentStore.createStoredDocument(name, data, {
        kind: 'output',
        retention: 'transient',
        mimeType: 'application/pdf',
        saveKind: 'pdf',
    });
}

/**
 * Prepares a DjVu for printing as desktop does (runDjvuPrintPath): the
 * selected pages are converted to PDF, then laid out on print sheets when
 * the view mode or orientation asks for it. A browser has no print dialog
 * of its own, so the prepared PDF is returned for the workspace's browser
 * print, which removes it through cleanupTemp once printed.
 */
export async function prepareBrowserDjvuPrint(
    djvuPath: TDocumentRef,
    options: IDjvuPrintOptions,
    jobId: TJobId,
): Promise<IDjvuPrintResult> {
    const baseName = (getDocumentRefBaseName(djvuPath) ?? 'document').replace(/\.[^.]+$/u, '');
    const cancellation = new AbortController();
    printCancellations.set(jobId, cancellation);
    const {signal} = cancellation;
    const convertedPath = await createPrintDocument(`${baseName}-print.pdf`, new Uint8Array());
    let printablePath: TDocumentRef | null = null;
    try {
        // Canceled while its output was being created: no conversion starts.
        signal.throwIfAborted();
        const converted = await runBrowserDjvuConversion(djvuPath, convertedPath, {
            jobId,
            pdfStrategy: options.pdfStrategy ?? 'compact-djvu-aware',
            ...(options.subsample === undefined ? {} : {subsample: options.subsample}),
            preserveBookmarks: false,
        }, options.pageNumbers);
        if (!converted.success) {
            return {
                success: false,
                jobId,
                ...(converted.expected?.code === 'canceled' ? {canceled: true} : {}),
                error: converted.error,
            };
        }
        if (options.viewMode === 'single' && options.orientation === 'auto') {
            printablePath = convertedPath;
        } else {
            signal.throwIfAborted();
            const laidOut = await layoutPdfForPrint(await browserDocumentStore.read(convertedPath, {maxBytes: BROWSER_PAGE_OPS_MAX_REQUEST_BYTES}), {
                viewMode: options.viewMode,
                orientation: options.orientation,
                signal,
            });
            signal.throwIfAborted();
            printablePath = await createPrintDocument(`${baseName}-print-layout.pdf`, laidOut.data);
        }
        signal.throwIfAborted();
        return {
            success: true,
            jobId,
            printablePdfPath: printablePath,
        };
    } catch (error) {
        if (!signal.aborted) throw error;
        return {
            success: false,
            jobId,
            canceled: true,
            error: 'DjVu print was canceled',
        };
    } finally {
        printCancellations.delete(jobId);
        // A canceled print publishes nothing; otherwise only the laid-out copy outlives preparation.
        for (const path of new Set([
            convertedPath,
            printablePath,
        ])) {
            if (path && (signal.aborted || path !== printablePath)) {
                await browserDocumentStore.remove(path).catch(() => undefined);
            }
        }
    }
}
