import type {IPdfSaveByteRouteDecision} from '@app/modules/pdf-viewer/public';

export const TEST_PDF_SAVE_BYTE_ROUTE_DECISION: IPdfSaveByteRouteDecision = {
    route: 'source-clean',
    annotationPlan: {
        route: 'source-clean',
        expectedCost: 'small',
        reason: 'no-annotation-work',
        unreplayableAnnotationIds: [],
    },
    canonical: {
        comments: [],
        pendingTexts: new Map(),
        pendingDeletes: [],
        frontierChanges: {
            ids: new Set(),
            noteIds: new Set(),
            hasChanges: false,
        },
        replayableEmbeddedAnnotationIds: new Set(),
        replayableCanonicalStickyNoteStableKeys: new Set(),
    },
    baseBytes: 'loaded-source',
    sourceFallbackAllowed: false,
    nativeRejection: 'backend-not-native-append',
};
