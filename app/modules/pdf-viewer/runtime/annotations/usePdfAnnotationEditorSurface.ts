import type {
    ComputedRef,
    InjectionKey,
    Ref,
    ShallowRef,
} from 'vue';
import type {
    IAnnotationSettings,
    IAnnotationMarkerRect,
    TAnnotationTool,
    TMarkupSubtype,
} from '@app/types/annotations';
import type { AnnotationApplication } from '@app/modules/pdf-viewer/annotations/annotationApplication';
import type {
    AnnotationEntity,
    AnnotationId,
    IAnnotationIdentity,
    IPlacedImageEntity,
    INoteEntity,
    IShapeEntity,
    ITextBoxEntity,
    ITextMarkupEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {mintAnnotationId} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {nudgeMarkerRectByPdfPoints} from '@app/modules/pdf-viewer/engine/annotation-editor-geometry/nudgeMarkerRectByPdfPoints';

type TAnnotationHistoryAction = () => boolean | Promise<boolean>;

export interface IAnnotationGesture {
    readonly annotationId: AnnotationId;
    readonly entity: AnnotationEntity;
    readonly kind: 'move' | 'resize';
}

export type TAnnotationGesturePatch = Partial<Pick<
    ITextBoxEntity,
    'text' | 'rect' | 'rotation' | 'fontSize' | 'color'
>> & Partial<Pick<
    INoteEntity,
    'contents' | 'position' | 'color' | 'open'
>> & Partial<Pick<
    ITextMarkupEntity,
    'subtype' | 'contents' | 'quadPoints' | 'color' | 'opacity'
>> & Partial<Pick<
    IPlacedImageEntity,
    'rect' | 'rotation' | 'image'
>> & Partial<Pick<
    IShapeEntity,
    'tool' | 'rect' | 'points' | 'strokes' | 'strokeColor' | 'strokeWidth' | 'fill' | 'opacity'
>>;

export interface IAnnotationEditorSurface {
    readonly entitiesByPage: Readonly<Ref<ReadonlyMap<number, readonly AnnotationEntity[]>>>;
    readonly selectedIds: Readonly<Ref<ReadonlySet<AnnotationId>>>;
    readonly activeTool: ComputedRef<TAnnotationTool>;
    readonly settings: ComputedRef<IAnnotationSettings | null>;
    getEntitiesForPage(pageIndex: number): readonly AnnotationEntity[];
    select(ids: readonly AnnotationId[], options?: { additive?: boolean }): void;
    clearSelection(): void;
    getSelectedTextBox(): ITextBoxEntity | null;
    updateSelectedTextBoxProperties(
        updates: Partial<Pick<ITextBoxEntity, 'fontSize' | 'color'>>,
    ): boolean;
    discardUnsavedAnnotation(annotationId: AnnotationId): boolean;
    deleteAnnotation(annotationId: AnnotationId): boolean;
    deleteSelection(): void;
    moveSelection(deltaX: number, deltaY: number): void;
    nudgeSelection(deltaX: number, deltaY: number): void;
    nudgeSelectionByPdfPoints(deltaX: number, deltaY: number, pageView: number[], pageRotation?: 0 | 90 | 180 | 270): void;
    undo(): boolean | Promise<boolean>;
    redo(): boolean | Promise<boolean>;
    getPageGeometry(pageIndex: number): {
        pageView: number[];
        rotation: 0 | 90 | 180 | 270
    } | null;
    beginMove(annotationId: AnnotationId): IAnnotationGesture | null;
    beginResize(annotationId: AnnotationId): IAnnotationGesture | null;
    commitGesture(
        gesture: IAnnotationGesture | AnnotationId,
        patch: TAnnotationGesturePatch,
    ): AnnotationEntity | null;
    cancelGesture(_gesture: IAnnotationGesture | AnnotationId): void;
    createTextBoxAt(
        pageIndex: number,
        rect: IAnnotationMarkerRect,
        overrides?: Partial<Omit<ITextBoxEntity, 'kind' | 'identity' | 'pageIndex' | 'revision' | 'persistedRevision' | 'deleted'>>,
    ): ITextBoxEntity;
    createNoteAt(
        pageIndex: number,
        position: IAnnotationMarkerRect,
        overrides?: Partial<Omit<INoteEntity, 'kind' | 'identity' | 'pageIndex' | 'revision' | 'persistedRevision' | 'deleted'>>,
    ): INoteEntity;
    createStampAt(
        pageIndex: number,
        rect: IAnnotationMarkerRect,
        image: IPlacedImageEntity['image'],
        overrides?: Partial<Omit<IPlacedImageEntity, 'kind' | 'identity' | 'pageIndex' | 'revision' | 'persistedRevision' | 'deleted' | 'rect' | 'image'>>,
    ): IPlacedImageEntity;
    resolveStampImage?: (entity: IPlacedImageEntity) => Promise<string | null>;
    createHighlightFromSelection(
        pageIndex: number,
        quadPoints: readonly IAnnotationMarkerRect[],
        overrides?: Partial<Omit<ITextMarkupEntity, 'kind' | 'identity' | 'pageIndex' | 'revision' | 'persistedRevision' | 'deleted' | 'quadPoints'>>,
    ): ITextMarkupEntity;
    createShape(entity: IShapeEntity): IShapeEntity;
    openNote(annotationId: AnnotationId): void;
    openShapeContextMenu(payload: {
        shapeId: AnnotationId;
        clientX: number;
        clientY: number;
    }): void;
}

export const annotationEditorSurfaceKey: InjectionKey<IAnnotationEditorSurface> = Symbol(
    'annotationEditorSurface',
);

function groupAnnotationEntitiesByPage(
    entities: readonly AnnotationEntity[],
): ReadonlyMap<number, readonly AnnotationEntity[]> {
    const grouped = new Map<number, AnnotationEntity[]>();
    entities.forEach((entity) => {
        if (entity.deleted) {
            return;
        }
        const pageEntities = grouped.get(entity.pageIndex);
        if (pageEntities) {
            pageEntities.push(entity);
        } else {
            grouped.set(entity.pageIndex, [entity]);
        }
    });
    return grouped;
}

interface IUsePdfAnnotationEditorSurfaceOptions {
    annotationApplication: ShallowRef<AnnotationApplication>;
    activeTool: ComputedRef<TAnnotationTool>;
    settings: ComputedRef<IAnnotationSettings | null>;
    emitOpenNote?: (entity: AnnotationEntity) => void;
    resolveStampImage?: (entity: IPlacedImageEntity) => Promise<string | null>;
    emitAnnotationModified?: () => void;
    runHistoryTransaction?: <T>(action: () => T) => T;
    undo?: TAnnotationHistoryAction;
    redo?: TAnnotationHistoryAction;
    emitShapeContextMenu?: (payload: {
        shapeId: AnnotationId;
        clientX: number;
        clientY: number;
    }) => void;
    getPageGeometry?: (pageIndex: number) => {
        pageView: number[];
        rotation: 0 | 90 | 180 | 270
    } | null;
}

function timestamp() {
    return Date.now();
}

function newIdentity(): IAnnotationIdentity {
    return {id: mintAnnotationId()};
}

function baseEntityFields() {
    const now = timestamp();
    return {
        revision: 0,
        persistedRevision: -1,
        deleted: false as const,
        createdAt: now,
        modifiedAt: now,
        author: null,
    };
}

function textMarkupStyle(
    settings: IAnnotationSettings | null,
    subtype: TMarkupSubtype,
) {
    if (!settings) {
        return {
            color: null,
            opacity: null,
        };
    }
    switch (subtype) {
        case 'Underline':
            return {
                color: settings.underlineColor,
                opacity: settings.underlineOpacity,
            };
        case 'StrikeOut':
            return {
                color: settings.strikethroughColor,
                opacity: settings.strikethroughOpacity,
            };
        case 'Squiggly':
            return {
                color: settings.squigglyColor,
                opacity: settings.squigglyOpacity,
            };
        case 'Highlight':
            return {
                color: settings.highlightColor,
                opacity: settings.highlightOpacity,
            };
    }
}

export const usePdfAnnotationEditorSurface = (
    options: IUsePdfAnnotationEditorSurfaceOptions,
): IAnnotationEditorSurface => {
    const entitiesByPage = shallowRef<ReadonlyMap<number, readonly AnnotationEntity[]>>(new Map());
    const selectedIds = shallowRef<ReadonlySet<AnnotationId>>(new Set());
    let stopSubscription: (() => void) | null = null;

    function subscribeToApplication(application: AnnotationApplication) {
        stopSubscription?.();
        stopSubscription = application.store.subscribe((entities) => {
            // The store emission is the only retained projection. Group it in
            // one pass so each page component reads the same stable snapshot.
            entitiesByPage.value = groupAnnotationEntitiesByPage(entities);
            selectedIds.value = new Set(application.store.selectedIds);
        });
    }

    watch(options.annotationApplication, subscribeToApplication, {
        immediate: true,
        flush: 'sync',
    });
    onScopeDispose(() => stopSubscription?.());

    function store() {
        return options.annotationApplication.value.store;
    }

    function getEntitiesForPage(pageIndex: number) {
        return entitiesByPage.value.get(pageIndex) ?? [];
    }

    function select(ids: readonly AnnotationId[], selectionOptions: { additive?: boolean } = {}) {
        const nextIds = selectionOptions.additive
            ? new Set([
                ...selectedIds.value,
                ...ids,
            ])
            : new Set(ids);
        store().select([...nextIds]);
    }

    function clearSelection() {
        store().clearSelection();
    }

    function getSelectedTextBox() {
        for (const id of selectedIds.value) {
            const entity = store().get(id);
            if (entity?.kind === 'text-box' && !entity.deleted) {
                return entity;
            }
        }
        return null;
    }

    function updateSelectedTextBoxProperties(
        updates: Partial<Pick<ITextBoxEntity, 'fontSize' | 'color'>>,
    ) {
        const entity = getSelectedTextBox();
        if (!entity) {
            return false;
        }
        const changed = (
            updates.fontSize !== undefined
            && updates.fontSize !== entity.fontSize
        ) || (
            updates.color !== undefined
            && updates.color !== entity.color
        );
        if (!changed) {
            return false;
        }
        store().updateTextBox(entity.identity.id, updates);
        options.emitAnnotationModified?.();
        return true;
    }

    function deleteAnnotation(annotationId: AnnotationId) {
        const entity = store().get(annotationId);
        if (!entity || entity.deleted) {
            return false;
        }
        store().delete(annotationId);
        options.emitAnnotationModified?.();
        return true;
    }

    function discardUnsavedAnnotation(annotationId: AnnotationId) {
        const entity = store().get(annotationId);
        if (!entity || entity.deleted || entity.persistedRevision >= 0 || entity.identity.pdfRef) {
            return false;
        }
        store().forget(new Set([annotationId]));
        return true;
    }

    function deleteSelection() {
        (options.runHistoryTransaction ?? ((action: () => void) => action()))(() => {
            [...selectedIds.value].forEach(id => deleteAnnotation(id));
        });
    }

    function translateRect(rect: IAnnotationMarkerRect, deltaX: number, deltaY: number) {
        return {
            ...rect,
            left: rect.left + deltaX,
            top: rect.top + deltaY,
        };
    }

    function moveSelection(deltaX: number, deltaY: number) {
        let changed = false;
        const ids = [...selectedIds.value];
        (options.runHistoryTransaction ?? ((action: () => void) => action()))(() => ids.forEach((id) => {
            const entity = store().get(id);
            if (!entity) {
                return;
            }
            switch (entity.kind) {
                case 'text-box':
                    store().updateTextBox(id, {rect: translateRect(entity.rect, deltaX, deltaY)});
                    changed = true;
                    break;
                case 'note':
                    store().updateNote(id, {position: translateRect(entity.position, deltaX, deltaY)});
                    changed = true;
                    break;
                case 'text-markup':
                    store().updateTextMarkup(id, {quadPoints: entity.quadPoints.map(rect => translateRect(rect, deltaX, deltaY))});
                    changed = true;
                    break;
                case 'placed-image':
                    store().updatePlacedImage(id, {rect: translateRect(entity.rect, deltaX, deltaY)});
                    changed = true;
                    break;
                case 'shape':
                    {
                        const patch: {
                            rect: IAnnotationMarkerRect;
                            points?: ReadonlyArray<{
                                x: number;
                                y: number
                            }>;
                            strokes?: ReadonlyArray<ReadonlyArray<{
                                x: number;
                                y: number
                            }>>;
                        } = {rect: translateRect(entity.rect, deltaX, deltaY)};
                        if (entity.points !== undefined) {
                            patch.points = entity.points.map(point => ({
                                x: point.x + deltaX,
                                y: point.y + deltaY,
                            }));
                        }
                        if (entity.strokes !== undefined) {
                            patch.strokes = entity.strokes.map(stroke => stroke.map(point => ({
                                x: point.x + deltaX,
                                y: point.y + deltaY,
                            })));
                        }
                        store().updateShape(id, patch);
                        changed = true;
                    }
                    break;
            }
        }));
        if (changed) {
            options.emitAnnotationModified?.();
        }
    }

    function nudgeSelection(deltaX: number, deltaY: number) {
        moveSelection(deltaX, deltaY);
    }

    function nudgeSelectionByPdfPoints(
        deltaX: number,
        deltaY: number,
        pageView: number[],
        pageRotation: 0 | 90 | 180 | 270 = 0,
    ) {
        const ids = [...selectedIds.value];
        let changed = false;
        (options.runHistoryTransaction ?? ((action: () => void) => action()))(() => ids.forEach((id) => {
            const entity = store().get(id);
            if (!entity) {
                return;
            }
            const geometry = options.getPageGeometry?.(entity.pageIndex);
            const moveRect = (value: IAnnotationMarkerRect) => nudgeMarkerRectByPdfPoints(
                value,
                deltaX,
                deltaY,
                geometry?.pageView ?? pageView,
                geometry?.rotation ?? pageRotation,
            );
            switch (entity.kind) {
                case 'text-box': store().updateTextBox(id, {rect: moveRect(entity.rect)}); break;
                case 'note': store().updateNote(id, {position: moveRect(entity.position)}); break;
                case 'text-markup': store().updateTextMarkup(id, {quadPoints: entity.quadPoints.map(moveRect)}); break;
                case 'placed-image': store().updatePlacedImage(id, {rect: moveRect(entity.rect)}); break;
                case 'shape': {
                    const nextRect = moveRect(entity.rect);
                    const dx = nextRect.left - entity.rect.left;
                    const dy = nextRect.top - entity.rect.top;
                    store().updateShape(id, {
                        rect: nextRect,
                        ...(entity.points ? {points: entity.points.map(point => ({
                            x: point.x + dx,
                            y: point.y + dy,
                        }))} : {}),
                        ...(entity.strokes ? {strokes: entity.strokes.map(stroke => stroke.map(point => ({
                            x: point.x + dx,
                            y: point.y + dy,
                        })))} : {}),
                    });
                    break;
                }
            }
            changed = true;
        }));
        if (changed) options.emitAnnotationModified?.();
    }

    function beginGesture(annotationId: AnnotationId, kind: IAnnotationGesture['kind']) {
        const entity = store().get(annotationId);
        return entity && !entity.deleted
            ? {
                annotationId,
                entity,
                kind,
            }
            : null;
    }

    function commitGesture(
        gesture: IAnnotationGesture | AnnotationId,
        patch: TAnnotationGesturePatch,
    ) {
        const annotationId = typeof gesture === 'string' ? gesture : gesture.annotationId;
        const entity = store().get(annotationId);
        if (!entity || entity.deleted) {
            return null;
        }
        switch (entity.kind) {
            case 'text-box':
            {
                const updated = store().updateTextBox(annotationId, patch);
                options.emitAnnotationModified?.();
                return updated;
            }
            case 'note':
            {
                const updated = store().updateNote(annotationId, patch);
                options.emitAnnotationModified?.();
                return updated;
            }
            case 'text-markup':
            {
                const updated = store().updateTextMarkup(annotationId, patch);
                options.emitAnnotationModified?.();
                return updated;
            }
            case 'placed-image':
            {
                const updated = store().updatePlacedImage(annotationId, patch);
                options.emitAnnotationModified?.();
                return updated;
            }
            case 'shape':
            {
                const updated = store().updateShape(annotationId, patch);
                options.emitAnnotationModified?.();
                return updated;
            }
        }
    }

    function createTextBoxAt(
        pageIndex: number,
        rect: IAnnotationMarkerRect,
        overrides: Partial<Omit<ITextBoxEntity, 'kind' | 'identity' | 'pageIndex' | 'revision' | 'persistedRevision' | 'deleted'>> = {},
    ) {
        const created = store().createTextBox({
            kind: 'text-box',
            identity: newIdentity(),
            pageIndex,
            ...baseEntityFields(),
            text: '',
            rect,
            rotation: 0,
            fontSize: options.settings.value?.textSize ?? 14,
            color: options.settings.value?.textColor ?? null,
            ...overrides,
        });
        return created;
    }

    function createNoteAt(
        pageIndex: number,
        position: IAnnotationMarkerRect,
        overrides: Partial<Omit<INoteEntity, 'kind' | 'identity' | 'pageIndex' | 'revision' | 'persistedRevision' | 'deleted'>> = {},
    ) {
        return store().createNote({
            kind: 'note',
            identity: newIdentity(),
            pageIndex,
            ...baseEntityFields(),
            contents: '',
            position,
            color: options.settings.value?.textColor ?? null,
            open: false,
            ...overrides,
        });
    }

    function createStampAt(
        pageIndex: number,
        rect: IAnnotationMarkerRect,
        image: IPlacedImageEntity['image'],
        overrides: Partial<Omit<IPlacedImageEntity, 'kind' | 'identity' | 'pageIndex' | 'revision' | 'persistedRevision' | 'deleted' | 'rect' | 'image'>> = {},
    ) {
        return store().createPlacedImage({
            kind: 'placed-image',
            identity: newIdentity(),
            pageIndex,
            ...baseEntityFields(),
            rect,
            rotation: 0,
            image,
            ...overrides,
        });
    }

    function createHighlightFromSelection(
        pageIndex: number,
        quadPoints: readonly IAnnotationMarkerRect[],
        overrides: Partial<Omit<ITextMarkupEntity, 'kind' | 'identity' | 'pageIndex' | 'revision' | 'persistedRevision' | 'deleted' | 'quadPoints'>> = {},
    ) {
        const subtype = overrides.subtype ?? 'Highlight' satisfies TMarkupSubtype;
        const style = textMarkupStyle(options.settings.value, subtype);
        return store().createTextMarkup({
            kind: 'text-markup',
            identity: newIdentity(),
            pageIndex,
            ...baseEntityFields(),
            subtype,
            contents: '',
            quadPoints,
            color: style.color,
            opacity: style.opacity,
            ...overrides,
        });
    }

    function createShape(entity: IShapeEntity) {
        return store().createShape(entity);
    }

    function openNote(annotationId: AnnotationId) {
        const entity = store().get(annotationId);
        if (entity?.kind === 'note') {
            options.emitOpenNote?.(entity);
        }
    }

    function openShapeContextMenu(payload: {
        shapeId: AnnotationId;
        clientX: number;
        clientY: number;
    }) {
        options.emitShapeContextMenu?.(payload);
    }

    return {
        entitiesByPage,
        selectedIds,
        activeTool: options.activeTool,
        settings: options.settings,
        getEntitiesForPage,
        select,
        clearSelection,
        getSelectedTextBox,
        updateSelectedTextBoxProperties,
        discardUnsavedAnnotation,
        deleteAnnotation,
        deleteSelection,
        moveSelection,
        nudgeSelection,
        nudgeSelectionByPdfPoints,
        undo: () => options.undo?.() ?? store().undo(),
        redo: () => options.redo?.() ?? store().redo(),
        getPageGeometry: options.getPageGeometry ?? (() => null),
        beginMove: annotationId => beginGesture(annotationId, 'move'),
        beginResize: annotationId => beginGesture(annotationId, 'resize'),
        commitGesture,
        cancelGesture: () => {},
        createTextBoxAt,
        createNoteAt,
        createStampAt,
        ...(options.resolveStampImage ? {resolveStampImage: options.resolveStampImage} : {}),
        createHighlightFromSelection,
        createShape,
        openNote,
        openShapeContextMenu,
    };
};
