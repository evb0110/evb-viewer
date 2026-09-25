import type {
    IWorkingCopyBackingFailure,
    IWorkingCopyBackingStatus,
    TWorkingCopyBackingStatusState,
} from '@contracts/electronApiDocuments';
import {parseDocumentRef} from '@contracts/documentRef';
import {
    getWorkingCopyBackingEntry,
    normalizePathForLookup,
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
        retryable: code === 'WORKING_COPY_MATERIALIZATION_CANCELLED'
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
const latestBackingStatus = new Map<string, {
    registrationId: number;
    status: IWorkingCopyBackingStatus;
}>();

/** Progress within one registration never moves backwards. */
function publishBackingStatus(dispatch: IWorkingCopyBackingStatusDispatch) {
    const key = normalizePathForLookup(dispatch.status.documentRef) || dispatch.status.documentRef;
    const previous = latestBackingStatus.get(key);
    const status = previous?.registrationId === dispatch.registrationId
        ? {
            ...dispatch.status,
            progress: Math.max(previous.status.progress, dispatch.status.progress),
        }
        : dispatch.status;
    latestBackingStatus.set(key, {
        registrationId: dispatch.registrationId,
        status,
    });
    for (const listener of listeners) {
        listener({
            ...dispatch,
            status,
        });
    }
}

let subscribedToMaterialization = false;

export function onWorkingCopyBackingStatusChanged(listener: (dispatch: IWorkingCopyBackingStatusDispatch) => void) {
    if (!subscribedToMaterialization) {
        subscribedToMaterialization = true;
        onWorkingCopyMaterializationProgress((progress) => {
            const entry = getWorkingCopyBackingEntry(progress.documentRef);
            if (!entry) {
                return;
            }
            publishBackingStatus({
                ...(entry.ownerWebContentsId === undefined
                    ? {}
                    : {ownerWebContentsId: entry.ownerWebContentsId}),
                registrationId: entry.registrationId,
                status: toProgressStatus(progress),
            });
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
    const latestStatus = latestBackingStatus.get(normalizePathForLookup(filePath) || filePath);
    return {
        documentRef: requireDocumentRef(filePath),
        failure: toBackingFailure(entry.sourceBackingErrorCode),
        progress: state === 'materialized'
            ? 1
            : latestStatus?.registrationId === entry.registrationId
                ? latestStatus.status.progress
                : 0,
        state,
    };
}
