import type {TAnnotationCreationFailureReason} from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationCreationOutcome.types';

/**
 * Automation-facing English text for a creation failure. User-facing copy is
 * localized separately by the workspace failure surface; this string is what
 * the agent and automation results carry alongside the typed reason.
 */
export function describeAnnotationCreationFailure(reason: TAnnotationCreationFailureReason): string {
    switch (reason) {
        case 'viewer-not-ready':
            return 'The PDF viewer is not ready for annotation.';
        case 'no-selection':
            return 'No text selection was available.';
        case 'selection-spans-pages':
            return 'The selection spans more than one page.';
        case 'selection-not-in-text-layer':
            return 'The selection is outside the page text layer.';
        case 'mode-switch-failed':
            return 'The PDF viewer could not switch into the annotation editing mode.';
        case 'editor-unavailable':
            return 'The annotation was created, but its editor has not appeared yet.';
        case 'editor-binding-failed':
            return 'The annotation was created, but no editor could be bound to it.';
        case 'page-not-rendered':
            return 'The target page is not rendered.';
        case 'point-outside-page':
            return 'The requested point is outside the page.';
        case 'projection-failed':
            return 'The annotation editor could not be projected onto the page.';
    }
}
