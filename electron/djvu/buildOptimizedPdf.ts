import { tryBuildOptimizedPdfWithNativeImageCombiner } from '@electron/image/tryCreatePdfWithNativeImageCombiner';
import { PdfCombineCapabilityError } from '@electron/image/pdfCombineErrors';

interface IBuildOptimizedPdfOptions { signal?: AbortSignal; }

function throwIfAborted(signal: AbortSignal | undefined) {
    if (!signal?.aborted) {
        return;
    }
    throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException('Operation aborted', 'AbortError');
}

/** Build an optimized PDF from Netpbm image files through the native writer. */
export async function buildOptimizedPdf(
    imagePaths: string[],
    dpi: number,
    onPageProcessed?: (pageNum: number, totalPages: number) => void,
    options: IBuildOptimizedPdfOptions = {},
) {
    throwIfAborted(options.signal);
    const nativePdf = await tryBuildOptimizedPdfWithNativeImageCombiner(
        imagePaths,
        dpi,
        onPageProcessed,
        options.signal === undefined ? undefined : {signal: options.signal},
    );
    throwIfAborted(options.signal);
    if (nativePdf) {
        return nativePdf;
    }

    throw new PdfCombineCapabilityError(
        'native-failure',
        'Native optimized DjVu PDF generation did not produce an output file',
        {operation: 'djvu-pdf'},
    );
}
