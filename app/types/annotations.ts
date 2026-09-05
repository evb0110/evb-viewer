import type {
    IMarkerRect,
    IPoint2D,
} from '@contracts/geometry';
import type {
    TPdfAnnotationLineEndStyle,
    TPdfAnnotationMarkupSubtype,
    TPdfAnnotationShapePdfSubtype,
    TPdfAnnotationShapeType,
    TAnnotationTool as TContractAnnotationTool,
    TDrawableShapeTool,
} from '@contracts/annotations';
import type { IPdfNativeShapeAnnotation } from '@contracts/electronApiDocuments';
import type { IPdfAnnotationNoteReply } from '@contracts/pdfAnnotationParseTypes';
import type {
    Except,
    TaggedUnion,
} from 'type-fest';
export {
    ANNOTATION_TOOLS,
    DRAWABLE_SHAPE_TOOLS,
} from '@contracts/annotations';

export type TAnnotationTool = TContractAnnotationTool;

export type TAnnotationCommentsStatus = 'loading' | 'ready';

/**
 * Automation-only progress counters for the annotation comment sync.
 *
 * A comment sync reads the PDF.js editor layer synchronously and then awaits
 * the parsed PDF snapshot, so nothing observable in the DOM or in the canonical
 * projection tells an automation client that the deferred pass has finished.
 * The ledger is quiescent — every requested sync has been fully serviced —
 * when `servicedSeq >= requestSeq`, `runningPasses === 0` and
 * `pendingDebounces === 0`.
 */
export interface IAnnotationSyncAutomationActivity {
    /** Debounce timers armed by a schedule call and not yet fired or cancelled. */
    pendingDebounces: number;
    /** Incremented once per requested sync, whether debounced or immediate. */
    requestSeq: number;
    /** Sync passes currently between their editor scan and their applied state. */
    runningPasses: number;
    /** Highest `requestSeq` a completed pass has covered. */
    servicedSeq: number;
}

/**
 * Why a background annotation inventory stopped short of the whole document.
 *
 * `page-cap` and `record-cap` are deterministic: rescanning the same revision
 * truncates at the same place. `page-parse-failure` is transient, so a snapshot
 * carrying it is retried once per document revision.
 */
export type TAnnotationInventoryOmission =
    | 'page-cap'
    | 'record-cap'
    | 'page-parse-failure'
    | 'annotation-name-unavailable';

export interface IAnnotationInventoryCompleteness {
    complete: boolean;
    omissions: readonly TAnnotationInventoryOmission[];
    scannedPageCount: number;
    totalPageCount: number;
    failedPageCount: number;
}

export type TMarkupSubtype = TPdfAnnotationMarkupSubtype;

export type TShapeType = TPdfAnnotationShapeType;
export type TDrawableShapeType = TDrawableShapeTool;

export type TLineEndStyle = TPdfAnnotationLineEndStyle;
export type TEmbeddedPdfShapeSubtype = TPdfAnnotationShapePdfSubtype;
export type TShapeResizeHandle = 'nw' | 'ne' | 'sw' | 'se';

export type IShapePoint = IPoint2D;

type TEditorShapeOverrides =
    | 'annotationId'
    | 'fillColor'
    | 'id'
    | 'lineEndStyle'
    | 'lineStartStyle'
    | 'pageIndex'
    | 'pdfSubtype'
    | 'points'
    | 'stableKey'
    | 'strokes'
    | 'x2'
    | 'y2';

/**
 * Legacy shape DTO retained for the existing drawing tools and serializers.
 * Remove it with the adapter in annotationEntity.ts when #165 and #166 move
 * those consumers to IShapeEntity.
 */
export interface IShapeAnnotation extends Omit<IPdfNativeShapeAnnotation, TEditorShapeOverrides> {
    id: string;
    pageIndex: number;
    x2?: number;
    y2?: number;
    fillColor?: string | undefined;
    points?: IShapePoint[] | undefined;
    strokes?: IShapePoint[][] | undefined;
    source?: 'local' | 'embedded';
    annotationId?: string | null | undefined;
    stableKey?: string | null | undefined;
    pdfSubtype?: TEmbeddedPdfShapeSubtype | null;
    lineStartStyle?: TLineEndStyle | undefined;
    lineEndStyle?: TLineEndStyle | undefined;
    createdAt?: number | null;
    modifiedAt?: number | null;
}

export type TAnnotationStableKey =
    | `nm:${string}`
    | `ann:${number}:${string}`;

export type TImmutableShapeKey = 'id' | 'pageIndex';
export type TShapeAnnotationPatch = Partial<Except<IShapeAnnotation, TImmutableShapeKey>>;

export type TAnnotationSettingChange = {
    [K in keyof IAnnotationSettings]: {
        key: K;
        value: IAnnotationSettings[K];
    };
}[keyof IAnnotationSettings];

export interface IAnnotationSettings {
    highlightColor: string;
    highlightOpacity: number;
    highlightThickness: number;
    highlightFreehandEnabled: boolean;
    showAllHighlights: boolean;
    underlineColor: string;
    underlineOpacity: number;
    strikethroughColor: string;
    strikethroughOpacity: number;
    squigglyColor: string;
    squigglyOpacity: number;
    inkColor: string;
    inkOpacity: number;
    inkThickness: number;
    textColor: string;
    textSize: number;
    shapeColor: string;
    shapeFillColor: string;
    shapeOpacity: number;
    shapeStrokeWidth: number;
}

export interface IAnnotationEditorState {
    isEditing: boolean;
    isEmpty: boolean;
    hasSomethingToUndo: boolean;
    hasSomethingToRedo: boolean;
    hasSelectedEditor: boolean;
    /** True while a newly created FreeText editor still needs save-time commit. */
    hasPendingFreeTextDraft?: boolean;
    // Separate app-routed history flags keep toolbar undo responsive when
    // PDF.js storage state events arrive after command registration.
    hasAppAnnotationUndoHistory?: boolean;
    hasAppAnnotationRedoHistory?: boolean;
}

export interface IAnnotationModifiedPayload { forceDirty?: boolean }

export type IAnnotationMarkerRect = IMarkerRect;

export interface ITextMarkupAnnotationProperties {
    id: string;
    pageIndex: number;
    subtype: TMarkupSubtype;
    color: string;
    markerRect: IAnnotationMarkerRect | null;
    opacity?: number | null;
    contents?: string;
}

export interface ILinkAnnotation {
    id: string;
    pageNumber: number;
    url?: string;
    dest?: string | unknown[];
    rect: IAnnotationMarkerRect;
}

interface IAnnotationCommentSummaryFields {
    appAnnotationId?: string;
    id: string;
    stableKey: TAnnotationStableKey;
    sortIndex?: number | null;
    pageIndex: number;
    pageNumber: number;
    text: string;
    displayText?: string | null;
    previewText?: string | null;
    kindLabel?: string | null;
    subtype?: string | null | undefined;
    author: string | null;
    createdAt?: number | null;
    modifiedAt: number | null;
    color: string | null;
    colorEdited?: boolean | undefined;
    fillColor?: string | null;
    opacity?: number | null;
    strokeWidth?: number | null;
    uid: string | null;
    annotationId: string | null;
    annotationName?: string | null | undefined;
    hasNote?: boolean;
    markerRect?: IAnnotationMarkerRect | null | undefined;
    /** Replies derived from a foreign PDF note. The editor never authors them. */
    replies?: readonly IPdfAnnotationNoteReply[] | undefined;
    /**
     * Canonical text-markup geometry: one marker rect per `/QuadPoints` quad,
     * so a multi-line highlight survives ingest as the lines it was drawn from
     * instead of collapsing into its bounding box. Absent for everything that
     * is not text markup read from a PDF.
     */
    markupGeometry?: readonly IAnnotationMarkerRect[] | null | undefined;
}

export type IAnnotationCommentSummary = TaggedUnion<'source', {
    editor: { [Key in keyof IAnnotationCommentSummaryFields]: IAnnotationCommentSummaryFields[Key] };
    pdf: { [Key in keyof IAnnotationCommentSummaryFields]: IAnnotationCommentSummaryFields[Key] };
    shape: { [Key in keyof IAnnotationCommentSummaryFields]: IAnnotationCommentSummaryFields[Key] };
}>;
