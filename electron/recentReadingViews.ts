import {isEqual} from 'es-toolkit/predicate';
import type {IRecentReadingView} from '@contracts/recentReadingView';
import {parseDocumentRef} from '@contracts/documentRef';
import {
    getWorkingCopyOriginalFileExpectation,
    getWorkingCopyOriginalPath,
} from '@electron/file-access/workingCopyStore';
import {getAdmittedDjvuViewingSource} from '@electron/features/djvu/public';
import {
    mutateRecentFiles,
    readRecentFilesData,
} from '@electron/recentFiles';

// Reading views are stored with their Recent entries, but which source bytes a
// view belongs to is the working-copy registry's knowledge, not the list's.

// The source a document was admitted from, with the size and modification
// time it had then: the identity a reading view belongs to. A PDF is shown
// from a working copy whose registry recorded its source; a DjVu is read live
// from its source, whose open recorded the metadata its probe read. Read when
// the call arrives, while the sender still owns the working copy or grant.
async function readAdmittedSource(documentPath: string, senderWebContentsId: number) {
    const mapped = getWorkingCopyOriginalPath(documentPath, senderWebContentsId);
    const expectation = getWorkingCopyOriginalFileExpectation(documentPath, senderWebContentsId);
    const originalPath = mapped && !mapped.retired ? parseDocumentRef(mapped.originalPath) : null;
    if (originalPath && expectation) {
        return {
            originalPath,
            sourceSize: expectation.size,
            sourceModifiedAtMs: expectation.mtimeMs,
        };
    }
    const djvu = await getAdmittedDjvuViewingSource(documentPath, senderWebContentsId);
    const djvuPath = djvu ? parseDocumentRef(djvu.originalPath) : null;
    return djvu && djvuPath
        ? {
            originalPath: djvuPath,
            sourceSize: djvu.sourceSize,
            sourceModifiedAtMs: djvu.sourceModifiedAt,
        }
        : null;
}

/** Remembers where a reader left a document that is already in Recent; never adds an entry. */
export async function rememberRecentReadingView(documentPath: string, view: IRecentReadingView, senderWebContentsId: number) {
    const source = await readAdmittedSource(documentPath, senderWebContentsId);
    if (!source) {
        return;
    }
    const {
        originalPath, ...witness
    } = source;
    await mutateRecentFiles((data) => {
        const entry = data.files.find(file => file.originalPath === originalPath);
        const readingView = {
            ...view,
            ...witness,
        };
        if (!entry || isEqual(entry.readingView, readingView)) {
            return false;
        }
        entry.readingView = readingView;
        return true;
    });
}

/** The view a reader left this document's source at, if the source is the bytes it was left on. */
export async function getRecentReadingView(documentPath: string, senderWebContentsId: number): Promise<IRecentReadingView | null> {
    const source = await readAdmittedSource(documentPath, senderWebContentsId);
    return source ? readRecentReadingViewOf(source) : null;
}

/**
 * The view stored for a source with the size and modification time main
 * itself read from it: the working copy's admission, a DjVu grant, or an
 * opening preflight's stat of the Recent original.
 */
export async function readRecentReadingViewOf(source: {
    originalPath: string;
    sourceSize: number;
    sourceModifiedAtMs: number;
}): Promise<IRecentReadingView | null> {
    const stored = (await readRecentFilesData()).files.find(file => file.originalPath === source.originalPath)?.readingView;
    if (stored?.sourceSize !== source.sourceSize || stored.sourceModifiedAtMs !== source.sourceModifiedAtMs) {
        return null;
    }
    const {
        sourceSize: _sourceSize,
        sourceModifiedAtMs: _sourceModifiedAtMs,
        ...view
    } = stored;
    return view;
}

/** The Recent reading-view IPC handlers; the sender owns the working copy or DjVu grant. */
export const recentReadingViewMainBindings = {
    getRecentReadingView: (context: {senderId: number}, documentPath: string) => getRecentReadingView(documentPath, context.senderId),
    rememberRecentReadingView: async (context: {senderId: number}, documentPath: string, view: IRecentReadingView) => {
        await rememberRecentReadingView(documentPath, view, context.senderId);
        return undefined;
    },
};
