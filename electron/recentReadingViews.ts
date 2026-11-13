import {loadSettings} from '@electron/settings';
import {isEqual} from 'es-toolkit/predicate';
import type {IRecentReadingView} from '@contracts/recentReadingView';
import {parseDocumentRef} from '@contracts/documentRef';
import {
    getBaselineFileVersion,
    getWorkingCopyOriginalPath,
} from '@electron/file-access/documentStore';
import {getAdmittedDjvuViewingSource} from '@electron/features/djvu/public';
import {
    mutateRecentFiles,
    readRecentFilesData,
} from '@electron/recentFiles';

/** A file version as a reading view names it: its size, and its modification time in fractional milliseconds. */
export function readingViewSourceOf(version: {size: bigint; mtimeNs: bigint}) {
    return {sourceSize: Number(version.size), sourceModifiedAtMs: Number(version.mtimeNs) / 1_000_000};
}

// A reading view, stored with its Recent entry, belongs to a version of its file: for a PDF the one its document last
// read or saved (its baseline, so a Save moves the view along), for a DjVu the one its open probed. Read while the
// sender still owns the document or grant.
async function readAdmittedSource(documentPath: string, senderWebContentsId: number) {
    const mapped = getWorkingCopyOriginalPath(documentPath, senderWebContentsId);
    const version = getBaselineFileVersion(documentPath, senderWebContentsId);
    const originalPath = mapped ? parseDocumentRef(mapped.originalPath) : null;
    if (originalPath && version) return {originalPath, ...readingViewSourceOf(version)};
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
 * The opted-in opening seed for a source with the size and modification time main
 * itself read from it: the working copy's admission, a DjVu grant, or an
 * opening preflight's stat of the Recent original.
 */
export async function readRecentReadingViewOf(source: {
    originalPath: string;
    sourceSize: number;
    sourceModifiedAtMs: number;
}): Promise<IRecentReadingView | null> {
    if (!(await loadSettings()).rememberDocumentView) {
        return null;
    }
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
