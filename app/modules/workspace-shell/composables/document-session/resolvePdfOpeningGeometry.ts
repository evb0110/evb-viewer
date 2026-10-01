import type {
    IPdfOpeningGeometry,
    TOpenFileResult,
} from '@contracts/electronApiDocuments';
import type { TDocumentRef } from '@contracts/documentRef';
import { parseEpochMs } from '@contracts/timestamps';
import type { IDocumentOpenSurfaceSession } from '@app/modules/document-viewer/public';
import type { IPdfValidationSourceRevision } from '@app/modules/workspace-shell/composables/document-session/pdfValidationRevisionCache';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getErrorMessage } from '@app/utils/error';

const RECENT_OPEN_LOG_SECTION = 'recent-open';

/**
 * Reads the first page's geometry and gives it to the opening surface, which
 * sizes the opening skeleton from it, when the same open still owns the same
 * surface generation. Resolves whether the geometry was committed. An open
 * that starts on another page has nothing to commit, so it reads nothing.
 */
export function commitPdfOpeningGeometryWhenRead(options: {
    readonly documentId: TDocumentRef;
    readonly isCurrent: () => boolean;
    readonly openSurface?: IDocumentOpenSurfaceSession | undefined;
    readonly read: () => Promise<IPdfOpeningGeometry | null>;
}): Promise<boolean> {
    const {
        documentId,
        isCurrent,
        openSurface,
    } = options;
    if (openSurface?.viewportSession.value.requestedPage !== 1) {
        return Promise.resolve(false);
    }
    const surfaceGeneration = openSurface.snapshot.value.generation;
    return options.read()
        .then((openingGeometry) => {
            const currentSurface = openSurface.snapshot.value;
            return Boolean(
                openingGeometry
                && currentSurface.phase === 'pending'
                && currentSurface.generation === surfaceGeneration
                && currentSurface.identity?.documentId === documentId
                && openSurface.viewportSession.value.requestedPage === openingGeometry.pageNumber
                && isCurrent()
                && openSurface.commitOpeningPageGeometry(currentSurface.generation, {
                    documentId,
                    ...openingGeometry,
                }),
            );
        })
        .catch((error: unknown) => {
            BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'PDF opening geometry unavailable', {
                documentId,
                error: getErrorMessage(error),
            });
            return false;
        });
}

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
    if (options.readOpeningGeometry) {
        void commitPdfOpeningGeometryWhenRead({
            documentId: result.originalPath,
            isCurrent,
            openSurface,
            read: options.readOpeningGeometry,
        });
    }
    return {validationRevision};
}
