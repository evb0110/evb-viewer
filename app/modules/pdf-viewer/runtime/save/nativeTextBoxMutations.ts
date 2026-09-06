import type {IPdfPage} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type { IPdfNativeTextBoxMutation } from '@contracts/electronApiDocuments';
import { requirePageIndex } from '@contracts/pageNumbers';
import type { ITextBoxEntity } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { normalizePageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizePageRotation';
import { toPdfRectFromMarkerRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/toPdfRectFromMarkerRect';
import { normalizeMarkerRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizeMarkerRect';
import type { TPageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/pageRotation';
import { parseCssRgbColor } from '@app/modules/pdf-viewer/engine/text-markup-color/parseCssRgbColor';
import type { ISerializationPlan } from '@app/modules/pdf-viewer/annotations/persistence/annotationSavePlan';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import {
    formatPdfJsAnnotationRef,
    parsePdfAnnotationRef,
} from '@app/utils/pdfAnnotationRefs';

interface IPdfTextBoxPageReader {getPage(pageNumber: number): Promise<Pick<IPdfPage, 'rotate' | 'view'>>;}

export function isReplayableCanonicalTextBox(comment: IAnnotationCommentSummary) {
    const markerRect = normalizeMarkerRect(comment.markerRect);
    return comment.source === 'editor'
        && Boolean(comment.appAnnotationId)
        && comment.annotationId === null
        && comment.subtype?.trim().toLowerCase() === 'freetext'
        && Boolean(markerRect);
}

function isChangedTextBox(entity: ISerializationPlan['expected'][number]): entity is ITextBoxEntity {
    return entity.kind === 'text-box'
        && !entity.deleted
        && entity.revision !== entity.persistedRevision;
}

function toNativeTextBox(
    entity: ITextBoxEntity,
    pageView: readonly number[],
    pageRotation: TPageRotation,
): IPdfNativeTextBoxMutation | null {
    const rect = toPdfRectFromMarkerRect(entity.rect, [...pageView], pageRotation);
    const color = entity.color === null
        ? {
            r: 0,
            g: 0,
            b: 0,
        }
        : parseCssRgbColor(entity.color);
    if (!rect || !color) {
        return null;
    }
    const parsedPdfRef = entity.identity.pdfRef
        ? parsePdfAnnotationRef(entity.identity.pdfRef)
        : null;
    if (entity.identity.pdfRef && !parsedPdfRef) {
        return null;
    }

    return {
        pageIndex: requirePageIndex(entity.pageIndex),
        // New native text boxes use the canonical id as /NM so the writer's
        // identity binding can be acknowledged by the annotation store.
        stableKey: entity.identity.id,
        ...(parsedPdfRef ? {annotationId: formatPdfJsAnnotationRef(parsedPdfRef)} : {}),
        text: entity.text,
        rect,
        rotation: entity.rotation,
        fontSize: entity.fontSize,
        color: [
            Math.round(color.r),
            Math.round(color.g),
            Math.round(color.b),
        ],
        author: entity.author,
        createdAt: entity.createdAt,
        modifiedAt: entity.modifiedAt,
    };
}

/**
 * Collect the native payload for changed canonical text boxes. Returning
 * `undefined` means this save has no canonical text-box work. Returning null
 * means the work exists but its page geometry could not be collected, so the
 * classifier must fail closed instead of falling back to a legacy note shape.
 */
export async function collectNativeTextBoxMutationsForSave(
    document: IPdfTextBoxPageReader | null,
    plan: ISerializationPlan,
): Promise<IPdfNativeTextBoxMutation[] | null | undefined> {
    const changedTextBoxes = plan.expected.filter(isChangedTextBox);
    if (changedTextBoxes.length === 0) {
        return undefined;
    }
    if (!document) {
        return null;
    }

    const pages = new Map<number, Promise<Pick<IPdfPage, 'rotate' | 'view'> | null>>();
    const getPage = (pageIndex: number) => {
        const cached = pages.get(pageIndex);
        if (cached) {
            return cached;
        }
        const loading = document.getPage(pageIndex + 1).catch(() => null);
        pages.set(pageIndex, loading);
        return loading;
    };

    const mutations: IPdfNativeTextBoxMutation[] = [];
    for (const entity of changedTextBoxes) {
        const page = await getPage(entity.pageIndex);
        const mutation = page && Array.isArray(page.view)
            ? toNativeTextBox(entity, page.view, normalizePageRotation(page.rotate))
            : null;
        if (!mutation) {
            return null;
        }
        mutations.push(mutation);
    }
    return mutations;
}
