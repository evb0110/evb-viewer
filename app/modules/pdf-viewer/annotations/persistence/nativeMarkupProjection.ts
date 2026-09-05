import type {
    IAnnotationCommentSummary,
    TMarkupSubtype,
} from '@app/types/annotations';
import { normalizeMarkerRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizeMarkerRect';
import { collectMarkupSubtypeHints } from '@app/modules/pdf-viewer/engine/annotation-subtype-hints/collectMarkupSubtypeHints';
import type { IMarkupSubtypeHint } from '@app/modules/pdf-viewer/engine/annotation-subtype-hints/pdfSerializationSubtypeHintsTypes';
import {
    normalizePdfJsAnnotationId,
    parsePdfJsAnnotationRef,
} from '@app/utils/pdfAnnotationRefs';
import type { IPdfNativeMarkupSubtypeHint } from '@contracts/electronApiDocuments';
import { requirePageIndex } from '@contracts/pageNumbers';
import { PDF_ANNOTATION_MARKUP_SUBTYPES } from '@contracts/annotations';
import { isOneOf } from '@contracts/runtimeGuards';
import { PDF_NATIVE_MUTATION_LIMITS } from '@contracts/nativePdfMutations';

function isNativeMarkupSubtype(value: unknown): value is TMarkupSubtype {
    return isOneOf(PDF_ANNOTATION_MARKUP_SUBTYPES, value);
}

function addMarkupTargetKey(keys: Set<string>, value: string | null | undefined) {
    const normalized = value?.trim();
    if (normalized) {
        keys.add(normalized);
    }
}

function buildCurrentMarkupTargetKeys(hints: IMarkupSubtypeHint[]) {
    const keys = new Set<string>();
    for (const hint of hints) {
        addMarkupTargetKey(keys, hint.appAnnotationId);
        addMarkupTargetKey(keys, normalizePdfJsAnnotationId(hint.appAnnotationId));
        addMarkupTargetKey(keys, hint.id);
        addMarkupTargetKey(keys, hint.annotationId);
        const normalizedAnnotationId = normalizePdfJsAnnotationId(hint.annotationId);
        addMarkupTargetKey(keys, normalizedAnnotationId);
        if (normalizedAnnotationId) {
            addMarkupTargetKey(keys, `ann:${hint.pageIndex}:${normalizedAnnotationId}`);
        }
    }
    return keys;
}

function hasCurrentMarkupTargetKey(keys: Set<string>, value: string | null | undefined) {
    const normalized = value?.trim();
    if (!normalized) {
        return false;
    }
    const normalizedAnnotationId = normalizePdfJsAnnotationId(normalized);
    return keys.has(normalized) || Boolean(normalizedAnnotationId && keys.has(normalizedAnnotationId));
}

function areMarkupTargetIdentitiesEqual(
    left: string | null | undefined,
    right: string | null | undefined,
) {
    const normalizedLeft = left?.trim();
    const normalizedRight = right?.trim();
    if (!normalizedLeft || !normalizedRight) {
        return false;
    }
    const leftPdfId = normalizePdfJsAnnotationId(normalizedLeft);
    const rightPdfId = normalizePdfJsAnnotationId(normalizedRight);
    return normalizedLeft === normalizedRight
        || Boolean(leftPdfId && rightPdfId && leftPdfId === rightPdfId);
}

function isCurrentMarkupHint(hint: IMarkupSubtypeHint, keys: Set<string>) {
    return hasCurrentMarkupTargetKey(keys, hint.appAnnotationId)
        || hasCurrentMarkupTargetKey(keys, hint.annotationId)
        || hasCurrentMarkupTargetKey(keys, hint.id);
}

function isRetiredPdfRefForEditorMarkupAlias(
    annotationId: string | null | undefined,
    currentMarkupHints: IMarkupSubtypeHint[],
    aliases: Array<string | null | undefined> = [],
) {
    if (!parsePdfJsAnnotationRef(annotationId)) {
        return false;
    }
    return currentMarkupHints.some(current => {
        if (current.source !== 'editor' || current.annotationId) {
            return false;
        }
        return [
            annotationId,
            ...aliases,
        ].some(candidate => (
            areMarkupTargetIdentitiesEqual(candidate, current.appAnnotationId)
            || areMarkupTargetIdentitiesEqual(candidate, current.id)
        ));
    });
}

function isRetiredPdfRefForEditorMarkup(
    hint: IMarkupSubtypeHint,
    currentMarkupHints: IMarkupSubtypeHint[],
) {
    return isRetiredPdfRefForEditorMarkupAlias(
        hint.annotationId,
        currentMarkupHints,
        [
            hint.appAnnotationId,
            hint.id,
        ],
    );
}

function isNativeMarkupHintEligible(hint: IMarkupSubtypeHint) {
    return isNativeMarkupSubtype(hint.subtype)
        && Number.isSafeInteger(hint.pageIndex)
        && hint.pageIndex >= 0
        && Boolean(normalizeMarkerRect(hint.markerRect));
}

export function toNativeMarkupHint(hint: IMarkupSubtypeHint): IPdfNativeMarkupSubtypeHint | null {
    if (!isNativeMarkupHintEligible(hint)) {
        return null;
    }
    const markerRect = normalizeMarkerRect(hint.markerRect);
    if (!markerRect) {
        return null;
    }
    const markupGeometry = hint.markupGeometry?.length
        ? hint.markupGeometry.map(normalizeMarkerRect)
        : null;
    if (markupGeometry?.some(rect => !rect)) {
        return null;
    }
    const validMarkupGeometry = markupGeometry
        ? markupGeometry.filter((rect): rect is NonNullable<typeof rect> => rect !== null)
        : null;
    const emittedMarkupGeometry = validMarkupGeometry
        && validMarkupGeometry.length <= PDF_NATIVE_MUTATION_LIMITS.markupGeometryItems
        ? validMarkupGeometry
        : null;
    return {
        subtype: hint.subtype,
        pageIndex: requirePageIndex(hint.pageIndex),
        markerRect,
        ...(hint.appAnnotationId?.trim() ? {appAnnotationId: hint.appAnnotationId.trim()} : {}),
        ...(emittedMarkupGeometry
            ? {markupGeometry: emittedMarkupGeometry}
            : {}),
        annotationId: hint.annotationId ?? null,
        color: hint.color ?? null,
        ...(hint.contents !== undefined ? {contents: hint.contents} : {}),
        id: hint.id ?? null,
        pageMarkupIndex: typeof hint.pageMarkupIndex === 'number' && Number.isSafeInteger(hint.pageMarkupIndex)
            ? hint.pageMarkupIndex
            : null,
        source: hint.source ?? null,
    };
}

export function buildNativeMarkupMutationForSave(opts: {
    canonicalComments: IAnnotationCommentSummary[];
    changedComments?: IAnnotationCommentSummary[];
    annotationWorkDirty: boolean;
    markupSubtypeOverrides: Map<string, TMarkupSubtype> | undefined;
    markupSubtypeHints: IMarkupSubtypeHint[];
}) {
    if (!opts.annotationWorkDirty) {
        return null;
    }
    const currentMarkupHints = collectMarkupSubtypeHints(opts.canonicalComments);
    const changedMarkupHints = opts.changedComments
        ? collectMarkupSubtypeHints(opts.changedComments, {includeContents: true})
        : currentMarkupHints.filter(hint => hint.color !== null || hint.source === 'editor');
    const currentMarkupTargetKeys = buildCurrentMarkupTargetKeys(currentMarkupHints);
    const overrides: Array<readonly [string, TMarkupSubtype]> = [];
    for (const [
        id,
        subtype,
    ] of opts.markupSubtypeOverrides?.entries() ?? []) {
        if (
            id.trim().length > 0
            && isNativeMarkupSubtype(subtype)
            && hasCurrentMarkupTargetKey(currentMarkupTargetKeys, id)
            && !isRetiredPdfRefForEditorMarkupAlias(id, currentMarkupHints)
        ) {
            overrides.push([
                id.trim(),
                subtype,
            ]);
        }
    }
    const liveHints = opts.markupSubtypeHints
        .filter(hint => isCurrentMarkupHint(hint, currentMarkupTargetKeys))
        // A restored editor can retain the ref from the deleted PDF revision.
        // Drop only that matching live alias; the canonical editor hint below
        // carries the current geometry and canonical app identity for creation.
        .filter(hint => !isRetiredPdfRefForEditorMarkup(hint, currentMarkupHints))
        .flatMap((hint) => {
            const nativeHint = toNativeMarkupHint(hint);
            return nativeHint ? [nativeHint] : [];
        });
    const editedCommentHints = changedMarkupHints
        // Incremental native markup touches only canonical comments whose
        // revision changed. This includes note-only edits on imported markup.
        .flatMap((hint) => {
            const nativeHint = toNativeMarkupHint(hint);
            return nativeHint ? [nativeHint] : [];
        });
    if (overrides.length + liveHints.length + editedCommentHints.length === 0) {
        return null;
    }
    return {
        overrides,
        hints: [
            ...liveHints,
            ...editedCommentHints,
        ],
    };
}
