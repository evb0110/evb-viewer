import type { IPdfOpeningGeometry } from '@contracts/electronApiDocuments';
import type { TDocumentRef } from '@contracts/documentRef';
import type { IRecentReadingView } from '@contracts/recentReadingView';
import {
    createPageNavigationRequest,
    type IDocumentOpenSurfaceSession,
} from '@app/modules/document-viewer/public';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getErrorMessage } from '@app/utils/error';
import { getDocumentFilesCapability } from '@app/utils/platformDocuments';

const RECENT_OPEN_LOG_SECTION = 'recent-open';

/**
 * One open's question to the main process for its first page's shape, asked
 * as soon as the open's input names the file. The main process owns the
 * shapes and answers a file it has read before from memory, after checking
 * that the file is unchanged. The open takes the answer before claiming its
 * surface.
 */
export interface IPdfPageShapeRead {
    readonly path: TDocumentRef;
    readonly answer: Promise<IPdfOpeningGeometry | null>;
}

export function readPdfPageShape(path: TDocumentRef | null | undefined): IPdfPageShapeRead | null {
    const read = getDocumentFilesCapability().getPdfOpeningGeometry;
    if (!path || !read || !/\.pdf$/iu.test(path)) {
        return null;
    }
    const answer = read(path)
        .catch((error: unknown) => {
            BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'PDF opening geometry unavailable', {
                path,
                error: getErrorMessage(error),
            });
            return null;
        });
    return {
        path,
        answer,
    };
}

/** A normal open's taker of where its reader left the bytes it opens. */
export interface IOpeningReadingSeed {
    seed(view: IRecentReadingView): void;
    /** The seed is the view shown at once (nothing else is shown), so the frame reads it live. */
    readonly shown: boolean;
}

/**
 * Claims the opening surface with the admitted shape. A normal open starts
 * at its remembered page and seeds its view before the first frame; other
 * opens take a shape only of `initialPage`.
 */
export function beginOpenSurfaceWithPageShape(
    openSurface: IDocumentOpenSurfaceSession,
    identity: Parameters<IDocumentOpenSurfaceSession['begin']>[0],
    initialPage: number,
    shape: IPdfOpeningGeometry | null,
    reading: IOpeningReadingSeed | null = null,
) {
    const view = reading && shape ? shape.readingView ?? null : null;
    const openingPage = shape && view ? shape.pageNumber : initialPage;
    openSurface.begin(identity, shape?.pageNumber === openingPage ? {
        documentId: identity.documentId,
        ...shape,
        readingView: reading?.shown ? null : view,
    } : null, openingPage);
    if (shape && view) {
        openSurface.navigate(createPageNavigationRequest(shape.pageNumber, 'restore', view.anchor));
        reading?.seed(view);
    }
}
