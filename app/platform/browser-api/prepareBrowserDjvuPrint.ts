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
    const convertedPath = await createPrintDocument(`${baseName}-print.pdf`, new Uint8Array());
    let printablePath: TDocumentRef | null = null;
    try {
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
            const laidOut = await layoutPdfForPrint(await browserDocumentStore.read(convertedPath), {
                viewMode: options.viewMode,
                orientation: options.orientation,
            });
            printablePath = await createPrintDocument(`${baseName}-print-layout.pdf`, laidOut.data);
        }
        return {
            success: true,
            jobId,
            printablePdfPath: printablePath,
        };
    } finally {
        if (printablePath !== convertedPath) {
            await browserDocumentStore.remove(convertedPath).catch(() => undefined);
        }
    }
}
