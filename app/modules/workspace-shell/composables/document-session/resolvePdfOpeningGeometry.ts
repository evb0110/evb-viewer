import type {
    IPdfOpeningGeometry,
    TOpenFileResult,
} from '@contracts/electronApiDocuments';
import { requirePageNumber } from '@contracts/pageNumbers';
import { parseEpochMs } from '@contracts/timestamps';
import type { TDocumentRef } from '@contracts/documentRef';
import type { IDocumentOpenSurfaceSession } from '@app/modules/document-viewer/public';
import type { IPdfValidationSourceRevision } from '@app/modules/workspace-shell/composables/document-session/pdfValidationRevisionCache';
import type { IPdfOpeningGeometryResolution } from '@app/modules/workspace-shell/composables/document-session/stagePdfOpeningPreview';
import {
    cacheTrustedPdfOpenGeometry,
    readPrevalidatedTrustedPdfOpenGeometry,
} from '@app/modules/pdf-viewer/public/openGeometry';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getErrorMessage } from '@app/utils/error';

const RECENT_OPEN_LOG_SECTION = 'recent-open';

function sourceRevision(
    documentId: TDocumentRef,
    geometry: Pick<IPdfOpeningGeometry, 'size' | 'modifiedAt'> | null | undefined,
): IPdfValidationSourceRevision | null {
    const modifiedAt = parseEpochMs(geometry?.modifiedAt);
    return geometry
        && Number.isSafeInteger(geometry.size)
        && modifiedAt !== null
        ? {
            documentId,
            size: geometry.size,
            modifiedAt,
        }
        : null;
}

export function resolvePdfOpeningGeometry(options: {
    readonly concurrent: boolean;
    readonly isCurrent: () => boolean;
    readonly openSurface?: IDocumentOpenSurfaceSession | undefined;
    readonly readOpeningGeometry?: (() => Promise<IPdfOpeningGeometry | null>) | undefined;
    readonly readSourceRevision: () => Promise<{
        readonly fileSize?: number;
        readonly modifiedAt?: number;
    } | null>;
    readonly result: Extract<TOpenFileResult, {kind: 'pdf'}>;
}) {
    const {
        isCurrent,
        openSurface,
        result,
    } = options;
    const surfaceSnapshot = openSurface?.snapshot.value;
    const surfaceGeneration = surfaceSnapshot?.generation;
    const cachedGeometry = readPrevalidatedTrustedPdfOpenGeometry(
        result.originalPath,
        requirePageNumber(1),
    );
    if (
        cachedGeometry
        && openSurface
        && surfaceSnapshot?.phase === 'pending'
        && surfaceSnapshot.identity?.documentId === result.originalPath
        && openSurface.viewportSession.value.requestedPage === cachedGeometry.pageNumber
        && isCurrent()
    ) {
        openSurface.commitOpeningPageGeometry(surfaceSnapshot.generation, cachedGeometry);
    }

    const initialOpeningGeometry = (result.openingGeometry ?? cachedGeometry) as IPdfOpeningGeometry | null;
    const initialSourceRevision = sourceRevision(result.originalPath, initialOpeningGeometry);
    const recentSourceTask = options.concurrent
        ? options.readSourceRevision().catch(() => null)
        : Promise.resolve(null);
    const validationRevision = initialSourceRevision === null
        ? recentSourceTask.then(recentSource => {
            const modifiedAt = parseEpochMs(recentSource?.modifiedAt);
            return recentSource?.fileSize !== undefined && modifiedAt !== null
                ? {
                    documentId: result.originalPath,
                    size: recentSource.fileSize,
                    modifiedAt,
                }
                : null;
        })
        : Promise.resolve(initialSourceRevision);
    const fallback: IPdfOpeningGeometryResolution = {
        openingGeometry: initialOpeningGeometry,
        sourceRevision: initialSourceRevision,
    };
    if (!options.concurrent || !options.readOpeningGeometry) {
        return {
            resolution: validationRevision.then(resolvedRevision => ({
                ...fallback,
                sourceRevision: resolvedRevision,
            })),
            validationRevision,
        };
    }

    const resolution = Promise.all([
        options.readOpeningGeometry(),
        validationRevision,
    ])
        .then(([
            openingGeometry,
            resolvedValidationRevision,
        ]) => {
            const resolvedSourceRevision = initialSourceRevision ?? resolvedValidationRevision;
            if (openingGeometry === null) {
                return {
                    openingGeometry: fallback.openingGeometry,
                    sourceRevision: resolvedSourceRevision,
                };
            }
            const cached = cacheTrustedPdfOpenGeometry(result.originalPath, openingGeometry, {
                makeSynchronouslyAvailable: resolvedSourceRevision !== null,
                ...(resolvedSourceRevision ? {sourceRevision: resolvedSourceRevision} : {}),
            });
            const resolvedGeometry = cached ?? openingGeometry;
            const currentSurface = openSurface?.snapshot.value;
            if (
                openSurface
                && currentSurface?.phase === 'pending'
                && currentSurface.generation === surfaceGeneration
                && currentSurface.identity?.documentId === result.originalPath
                && openSurface.viewportSession.value.requestedPage === resolvedGeometry.pageNumber
                && isCurrent()
            ) {
                openSurface.commitOpeningPageGeometry(currentSurface.generation, {
                    documentId: result.originalPath,
                    ...resolvedGeometry,
                });
            }
            return {
                openingGeometry: resolvedGeometry as IPdfOpeningGeometry,
                sourceRevision: resolvedSourceRevision,
            };
        })
        .catch((error: unknown) => {
            BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'PDF opening geometry unavailable', {
                workingPath: result.workingPath,
                error: getErrorMessage(error),
            });
            return fallback;
        });
    return {
        resolution,
        validationRevision,
    };
}
