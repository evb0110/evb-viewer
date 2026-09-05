import {
    formatPdfJsAnnotationRef,
    parsePdfAnnotationRef,
    type IPdfAnnotationRef,
} from '@app/utils/pdfAnnotationRefs';
import type { TAnnotationStableKey } from '@app/types/annotations';

type TPdfAnnotationStableKey = Extract<TAnnotationStableKey, `ann:${string}`>;

export interface IPdfAnnotationStableKey {
    stableKey: TPdfAnnotationStableKey;
    pageIndex: number;
    annotationId: string;
}

export interface IPdfAnnotationStableKeyRef extends IPdfAnnotationStableKey {
    ref: IPdfAnnotationRef;
    normalizedAnnotationId: string;
}

const PDF_ANNOTATION_STABLE_KEY_RE = /^ann:(\d+):(.+)$/u;

function parseStableKeyPageIndex(value: string | undefined) {
    if (!value) {
        return null;
    }

    const pageIndex = Number(value);
    return Number.isInteger(pageIndex) && pageIndex >= 0 ? pageIndex : null;
}

export function parsePdfAnnotationStableKey(
    stableKey: string | null | undefined,
): IPdfAnnotationStableKey | null {
    const trimmed = stableKey?.trim();
    if (!trimmed) {
        return null;
    }

    const match = trimmed.match(PDF_ANNOTATION_STABLE_KEY_RE);
    const pageIndex = parseStableKeyPageIndex(match?.[1]);
    const annotationId = match?.[2]?.trim();
    if (pageIndex === null || !annotationId) {
        return null;
    }

    return {
        stableKey: `ann:${pageIndex}:${annotationId}`,
        pageIndex,
        annotationId,
    };
}

export function parsePdfAnnotationStableKeyRef(
    stableKey: string | null | undefined,
): IPdfAnnotationStableKeyRef | null {
    const trimmed = stableKey?.trim();
    if (!trimmed) {
        return null;
    }

    const match = trimmed.match(PDF_ANNOTATION_STABLE_KEY_RE);
    const pageIndex = parseStableKeyPageIndex(match?.[1]);
    const refText = match?.[2]?.trim();
    const ref = parsePdfAnnotationRef(refText);
    if (pageIndex === null || !refText || !ref) {
        return null;
    }

    return {
        stableKey: `ann:${pageIndex}:${refText}`,
        pageIndex,
        annotationId: refText,
        ref,
        normalizedAnnotationId: formatPdfJsAnnotationRef(ref),
    };
}

export function getPdfAnnotationIdFromStableKey(
    stableKey: string | null | undefined,
) {
    return parsePdfAnnotationStableKey(stableKey)?.annotationId ?? null;
}
