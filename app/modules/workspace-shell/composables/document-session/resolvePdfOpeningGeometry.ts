import type { IPdfOpeningGeometry } from '@contracts/electronApiDocuments';
import type { TDocumentRef } from '@contracts/documentRef';
import type { IDocumentOpenSurfaceSession } from '@app/modules/document-viewer/public';
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

/**
 * Claims the opening surface for an open. A page shape already in hand goes
 * into the claim, so the first frame shows the page skeleton; one still on
 * its way is committed when it arrives, if the same claim still owns the
 * surface. The shape describes page 1, so an open at another page waits for
 * that page's shape from the document.
 */
export function beginOpenSurfaceWithPageShape(
    openSurface: IDocumentOpenSurfaceSession,
    identity: Parameters<IDocumentOpenSurfaceSession['begin']>[0],
    initialPage: number,
    pageShape: IPdfPageShapeRead | null,
) {
    const read = initialPage === 1 ? pageShape : null;
    const settled = read?.settled();
    const generation = openSurface.begin(identity, settled
        ? {
            documentId: identity.documentId,
            ...settled,
        }
        : null, initialPage);
    if (!read || settled !== undefined) {
        return;
    }
    void read.answer.then((shape) => {
        const current = openSurface.snapshot.value;
        if (
            shape
            && current.phase === 'pending'
            && current.generation === generation
            && current.identity?.documentRevision === identity.documentRevision
            && openSurface.viewportSession.value.requestedPage === shape.pageNumber
        ) {
            openSurface.commitOpeningPageGeometry(generation, {
                documentId: identity.documentId,
                ...shape,
            });
        }
    });
}
