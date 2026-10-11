import type {IPageOpsMetadataSnapshot} from '@contracts/electronApiPageOps';
import {
    applyPageMetadataRemap, getPdfPageCount,
} from '@electron/features/page-ops/public';

/** OCR changes text, so every source page retains its identity. */
export async function persistOcrPageMetadata(
    workingCopyPath: string,
    metadataSnapshot: IPageOpsMetadataSnapshot | undefined,
    signal: AbortSignal,
    cancelGroup: string,
) {
    if (!metadataSnapshot) return;
    const pageCount = await getPdfPageCount(workingCopyPath, {
        signal,
        cancelGroup,
    });
    await applyPageMetadataRemap({
        workingCopyPath,
        metadataSnapshot,
        delta: {
            previousPageCount: pageCount,
            nextPageCount: pageCount,
            ranges: [{
                kind: 'retain',
                fromPageNumber: 1,
                toPageNumber: 1,
                count: pageCount,
            }],
        },
        signal,
        cancelGroup,
    });
}
