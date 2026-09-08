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
    IAnnotationPropertyUpdate,
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
import {
    annotationPageDimensions,
    annotationRectsEqual,
    rotateAnnotationPointAround,
    rotatedAnnotationBounds,
} from '@app/modules/pdf-viewer/engine/annotation-editor-geometry/annotationEditorGeometry';
import {createEpochMs} from '@contracts/timestamps';
import { requirePageIndex } from '@contracts/pageNumbers';

type TAnnotationHistoryAction = () => boolean | Promise<boolean>;

export interface IAnnotationPageInteraction {
    commitTextDraft(): void;
    cancelTextDraft(): void;
    cancelPointerGesture(): void;
    focus(): void;
    fitTextBox?(entity: ITextBoxEntity): ITextBoxEntity['rect'];
}

export interface IAnnotationTextEditPoint {
    clientX: number;
    clientY: number;
}

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
    readonly editingId: Readonly<Ref<AnnotationId | null>>;
    readonly selectionMoveDelta: Readonly<Ref<{
        x: number;
        y: number
    } | null>>;
    setSelectionMoveDelta(delta: {
        x: number;
        y: number
    } | null): void;
    readonly textEditPoint: Readonly<Ref<IAnnotationTextEditPoint | null>>;
    registerPageInteraction(pageIndex: number, interaction: IAnnotationPageInteraction): () => void;
    beginTextEditing(id: AnnotationId, point?: IAnnotationTextEditPoint): void;
    endTextEditing(id: AnnotationId, options?: {
        created?: boolean;
        cancelled?: boolean;
        restoreFocus?: boolean
    }): void;
    beginPointerInteraction(pageIndex: number): void;
    endPointerInteraction(pageIndex: number): void;
    cancelActiveInteraction(): boolean;
    prepareToolChange(): void;
    suspendInteraction(): void;
    completeCreation(tool: TAnnotationTool): void;
    selectAll(): boolean;
    focusSelectedAnnotation(annotationId: AnnotationId): boolean;
    handleEscape(): boolean;
    getSelectedAnnotations(): readonly AnnotationEntity[];
    updateSelectedAnnotationProperties(updates: IAnnotationPropertyUpdate): boolean;
    readonly entitiesByPage: Readonly<Ref<ReadonlyMap<number, readonly AnnotationEntity[]>>>;
    readonly selectedIds: Readonly<Ref<ReadonlySet<AnnotationId>>>;
    readonly activeTool: ComputedRef<TAnnotationTool>;
    readonly settings: ComputedRef<IAnnotationSettings | null>;
    getEntitiesForPage(pageIndex: number): readonly AnnotationEntity[];
    select(ids: readonly AnnotationId[], options?: { additive?: boolean }): void;
    clearSelection(): void;
    getSelectedTextBox(): ITextBoxEntity | null;
    registerTextBoxDraftCommitter(committer: () => void): () => void;
    commitPendingTextBoxDraftsForSave(): void;
    setTextBoxDraftPending(annotationId: AnnotationId): void;
    clearTextBoxDraftPending(annotationId: AnnotationId): void;
    hasPendingTextBoxDrafts(): boolean;
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
        viewRotation?: 0 | 90 | 180 | 270
    } | null;
    beginMove(annotationId: AnnotationId): IAnnotationGesture | null;
    beginResize(annotationId: AnnotationId): IAnnotationGesture | null;
    commitGesture(
        gesture: IAnnotationGesture | AnnotationId,
        patch: TAnnotationGesturePatch,
    ): AnnotationEntity | null;
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
    isActive?: ComputedRef<boolean>;
    settings: ComputedRef<IAnnotationSettings | null>;
    authorName?: ComputedRef<string | null | undefined>;
    onCreationCompleted?: (tool: TAnnotationTool) => void;
    onToolCancel?: (() => void) | undefined;
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
        viewRotation?: 0 | 90 | 180 | 270
    } | null;
}

function timestamp() {
    return createEpochMs();
}

function newIdentity(): IAnnotationIdentity {
    return {id: mintAnnotationId()};
}

function baseEntityFields(author: string | null) {
    const now = timestamp();
    return {
        revision: 0,
        persistedRevision: -1,
        deleted: false as const,
        createdAt: now,
        modifiedAt: now,
        author,
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
    const editingId = ref<AnnotationId | null>(null);
    const selectionMoveDelta = shallowRef<{
        x: number;
        y: number
    } | null>(null);
    const textEditPoint = shallowRef<IAnnotationTextEditPoint | null>(null);
    const pageInteractions = new Map<number, IAnnotationPageInteraction>();
    let editingPageIndex: number | null = null;
    let pointerPageIndex: number | null = null;
    let preparingToolChange = false;
    const entitiesByPage = shallowRef<ReadonlyMap<number, readonly AnnotationEntity[]>>(new Map());
    const selectedIds = shallowRef<ReadonlySet<AnnotationId>>(new Set());
    const textBoxDraftCommitters = new Set<() => void>();
    const pendingTextBoxDraftIds = new Set<AnnotationId>();
    const pendingTextBoxDraftCount = ref(0);
    let stopSubscription: (() => void) | null = null;
    let subscribedApplication: AnnotationApplication | null = null;

    function commitTextSession() {
        if (editingPageIndex !== null) pageInteractions.get(editingPageIndex)?.commitTextDraft();
    }

    function cancelPointerSession() {
        const pageIndex = pointerPageIndex;
        pointerPageIndex = null;
        selectionMoveDelta.value = null;
        if (pageIndex === null) {
            return false;
        }
        pageInteractions.get(pageIndex)?.cancelPointerGesture();
        return true;
    }

    function registerPageInteraction(pageIndex: number, interaction: IAnnotationPageInteraction) {
        pageInteractions.set(pageIndex, interaction);
        return () => {
            if (pageInteractions.get(pageIndex) !== interaction) {
                return;
            }
            if (editingPageIndex === pageIndex) commitTextSession();
            if (pointerPageIndex === pageIndex) cancelPointerSession();
            pageInteractions.delete(pageIndex);
        };
    }

    function beginTextEditing(id: AnnotationId, point?: IAnnotationTextEditPoint) {
        const entity = store().get(id);
        if (entity?.kind !== 'text-box' || entity.deleted) {
            return;
        }
        if (editingId.value !== id) commitTextSession();
        cancelPointerSession();
        select([id]);
        editingPageIndex = entity.pageIndex;
        textEditPoint.value = point ?? null;
        editingId.value = id;
    }

    function endTextEditing(id: AnnotationId, endOptions: {
        created?: boolean;
        cancelled?: boolean;
        restoreFocus?: boolean;
    } = {}) {
        if (editingId.value !== id) {
            return;
        }
        const pageIndex = editingPageIndex;
        editingId.value = null;
        editingPageIndex = null;
        textEditPoint.value = null;
        clearTextBoxDraftPending(id);
        if (endOptions.created && !endOptions.cancelled && !preparingToolChange) completeCreation('text');
        if (endOptions.restoreFocus !== false && !preparingToolChange && pageIndex !== null) {
            void nextTick(() => pageInteractions.get(pageIndex)?.focus());
        }
    }

    function beginPointerInteraction(pageIndex: number) {
        if (pointerPageIndex !== null && pointerPageIndex !== pageIndex) cancelPointerSession();
        pointerPageIndex = pageIndex;
    }

    function endPointerInteraction(pageIndex: number) {
        if (pointerPageIndex === pageIndex) {
            pointerPageIndex = null;
            selectionMoveDelta.value = null;
        }
    }

    function cancelActiveInteraction() {
        if (cancelPointerSession()) {
            return true;
        }
        if (editingPageIndex !== null) {
            pageInteractions.get(editingPageIndex)?.cancelTextDraft();
            return true;
        }
        return false;
    }

    function suspendInteraction() {
        preparingToolChange = true;
        try {
            commitTextSession();
            cancelPointerSession();
        } finally {
            preparingToolChange = false;
        }
    }

    function prepareToolChange() {
        preparingToolChange = true;
        try {
            commitTextSession();
            cancelPointerSession();
            clearSelection();
        } finally {
            preparingToolChange = false;
        }
    }

    function completeCreation(tool: TAnnotationTool) {
        options.onCreationCompleted?.(tool);
    }

    function handleEscape() {
        if (cancelActiveInteraction()) {
            return true;
        }
        if (selectedIds.value.size > 0) {
            clearSelection();
            return true;
        }
        if (options.activeTool.value !== 'none' && options.activeTool.value !== 'select') {
            options.onToolCancel?.();
            return true;
        }
        return false;
    }

    function selectAll() {
        if (editingId.value !== null) {
            return false;
        }
        select([...entitiesByPage.value.values()].flat().map(entity => entity.identity.id));
        return selectedIds.value.size > 0;
    }

    function focusSelectedAnnotation(annotationId: AnnotationId) {
        if (options.isActive?.value === false || editingId.value !== null || !selectedIds.value.has(annotationId)) {
            return false;
        }
        const entity = store().get(annotationId);
        const interaction = entity && !entity.deleted ? pageInteractions.get(entity.pageIndex) : undefined;
        if (!interaction) {
            return false;
        }
        interaction.focus();
        return true;
    }

    function getSelectedAnnotations() {
        return [...selectedIds.value].flatMap(id => {
            const entity = store().get(id);
            return entity && !entity.deleted ? [entity] : [];
        });
    }

    function updateSelectedAnnotationProperties(updates: IAnnotationPropertyUpdate) {
        let changed = false;
        (options.runHistoryTransaction ?? ((action: () => void) => action()))(() => {
            for (const entity of getSelectedAnnotations()) {
                const patch: {-readonly [K in keyof TAnnotationGesturePatch]: TAnnotationGesturePatch[K]} = {};
                if (updates.color !== undefined) {
                    if (entity.kind === 'shape') patch.strokeColor = updates.color;
                    else if (entity.kind !== 'placed-image') patch.color = updates.color;
                }
                if (updates.fontSize !== undefined && entity.kind === 'text-box') {
                    patch.fontSize = updates.fontSize;
                    const fittedRect = pageInteractions.get(entity.pageIndex)?.fitTextBox?.({
                        ...entity,
                        fontSize: updates.fontSize,
                    });
                    if (fittedRect && !annotationRectsEqual(entity.rect, fittedRect)) patch.rect = fittedRect;
                }
                if (updates.opacity !== undefined && (entity.kind === 'shape' || entity.kind === 'text-markup')) patch.opacity = updates.opacity;
                if (entity.kind === 'shape') {
                    if (updates.strokeWidth !== undefined) patch.strokeWidth = updates.strokeWidth;
                    if (updates.fill !== undefined) patch.fill = updates.fill;
                }
                if (updates.rotation !== undefined && (entity.kind === 'text-box' || entity.kind === 'placed-image')) patch.rotation = updates.rotation;
                if (Object.entries(patch).some(([
                    key,
                    value,
                ]) => Reflect.get(entity, key) !== value)) {
                    commitGesture(entity.identity.id, patch);
                    changed = true;
                }
            }
        });
        return changed;
    }

    function clearPendingTextBoxDrafts() {
        pendingTextBoxDraftIds.clear();
        pendingTextBoxDraftCount.value = 0;
    }

    function prunePendingTextBoxDrafts(entities: readonly AnnotationEntity[]) {
        const liveTextBoxIds = new Set(
            entities
                .filter((entity): entity is ITextBoxEntity => entity.kind === 'text-box' && !entity.deleted)
                .map(entity => entity.identity.id),
        );
        [...pendingTextBoxDraftIds].forEach((annotationId) => {
            if (!liveTextBoxIds.has(annotationId)) {
                clearTextBoxDraftPending(annotationId);
            }
        });
    }

    function subscribeToApplication(application: AnnotationApplication) {
        if (subscribedApplication && subscribedApplication !== application) {
            cancelActiveInteraction();
            editingId.value = null;
            editingPageIndex = null;
            clearPendingTextBoxDrafts();
        }
        subscribedApplication = application;
        stopSubscription?.();
        stopSubscription = application.store.subscribe((entities) => {
            prunePendingTextBoxDrafts(entities);
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
    onScopeDispose(() => {
        cancelPointerSession();
        pageInteractions.clear();
        stopSubscription?.();
        textBoxDraftCommitters.clear();
        clearPendingTextBoxDrafts();
        subscribedApplication = null;
    });

    function registerTextBoxDraftCommitter(committer: () => void) {
        textBoxDraftCommitters.add(committer);
        return () => {
            textBoxDraftCommitters.delete(committer);
        };
    }

    function commitPendingTextBoxDraftsForSave() {
        commitTextSession();
        [...textBoxDraftCommitters].forEach(committer => committer());
    }

    function setTextBoxDraftPending(annotationId: AnnotationId) {
        const entity = store().get(annotationId);
        if (entity?.kind !== 'text-box' || entity.deleted) {
            return;
        }
        if (pendingTextBoxDraftIds.has(annotationId)) {
            return;
        }
        pendingTextBoxDraftIds.add(annotationId);
        pendingTextBoxDraftCount.value += 1;
    }

    function clearTextBoxDraftPending(annotationId: AnnotationId) {
        if (!pendingTextBoxDraftIds.delete(annotationId)) {
            return;
        }
        pendingTextBoxDraftCount.value = Math.max(0, pendingTextBoxDraftCount.value - 1);
    }

    function hasPendingTextBoxDrafts() {
        return pendingTextBoxDraftCount.value > 0;
    }

    function store() {
        return options.annotationApplication.value.store;
    }

    function getEntitiesForPage(pageIndex: number) {
        return entitiesByPage.value.get(pageIndex) ?? [];
    }

    function select(ids: readonly AnnotationId[], selectionOptions: { additive?: boolean } = {}) {
        if (editingId.value !== null && !ids.includes(editingId.value)) commitTextSession();
        const nextIds = selectionOptions.additive
            ? new Set([
                ...selectedIds.value,
                ...ids,
            ])
            : new Set(ids);
        store().select([...nextIds]);
    }

    function clearSelection() {
        commitTextSession();
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
        // Keyboard directions describe the display, while canonical coordinates
        // already include the PDF page's intrinsic rotation.
        const entries = [...selectedIds.value].flatMap(id => {
            const entity = store().get(id);
            if (!entity || entity.deleted) {
                return [];
            }
            const geometry = options.getPageGeometry?.(entity.pageIndex);
            const page = annotationPageDimensions(geometry?.pageView ?? pageView, geometry?.rotation ?? pageRotation);
            const delta = rotateAnnotationPointAround({
                x: deltaX / page.width,
                y: deltaY / page.height,
            }, {
                x: 0,
                y: 0,
            }, -(geometry?.viewRotation ?? 0), page);
            const rects = entity.kind === 'text-markup' ? entity.quadPoints : [entity.kind === 'note' ? entity.position : entity.rect];
            const bounds = rects.map(rect => rotatedAnnotationBounds(rect, 'rotation' in entity ? entity.rotation : 0, page));
            return [{
                id,
                entity,
                delta,
                bounds,
            }];
        });
        let fraction = 1;
        for (const {
            delta,
            bounds,
        } of entries) {
            for (const rect of bounds) {
                if (delta.x > 0) fraction = Math.min(fraction, (1 - rect.left - rect.width) / delta.x);
                if (delta.x < 0) fraction = Math.min(fraction, -rect.left / delta.x);
                if (delta.y > 0) fraction = Math.min(fraction, (1 - rect.top - rect.height) / delta.y);
                if (delta.y < 0) fraction = Math.min(fraction, -rect.top / delta.y);
            }
        }
        fraction = Math.max(0, fraction);
        if (!fraction || !entries.length) {
            return;
        }
        (options.runHistoryTransaction ?? ((action: () => void) => action()))(() => {
            for (const {
                id,
                entity,
                delta,
            } of entries) {
                const dx = delta.x * fraction;
                const dy = delta.y * fraction;
                const moveRect = (rect: IAnnotationMarkerRect) => translateRect(rect, dx, dy);
                switch (entity.kind) {
                    case 'text-box': store().updateTextBox(id, {rect: moveRect(entity.rect)}); break;
                    case 'note': store().updateNote(id, {position: moveRect(entity.position)}); break;
                    case 'text-markup': store().updateTextMarkup(id, {quadPoints: entity.quadPoints.map(moveRect)}); break;
                    case 'placed-image': store().updatePlacedImage(id, {rect: moveRect(entity.rect)}); break;
                    case 'shape': store().updateShape(id, {
                        rect: moveRect(entity.rect),
                        ...(entity.points ? {points: entity.points.map(point => ({
                            x: point.x + dx,
                            y: point.y + dy,
                        }))} : {}),
                        ...(entity.strokes ? {strokes: entity.strokes.map(stroke => stroke.map(point => ({
                            x: point.x + dx,
                            y: point.y + dy,
                        })))} : {}),
                    }); break;
                }
            }
        });
        options.emitAnnotationModified?.();
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

    function annotationAuthor() {
        const author = options.authorName?.value?.trim() ?? '';
        return author.length > 0 ? author : null;
    }

    function createTextBoxAt(
        pageIndex: number,
        rect: IAnnotationMarkerRect,
        overrides: Partial<Omit<ITextBoxEntity, 'kind' | 'identity' | 'pageIndex' | 'revision' | 'persistedRevision' | 'deleted'>> = {},
    ) {
        const created = store().createTextBox({
            kind: 'text-box',
            identity: newIdentity(),
            pageIndex: requirePageIndex(pageIndex),
            ...baseEntityFields(annotationAuthor()),
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
        const {
            replies,
            ...restOverrides
        } = overrides;
        const entity: Omit<INoteEntity, 'replies'> = {
            kind: 'note',
            identity: newIdentity(),
            pageIndex: requirePageIndex(pageIndex),
            ...baseEntityFields(annotationAuthor()),
            contents: '',
            position,
            color: options.settings.value?.noteColor ?? '#f59e0b',
            open: false,
            ...restOverrides,
        };
        return store().createNote(replies === undefined ? entity : {
            ...entity,
            replies,
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
            pageIndex: requirePageIndex(pageIndex),
            ...baseEntityFields(annotationAuthor()),
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
        const {
            selectedText,
            ...restOverrides
        } = overrides;
        const entity: Omit<ITextMarkupEntity, 'selectedText'> = {
            kind: 'text-markup',
            identity: newIdentity(),
            pageIndex: requirePageIndex(pageIndex),
            ...baseEntityFields(annotationAuthor()),
            subtype,
            contents: '',
            quadPoints,
            color: style.color,
            opacity: style.opacity,
            ...restOverrides,
        };
        return store().createTextMarkup(
            selectedText === undefined ? entity : {
                ...entity,
                selectedText,
            },
        );
    }

    function createShape(entity: IShapeEntity) {
        return store().createShape({
            ...entity,
            author: annotationAuthor(),
        });
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
        editingId,
        selectionMoveDelta,
        setSelectionMoveDelta: delta => { selectionMoveDelta.value = delta; },
        textEditPoint,
        registerPageInteraction,
        beginTextEditing,
        endTextEditing,
        beginPointerInteraction,
        endPointerInteraction,
        cancelActiveInteraction,
        prepareToolChange,
        suspendInteraction,
        completeCreation,
        selectAll,
        focusSelectedAnnotation,
        handleEscape,
        getSelectedAnnotations,
        updateSelectedAnnotationProperties,
        entitiesByPage,
        selectedIds,
        activeTool: options.activeTool,
        settings: options.settings,
        getEntitiesForPage,
        select,
        clearSelection,
        getSelectedTextBox,
        registerTextBoxDraftCommitter,
        commitPendingTextBoxDraftsForSave,
        setTextBoxDraftPending,
        clearTextBoxDraftPending,
        hasPendingTextBoxDrafts,
        updateSelectedTextBoxProperties,
        discardUnsavedAnnotation,
        deleteAnnotation,
        deleteSelection,
        moveSelection,
        nudgeSelection,
        nudgeSelectionByPdfPoints,
        undo: () => {
            cancelPointerSession();
            return options.undo?.() ?? store().undo();
        },
        redo: () => {
            cancelPointerSession();
            return options.redo?.() ?? store().redo();
        },
        getPageGeometry: options.getPageGeometry ?? (() => null),
        beginMove: annotationId => beginGesture(annotationId, 'move'),
        beginResize: annotationId => beginGesture(annotationId, 'resize'),
        commitGesture,
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
