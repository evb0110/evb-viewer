import {getDocumentFilesCapability} from '@app/utils/platformDocuments';
import type { IDocumentSessionState } from '@app/modules/workspace-shell/viewers/workspaceDocumentDriver';
import type {
    IDocumentRevisionInfo, TDocumentRevisionToken, 
} from '@contracts/documentRevision';
import type { TDocumentRef } from '@contracts/documentRef';
import { isNativeDocumentRef } from '@app/utils/documentRef';
import { isPathPdfSource } from '@app/modules/pdf-viewer/public/nativePreviewRouting';
import type { ILazyHistoryBaseline } from '@app/modules/workspace-shell/composables/document-session/createDocumentHistory';

interface IResolvedPathBaseline {
    baseline: ILazyHistoryBaseline;
    revisionInfo: IDocumentRevisionInfo;
}

export function hasNativePathBackedSource(state: IDocumentSessionState, path: TDocumentRef) {
    return [
        state.pdfSrc.value,
        state.pdfReloadSrc.value,
    ].some(source => {
        if (!isPathPdfSource(source)) {
            return false;
        }
        return source.path === path
            && state.isElectron.value
            && isNativeDocumentRef(path);
    });
}

export async function adoptStablePathBackedPersistedState(input: {
    state: IDocumentSessionState;
    path: TDocumentRef;
    resolveStableBaseline: () => Promise<IResolvedPathBaseline>;
    markCurrentHistoryEntryClean: (
        snapshot: Uint8Array | null,
        options?: {
            lazyBaseline?: ILazyHistoryBaseline;
            recordSnapshotChange?: boolean;
        },
    ) => Promise<void>;
}) {
    const {
        baseline,
        revisionInfo,
    } = await input.resolveStableBaseline();
    if (!input.state.isActiveWorkingCopy(input.path)) {
        return false;
    }

    const source = {
        kind: 'path' as const,
        path: input.path,
        size: baseline.size,
        revision: baseline.revision,
    };
    input.state.documentRevisionInfo.value = revisionInfo;
    input.state.documentRevisionToken.value = revisionInfo.token;
    input.state.pdfData.value = null;
    input.state.pdfSrc.value = source;
    input.state.pdfReloadSrc.value = source;
    await input.markCurrentHistoryEntryClean(null, {
        lazyBaseline: baseline,
        recordSnapshotChange: false,
    });
    return true;
}

export async function resolveStableLazyHistoryBaseline(path: TDocumentRef) {
    const documentFiles = getDocumentFilesCapability();
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const before = await documentFiles.getDocumentRevision(path);
        const file = await documentFiles.statFile(path);
        const after = await documentFiles.getDocumentRevision(path);
        if (before.token === after.token) {
            return {
                baseline: {
                    workingPath: path,
                    revision: after.token,
                    size: file.size,
                },
                revisionInfo: after,
            };
        }
    }
    throw new Error('Working-copy revision changed while adopting the saved path');
}

// The preserved-source path keeps the loaded document on screen, so `pdfSrc`
// must not be reassigned: a new object identity restarts the viewer's open
// flow. Its recorded length still has to follow the file, because a later
// range-backed open reads the length from this source.
export function alignLoadedPathSourceLength(
    state: IDocumentSessionState,
    path: TDocumentRef,
    size: number,
    revision?: TDocumentRevisionToken,
) {
    const source = state.pdfSrc.value;
    if (!isPathPdfSource(source) || source.path !== path) {
        return;
    }
    source.size = size;
    if (revision !== undefined) {
        source.revision = revision;
    }
}
