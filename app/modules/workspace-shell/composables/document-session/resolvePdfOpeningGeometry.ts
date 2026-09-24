import type {
    IPdfOpeningGeometry,
    TOpenFileResult,
} from '@contracts/electronApiDocuments';
import { parseEpochMs } from '@contracts/timestamps';
import type { IDocumentOpenSurfaceSession } from '@app/modules/document-viewer/public';
import type { IPdfValidationSourceRevision } from '@app/modules/workspace-shell/composables/document-session/pdfValidationRevisionCache';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getErrorMessage } from '@app/utils/error';

const RECENT_OPEN_LOG_SECTION = 'recent-open';

/**
 * Starts the concurrent opening probes for a PDF: the source revision used to
 * reuse a cached validation, and the first-page geometry that sizes the
 * opening skeleton before PDF.js paints.
 */
export function resolvePdfOpeningGeometry(options: {
    readonly isCurrent: () => boolean;
    readonly openSurface?: IDocumentOpenSurfaceSession | undefined;
    readonly readOpeningGeometry?: (() => Promise<IPdfOpeningGeometry | null>) | undefined;
    readonly readSourceRevision: () => Promise<{
        readonly fileSize?: number;
        readonly modifiedAt?: number;
    } | null>;
    readonly result: Extract<TOpenFileResult, {kind: 'pdf'}>;
}): {readonly validationRevision: Promise<IPdfValidationSourceRevision | null>} {
    const {
        isCurrent,
        openSurface,
        result,
    } = options;
    const surfaceGeneration = openSurface?.snapshot.value.generation;
    const validationRevision = options.readSourceRevision()
        .catch(() => null)
        .then((source) => {
            const modifiedAt = parseEpochMs(source?.modifiedAt);
            return source?.fileSize !== undefined && modifiedAt !== null
                ? {
                    documentId: result.originalPath,
                    size: source.fileSize,
                    modifiedAt,
                }
                : null;
        });
    const readOpeningGeometry = options.readOpeningGeometry;
    if (readOpeningGeometry) {
        void readOpeningGeometry()
            .then((openingGeometry) => {
                const currentSurface = openSurface?.snapshot.value;
                if (
                    openingGeometry
                    && openSurface
                    && currentSurface?.phase === 'pending'
                    && currentSurface.generation === surfaceGeneration
                    && currentSurface.identity?.documentId === result.originalPath
                    && openSurface.viewportSession.value.requestedPage === openingGeometry.pageNumber
                    && isCurrent()
                ) {
                    openSurface.commitOpeningPageGeometry(currentSurface.generation, {
                        documentId: result.originalPath,
                        ...openingGeometry,
                    });
                }
            })
            .catch((error: unknown) => {
                BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'PDF opening geometry unavailable', {
                    workingPath: result.workingPath,
                    error: getErrorMessage(error),
                });
            });
    }
    return {validationRevision};
}
