import type {INativePdfMutationProjection} from '@app/modules/pdf-viewer/runtime/save/pdfViewerSaveTransaction.types';
export type {INativePdfMutationProjection} from '@app/modules/pdf-viewer/runtime/save/pdfViewerSaveTransaction.types';

/** Save flow supported by the native mutation projection. */
export type TNativePdfMutationSaveMode = 'save' | 'save_as';

export interface INativePdfMutationAnnotationSavePlan {
    route: string;
    reason: string;
}

/**
 * The native-append grant emitted once by the native mutation planner. Native projectors
 * assert it and read its flags; they never re-derive a mode, capability, or route.
 */
export interface INativeAppendSaveRoute {
    readonly route: 'native-append';
    /** Only `loaded-source` admits replayable annotation mutations onto this route. */
    readonly annotationRoute: INativePdfMutationAnnotationSavePlan;
    readonly replayableAnnotationMutationsAllowed: boolean;
    readonly metadataMutationsAllowed: boolean;
    readonly annotationWorkDirty: boolean;
    readonly writerSaveForced: boolean;
    readonly nativeMutationProjection: INativePdfMutationProjection;
}

export interface INativePdfMutationSkipEvent {
    event: string;
    reason: string;
    details: Record<string, unknown>;
}

export interface INativePdfMutationBuildResult<T> {
    value: T | null;
    skipEvents: INativePdfMutationSkipEvent[];
}
