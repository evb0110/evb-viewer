// The result algebra of one save attempt: the three shapes an execution can
// end in, plus the constructors that make "nothing was written" always carry
// why. Kept beside the save service rather than inside it so the reasons and
// the shapes that use them stay one unit.
import type { IPdfPersistResult } from '@app/types/pdfUi';
import type { IPdfNativeAnnotationIdentityBinding } from '@contracts/electronApiDocuments';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TWorkspaceSaveFailureReason } from '@app/modules/workspace-shell/composables/useWorkspaceFailureSurface';

export interface IPostSaveReloadWaiter {
    promise: Promise<void>;
    cancel: () => void;
}

/**
 * What a completed save is allowed to mark clean. Every flag defaults to false
 * at each construction site rather than being optional, so a new save path has
 * to state which layers it actually wrote. A layer marked clean without its
 * edits having been written loses them: the tab stops looking dirty and the
 * close guard stops asking.
 */
export interface ISaveCompletionPolicy {
    allowAnnotationSaveStateRefresh?: boolean;
    allowBookmarksSaveStateRefresh?: boolean;
    allowPageLabelsSaveStateRefresh?: boolean;
    markAnnotationStateSaved: boolean;
    markBookmarksStateSaved: boolean;
    markPageLabelsStateSaved: boolean;
    markShapeStateSaved: boolean;
    preserveLivePdfjsSession: boolean;
    resetAnnotationStorage: boolean;
}

/**
 * Why a save stopped without writing. `cancelled` is the one member that is
 * not a failure: the user dismissed the Save As dialog, so nothing is reported
 * to them.
 */
export type TWorkspaceSaveAbortReason = TWorkspaceSaveFailureReason | 'cancelled';

/**
 * Where in the write an abort happened, because it decides how the failure may
 * be matched to a document.
 *
 * A pre-write abort has touched nothing, so the revision it planned against
 * still identifies the open document and can be demanded before the failure is
 * reported. Paths alone cannot: an abort that awaits validation while the user
 * reopens the same file would otherwise be reported against the replacement.
 *
 * A post-write abort has already handed bytes to the persistence layer, which
 * moves the revision by design, so only the paths remain comparable.
 */
export type TWorkspaceSaveAbortOrigin =
    | {
        phase: 'pre-write';
        plannedRevisionToken: TDocumentRevisionToken | null;
    }
    | {phase: 'post-write';};

export type TWorkspaceSaveExecutionResult =
    | {
        status: 'saved';
        persisted: IPdfPersistResult;
        serializedChanges: boolean;
        reloadWaiter: IPostSaveReloadWaiter | null;
        completion: ISaveCompletionPolicy;
        /**
         * The token this save's shape priming returned. Only it may declare the
         * shape layer clean, so a document replaced mid-save cannot inherit the
         * previous document's save.
         */
        preparedShapeState?: unknown;
        annotationMaterializationBaseline?: unknown;
        commitAnnotationSave?: (identityBindings?: readonly IPdfNativeAnnotationIdentityBinding[]) => void;
    }
    | {
        status: 'not-saved';
        // Every non-throwing abort carries why it stopped so the shared
        // failure surface can report it exactly like a thrown save.
        reason: TWorkspaceSaveAbortReason;
        origin: TWorkspaceSaveAbortOrigin;
        reloadWaiter: IPostSaveReloadWaiter | null;
    }
    | {
        status: 'failed';
        error: unknown;
        reloadWaiter: IPostSaveReloadWaiter | null;
    };

/** An abort that stopped before anything was handed to the persistence layer. */
export type TWorkspaceSaveAbort = Extract<TWorkspaceSaveExecutionResult, {status: 'not-saved'}>;

export function notSavedBeforeWrite(
    reason: TWorkspaceSaveAbortReason,
    plannedRevisionToken: TDocumentRevisionToken | null,
    reloadWaiter: IPostSaveReloadWaiter | null,
): TWorkspaceSaveAbort {
    return {
        status: 'not-saved',
        reason,
        origin: {
            phase: 'pre-write',
            plannedRevisionToken,
        },
        reloadWaiter,
    };
}

/** An abort the persistence layer itself returned, after the write ran. */
export function notSavedAfterWrite(
    reason: TWorkspaceSaveAbortReason,
    reloadWaiter: IPostSaveReloadWaiter | null,
): TWorkspaceSaveAbort {
    return {
        status: 'not-saved',
        reason,
        origin: {phase: 'post-write'},
        reloadWaiter,
    };
}

/**
 * A refused persist result is only a failure when the write was actually
 * attempted. A dismissed Save As dialog and a document swapped out mid-save
 * both arrive here as `success: false` and neither is the user's error.
 */
export function abortReasonForPersistResult(persisted: IPdfPersistResult): TWorkspaceSaveAbortReason {
    if (persisted.abortReason === 'cancelled') {
        return 'cancelled';
    }
    if (persisted.abortReason === 'stale') {
        return 'document-changed';
    }
    return 'persist-rejected';
}

/**
 * Shared tail of the working-copy saves: each hands its persist result back
 * with the same completion policy, and a refused result carries why it stopped.
 */
export function workingCopySaveResult(
    persisted: IPdfPersistResult,
    reloadWaiter: IPostSaveReloadWaiter | null,
    completion: Partial<ISaveCompletionPolicy> = {},
): TWorkspaceSaveExecutionResult {
    if (!persisted.success) {
        return notSavedAfterWrite(abortReasonForPersistResult(persisted), reloadWaiter);
    }
    return {
        status: 'saved',
        persisted,
        serializedChanges: false,
        reloadWaiter,
        completion: {
            allowAnnotationSaveStateRefresh: false,
            allowBookmarksSaveStateRefresh: false,
            allowPageLabelsSaveStateRefresh: false,
            markAnnotationStateSaved: false,
            markBookmarksStateSaved: false,
            markPageLabelsStateSaved: false,
            markShapeStateSaved: false,
            preserveLivePdfjsSession: false,
            resetAnnotationStorage: false,
            ...completion,
        },
    };
}
