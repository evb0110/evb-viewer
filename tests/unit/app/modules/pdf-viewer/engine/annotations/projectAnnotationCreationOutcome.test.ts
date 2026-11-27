import {describe, expect, it} from 'vitest';
import {
    getAnnotationCreationExpectedOutcome,
    type TAnnotationCreationFailureReason,
    type TAnnotationCreationOutcome,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationCreationOutcome.types';
import {projectAnnotationCreationOutcome} from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/projectAnnotationCreationOutcome';

const CANCELLED_REASON = 'The document changed before the annotation was created.';

function project(outcome: TAnnotationCreationOutcome) {
    return projectAnnotationCreationOutcome(outcome, CANCELLED_REASON);
}

describe('projectAnnotationCreationOutcome', () => {
    it('classifies handled selection and readiness states without an occurrence', () => {
        expect(getAnnotationCreationExpectedOutcome('selection-spans-pages')).toEqual({
            kind: 'expected',
            code: 'validation-rejected',
        });
        expect(getAnnotationCreationExpectedOutcome('viewer-not-ready')).toEqual({
            kind: 'expected',
            code: 'temporarily-unavailable',
        });
        expect(getAnnotationCreationExpectedOutcome('mode-switch-failed')).toBeNull();
        expect(getAnnotationCreationExpectedOutcome('editor-binding-failed')).toBeNull();
        expect(getAnnotationCreationExpectedOutcome('projection-failed')).toBeNull();
    });
    it('reports success only for an annotation whose editor is bound', () => {
        expect(
            project({
                status: 'created',
                annotationId: 'annotation-1',
            }),
        ).toEqual({created: true});
    });

    it('refuses success for an annotation whose editor never appeared', () => {
        expect(
            project({
                status: 'pending-editor',
                annotationId: 'annotation-1',
                reason: 'editor-unavailable',
            }),
        ).toEqual({
            created: false,
            reason: 'The annotation was created, but its editor has not appeared yet.',
            failureReason: 'editor-unavailable',
            // Retrying on `created: false` alone would mint a second copy.
            pendingEditor: true,
        });
    });

    it('marks a mode-switch failure as half-done rather than as nothing happened', () => {
        expect(
            project({
                status: 'pending-editor',
                annotationId: 'annotation-1',
                reason: 'mode-switch-failed',
            }),
        ).toMatchObject({
            created: false,
            failureReason: 'mode-switch-failed',
            pendingEditor: true,
        });
    });

    it('marks a genuine no-op as safe to retry', () => {
        const projection = project({
            status: 'failed',
            reason: 'no-selection',
        });

        expect(projection).toEqual({
            created: false,
            reason: 'No text selection was available.',
            failureReason: 'no-selection',
        });
        expect(projection.pendingEditor).toBeUndefined();
    });

    it('explains a superseded document without a machine-readable failure', () => {
        const projection = project({status: 'cancelled'});

        expect(projection).toEqual({
            created: false,
            reason: CANCELLED_REASON,
        });
        expect(projection.failureReason).toBeUndefined();
        expect(projection.pendingEditor).toBeUndefined();
    });

    it('carries a distinct description for every failure reason', () => {
        // Keyed on the exported union so a reason added to the contract fails
        // to compile here until it is listed and given its own description.
        const reasons = Object.keys({
            'viewer-not-ready': true,
            'no-selection': true,
            'selection-spans-pages': true,
            'selection-not-in-text-layer': true,
            'mode-switch-failed': true,
            'editor-unavailable': true,
            'editor-binding-failed': true,
            'page-not-rendered': true,
            'point-outside-page': true,
            'projection-failed': true,
        } satisfies Record<TAnnotationCreationFailureReason, true>) as TAnnotationCreationFailureReason[];
        const descriptions = reasons.map(
            (reason) =>
                project({
                    status: 'failed',
                    reason,
                }).reason,
        );

        expect(descriptions.every((description) => Boolean(description))).toBe(true);
        expect(new Set(descriptions).size).toBe(reasons.length);
    });
});
