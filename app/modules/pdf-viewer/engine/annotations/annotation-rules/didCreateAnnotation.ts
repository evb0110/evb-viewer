import type { TAnnotationCreationOutcome } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationCreationOutcome.types';

/**
 * True when the canonical annotation exists, whether or not its editor is
 * bound yet. Fallback paths must consult this rather than the stricter
 * `status === 'created'`, or they mint a duplicate annotation for the same
 * user gesture.
 */
export function didCreateAnnotation(outcome: TAnnotationCreationOutcome) {
    return outcome.status === 'created' || outcome.status === 'pending-editor';
}
