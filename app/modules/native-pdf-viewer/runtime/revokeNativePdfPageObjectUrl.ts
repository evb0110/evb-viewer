import type { IPagePreviewSource } from '@app/modules/document-viewer/public';
import { BrowserLogger } from '@app/utils/browserLogger';

export function revokeNativePdfPageObjectUrl(
    source: Pick<IPagePreviewSource, 'revokeObjectURL'>,
    pageNumber: number,
    objectUrl: string,
) {
    try {
        source.revokeObjectURL(objectUrl);
    } catch (error) {
        BrowserLogger.warn('native-pdf-viewer', 'Failed to revoke PDF page URL', {
            pageNumber,
            error,
        });
    }
}
