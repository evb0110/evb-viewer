import { PDFDateString } from 'pdfjs-dist';
import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
} from '@app/types/annotations';

/**
 * Minimal shape for PDF.js annotation editor instances.
 * PDF.js doesn't export a public type for individual editors, so we define
 * just the properties we actually access to satisfy the type checker.
 */
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
    _onResized?: () => void;
    _onResizing?: () => void;
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
    comment: IAnnotationCommentSummary | null;
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

export function toCssColor(
    color: string | number[] | {
        r: number;
        g: number;
        b: number;
    } | null | undefined,
    opacity = 1,
) {
    if (!color) {
        return null;
    }

    if (typeof color === 'string') {
        return color;
    }

    if (Array.isArray(color) && color.length >= 3) {
        return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${opacity})`;
    }

    if (
        typeof (color as { r?: number }).r === 'number'
        && typeof (color as { g?: number }).g === 'number'
        && typeof (color as { b?: number }).b === 'number'
    ) {
        const rgb = color as {
            r: number;
            g: number;
            b: number;
        };
        return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`;
    }

    return null;
}

export function colorWithOpacity(color: string, opacity: number) {
    if (color.startsWith('#') && (color.length === 7 || color.length === 4)) {
        const hex = color.length === 4
            ? color
                .slice(1)
                .split('')
                .map(c => c + c)
                .join('')
            : color.slice(1);
        const r = Number.parseInt(hex.slice(0, 2), 16);
        const g = Number.parseInt(hex.slice(2, 4), 16);
        const b = Number.parseInt(hex.slice(4, 6), 16);
        return `rgba(${r}, ${g}, ${b}, ${opacity})`;
    }

    return color;
}

export function normalizeMarkerRect(rect: IAnnotationMarkerRect | null | undefined): IAnnotationMarkerRect | null {
    if (!rect) {
        return null;
    }
    const left = Number.isFinite(rect.left) ? rect.left : 0;
    const top = Number.isFinite(rect.top) ? rect.top : 0;
    const width = Number.isFinite(rect.width) ? rect.width : 0;
    const height = Number.isFinite(rect.height) ? rect.height : 0;
    if (width <= 0 || height <= 0) {
        return null;
    }

    const clampedLeft = Math.min(1, Math.max(0, left));
    const clampedTop = Math.min(1, Math.max(0, top));
    const maxWidth = 1 - clampedLeft;
    const maxHeight = 1 - clampedTop;
    const clampedWidth = Math.min(maxWidth, Math.max(0, width));
    const clampedHeight = Math.min(maxHeight, Math.max(0, height));
    if (clampedWidth <= 0 || clampedHeight <= 0) {
        return null;
    }

    return {
        left: clampedLeft,
        top: clampedTop,
        width: clampedWidth,
        height: clampedHeight,
    };
}

export function toMarkerRectFromPdfRect(
    rect: number[] | null | undefined,
    pageView: number[] | null | undefined,
): IAnnotationMarkerRect | null {
    if (!rect || rect.length < 4 || !pageView || pageView.length < 4) {
        return null;
    }

    const x1 = rect[0] ?? 0;
    const y1 = rect[1] ?? 0;
    const x2 = rect[2] ?? 0;
    const y2 = rect[3] ?? 0;
    const minX = Math.min(x1, x2);
    const maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2);
    const maxY = Math.max(y1, y2);

    const xMin = pageView[0] ?? 0;
    const yMin = pageView[1] ?? 0;
    const xMax = pageView[2] ?? 0;
    const yMax = pageView[3] ?? 0;
    const pageWidth = xMax - xMin;
    const pageHeight = yMax - yMin;
    if (!Number.isFinite(pageWidth) || !Number.isFinite(pageHeight) || pageWidth <= 0 || pageHeight <= 0) {
        return null;
    }

    return normalizeMarkerRect({
        left: (minX - xMin) / pageWidth,
        top: (yMax - maxY) / pageHeight,
        width: (maxX - minX) / pageWidth,
        height: (maxY - minY) / pageHeight,
    });
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

export function annotationKindLabelFromSubtype(subtype: string | null | undefined) {
    const normalized = (subtype ?? '').trim().toLowerCase();
    switch (normalized) {
        case 'highlight':
            return 'Highlight';
        case 'underline':
            return 'Underline';
        case 'squiggly':
            return 'Squiggle';
        case 'strikeout':
            return 'Strike Out';
        case 'text':
        case 'note-linked':
            return 'Pop-up Note';
        case 'freetext':
        case 'typewriter':
        case 'note-inline':
            return 'Inline Note';
        case 'ink':
            return 'Freehand Line';
        case 'line':
        case 'straight-line':
            return 'Line';
        case 'square':
        case 'geomsquare':
        case 'rectangle':
            return 'Rectangle';
        case 'circle':
        case 'geomcircle':
        case 'ellipse':
            return 'Ellipse';
        case 'polygon':
            return 'Polygon';
        case 'stamp':
            return 'Stamp';
        default:
            return 'Annotation';
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

export function escapeCssAttr(value: string) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
        return CSS.escape(value);
    }
    return value.replace(/"/g, '\\"');
}

export function errorToLogText(error: unknown) {
    const message = error instanceof Error
        ? error.message
        : typeof error === 'string'
            ? error
            : (() => {
                try {
                    return JSON.stringify(error);
                } catch {
                    return String(error);
                }
            })();
    const stack = error instanceof Error ? error.stack ?? '' : '';
    return stack
        ? `${message}\n${stack}`
        : message;
}

export function clamp01(value: number) {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.max(0, Math.min(1, value));
}

export function commentPreviewText(comment: IAnnotationCommentSummary) {
    const raw = comment.text.trim();
    if (!raw) {
        return 'Empty note';
    }
    if (raw.length > 120) {
        return `${raw.slice(0, 117)}...`;
    }
    return raw;
}

export function commentPreviewFromRawText(text: string) {
    const raw = text.trim();
    if (!raw) {
        return 'Empty note';
    }
    if (raw.length > 120) {
        return `${raw.slice(0, 117)}...`;
    }
    return raw;
}

export function markerRectIoU(
    leftRect: IAnnotationMarkerRect | null | undefined,
    rightRect: IAnnotationMarkerRect | null | undefined,
) {
    const left = normalizeMarkerRect(leftRect);
    const right = normalizeMarkerRect(rightRect);
    if (!left || !right) {
        return 0;
    }

    const intersectionLeft = Math.max(left.left, right.left);
    const intersectionTop = Math.max(left.top, right.top);
    const intersectionRight = Math.min(left.left + left.width, right.left + right.width);
    const intersectionBottom = Math.min(left.top + left.height, right.top + right.height);
    const intersectionWidth = Math.max(0, intersectionRight - intersectionLeft);
    const intersectionHeight = Math.max(0, intersectionBottom - intersectionTop);
    const intersectionArea = intersectionWidth * intersectionHeight;
    if (intersectionArea <= 0) {
        return 0;
    }

    const leftArea = left.width * left.height;
    const rightArea = right.width * right.height;
    const unionArea = leftArea + rightArea - intersectionArea;
    if (unionArea <= 0) {
        return 0;
    }

    return intersectionArea / unionArea;
}

export function rectIntersectionArea(left: DOMRect, right: DOMRect) {
    const x1 = Math.max(left.left, right.left);
    const y1 = Math.max(left.top, right.top);
    const x2 = Math.min(left.right, right.right);
    const y2 = Math.min(left.bottom, right.bottom);
    const width = Math.max(0, x2 - x1);
    const height = Math.max(0, y2 - y1);
    return width * height;
}

export function rectIoU(left: DOMRect, right: DOMRect) {
    const intersection = rectIntersectionArea(left, right);
    if (intersection <= 0) {
        return 0;
    }
    const leftArea = left.width * left.height;
    const rightArea = right.width * right.height;
    const union = leftArea + rightArea - intersection;
    if (union <= 0) {
        return 0;
    }
    return intersection / union;
}

export function rectCenterDistance(left: DOMRect, right: DOMRect) {
    const leftX = left.left + left.width / 2;
    const leftY = left.top + left.height / 2;
    const rightX = right.left + right.width / 2;
    const rightY = right.top + right.height / 2;
    return Math.hypot(leftX - rightX, leftY - rightY);
}

export function rectsIntersect(
    leftRect: {
        left: number;
        top: number;
        right: number;
        bottom: number;
    },
    rightRect: {
        left: number;
        top: number;
        right: number;
        bottom: number;
    },
) {
    return !(
        leftRect.right < rightRect.left
        || leftRect.left > rightRect.right
        || leftRect.bottom < rightRect.top
        || leftRect.top > rightRect.bottom
    );
}

export function mergeMarkerRects(left: IAnnotationMarkerRect, right: IAnnotationMarkerRect): IAnnotationMarkerRect {
    const minLeft = Math.min(left.left, right.left);
    const minTop = Math.min(left.top, right.top);
    const maxRight = Math.max(left.left + left.width, right.left + right.width);
    const maxBottom = Math.max(left.top + left.height, right.top + right.height);
    return {
        left: minLeft,
        top: minTop,
        width: Math.max(0.0001, maxRight - minLeft),
        height: Math.max(0.0001, maxBottom - minTop),
    };
}
