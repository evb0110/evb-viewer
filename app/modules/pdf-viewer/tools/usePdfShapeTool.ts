import type {
    Ref,
    ShallowRef,
} from 'vue';
import type { IShapeAnnotation } from '@app/types/annotations';
import type { AnnotationApplication } from '@app/modules/pdf-viewer/annotations/annotationApplication';
import { toCanonicalShapeEntity } from '@app/modules/pdf-viewer/annotations/annotationApplication';
import {
    asAnnotationId,
    toLegacyShapeAnnotation,
    toLegacyShapeStableKey,
    type AnnotationEntity,
    type IShapeEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

interface IUsePdfShapeToolOptions {
    annotationApplication: ShallowRef<AnnotationApplication>;
    /** The editor surface's live projection of the store. */
    entitiesByPage: Readonly<Ref<ReadonlyMap<number, readonly AnnotationEntity[]>>>;
    markModified: () => void;
}

const isShapeEntity = (entity: AnnotationEntity): entity is IShapeEntity => entity.kind === 'shape';

/**
 * The shape DTOs the save path and the host read, projected on demand from
 * the canonical `AnnotationStore`. Selection and editing belong to the editor
 * surface; this holds no state of its own.
 */
export const usePdfShapeTool = (options: IUsePdfShapeToolOptions) => {
    const store = () => options.annotationApplication.value.store;

    function projectShape(entity: IShapeEntity): IShapeAnnotation {
        return {
            ...toLegacyShapeAnnotation(entity),
            source: entity.identity.pdfRef ? 'embedded' : 'local',
        };
    }

    // Deleted shapes the saved document still holds.
    function persistedTombstones() {
        return store().list({includeDeleted: true})
            .filter(isShapeEntity)
            .filter(entity => entity.deleted && (entity.identity.pdfRef !== undefined || entity.materialized === true));
    }

    return {
        hasShapes: computed(() => [...options.entitiesByPage.value.values()].some(entities => entities.some(isShapeEntity))),
        getAllShapes: () => store().list().filter(isShapeEntity).map(projectShape),
        getDeletedEmbeddedAnnotationIds: () => [...new Set(persistedTombstones().flatMap(entity => entity.identity.pdfRef || []))],
        getDeletedEmbeddedShapeStableKeys: () => [...new Set(persistedTombstones().map(entity => toLegacyShapeStableKey(entity.identity.id)))],
        createShape(shape: IShapeAnnotation) {
            store().createShape(toCanonicalShapeEntity(shape, asAnnotationId(shape.id)));
            options.markModified();
        },
    };
};
