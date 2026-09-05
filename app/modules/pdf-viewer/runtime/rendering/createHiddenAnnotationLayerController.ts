import { uniq } from 'es-toolkit/array';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type { AnnotationLayer as TAnnotationLayer } from 'pdfjs-dist/types/src/display/annotation_layer';
import type { MaybeRefOrGetter } from 'vue';
import { normalizePdfJsAnnotationId } from '@app/utils/pdfAnnotationRefs';
import { getOptionalFunction } from '@app/services/pdfjs/runtime';
import type {
    IAnnotationLayerWithEditableAnnotations,
    IEditableAnnotationLike,
} from '@app/modules/pdf-viewer/runtime/rendering/pdfAnnotationLayerRendererTypes';

// fallow-ignore-next-line unused-export -- hidden-layer compensation remains for the #195 bridge cleanup.
export function createHiddenAnnotationLayerController(options: {
    hiddenAnnotationIds?: MaybeRefOrGetter<Set<string>> | undefined;
    managedAnnotationIds?: MaybeRefOrGetter<Set<string>> | undefined;
    getAnnotationUiManager: () => AnnotationEditorUIManager | null;
    annotationEditorLayers: ReadonlyMap<number, unknown>;
    drawLayers: ReadonlyMap<number, unknown>;
    annotationEditorLayerContainers: ReadonlyMap<number, HTMLElement>;
}) {
    const normalizedAnnotationId = (id: string | null | undefined) => normalizePdfJsAnnotationId(id);
    const normalizeIds = (source?: MaybeRefOrGetter<Set<string>>) => {
        const normalizedIds = new Set<string>();
        (toValue(source) ?? new Set<string>()).forEach((id) => {
            const normalizedId = normalizePdfJsAnnotationId(id);
            if (normalizedId) {
                normalizedIds.add(normalizedId);
            }
        });
        return normalizedIds;
    };
    const getNormalizedHiddenAnnotationIds = () => normalizeIds(options.hiddenAnnotationIds);
    const getNormalizedManagedAnnotationIds = () => normalizeIds(options.managedAnnotationIds);
    const signature = (ids: Set<string>) => [...ids].sort((left, right) => left.localeCompare(right)).join('\u0000');
    const getHiddenAnnotationSignature = () => signature(getNormalizedHiddenAnnotationIds());
    const getManagedAnnotationSignature = () => signature(getNormalizedManagedAnnotationIds());

    const getEditableAnnotationId = (editable: unknown) => {
        if (!editable || typeof editable !== 'object') {
            return null;
        }
        const data = (editable as IEditableAnnotationLike).data;
        return typeof data?.id === 'string' ? data.id : null;
    };
    const isHiddenEditableAnnotationId = (
        annotationId: string | null | undefined,
        pageContainer?: HTMLElement | null,
    ) => {
        void pageContainer;
        const normalized = normalizedAnnotationId(annotationId);
        return Boolean(normalized && getNormalizedHiddenAnnotationIds().has(normalized));
    };

    const hideHiddenManagedEditors = (pageNumber?: number) => {
        const annotationUiManager = options.getAnnotationUiManager();
        if (!annotationUiManager) {
            return;
        }
        const getEditors = getOptionalFunction<[number], Iterable<unknown>>(annotationUiManager, 'getEditors');
        if (!getEditors) {
            return;
        }
        const targetPageNumbers = pageNumber
            ? [pageNumber]
            : uniq([
                ...options.annotationEditorLayers.keys(),
                ...options.drawLayers.keys(),
            ])
                .sort((left, right) => left - right);
        const getActive = getOptionalFunction<[]>(annotationUiManager, 'getActive');
        const setActiveEditor = getOptionalFunction<[unknown | null]>(annotationUiManager, 'setActiveEditor');
        const activeEditor = getActive?.call(annotationUiManager) ?? null;
        targetPageNumbers.forEach((targetPageNumber) => {
            const editors = Array.from(getEditors.call(annotationUiManager, targetPageNumber - 1) ?? []);
            editors.forEach((editor) => {
                const annotationElementId = editor && typeof editor === 'object'
                    ? (editor as { annotationElementId?: unknown }).annotationElementId
                    : null;
                const annotationId = normalizePdfJsAnnotationId(
                    typeof annotationElementId === 'string' ? annotationElementId : null,
                );
                if (!annotationId || !isHiddenEditableAnnotationId(
                    annotationId,
                    options.annotationEditorLayerContainers.get(targetPageNumber) ?? null,
                )) {
                    return;
                }
                getOptionalFunction<[boolean?]>(editor, 'show')?.call(editor, false);
                getOptionalFunction<[]>(editor, 'disableEditing')?.call(editor);
                const parent = editor && typeof editor === 'object' && 'parent' in editor
                    ? (editor as { parent?: unknown }).parent
                    : null;
                const editable = getOptionalFunction<[string]>(parent, 'getEditableAnnotation')
                    ?.call(parent, annotationId) ?? null;
                getOptionalFunction<[]>(editable, 'hide')?.call(editable);
                const pageIndexValue = editor && typeof editor === 'object'
                    ? (editor as { pageIndex?: unknown }).pageIndex
                    : null;
                const pageIndex = typeof pageIndexValue === 'number' && Number.isFinite(pageIndexValue)
                    ? pageIndexValue
                    : null;
                if (activeEditor === editor && pageIndex !== null && pageIndex + 1 === targetPageNumber) {
                    setActiveEditor?.call(annotationUiManager, null);
                }
            });
        });
    };

    const applyHiddenEditableAnnotationFilter = (
        annotationLayerInstance: TAnnotationLayer | null,
        pageContainer: HTMLElement | null,
    ) => {
        if (!annotationLayerInstance) {
            return annotationLayerInstance;
        }
        const getEditableAnnotations = getOptionalFunction<[], Iterable<unknown>>(
            annotationLayerInstance,
            'getEditableAnnotations',
        );
        const getEditableAnnotation = getOptionalFunction<[string]>(annotationLayerInstance, 'getEditableAnnotation');
        if (!getEditableAnnotations && !getEditableAnnotation) {
            return annotationLayerInstance;
        }
        const mutableAnnotationLayer = annotationLayerInstance as IAnnotationLayerWithEditableAnnotations;
        if (getEditableAnnotations) {
            mutableAnnotationLayer.getEditableAnnotations = () => Array.from(
                getEditableAnnotations.call(annotationLayerInstance),
            ).filter(editable => !isHiddenEditableAnnotationId(getEditableAnnotationId(editable), pageContainer));
        }
        if (getEditableAnnotation) {
            mutableAnnotationLayer.getEditableAnnotation = (annotationId) => (
                isHiddenEditableAnnotationId(annotationId, pageContainer)
                    ? null
                    : getEditableAnnotation.call(annotationLayerInstance, annotationId)
            );
        }
        return annotationLayerInstance;
    };

    const removeHiddenAnnotations = (annotationLayerDiv: HTMLElement) => {
        const hiddenAnnotationIds = getNormalizedHiddenAnnotationIds();
        if (hiddenAnnotationIds.size === 0) {
            return;
        }
        annotationLayerDiv.querySelectorAll<HTMLElement>('[data-annotation-id]').forEach((element) => {
            const annotationId = normalizedAnnotationId(
                element.dataset.annotationId ?? element.getAttribute('data-annotation-id'),
            );
            if (annotationId && hiddenAnnotationIds.has(annotationId)) {
                element.remove();
            }
        });
    };

    return {
        applyHiddenEditableAnnotationFilter,
        getEditableAnnotationId,
        getHiddenAnnotationSignature,
        getManagedAnnotationSignature,
        getNormalizedHiddenAnnotationIds,
        getNormalizedManagedAnnotationIds,
        hideHiddenManagedEditors,
        isHiddenEditableAnnotationId,
        removeHiddenAnnotations,
    };
}
