import type { IWorkspacePdfViewerForAnnotationUtils } from '@app/modules/workspace-shell/annotations/workspaceAnnotationTypes';

export function hasViewerShapeChanges(
    viewer: Pick<IWorkspacePdfViewerForAnnotationUtils, 'hasCanonicalShapeChanges' | 'hasShapes'> | null | undefined,
) {
    if (viewer?.hasCanonicalShapeChanges) {
        return viewer.hasCanonicalShapeChanges();
    }
    return Boolean(unref(viewer?.hasShapes ?? false));
}
