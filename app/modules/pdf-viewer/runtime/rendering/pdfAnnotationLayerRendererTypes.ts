// fallow-ignore-next-line unused-type -- dormant PDF.js compatibility contract is removed with #195.
export interface IAnnotationUiManagerWithAnnotationRenderGuards {
    renderAnnotationElement?: (annotation: unknown) => unknown;
    setMissingCanvas?: (
        annotationId: string,
        annotationElementId: string,
        canvas: HTMLCanvasElement,
    ) => unknown;
    getEditors?: (pageIndex: number) => Iterable<unknown>;
    getActive?: () => unknown;
    setActiveEditor?: (editor: unknown | null) => unknown;
}

export interface IEditableAnnotationDataLike {id?: string | null;}
export interface IEditableAnnotationLike {data?: IEditableAnnotationDataLike | null;}
export interface IAnnotationLayerWithEditableAnnotations {
    getEditableAnnotations?: () => Iterable<unknown>;
    getEditableAnnotation?: (id: string) => unknown;
}

export interface IAnnotationLayerRenderOptions {
    shouldContinue?: () => boolean;
    signal?: AbortSignal | undefined;
    documentVersion?: number | undefined;
}

export type TAnnotationEditorLayerFailureReason =
    | 'render-error'
    | 'pdfjs-compatibility-unsupported'
    | 'stale-document';

// fallow-ignore-next-line unused-type -- dormant PDF.js failure contract is removed with #195.
export interface IAnnotationEditorLayerPageFailure {
    pageNumber: number;
    reason: TAnnotationEditorLayerFailureReason;
    attempts: number;
    lastFailedAt: number;
    message: string;
}

export type TAnnotationEditorLayerRenderResult =
    | {
        ok: true;
        rendered: true
    }
    | {
        ok: true;
        rendered: false;
        reason: 'no-ui-manager' | 'stale' | 'quarantined'
    }
    | {
        ok: false;
        reason: TAnnotationEditorLayerFailureReason;
        error: unknown;
        retryable: boolean
    };
