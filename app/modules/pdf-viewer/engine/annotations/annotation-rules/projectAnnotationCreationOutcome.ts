import type {
    TAnnotationCreationFailureReason,
    TAnnotationCreationOutcome,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationCreationOutcome.types';
import {describeAnnotationCreationFailure} from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/describeAnnotationCreationFailure';
import {didCreateAnnotation} from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/didCreateAnnotation';

export interface IAnnotationCreationOutcomeProjection {
    created: boolean;
    reason?: string | undefined;
    failureReason?: TAnnotationCreationFailureReason | undefined;
    pendingEditor?: boolean | undefined;
}

/**
 * Flattens a creation outcome onto the automation result shape shared by the
 * text-markup and point-note entry points.
 *
 * `created` is reserved for an annotation whose editor is bound, so an
 * automation caller never acts on a projection that does not exist yet. The
 * half-done case is not silent either: it carries `pendingEditor`, which tells
 * a caller that retrying on `created: false` alone would mint a duplicate of an
 * annotation that is already in the document.
 */
export function projectAnnotationCreationOutcome(
    outcome: TAnnotationCreationOutcome,
    cancelledReason: string,
): IAnnotationCreationOutcomeProjection {
    if (outcome.status === 'created') {
        return {created: true};
    }
    if (outcome.status === 'cancelled') {
        return {
            created: false,
            reason: cancelledReason,
        };
    }
    return {
        created: false,
        reason: describeAnnotationCreationFailure(outcome.reason),
        failureReason: outcome.reason,
        ...(didCreateAnnotation(outcome) ? {pendingEditor: true} : {}),
    };
}
