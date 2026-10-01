import type { TPageNumber } from '@contracts/pageNumbers';

import type {
    ExpectedOutcome,
    FailureReceipt,
} from '@contracts/diagnostics/failureReceipt';

/**
 * Typed result of an annotation creation attempt.
 *
 * Creation runs in two stages: a canonical intent is submitted to the
 * annotation store, then an editor is projected for it. The two stages
 * fail independently, so callers need to tell "nothing exists" from "the
 * annotation exists but its editor has not appeared yet". Reporting a bare
 * `true` for both is what issue #91 fixes.
 */
export type TAnnotationCreationFailureReason =
    | 'viewer-not-ready'
    | 'no-selection'
    | 'selection-spans-pages'
    | 'selection-not-in-text-layer'
    | 'mode-switch-failed'
    | 'editor-unavailable'
    | 'editor-binding-failed'
    | 'page-not-rendered'
    | 'point-outside-page'
    | 'projection-failed';

/**
 * Why a created annotation still has no editor. A pending outcome always has
 * its canonical intent in the document, so the reasons that mean "nothing was
 * created" cannot appear here. `editor-binding-failed` is not one of them
 * either: it is reported by the retry loop that outlives the outcome, never
 * carried by the outcome itself.
 */
export type TAnnotationPendingEditorReason =
    | 'editor-unavailable'
    | 'mode-switch-failed'
    | 'projection-failed';

/** The canonical intent was submitted and an editor was bound to it. */
export interface IAnnotationCreationCreated {
    status: 'created';
    annotationId: string;
}

/**
 * The canonical intent was submitted, but no editor is bound yet. The
 * annotation exists and will be saved; a retry loop keeps looking for its
 * editor and reports `editor-binding-failed` if it never appears.
 */
export interface IAnnotationCreationPendingEditor {
    status: 'pending-editor';
    annotationId: string;
    reason: TAnnotationPendingEditorReason;
}

/** The document or editor manager changed mid-flight. Not a failure. */
export interface IAnnotationCreationCancelled {status: 'cancelled';}

/** Nothing was created. */
export interface IAnnotationCreationFailed {
    status: 'failed';
    reason: TAnnotationCreationFailureReason;
}

export type TAnnotationCreationOutcome =
    | IAnnotationCreationCreated
    | IAnnotationCreationPendingEditor
    | IAnnotationCreationCancelled
    | IAnnotationCreationFailed;

interface IAnnotationCreationReportBase {
    operationId: string;
    reason: TAnnotationCreationFailureReason;
    pageNumber: TPageNumber | null;
}

/** A handled selection, geometry, or readiness state. It never owns an occurrence. */
export interface IAnnotationCreationExpectedReport extends IAnnotationCreationReportBase {
    kind: 'expected';
    outcome: ExpectedOutcome;
}

/** An unexpected annotation defect and the one receipt created by its bridge owner. */
export interface IAnnotationCreationFaultReport extends IAnnotationCreationReportBase {
    kind: 'fault';
    failure: FailureReceipt;
}

/** What the viewer hands to the shared workspace failure surface. */
export type IAnnotationCreationFailureReport =
    | IAnnotationCreationExpectedReport
    | IAnnotationCreationFaultReport;

export function getAnnotationCreationExpectedOutcome(
    reason: TAnnotationCreationFailureReason,
): ExpectedOutcome | null {
    switch (reason) {
        case 'no-selection':
        case 'selection-spans-pages':
        case 'selection-not-in-text-layer':
        case 'point-outside-page':
            return {
                kind: 'expected',
                code: 'validation-rejected',
            };
        case 'viewer-not-ready':
        case 'editor-unavailable':
        case 'page-not-rendered':
            return {
                kind: 'expected',
                code: 'temporarily-unavailable',
            };
        case 'mode-switch-failed':
        case 'editor-binding-failed':
        case 'projection-failed':
            return null;
    }
}
