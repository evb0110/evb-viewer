import { PDFDateString } from 'pdfjs-dist';
import type { IAnnotationMarkerRect } from '@app/types/annotations';
import type {
    TTranslateFn,
    TTranslationKey,
} from '@app/i18n/locales';
import { normalizeMarkerRect } from '@app/composables/pdf/annotationGeometry';

export {
    clamp01, normalizeMarkerRect, toMarkerRectFromPdfRect, markerRectIoU, rectIntersectionArea, rectIoU, rectCenterDistance, rectsIntersect, mergeMarkerRects, 
} from '@app/composables/pdf/annotationGeometry';
export {
    toCssColor, colorWithOpacity, escapeCssAttr, errorToLogText, commentPreviewText, commentPreviewFromRawText, 
} from '@app/composables/pdf/annotationCssUtils';

export interface IPdfjsEditor {
    id?: string;
    div?: HTMLElement;
    uid?: string;
    annotationElementId?: string | null;
    comment?: string | {
        text?: string | null;
        deleted?: boolean | null;
    } | null;
    hasComment?: boolean;
    color?: string | number[] | null;
    opacity?: number;
    parentPageIndex?: number;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    isSelected?: boolean;
    _isDraggable?: boolean;
    _onResized?: () => void;
    _onResizing?: () => void;
    isInEditMode?: () => boolean;
    updateParams?: (type: number, value: unknown) => void;
    setDims?: () => void;
    fixAndSetPosition?: () => void;
    parent?: { div?: HTMLElement };
    getData?: () => {
        modificationDate?: string | null;
        creationDate?: string | null;
        color?: string | number[] | null;
        opacity?: number;
    };
    toggleComment?: (isSelected: boolean, visibility?: boolean) => void;
    addToAnnotationStorage?: () => void;
    focusCommentButton?: () => void;
    remove?: () => void;
    delete?: () => void;
}

export interface IAnnotationContextMenuPayload {
    comment: import('@app/types/annotations').IAnnotationCommentSummary | null;
    clientX: number;
    clientY: number;
    hasSelection: boolean;
    pageNumber: number | null;
    pageX: number | null;
    pageY: number | null;
}

export function getCommentText(editor: IPdfjsEditor | null | undefined) {
    if (!editor) {
        return '';
    }
    try {
        const comment = editor.comment;
        if (typeof comment === 'string') {
            return comment;
        }
        if (comment && typeof comment.text === 'string') {
            return comment.text;
        }
    } catch {
        return '';
    }
    return '';
}

export function hasEditorCommentPayload(editor: IPdfjsEditor | null | undefined) {
    if (!editor) {
        return false;
    }
    try {
        const comment = editor.comment;
        if (typeof comment === 'string') {
            return comment.trim().length > 0;
        }
        if (comment && typeof comment === 'object') {
            const text = typeof comment.text === 'string'
                ? comment.text.trim()
                : '';
            const deleted = comment.deleted === true;
            return !deleted && text.length > 0;
        }
    } catch {
        return false;
    }
    return false;
}

export function parsePdfDateTimestamp(value: string | null | undefined) {
    if (!value) {
        return null;
    }

    try {
        const date = PDFDateString.toDateObject(value);
        if (!date) {
            return null;
        }
        return date.getTime();
    } catch {
        return null;
    }
}

export function toMarkerRectFromEditor(editor: IPdfjsEditor): IAnnotationMarkerRect | null {
    const editorDiv = editor.div;
    if (!editorDiv) {
        return null;
    }
    const pageContainer = editorDiv.closest<HTMLElement>('.page_container');
    if (!pageContainer) {
        return null;
    }
    const pageRect = pageContainer.getBoundingClientRect();
    const editorRect = editorDiv.getBoundingClientRect();
    if (pageRect.width <= 0 || pageRect.height <= 0 || editorRect.width <= 0 || editorRect.height <= 0) {
        return null;
    }

    return normalizeMarkerRect({
        left: (editorRect.left - pageRect.left) / pageRect.width,
        top: (editorRect.top - pageRect.top) / pageRect.height,
        width: editorRect.width / pageRect.width,
        height: editorRect.height / pageRect.height,
    });
}

export function getAnnotationCommentText(annotation: {
    contents?: string;
    contentsObj?: { str?: string | null };
    richText?: { str?: string | null };
}) {
    const rich = annotation.richText?.str?.trim();
    if (rich) {
        return rich;
    }
    const structured = annotation.contentsObj?.str?.trim();
    if (structured) {
        return structured;
    }
    return annotation.contents?.trim() ?? '';
}

export function getAnnotationAuthor(annotation: {
    titleObj?: { str?: string | null };
    title?: string;
}) {
    const withObj = annotation.titleObj?.str?.trim();
    if (withObj) {
        return withObj;
    }
    const direct = annotation.title?.trim();
    return direct || null;
}

type TTranslateLabel = TTranslateFn;

export function annotationKindLabelFromSubtype(
    subtype: string | null | undefined,
    translate?: TTranslateLabel,
) {
    const label = (key: TTranslationKey, fallback: string) => (
        typeof translate === 'function'
            ? translate(key)
            : fallback
    );

    const normalized = (subtype ?? '').trim().toLowerCase();
    switch (normalized) {
        case 'highlight':
            return label('annotations.highlightLabel', 'Highlight');
        case 'underline':
            return label('annotations.underlineLabel', 'Underline');
        case 'squiggly':
            return label('annotations.squiggleLabel', 'Squiggle');
        case 'strikeout':
            return label('annotations.strikeOutLabel', 'Strike Out');
        case 'text':
        case 'note-linked':
            return label('annotations.popUpNoteLabel', 'Pop-up Note');
        case 'freetext':
        case 'typewriter':
        case 'note-inline':
            return label('annotations.inlineNoteLabel', 'Inline Note');
        case 'ink':
            return label('annotations.freehandLineLabel', 'Freehand Line');
        case 'line':
        case 'straight-line':
            return label('annotations.lineLabel', 'Line');
        case 'square':
        case 'geomsquare':
        case 'rectangle':
            return label('annotations.rectangleLabel', 'Rectangle');
        case 'circle':
        case 'geomcircle':
        case 'ellipse':
            return label('annotations.circleLabel', 'Circle');
        case 'polygon':
            return label('annotations.polygonLabel', 'Polygon');
        case 'stamp':
            return label('annotations.stamp', 'Stamp');
        default:
            return label('annotations.annotationLabel', 'Annotation');
    }
}

export function isPopupSubtype(subtype: string | null | undefined) {
    return (subtype ?? '').trim().toLowerCase() === 'popup';
}

export function detectEditorSubtype(editor: IPdfjsEditor | null | undefined) {
    if (!editor) {
        return null;
    }
    const className = editor.div?.className ?? '';
    if (className.includes('highlightEditor')) {
        return 'Highlight';
    }
    if (className.includes('freeTextEditor')) {
        return 'Typewriter';
    }
    if (className.includes('inkEditor')) {
        return 'Ink';
    }

    const constructorType = (editor as { constructor?: { _type?: unknown } }).constructor?._type;
    if (constructorType === 'freetext') {
        return 'Typewriter';
    }
    if (constructorType === 'highlight') {
        return 'Highlight';
    }
    if (constructorType === 'ink') {
        return 'Ink';
    }

    const serialized = (editor as { serialize?: () => unknown }).serialize?.();
    if (serialized && typeof serialized === 'object') {
        const annotationType = (serialized as { annotationType?: unknown }).annotationType;
        if (annotationType === 'freetext') {
            return 'Typewriter';
        }
        if (annotationType === 'highlight') {
            return 'Highlight';
        }
        if (annotationType === 'ink') {
            return 'Ink';
        }
    }
    return null;
}

export function isTextMarkupSubtype(subtype: string | null | undefined) {
    const normalized = (subtype ?? '').trim().toLowerCase();
    return (
        normalized === 'highlight'
        || normalized === 'underline'
        || normalized === 'squiggly'
        || normalized === 'strikeout'
    );
}
