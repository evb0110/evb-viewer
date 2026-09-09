import {
    createApp as createVueApp,
    computed,
    defineComponent,
    effectScope,
    ref,
    shallowRef,
    h,
} from 'vue';
import {
    onTestFinished,
    vi,
} from 'vitest';
import {DEFAULT_ANNOTATION_SETTINGS} from '@app/constants/annotationDefaults';
import {AnnotationApplication} from '@app/modules/pdf-viewer/annotations/annotationApplication';
import type {IAnnotationEditorSurface} from '@app/modules/pdf-viewer/runtime/annotations/usePdfAnnotationEditorSurface';
import {usePdfAnnotationEditorSurface} from '@app/modules/pdf-viewer/runtime/annotations/usePdfAnnotationEditorSurface';
import type {
    ITextBoxEntity,
    ITextMarkupEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type {TAnnotationTool} from '@app/types/annotations';
import {requirePageIndex} from '@contracts/pageNumbers';

export function createApp(...args: Parameters<typeof createVueApp>) {
    const app = createVueApp(...args);
    app.component('UIcon', {render: () => h('span')});
    app.component('AppTooltip', defineComponent({
        inheritAttrs: false,
        setup: (_props, {slots}) => () => slots.default?.(),
    }));
    return app;
}

export const annotationId = 'reopened-markup' as ITextMarkupEntity['identity']['id'];

export const entity: ITextMarkupEntity = {
    kind: 'text-markup',
    identity: {id: annotationId},
    pageIndex: requirePageIndex(25),
    revision: 2,
    persistedRevision: 2,
    deleted: false,
    createdAt: null,
    modifiedAt: null,
    author: null,
    subtype: 'Highlight',
    contents: '',
    quadPoints: [{
        left: 0.2,
        top: 0.2,
        width: 0.3,
        height: 0.05,
    }],
    color: '#facc15',
    opacity: 0.5,
};

export const createdTextBox: ITextBoxEntity = {
    kind: 'text-box',
    identity: {id: 'created-text-box' as ITextBoxEntity['identity']['id']},
    pageIndex: requirePageIndex(25),
    revision: 0,
    persistedRevision: -1,
    deleted: false,
    createdAt: null,
    modifiedAt: null,
    author: null,
    text: '',
    rect: {
        left: 0.2,
        top: 0.2,
        width: 0.3,
        height: 0.1,
    },
    rotation: 0,
    fontSize: 14,
    color: '#111827',
};

export function createInteractionMethods(
    select: IAnnotationEditorSurface['select'],
    register?: IAnnotationEditorSurface['registerTextBoxDraftCommitter'],
) {
    const scope = effectScope();
    const defaults = scope.run(() => usePdfAnnotationEditorSurface({
        annotationApplication: shallowRef(new AnnotationApplication('component-event-fixture')),
        activeTool: computed(() => 'select'),
        settings: computed(() => DEFAULT_ANNOTATION_SETTINGS),
    }))!;
    onTestFinished(() => scope.stop());
    const editingId = ref<ITextBoxEntity['identity']['id'] | null>(null);
    const textEditPoint = ref<{
        clientX: number;
        clientY: number
    } | null>(null);
    const selectionMoveDelta = ref<{
        x: number;
        y: number
    } | null>(null);
    return {
        ...defaults,
        selectionMoveDelta,
        setSelectionMoveDelta: (delta: {
            x: number;
            y: number
        } | null) => {selectionMoveDelta.value = delta;},
        editingId,
        textEditPoint,
        registerPageInteraction: vi.fn((_page: number, callbacks: {commitTextDraft: () => void}) => register?.(callbacks.commitTextDraft) ?? (() => {})),
        beginTextEditing: vi.fn((id: ITextBoxEntity['identity']['id'], point?: {
            clientX: number;
            clientY: number
        }) => {select([id]); editingId.value = id; textEditPoint.value = point ?? null;}),
        endTextEditing: vi.fn(() => {editingId.value = null;}),
        beginPointerInteraction: vi.fn(),
        endPointerInteraction: vi.fn(),
        cancelActiveInteraction: vi.fn(() => false),
        prepareToolChange: vi.fn(),
        completeCreation: vi.fn(),
    };
}

export function createCreationSurface() {
    const activeToolValue = ref<TAnnotationTool>('text');
    const activeTool = computed(() => activeToolValue.value);
    const entities = ref<readonly ITextBoxEntity[]>([]);
    const selectedIds = ref<ReadonlySet<ITextBoxEntity['identity']['id']>>(new Set());
    const select = vi.fn((ids: ReadonlyArray<ITextBoxEntity['identity']['id']>) => {
        selectedIds.value = new Set(ids);
    });
    const clearSelection = vi.fn(() => {
        selectedIds.value = new Set();
    });
    const commitGesture = vi.fn();
    const draftCommitters = new Set<() => void>();
    const registerTextBoxDraftCommitter = vi.fn((committer: () => void) => {
        draftCommitters.add(committer);
        return () => draftCommitters.delete(committer);
    });
    const commitPendingTextBoxDraftsForSave = vi.fn(() => {
        [...draftCommitters].forEach(committer => committer());
    });
    const pendingDraftIds = new Set<ITextBoxEntity['identity']['id']>();
    const setTextBoxDraftPending = vi.fn((id: ITextBoxEntity['identity']['id']) => {
        pendingDraftIds.add(id);
    });
    const clearTextBoxDraftPending = vi.fn((id: ITextBoxEntity['identity']['id']) => {
        pendingDraftIds.delete(id);
    });
    const hasPendingTextBoxDrafts = vi.fn(() => pendingDraftIds.size > 0);
    const createTextBoxAt = vi.fn((..._args: Parameters<IAnnotationEditorSurface['createTextBoxAt']>) => {
        entities.value = [createdTextBox];
        return createdTextBox;
    });
    const surface: IAnnotationEditorSurface = {
        ...createInteractionMethods(select, registerTextBoxDraftCommitter),
        activeTool,
        entitiesByPage: computed(() => new Map([[
            25,
            entities.value,
        ]])),
        selectedIds,
        settings: computed(() => null),
        getEntitiesForPage: (pageIndex: number) => pageIndex === 25 ? entities.value : [],
        select,
        clearSelection,
        getSelectedTextBox: vi.fn(() => selectedIds.value.has(createdTextBox.identity.id)
            ? createdTextBox
            : null),
        registerTextBoxDraftCommitter,
        commitPendingTextBoxDraftsForSave,
        setTextBoxDraftPending,
        clearTextBoxDraftPending,
        hasPendingTextBoxDrafts,
        updateSelectedTextBoxProperties: vi.fn(() => true),
        discardUnsavedAnnotation: vi.fn(() => true),
        deleteAnnotation: vi.fn(() => true),
        deleteSelection: vi.fn(),
        moveSelection: vi.fn(),
        nudgeSelection: vi.fn(),
        nudgeSelectionByPdfPoints: vi.fn(),
        undo: vi.fn(() => true),
        redo: vi.fn(() => true),
        getPageGeometry: vi.fn(() => ({
            pageView: [
                0,
                0,
                100,
                100,
            ],
            rotation: 0 as const,
        })),
        beginMove: vi.fn(() => null),
        beginResize: vi.fn(() => null),
        commitGesture,
        createTextBoxAt,
        createNoteAt: vi.fn(),
        createStampAt: vi.fn(),
        createHighlightFromSelection: vi.fn(),
        createShape: vi.fn(),
        openNote: vi.fn(),
        openShapeContextMenu: vi.fn(),
    };
    return {
        surface,
        activeToolValue,
        entities,
        selectedIds,
        select,
        clearSelection,
        createTextBoxAt,
        commitGesture,
        commitPendingTextBoxDraftsForSave,
        setTextBoxDraftPending,
        clearTextBoxDraftPending,
        hasPendingTextBoxDrafts,
        registerTextBoxDraftCommitter,
    };
}

export function createSurface() {
    const selectedIds = ref<ReadonlySet<ITextMarkupEntity['identity']['id']>>(new Set());
    const activeTool = computed(() => 'select' as const);
    const select = vi.fn((ids: ReadonlyArray<ITextMarkupEntity['identity']['id']>) => {
        selectedIds.value = new Set(ids);
    });
    const gesture = {
        annotationId,
        entity,
        kind: 'move' as const,
    };
    const commitGesture = vi.fn(() => entity);
    const surface: IAnnotationEditorSurface = {
        ...createInteractionMethods(select),
        activeTool,
        entitiesByPage: ref(new Map([[
            25,
            [entity],
        ]])),
        selectedIds,
        settings: computed(() => null),
        getEntitiesForPage: (pageIndex: number) => pageIndex === 25 ? [entity] : [],
        select,
        clearSelection: vi.fn(() => { selectedIds.value = new Set(); }),
        getSelectedTextBox: vi.fn(() => null),
        registerTextBoxDraftCommitter: vi.fn(() => vi.fn()),
        commitPendingTextBoxDraftsForSave: vi.fn(),
        setTextBoxDraftPending: vi.fn(),
        clearTextBoxDraftPending: vi.fn(),
        hasPendingTextBoxDrafts: vi.fn(() => false),
        updateSelectedTextBoxProperties: vi.fn(() => true),
        discardUnsavedAnnotation: vi.fn(() => true),
        deleteAnnotation: vi.fn(() => true),
        deleteSelection: vi.fn(),
        moveSelection: vi.fn(),
        nudgeSelection: vi.fn(),
        nudgeSelectionByPdfPoints: vi.fn(),
        undo: vi.fn(() => true),
        redo: vi.fn(() => true),
        getPageGeometry: vi.fn(() => ({
            pageView: [
                0,
                0,
                100,
                100,
            ],
            rotation: 0 as const,
        })),
        beginMove: vi.fn(() => gesture),
        beginResize: vi.fn(() => null),
        commitGesture,
        createTextBoxAt: vi.fn(),
        createNoteAt: vi.fn(),
        createStampAt: vi.fn(),
        createHighlightFromSelection: vi.fn(),
        createShape: vi.fn(),
        openNote: vi.fn(),
        openShapeContextMenu: vi.fn(),
    };
    return {
        surface,
        selectedIds,
        select,
        commitGesture,
    };
}
