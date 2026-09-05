import type { IHasAnnotationChangesDeps } from '@app/modules/workspace-shell/annotations/workspaceAnnotationTypes';
import { hasViewerShapeChanges } from '@app/modules/workspace-shell/annotations/hasViewerShapeChanges';

export function hasAnnotationChanges(deps: IHasAnnotationChangesDeps) {
    if ((deps.pdfViewerRef.value?.getAnnotationDirtyEntityCount?.() ?? 0) > 0) {
        return true;
    }
    if (deps.pdfViewerRef.value?.hasCanonicalAnnotationChanges?.() === true) {
        return true;
    }
    if (hasViewerShapeChanges(deps.pdfViewerRef.value)) {
        return true;
    }

    return false;
}
