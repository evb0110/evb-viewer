import { normalizePdfJsAnnotationId } from '@app/utils/pdfAnnotationRefs';

/**
 * The annotations PDF.js leaves out of a page raster because the EVB editor
 * layer draws them. PDF.js matches its `hiddenAnnotationIds` render parameter
 * against the ids `getAnnotations()` reports, so each id the store holds is
 * normalized to that form. The viewer canvas and the thumbnails both pass the
 * result, so they hide the same annotations.
 */
export function toPdfjsHiddenAnnotationIds(ids: ReadonlySet<string> | undefined) {
    const hidden = new Set<string>();
    ids?.forEach((id) => {
        const normalized = normalizePdfJsAnnotationId(id);
        if (normalized) {
            hidden.add(normalized);
        }
    });
    return hidden.size > 0 ? hidden : undefined;
}
