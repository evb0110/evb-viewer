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
 * that the file is unchanged, so the answer is usually back before the open
 * claims its tab.
 */
export interface IPdfPageShapeRead {
    readonly path: TDocumentRef;
    readonly answer: Promise<IPdfOpeningGeometry | null>;
    /** The answer once it has arrived; undefined while it is on its way. */
    settled(): IPdfOpeningGeometry | null | undefined;
}

export function readPdfPageShape(path: TDocumentRef | null | undefined): IPdfPageShapeRead | null {
    const read = getDocumentFilesCapability().getPdfOpeningGeometry;
    if (!path || !read || !/\.pdf$/iu.test(path)) {
        return null;
    }
    let settled: IPdfOpeningGeometry | null | undefined;
    const answer = read(path)
        .catch((error: unknown) => {
            BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'PDF opening geometry unavailable', {
                path,
                error: getErrorMessage(error),
            });
            return null;
        })
        .then(shape => (settled = shape));
    return {
        path,
        answer,
        settled: () => settled,
    };
}

/** A normal open's taker of where its reader left the bytes it opens. */
export interface IOpeningReadingSeed {
    seed(view: IRecentReadingView): void;
    /** The seed is the view shown at once (nothing else is shown), so the frame reads it live. */
    readonly shown: boolean;
}

/**
 * Claims the opening surface for an open. A page shape already in hand goes
 * into the claim, so the first frame shows the page skeleton; one still on
 * its way is committed when it arrives, if the same claim still owns the
 * surface. A normal open (`reading`) starts where main found its reader left
 * these bytes: that page, in that view, its point placed by the open's own
 * restore navigation, unless the reader has navigated first. Any other open
 * starts at `initialPage` and takes a shape only of that page.
 */
export function beginOpenSurfaceWithPageShape(
    openSurface: IDocumentOpenSurfaceSession,
    identity: Parameters<IDocumentOpenSurfaceSession['begin']>[0],
    initialPage: number,
    pageShape: IPdfPageShapeRead | null,
    reading: IOpeningReadingSeed | null = null,
) {
    const settled = pageShape?.settled();
    const readingOf = (shape: IPdfOpeningGeometry) => (reading ? shape.readingView ?? null : null);
    const openingPage = settled && readingOf(settled) ? settled.pageNumber : initialPage;
    // A view shown at once is read live; one kept for the next source is the frame's own.
    const geometryOf = (shape: IPdfOpeningGeometry) => ({
        documentId: identity.documentId,
        ...shape,
        readingView: reading?.shown ? null : readingOf(shape),
    });
    const present = (shape: IPdfOpeningGeometry) => {
        const view = readingOf(shape);
        if (view && openSurface.navigationTicket.value?.request.source === 'restore') {
            openSurface.navigate(createPageNavigationRequest(shape.pageNumber, 'restore', view.anchor));
            reading?.seed(view);
        }
        return openSurface.viewportSession.value.requestedPage === shape.pageNumber ? geometryOf(shape) : null;
    };
    const generation = openSurface.begin(identity, settled?.pageNumber === openingPage ? geometryOf(settled) : null, openingPage);
    if (settled) {
        present(settled);
        return;
    }
    if (!pageShape || settled !== undefined) {
        return;
    }
    void pageShape.answer.then((shape) => {
        const current = openSurface.snapshot.value;
        const geometry = shape
            && current.phase === 'pending'
            && current.generation === generation
            && current.identity?.documentRevision === identity.documentRevision
            ? present(shape)
            : null;
        if (geometry) {
            openSurface.commitOpeningPageGeometry(generation, geometry);
        }
    });
}
