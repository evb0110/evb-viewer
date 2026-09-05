import type {Ref} from 'vue';
import type { IShapeAnnotation } from '@app/types/annotations';
import type {IPdfViewerSaveExpose} from '@app/modules/pdf-viewer/public';

export interface IWorkspacePdfViewerForAnnotationUtils {
    runSaveTransaction: IPdfViewerSaveExpose['runSaveTransaction'];
    hasShapes?: boolean | Ref<boolean>;
    hasCanonicalAnnotationChanges?: () => boolean;
    getAnnotationDirtyEntityCount?: () => number;
    hasCanonicalShapeChanges?: (() => boolean) | undefined;
    getAllShapes: () => IShapeAnnotation[];
}

export interface IHasAnnotationChangesDeps {
    pdfViewerRef: Ref<IWorkspacePdfViewerForAnnotationUtils | null>;
    pdfDocument?: Ref<unknown>;
}
