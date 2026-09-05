import type { PDFDocument } from 'pdf-lib';
import { normalizePageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizePageRotation';
import {
    safePdfPageAnnots,
    tryResolvePdfLibPageView,
} from '@pdf-core';

export function resolvePageAnnotationContext(
    page: ReturnType<PDFDocument['getPages']>[number],
) {
    const pageView = tryResolvePdfLibPageView(page);
    if (!pageView) {
        return null;
    }

    const annots = safePdfPageAnnots(page);
    if (!annots) {
        return null;
    }

    return {
        pageView,
        pageRotation: normalizePageRotation(page.getRotation().angle),
        annots,
    };
}
