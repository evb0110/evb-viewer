import type {
    IWorkingCopyBackingFailure,
    IWorkingCopyBackingStatus,
    TWorkingCopyBackingStatusState,
} from '@contracts/electronApiDocuments';
import {parseDocumentRef} from '@contracts/documentRef';
import {
    getWorkingCopyBackingEntry,
    workingCopyMap,
    type TWorkingCopyBackingErrorCode,
    type TWorkingCopyBackingState,
} from '@electron/file-access/workingCopyStore';
import {
    onWorkingCopyMaterializationProgress,
    type IWorkingCopyMaterializationProgress,
} from '@electron/file-access/workingCopyMaterialization';

export interface IWorkingCopyBackingStatusDispatch {
    ownerWebContentsId?: number;
    registrationId: number;
    status: IWorkingCopyBackingStatus;
}

function requireDocumentRef(value: unknown) {
    const documentRef = parseDocumentRef(value);
    if (documentRef === null) {
        throw new Error('Expected an absolute document ref');
    }
    return documentRef;
}

function toRendererBackingState(state: TWorkingCopyBackingState): TWorkingCopyBackingStatusState {
    return state === 'lazy-original' || state === 'materializing'
        ? state
        : 'materialized';
}

function toBackingFailure(code: TWorkingCopyBackingErrorCode | undefined): IWorkingCopyBackingFailure | null {
    if (!code) {
        return null;
    }
    return {
        code,
        retryable: code === 'SOURCE_BACKING_UNAVAILABLE'
            || code === 'WORKING_COPY_MATERIALIZATION_CANCELLED'
            || code === 'WORKING_COPY_MATERIALIZATION_FAILED'
            || code === 'WORKING_COPY_MATERIALIZATION_NO_SPACE'
            || code === 'WORKING_COPY_MATERIALIZATION_VERIFICATION_FAILED',
    };
}

function toProgressStatus(progress: IWorkingCopyMaterializationProgress): IWorkingCopyBackingStatus {
    return {
        documentRef: requireDocumentRef(progress.documentRef),
        failure: toBackingFailure(progress.errorCode),
        progress: progress.status === 'completed'
            ? 1
            : Math.min(1, Math.max(0, progress.percent / 100)),
        state: progress.status === 'completed'
            ? 'materialized'
            : progress.status === 'running'
                ? 'materializing'
                : 'lazy-original',
    };
}

const listeners = new Set<(dispatch: IWorkingCopyBackingStatusDispatch) => void>();

let subscribedToMaterialization = false;

export function onWorkingCopyBackingStatusChanged(listener: (dispatch: IWorkingCopyBackingStatusDispatch) => void) {
    if (!subscribedToMaterialization) {
        subscribedToMaterialization = true;
        onWorkingCopyMaterializationProgress((progress) => {
            // Look up the registration regardless of owner; the dispatch
            // names its owner, and only that window is told.
            const entry = workingCopyMap.get(progress.documentRef);
            if (!entry) {
                return;
            }
            // Progress within one registration never moves backwards. It is
            // kept on the registration, so it ends when the registration does.
            const reported = toProgressStatus(progress);
            entry.backingProgress = Math.max(entry.backingProgress ?? 0, reported.progress);
            for (const notify of listeners) {
                notify({
                    ...(entry.ownerWebContentsId === undefined
                        ? {}
                        : {ownerWebContentsId: entry.ownerWebContentsId}),
                    registrationId: entry.registrationId,
                    status: {
                        ...reported,
                        progress: entry.backingProgress,
                    },
                });
            }
        });
    }
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function getWorkingCopyBackingStatus(senderId: number, filePath: string): IWorkingCopyBackingStatus | null {
    const entry = getWorkingCopyBackingEntry(filePath, senderId);
    if (!entry) {
        return null;
    }
    const state = toRendererBackingState(entry.backingState);
    return {
        documentRef: requireDocumentRef(filePath),
        failure: toBackingFailure(entry.sourceBackingErrorCode),
        progress: state === 'materialized' ? 1 : entry.backingProgress ?? 0,
        state,
    };
}
