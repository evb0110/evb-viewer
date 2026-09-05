import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
    TMarkupSubtype,
} from '@app/types/annotations';

export type TMarkupSubtypeHintSource = 'editor-live' | IAnnotationCommentSummary['source'];

export interface IMarkupSubtypeHint {
    subtype: TMarkupSubtype;
    pageIndex: number;
    markerRect: IAnnotationMarkerRect;
    /** One marker rectangle per source PDF text-markup quad. */
    markupGeometry?: readonly IAnnotationMarkerRect[] | null;
    consumed: boolean;
    appAnnotationId?: string | null;
    annotationId?: string | null;
    color?: string | null;
    /** Canonical `/Contents` note text for a native text-markup update. */
    contents?: string | null;
    id?: string | null;
    pageMarkupIndex?: number | null;
    source?: TMarkupSubtypeHintSource | null;
}
