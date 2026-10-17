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
    IPlacedImageEntity,
    INoteEntity,
    IShapeEntity,
    ITextBoxEntity,
    ITextMarkupEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {
    isReadOnlyAnnotation, mintAnnotationId,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {
    annotationPageDimensions,
    annotationRectsEqual,
    rotateAnnotationPointAround,
    rotatedAnnotationBounds,
    transformShapeToRect,
} from '@app/modules/pdf-viewer/engine/annotation-editor-geometry/annotationEditorGeometry';
import {createEpochMs} from '@contracts/timestamps';
import { requirePageIndex } from '@contracts/pageNumbers';
import { BrowserLogger } from '@app/utils/browserLogger';
import type {
    INativeTextBoxAppearance, TNativeTextBoxFit,
} from '@app/modules/pdf-viewer/runtime/save/nativeTextBoxMutations';

type TAnnotationHistoryAction = () => boolean | Promise<boolean>;

export interface IAnnotationPageInteraction {
    commitTextDraft(): void | Promise<void>;
    readonly pendingTextCompletion?: Promise<void> | null;
    cancelTextDraft(): void;
    cancelPointerGesture(): void;
    focus(): void;
    fitTextBox?(entity: ITextBoxEntity): ITextBoxEntity['rect'] | null;
    getTextBoxDraftRect?(annotationId: AnnotationId): IAnnotationMarkerRect | null;
    getPaintInput?(entity: AnnotationEntity): AnnotationEntity;
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

export type TResolveTextMarkupPreview = (
    quadPoints: readonly IAnnotationMarkerRect[],
) => string | null | undefined;

export interface IAnnotationEditorSurface {
    readonly editingId: Readonly<Ref<AnnotationId | null>>;
    readonly selectionMoveDelta: Readonly<Ref<{
        x: number;
        y: number;
        ids: ReadonlySet<AnnotationId>;
    } | null>>;
    setSelectionMoveDelta(delta: IAnnotationEditorSurface['selectionMoveDelta']['value']): void;
    readonly textEditPoint: Readonly<Ref<IAnnotationTextEditPoint | null>>;
    registerPageInteraction(pageIndex: number, interaction: IAnnotationPageInteraction): () => void;
    beginTextEditing(id: AnnotationId, point?: IAnnotationTextEditPoint): void | Promise<void>;
    endTextEditing(id: AnnotationId, options?: {
        created?: boolean;
        cancelled?: boolean;
        restoreFocus?: boolean
    }): void;
    beginPointerInteraction(pageIndex: number): void;
    endPointerInteraction(pageIndex: number): void;
    cancelActiveInteraction(): boolean;
    prepareToolChange(): void | Promise<void>;
    suspendInteraction(): void | Promise<void>;
    completeCreation(tool: TAnnotationTool): void;
    selectAll(): boolean;
    focusSelectedAnnotation(annotationId: AnnotationId): boolean;
    handleEscape(): boolean;
    /** The selection's entities as the store last emitted them: they follow edits as well as selection changes. */
    readonly selectedAnnotations: ComputedRef<readonly AnnotationEntity[]>;
    readonly selectedTextBox: ComputedRef<ITextBoxEntity | null>;
    canRotateSelectedAnnotations(delta: -90 | 90): boolean;
    updateSelectedAnnotationProperties(updates: IAnnotationPropertyUpdate): boolean | Promise<boolean>;
    readonly entitiesByPage: Readonly<Ref<ReadonlyMap<number, readonly AnnotationEntity[]>>>;
    readonly selectedIds: Readonly<Ref<ReadonlySet<AnnotationId>>>;
    /** What a move carries: the selection less what no command may change. */
    readonly movingIds: ComputedRef<ReadonlySet<AnnotationId>>;
    readonly activeTool: ComputedRef<TAnnotationTool>;
    readonly settings: ComputedRef<IAnnotationSettings | null>;
    getEntitiesForPage(pageIndex: number): readonly AnnotationEntity[];
    getPaintInput(entity: AnnotationEntity): AnnotationEntity;
    isOriginalAppearance(entity: AnnotationEntity): boolean;
    isNativeTextBoxAppearance(entity: ITextBoxEntity): boolean;
    fitTextBox(entity: ITextBoxEntity, proposal: ITextBoxEntity): TNativeTextBoxFit | Promise<TNativeTextBoxFit>;
    /** Paints the accepted text box, reusing the appearance its fit produced, before handing it off. */
    publishTextBoxAppearance(entity: ITextBoxEntity, handoff: () => void, appearance?: INativeTextBoxAppearance): void | Promise<void>;
    select(ids: readonly AnnotationId[], options?: { additive?: boolean }): void;
    clearSelection(): void;
    getSelectedTextBox(): ITextBoxEntity | null;
    commitPendingTextBoxDraftsForSave(): void | Promise<void>;
    getPendingTextCompletion(): undefined | Promise<unknown>;
    runAcceptedCommand<T>(command: Promise<T> | (() => T | Promise<T>)): T | Promise<T>;
    protectTextBoxDraft(annotationId: AnnotationId): void | Promise<void>;
    setTextBoxDraftPending(annotationId: AnnotationId, text?: string): void;
    restoreTextBoxDraftPending(annotationId: AnnotationId, geometry?: IAnnotationMarkerRect): void;
    clearTextBoxDraftPending(annotationId: AnnotationId): void;
    hasTextBoxDraftPending(annotationId: AnnotationId): boolean;
    getTextBoxDraftText(annotationId: AnnotationId): string | null;
    getTextBoxDraftRect(annotationId: AnnotationId): IAnnotationMarkerRect | null;
    updateSelectedTextBoxProperties(
        updates: Partial<Pick<ITextBoxEntity, 'fontSize' | 'color'>>,
    ): boolean | Promise<boolean>;
    discardUnsavedAnnotation(annotationId: AnnotationId): boolean;
    deleteAnnotation(annotationId: AnnotationId): boolean;
    deleteSelection(): void;
    moveSelection(deltaX: number, deltaY: number, ids?: ReadonlySet<AnnotationId>): void;
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
        options?: {resolveSelectedText?: TResolveTextMarkupPreview;},
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

interface IUsePdfAnnotationEditorSurfaceOptions {
    annotationApplication: ShallowRef<AnnotationApplication>;
    activeTool: ComputedRef<TAnnotationTool>;
    isActive?: ComputedRef<boolean>;
    settings: ComputedRef<IAnnotationSettings | null>;
    authorName?: ComputedRef<string | null | undefined>;
    onCreationCompleted?: (tool: TAnnotationTool) => void;
    onTextBoxDraftChanged?: (annotationId: AnnotationId, text: string | null) => void;
    getTextBoxDraftText?: (annotationId: AnnotationId) => string | null;
    textBoxDraftRects?: Map<string, IAnnotationMarkerRect>;
    isOriginalAppearance?: (entity: AnnotationEntity) => boolean;
    isNativeTextBoxAppearance?: (entity: ITextBoxEntity) => boolean;
    fitTextBox?: (entity: ITextBoxEntity, proposal: ITextBoxEntity) => Promise<TNativeTextBoxFit>;
    publishTextBoxAppearance?: (entity: ITextBoxEntity, handoff: () => void, isInputCurrent: () => boolean, appearance?: INativeTextBoxAppearance) => Promise<void>;
    getTextBoxDraftGeneration?: (annotationId: AnnotationId) => number | undefined;
    beforeTextBoxEdit?: (annotationId: AnnotationId) => void | Promise<void>;
    getPendingTextCompletion?: () => undefined | Promise<unknown>;
    protectTextBoxDraft?: ((assertCurrent: () => void) => Promise<void>) | undefined;
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
    getPageGeometry?: IAnnotationEditorSurface['getPageGeometry'];
}

function baseEntityFields(author: string | null) {
    const now = createEpochMs();
    return {
        identity: {id: mintAnnotationId()},
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
    const completeCreation = options.onCreationCompleted ?? (() => {});
    const getTextBoxDraftText = options.getTextBoxDraftText ?? (() => null);
    const selectionMoveDelta = shallowRef<IAnnotationEditorSurface['selectionMoveDelta']['value']>(null);
    const textEditPoint = shallowRef<IAnnotationTextEditPoint | null>(null);
    const pageInteractions = shallowReactive(new Map<number, IAnnotationPageInteraction>());
    const editingPageIndex = computed(() => editingId.value === null ? null : subscribedApplication?.store.get(editingId.value)?.pageIndex ?? null);
    let pointerPageIndex: number | null = null;
    let preparingToolChange = false;
    let pendingAnnotationCommand: Promise<unknown> | null = null;
    const entitiesByPage = shallowRef<ReadonlyMap<number, readonly AnnotationEntity[]>>(new Map());
    const selectedIds = shallowRef<ReadonlySet<AnnotationId>>(new Set());
    const pendingTextBoxDraftIds = reactive(new Set<AnnotationId>());
    const restoredTextBoxDraftRects = options.textBoxDraftRects ?? new Map<string, IAnnotationMarkerRect>();
    let stopSubscription: (() => void) | null = null;
    let subscribedApplication: AnnotationApplication | null = null;

    function commitTextSession<T>(after: () => T | Promise<T>, accepted: Promise<unknown>): Promise<T>;
    function commitTextSession<T>(after: () => T | Promise<T>): T | Promise<T>;
    function commitTextSession(): void | Promise<void>;
    function commitTextSession<T>(after?: () => T | Promise<T>, accepted?: Promise<unknown>): T | void | Promise<T | void> {
        const application = options.annotationApplication.value;
        const selection = selectedIds.value;
        const commitDraft = () => editingPageIndex.value === null ? undefined : pageInteractions.get(editingPageIndex.value)?.commitTextDraft();
        const pending = accepted ?? (pendingAnnotationCommand ? pendingAnnotationCommand.then(commitDraft) : commitDraft());
        if (!after) return pending ? pending.then(() => {}) : undefined;
        if (pending) return pending.then(() => {
            if (options.annotationApplication.value !== application || pointerPageIndex !== null || selectedIds.value.size !== selection.size || [...selection].some(id => !selectedIds.value.has(id))) throw new DOMException('The annotation command was superseded', 'AbortError');
            return after();
        });
        return after();
    }

    function runAcceptedCommand<T>(command: Promise<T> | (() => T | Promise<T>)): T | Promise<T> {
        const application = options.annotationApplication.value;
        const pending = command instanceof Promise ? undefined : options.getPendingTextCompletion?.() ?? getPendingTextCompletion();
        const result = command instanceof Promise ? command : pending ? pending.then(() => {
            if (options.annotationApplication.value !== application) throw new DOMException('The annotation document was replaced', 'AbortError');
            return command();
        }) : command();
        if (!(result instanceof Promise)) return result;
        const accepted = result.finally(() => {if (pendingAnnotationCommand === accepted) pendingAnnotationCommand = null;});
        pendingAnnotationCommand = accepted;
        return accepted;
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
            if (editingPageIndex.value === pageIndex) void commitTextSession()?.catch(error => BrowserLogger.debug('annotations', 'Unmounted text draft retained after completion failed', error));
            if (pointerPageIndex === pageIndex) cancelPointerSession();
            pageInteractions.delete(pageIndex);
        };
    }

    async function beginTextEditing(id: AnnotationId, point?: IAnnotationTextEditPoint) {
        const application = options.annotationApplication.value;
        const selection = selectedIds.value;
        if (editable(id)?.kind !== 'text-box') {
            return;
        }
        if (editingId.value !== id) {
            const pending = commitTextSession();
            if (pending) await pending;
            const other = options.beforeTextBoxEdit?.(id);
            if (other) await other;
        }
        const entity = editable(id);
        if (options.annotationApplication.value !== application || selectedIds.value !== selection || entity?.kind !== 'text-box') throw new DOMException('The text editor handoff was superseded', 'AbortError');
        cancelPointerSession();
        setSelection([id]);
        if (getTextBoxDraftText(id) !== null) pendingTextBoxDraftIds.add(id);
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
        editingId.value = null;
        textEditPoint.value = null;
        clearTextBoxDraftPending(id);
        if (endOptions.created && !endOptions.cancelled && !preparingToolChange) completeCreation('text');
        if (endOptions.restoreFocus !== false && !preparingToolChange) {
            void nextTick(() => focusSelectedAnnotation(id));
        }
    }

    function beginPointerInteraction(pageIndex: number) {
        if (pointerPageIndex !== null && pointerPageIndex !== pageIndex) cancelPointerSession();
        pointerPageIndex = pageIndex;
    }

    function endPointerInteraction(pageIndex: number) {
        if (pointerPageIndex === pageIndex) {
            pointerPageIndex = null;
        }
    }

    function cancelActiveInteraction() {
        if (cancelPointerSession()) {
            return true;
        }
        if (editingPageIndex.value !== null) {
            pageInteractions.get(editingPageIndex.value)?.cancelTextDraft();
            return true;
        }
        return false;
    }

    function suspendInteraction(): void | Promise<void> {
        preparingToolChange = true;
        let pending: void | Promise<void> = undefined;
        try {
            pending = commitTextSession();
            if (pending) return pending.then(() => {cancelPointerSession();}).finally(() => {preparingToolChange = false;});
            cancelPointerSession();
        } finally {
            if (!pending) preparingToolChange = false;
        }
    }

    function prepareToolChange(): void | Promise<void> {
        const pending = suspendInteraction();
        if (pending) return pending.then(() => {setSelection([]);});
        setSelection([]);
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
        return [...selectedIds.value].flatMap(id => editable(id) ?? []);
    }
    // Commands read the store; views read its emissions, which a store batch
    // defers until it ends.
    const selectedAnnotations = computed(() => {
        const live = new Map([...entitiesByPage.value.values()].flat().map(entity => [
            entity.identity.id,
            entity,
        ]));
        return [...selectedIds.value].flatMap(id => live.get(id) ?? []);
    });
    const selectedTextBox = computed(() => (
        selectedAnnotations.value.find((entity): entity is ITextBoxEntity => entity.kind === 'text-box') ?? null
    ));

    function fitRotatedRectToPage(pageIndex: number, rect: IAnnotationMarkerRect, rotation: number) {
        const geometry = options.getPageGeometry?.(pageIndex);
        if (!geometry || geometry.pageView.length < 4
            || !geometry.pageView.slice(0, 4).every(Number.isFinite)
            || geometry.pageView[2]! <= geometry.pageView[0]!
            || geometry.pageView[3]! <= geometry.pageView[1]!
            || !Number.isFinite(rotation)
            || !Number.isFinite(rect.left) || !Number.isFinite(rect.top)
            || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)
            || rect.width <= 0 || rect.height <= 0) {
            return null;
        }
        const page = annotationPageDimensions(geometry.pageView, geometry.rotation);
        const bounds = rotatedAnnotationBounds(rect, rotation, page);
        // Admit floating-point rounding at an exact page edge, never a visible
        // overflow. The writer applies its own PDF-coordinate edge tolerance.
        if (!Object.values(bounds).every(Number.isFinite) || bounds.width > 1 + 1e-12 || bounds.height > 1 + 1e-12) {
            return null;
        }
        const deltaX = bounds.left < 0 ? -bounds.left : Math.min(0, 1 - bounds.left - bounds.width);
        const deltaY = bounds.top < 0 ? -bounds.top : Math.min(0, 1 - bounds.top - bounds.height);
        return deltaX === 0 && deltaY === 0 ? rect : {
            ...rect,
            left: rect.left + deltaX,
            top: rect.top + deltaY,
        };
    }

    function planSelectedAnnotationProperties(updates: IAnnotationPropertyUpdate, includeTextDraft = false) {
        const hasRotation = updates.rotation !== undefined || updates.rotationDelta !== undefined;
        if (updates.rotation !== undefined && updates.rotationDelta !== undefined) {
            return null;
        }
        const entities = getSelectedAnnotations();
        if (hasRotation && entities.some(entity => {
            if (entity.kind !== 'text-box') return entity.kind !== 'placed-image';
            const text = getTextBoxDraftText(entity.identity.id);
            const rect = getTextBoxDraftRect(entity.identity.id);
            return (text !== null && text !== entity.text)
                || (rect !== null && !annotationRectsEqual(rect, entity.rect)
                    && !(editingId.value === entity.identity.id
                        && entity.persistedRevision < 0 && entity.text === ''));
        })) {
            return null;
        }
        const planned: Array<{
            id: AnnotationId;
            patch: TAnnotationGesturePatch;
            imageRotation?: number
        }> = [];
        for (const entity of entities) {
            const patch: {-readonly [K in keyof TAnnotationGesturePatch]: TAnnotationGesturePatch[K]} = {};
            let imageRotation: number | undefined;
            if (includeTextDraft && entity.kind === 'text-box' && entity.identity.id === editingId.value) {
                const draftRect = pageInteractions.get(entity.pageIndex)?.getTextBoxDraftRect?.(entity.identity.id);
                if (draftRect) patch.rect = {...draftRect};
            }
            if (updates.color !== undefined) {
                if (entity.kind === 'shape') patch.strokeColor = updates.color;
                else if (entity.kind !== 'placed-image') patch.color = updates.color;
            }
            if (updates.fontSize !== undefined && entity.kind === 'text-box') {
                const fittedRect = pageInteractions.get(entity.pageIndex)?.fitTextBox?.({
                    ...entity,
                    fontSize: updates.fontSize,
                });
                if (fittedRect !== null) {
                    patch.fontSize = updates.fontSize;
                    if (fittedRect && !annotationRectsEqual(entity.rect, fittedRect)) patch.rect = fittedRect;
                }
            }
            if (updates.opacity !== undefined && (entity.kind === 'shape' || entity.kind === 'text-markup')) patch.opacity = updates.opacity;
            if (entity.kind === 'shape') {
                if (updates.strokeWidth !== undefined) patch.strokeWidth = updates.strokeWidth;
                if (updates.fill !== undefined) patch.fill = updates.fill;
            }
            if (hasRotation && (entity.kind === 'text-box' || entity.kind === 'placed-image')) {
                const rawRotation = updates.rotation ?? entity.rotation + (updates.rotationDelta ?? 0);
                const rotation = ((rawRotation % 360) + 360) % 360;
                const fittedRect = fitRotatedRectToPage(entity.pageIndex, patch.rect ?? entity.rect, rotation);
                if (!fittedRect) {
                    return null;
                }
                if (!annotationRectsEqual(entity.rect, fittedRect)) patch.rect = fittedRect;
                if (entity.kind === 'text-box') {
                    if (rotation !== 0 && rotation !== 90 && rotation !== 180 && rotation !== 270) {
                        return null;
                    }
                    patch.rotation = rotation;
                } else {
                    imageRotation = rotation;
                }
            }
            if (Object.entries(patch).some(([
                key,
                value,
            ]) => Reflect.get(entity, key) !== value)
                    || imageRotation !== undefined && entity.kind === 'placed-image' && imageRotation !== entity.rotation) {
                planned.push({
                    id: entity.identity.id,
                    patch,
                    ...(imageRotation === undefined ? {} : {imageRotation}),
                });
            }
        }
        return planned;
    }

    function canRotateSelectedAnnotations(delta: -90 | 90) {
        const planned = planSelectedAnnotationProperties({rotationDelta: delta}, true);
        return planned !== null && planned.length > 0;
    }

    function getPendingTextCompletion() {
        return pendingAnnotationCommand ?? (editingPageIndex.value === null ? undefined : pageInteractions.get(editingPageIndex.value)?.pendingTextCompletion ?? undefined);
    }

    function updateSelectedAnnotationProperties(updates: IAnnotationPropertyUpdate) {
        const pending = options.getPendingTextCompletion?.() ?? getPendingTextCompletion();
        const result = pending ? commitTextSession(() => applySelectedAnnotationProperties(updates), pending) : applySelectedAnnotationProperties(updates);
        if (!(result instanceof Promise)) return result;
        return Promise.resolve(runAcceptedCommand(result)).catch(error => {
            BrowserLogger.debug('annotations', 'Annotation style command refused', error);
            return false;
        });
    }

    function applySelectedAnnotationProperties(updates: IAnnotationPropertyUpdate) {
        const hasRotation = updates.rotation !== undefined || updates.rotationDelta !== undefined;
        const planned = planSelectedAnnotationProperties(updates, hasRotation);
        if (!planned?.length) {
            return false;
        }
        const commit = () => {
            (options.runHistoryTransaction ?? ((action: () => void) => action()))(() => {
                for (const {
                    id, patch, imageRotation,
                } of planned) {
                    if (imageRotation === undefined) commitGesture(id, patch);
                    else {
                        store().updatePlacedImage(id, {
                            ...patch,
                            rotation: imageRotation,
                        });
                        options.emitAnnotationModified?.();
                    }
                }
            });
            return true;
        };
        const assertions = planned.map(entry => captureTextBoxInput(entry.id));
        const fitting = options.fitTextBox ? planned.flatMap(entry => {
            const entity = store().get(entry.id);
            if (entity?.kind !== 'text-box' || entry.id === editingId.value || !('fontSize' in entry.patch || 'rect' in entry.patch || 'rotation' in entry.patch)) return [];
            return [Promise.resolve(fitTextBox(entity, {
                ...entity,
                ...entry.patch,
                text: getTextBoxDraftText(entry.id) ?? entity.text,
            })).then((fitted) => {
                Object.assign(entry.patch, {
                    rect: fitted.rect,
                    fontSize: fitted.fontSize,
                });
            })];
        }) : [];
        if (!fitting.length) return commit();
        return commitTextSession(() => {
            assertions.forEach(assertCurrent => assertCurrent());
            return commit();
        }, Promise.all(fitting));
    }

    function subscribeToApplication(application: AnnotationApplication) {
        if (subscribedApplication && subscribedApplication !== application) {
            cancelActiveInteraction();
            editingId.value = null;
            [...pendingTextBoxDraftIds].forEach(clearTextBoxDraftPending);
            selectedIds.value = new Set();
        }
        subscribedApplication = application;
        stopSubscription?.();
        stopSubscription = application.store.subscribe((snapshotIncludingDeleted) => {
            const liveTextBoxIds = new Set(
                snapshotIncludingDeleted
                    .filter((entity): entity is ITextBoxEntity => entity.kind === 'text-box' && !entity.deleted)
                    .map(entity => entity.identity.id),
            );
            [...pendingTextBoxDraftIds].forEach((annotationId) => {
                if (!liveTextBoxIds.has(annotationId)) {
                    clearTextBoxDraftPending(annotationId);
                }
            });
            // The store emission is the only retained projection. Group it in
            // one pass so each page component reads the same stable snapshot.
            const grouped = new Map<number, AnnotationEntity[]>();
            snapshotIncludingDeleted.forEach((entity) => {
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
            entitiesByPage.value = grouped;
            setSelection([...selectedIds.value]);
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
        subscribedApplication = null;
    });

    function captureTextBoxInput(annotationId: AnnotationId) {
        const application = options.annotationApplication.value;
        const entity = store().get(annotationId);
        const editor = editingId.value;
        const generation = options.getTextBoxDraftGeneration?.(annotationId);
        const text = getTextBoxDraftText(annotationId);
        const geometry = getTextBoxDraftRect(annotationId);
        return (assert = true) => {
            const currentGeometry = getTextBoxDraftRect(annotationId);
            const changed = options.annotationApplication.value !== application || editingId.value !== editor
                || store().get(annotationId)?.revision !== entity?.revision
                || options.getTextBoxDraftGeneration?.(annotationId) !== generation
                || getTextBoxDraftText(annotationId) !== text
                || (geometry ? !currentGeometry || !annotationRectsEqual(currentGeometry, geometry) : currentGeometry !== null);
            if (changed && assert) throw new DOMException('The text draft changed while completion was pending', 'AbortError');
            return !changed;
        };
    }

    function protectTextBoxDraft(annotationId: AnnotationId) {
        if (!options.protectTextBoxDraft) return;
        const assertCurrent = captureTextBoxInput(annotationId);
        const geometry = getTextBoxDraftRect(annotationId);
        if (geometry) restoredTextBoxDraftRects.set(annotationId, geometry);
        return options.protectTextBoxDraft(assertCurrent).then(() => {assertCurrent();});
    }

    function fitTextBox(entity: ITextBoxEntity, proposal: ITextBoxEntity) {
        if (!options.fitTextBox) return {
            rect: proposal.rect,
            fontSize: proposal.fontSize,
        };
        const assertCurrent = captureTextBoxInput(entity.identity.id);
        return options.fitTextBox(entity, proposal).then(fitted => {assertCurrent(); return fitted;});
    }

    function publishTextBoxAppearance(entity: ITextBoxEntity, handoff: () => void, appearance?: INativeTextBoxAppearance) {
        if (!options.publishTextBoxAppearance) return handoff();
        const assertCurrent = captureTextBoxInput(entity.identity.id);
        return options.publishTextBoxAppearance(entity, handoff, () => assertCurrent(false), appearance);
    }

    function setTextBoxDraftPending(annotationId: AnnotationId, text?: string) {
        const entity = store().get(annotationId);
        if (entity?.kind !== 'text-box' || entity.deleted) {
            return;
        }
        const rect = pageInteractions.get(entity.pageIndex)?.getTextBoxDraftRect?.(annotationId);
        if (rect) restoredTextBoxDraftRects.set(annotationId, rect);
        if (text !== undefined) {
            options.onTextBoxDraftChanged?.(annotationId, text);
        }
        pendingTextBoxDraftIds.add(annotationId);
    }

    function restoreTextBoxDraftPending(annotationId: AnnotationId, geometry?: IAnnotationMarkerRect) {
        const entity = store().get(annotationId);
        const text = getTextBoxDraftText(annotationId);
        if (entity?.kind !== 'text-box' || entity.deleted || text === null) {
            return;
        }
        store().import({
            ...entity,
            text,
            rect: geometry ?? entity.rect,
            revision: entity.revision + 1,
        }, {preserveSavedBaseline: true});
        options.onTextBoxDraftChanged?.(annotationId, null);
    }

    function clearTextBoxDraftPending(annotationId: AnnotationId) {
        restoredTextBoxDraftRects.delete(annotationId);
        if (!pendingTextBoxDraftIds.delete(annotationId)) {
            return;
        }
        options.onTextBoxDraftChanged?.(annotationId, null);
    }

    function hasTextBoxDraftPending(annotationId: AnnotationId) {
        return pendingTextBoxDraftIds.has(annotationId);
    }

    function getTextBoxDraftRect(annotationId: AnnotationId) {
        const entity = hasTextBoxDraftPending(annotationId) ? store().get(annotationId) : null;
        const current = entity?.kind === 'text-box' && editingId.value === annotationId
            ? pageInteractions.get(entity.pageIndex)?.getTextBoxDraftRect?.(annotationId) : null;
        return current ?? restoredTextBoxDraftRects.get(annotationId) ?? null;
    }

    function store() {
        return options.annotationApplication.value.store;
    }

    /** The live annotation a command may change: a read-only label is only selected and copied. */
    function editable(id: AnnotationId) {
        const entity = store().get(id);
        return entity && !entity.deleted && !isReadOnlyAnnotation(entity) ? entity : null;
    }

    // The selection belongs to this view, like its page and zoom; another view
    // of the document keeps its own. It holds only annotations that still exist.
    function setSelection(ids: readonly AnnotationId[]) {
        const next = new Set(ids.filter((id) => {
            const entity = store().get(id);
            return Boolean(entity && !entity.deleted);
        }));
        if (next.size !== selectedIds.value.size || [...next].some(id => !selectedIds.value.has(id))) {
            selectedIds.value = next;
        }
    }

    function select(ids: readonly AnnotationId[], selectionOptions: { additive?: boolean } = {}) {
        if (editingId.value !== null && !ids.includes(editingId.value)) void commitTextSession()?.catch(error => BrowserLogger.debug('annotations', 'Selection handoff refused', error));
        setSelection(selectionOptions.additive ? [
            ...selectedIds.value,
            ...ids,
        ] : ids);
    }

    function clearSelection() {
        void commitTextSession()?.catch(error => BrowserLogger.debug('annotations', 'Selection handoff refused', error));
        setSelection([]);
    }

    function deleteAnnotation(annotationId: AnnotationId) {
        if (!editable(annotationId)) {
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
        cancelPointerSession();
        const pending = commitTextSession(() => (options.runHistoryTransaction ?? ((action: () => void) => action()))(() => {
            [...selectedIds.value].forEach(id => deleteAnnotation(id));
        }));
        if (pending) void pending.catch(error => BrowserLogger.warn('annotations', 'Annotation deletion refused', error));
    }

    function translateEntity(entity: AnnotationEntity, deltaX: number, deltaY: number) {
        const moveRect = (rect: IAnnotationMarkerRect) => ({
            ...rect,
            left: rect.left + deltaX,
            top: rect.top + deltaY,
        });
        const moved = entity.kind === 'shape' ? transformShapeToRect(entity, moveRect(entity.rect), 'move') : null;
        const patch = moved ? {
            rect: moved.rect,
            ...(moved.points === undefined ? {} : {points: moved.points}),
            ...(moved.strokes === undefined ? {} : {strokes: moved.strokes}),
        } : entity.kind === 'text-markup' ? {quadPoints: entity.quadPoints.map(moveRect)}
            : entity.kind === 'note' ? {position: moveRect(entity.position)}
                : {rect: moveRect(entity.rect)};
        commitGesture(entity.identity.id, patch);
    }

    function moveSelection(deltaX: number, deltaY: number, ids = selectedIds.value) {
        (options.runHistoryTransaction ?? ((action: () => void) => action()))(() => {
            for (const id of ids) {
                const entity = editable(id);
                if (entity) translateEntity(entity, deltaX, deltaY);
            }
        });
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
            const entity = editable(id);
            if (!entity) {
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
                entity,
                delta,
            } of entries) {
                const dx = delta.x * fraction;
                const dy = delta.y * fraction;
                translateEntity(entity, dx, dy);
            }
        });
    }

    function beginGesture(annotationId: AnnotationId, kind: IAnnotationGesture['kind']) {
        const entity = editable(annotationId);
        return entity
            ? {
                annotationId,
                entity: pageInteractions.get(entity.pageIndex)?.getPaintInput?.(entity) ?? entity,
                kind,
            }
            : null;
    }

    function commitGesture(
        gesture: IAnnotationGesture | AnnotationId,
        patch: TAnnotationGesturePatch,
    ) {
        const annotationId = typeof gesture === 'string' ? gesture : gesture.annotationId;
        const entity = editable(annotationId);
        if (!entity) {
            return null;
        }
        let updated: AnnotationEntity;
        switch (entity.kind) {
            case 'text-box':
                updated = store().updateTextBox(annotationId, patch);
                break;
            case 'note':
                updated = store().updateNote(annotationId, patch);
                break;
            case 'text-markup':
                updated = store().updateTextMarkup(annotationId, patch);
                break;
            case 'placed-image':
                updated = store().updatePlacedImage(annotationId, patch);
                break;
            case 'shape':
                updated = store().updateShape(annotationId, patch);
                break;
        }
        options.emitAnnotationModified?.();
        return updated;
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
        creationOptions: {resolveSelectedText?: TResolveTextMarkupPreview;} = {},
    ): ITextMarkupEntity {
        const subtype = overrides.subtype ?? 'Highlight' satisfies TMarkupSubtype;
        const style = textMarkupStyle(options.settings.value, subtype);
        const {
            selectedText,
            ...restOverrides
        } = overrides;
        const entity: Omit<ITextMarkupEntity, 'selectedText'> = {
            kind: 'text-markup',
            pageIndex: requirePageIndex(pageIndex),
            ...baseEntityFields(annotationAuthor()),
            subtype,
            contents: '',
            quadPoints,
            color: style.color,
            opacity: style.opacity,
            ...restOverrides,
        };
        const selection = store().applyTextMarkupSelection(
            selectedText === undefined ? entity : {
                ...entity,
                selectedText,
            },
            [],
            creationOptions.resolveSelectedText,
        );
        const stored = store().get(selection.created.identity.id);
        return stored?.kind === 'text-markup' ? stored : selection.created;
    }

    function createShape(entity: IShapeEntity) {
        return store().createShape({
            ...entity,
            author: annotationAuthor(),
        });
    }

    function openNote(annotationId: AnnotationId) {
        const entity = store().get(annotationId);
        if (entity?.kind === 'note' || entity?.kind === 'text-markup') {
            options.emitOpenNote?.(entity);
        }
    }

    return {
        editingId,
        selectionMoveDelta,
        setSelectionMoveDelta: delta => { selectionMoveDelta.value = delta; },
        // A read-only label stays where it is, and its place bounds no move.
        movingIds: computed(() => new Set([...selectedIds.value].filter(id => editable(id)))),
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
        selectedAnnotations,
        selectedTextBox,
        canRotateSelectedAnnotations,
        updateSelectedAnnotationProperties,
        entitiesByPage,
        selectedIds,
        activeTool: options.activeTool,
        settings: options.settings,
        getEntitiesForPage: pageIndex => entitiesByPage.value.get(pageIndex) ?? [],
        getPaintInput(entity) {
            if (entity.kind === 'text-box' && editingId.value === entity.identity.id) return entity;
            const preview = pageInteractions.get(entity.pageIndex)?.getPaintInput?.(entity) ?? entity;
            return preview.kind === 'text-box' ? {
                ...preview,
                text: getTextBoxDraftText(preview.identity.id) ?? preview.text,
                rect: restoredTextBoxDraftRects.get(preview.identity.id) ?? preview.rect,
            } : preview;
        },
        isOriginalAppearance: entity => options.isOriginalAppearance?.(entity) ?? false,
        isNativeTextBoxAppearance: entity => options.isNativeTextBoxAppearance?.(entity) ?? false,
        fitTextBox,
        publishTextBoxAppearance,
        select,
        clearSelection,
        getSelectedTextBox: () => getSelectedAnnotations().find((entity): entity is ITextBoxEntity => entity.kind === 'text-box') ?? null,
        commitPendingTextBoxDraftsForSave: commitTextSession,
        getPendingTextCompletion,
        runAcceptedCommand,
        protectTextBoxDraft,
        setTextBoxDraftPending,
        restoreTextBoxDraftPending,
        clearTextBoxDraftPending,
        hasTextBoxDraftPending,
        getTextBoxDraftText,
        getTextBoxDraftRect,
        updateSelectedTextBoxProperties: updateSelectedAnnotationProperties,
        discardUnsavedAnnotation,
        deleteAnnotation,
        deleteSelection,
        moveSelection,
        nudgeSelection: moveSelection,
        nudgeSelectionByPdfPoints,
        undo: () => {
            cancelPointerSession();
            return commitTextSession(() => options.undo?.() ?? store().undo());
        },
        redo: () => {
            cancelPointerSession();
            return commitTextSession(() => options.redo?.() ?? store().redo());
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
        openShapeContextMenu: payload => options.emitShapeContextMenu?.(payload),
    };
};
