import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { retry } from 'es-toolkit/function';
import {
    nextTick,
    ref,
} from 'vue';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
    TAnnotationCommentsStatus,
    TAnnotationTool,
} from '@app/types/annotations';
import {annotationIdForSummary} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationSummaryIdentity';
import type { IPdfPlacedImageFinalizePayload } from '@app/types/pdfImagePlacement';
import type { TDocumentOperationKind } from '@app/types/documentOperationKind';
import type { TPdfPlacedImageEmbeddingResult } from '@app/modules/pdf-viewer/public';
import { requireDocumentRevisionToken } from '@contracts';
import { usePageAnnotationActions } from '@app/modules/workspace-shell/composables/usePageAnnotationActions';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';
import { createTestDomRect } from '@tests/helpers/domGeometryTestHarness';
import {TEST_PDF_SAVE_BYTE_ROUTE_DECISION} from '@tests/unit/app/modules/pdf-viewer/runtime/save/testPdfSaveByteRouteDecision';

function createComment(stableKeySeed: string): IAnnotationCommentSummary {
    return {
        appAnnotationId: `anno-${stableKeySeed}`,
        id: stableKeySeed,
        stableKey: `ann:0:${stableKeySeed}`,
        pageIndex: 0,
        pageNumber: 1,
        text: `comment-${stableKeySeed}`,
        author: null,
        modifiedAt: null,
        color: null,
        uid: null,
        annotationId: null,
        source: 'pdf',
    };
}

function createPdfFreeTextComment(
    overrides: Partial<IAnnotationCommentSummary> = {},
): IAnnotationCommentSummary {
    return {
        ...createComment('ann:504:12R0'),
        source: 'pdf',
        annotationId: '12R',
        subtype: 'FreeText',
        hasNote: true,
        text: 'note text',
        pageIndex: 504,
        pageNumber: 505,
        ...overrides,
    };
}

function createEditorOpenNote(
    baseComment: IAnnotationCommentSummary,
    overrides: Partial<IAnnotationCommentSummary> = {},
): IAnnotationCommentSummary {
    return {
        ...baseComment,
        stableKey: 'ann:504:open-note',
        id: 'open-note',
        source: 'editor',
        annotationId: null,
        uid: 'open-note',
        ...overrides,
    };
}

function placedImagePayload(rotationDegrees = 0): IPdfPlacedImageFinalizePayload {
    return {
        pageNumber: 4,
        x: 0.1,
        y: 0.2,
        width: 0.3,
        height: 0.15,
        rotationDegrees,
        fileName: 'image.png',
        mimeType: 'image/png',
        bytes: Uint8Array.of(1, 2, 3),
        targetPixelWidth: 240,
        targetPixelHeight: 120,
    };
}

type TRunWithDocumentOperationLease = <T>(
    kind: TDocumentOperationKind,
    operation: () => Promise<T>,
) => Promise<T>;

type TRunWithDocumentOperationLeaseMock = TRunWithDocumentOperationLease & {mockImplementationOnce: (implementation: TRunWithDocumentOperationLease) => TRunWithDocumentOperationLeaseMock;};

async function waitForCondition(condition: () => boolean, timeoutMs = 300) {
    const intervalMs = 5;
    try {
        await retry(async () => {
            if (!condition()) {
                throw new Error('Condition not met');
            }
        }, {
            retries: Math.max(0, Math.ceil(timeoutMs / intervalMs) - 1),
            delay: intervalMs,
        });
    } catch {
        throw new Error('Timed out waiting for condition');
    }
}

function installSplitImagePickerPlatform(imagePath: string, options: { cleanupError?: Error } = {}) {
    const imageBytes = Uint8Array.of(1, 2, 3);
    const cleanupFile = vi.fn(() => (
        options.cleanupError
            ? Promise.reject(options.cleanupError)
            : Promise.resolve()
    ));
    const documentPicker = { openImageDialog: vi.fn(() => Promise.resolve(imagePath)) };
    const documentFiles = {
        readFile: vi.fn(() => Promise.resolve(imageBytes)),
        statFile: vi.fn(() => Promise.resolve({size: imageBytes.byteLength})),
    };
    const documentWorkingCopy = { cleanupFile };

    vi.stubGlobal('window', {
        ...globalThis,
        electronAPI: createElectronPlatformApiFixture({
            documentFiles,
            documentPicker,
            documentWorkingCopy,
        }),
    });

    return {
        documentFiles,
        documentPicker,
        documentWorkingCopy,
    };
}

interface ITestViewerPageContainer { getBoundingClientRect: () => DOMRect; }

interface ITestViewerContainer {
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
    querySelector: (selector: string) => ITestViewerPageContainer | null;
}

function createHarness() {
    const selectedShape = ref<IShapeAnnotation | null>(null);
    const viewerContainer = ref<ITestViewerContainer | null>(null);

    const viewer = {
        getViewerContainer: vi.fn(() => viewerContainer.value as HTMLElement | null),
        getCurrentPage: vi.fn(() => 1),
        commentSelection: vi.fn(async () => false),
        commentAtPoint: vi.fn(async () => true),
        focusAnnotationComment: vi.fn(async () => {}),
        highlightSelection: vi.fn(async () => true),
        invalidatePages: vi.fn(),
        updateAnnotationComment: vi.fn(() => true),
        deleteAnnotationComment: vi.fn(async (_comment: IAnnotationCommentSummary) => true),
        deleteAnnotationEditor: vi.fn(async (_comment: IAnnotationCommentSummary) => true),
        deleteReopenedEditorAnnotation: vi.fn(async (_comment: IAnnotationCommentSummary) => true),
        registerAnnotationHistoryCommand: vi.fn(),
        removeAnnotationFromDom: vi.fn(),
        removeAnnotationFromInternalCache: vi.fn(),
        deleteEmbeddedAnnotationDeferred: vi.fn(() => true),
        undeleteEmbeddedAnnotationDeferred: vi.fn(),
        updateSelectedTextMarkupAnnotationColor: vi.fn(() => true),
        updateTextMarkupAnnotationColor: vi.fn(() => true),
        selectedShapeId: null as string | null,
        updateShape: vi.fn(),
        getSelectedShape: vi.fn(() => selectedShape.value),
        deleteSelectedShape: vi.fn(),
        deleteShapeById: vi.fn(),
        getAllShapes: vi.fn(() => []),
        runSaveTransaction: vi.fn(async () => ({
            source: 'writer-save' as const,
            baseBytes: null,
            serializedBytes: Uint8Array.of(9, 9),
            serializedResult: null,
            nativeMutationProjection: null,
            fallbackDecision: TEST_PDF_SAVE_BYTE_ROUTE_DECISION,
            annotationSavePlan: {
                route: 'source-clean' as const,
                expectedCost: 'small' as const,
                reason: 'no-live-pdfjs-annotation-work' as const,
                unreplayableLiveAnnotationIds: [],
            },
        })),
        saveDocument: vi.fn(async () => Uint8Array.of(9, 9)),
        startImagePlacement: vi.fn(async (
            _file?: File,
            _placement?: {
                pageNumber?: number | null;
                pageX?: number | null;
                pageY?: number | null;
                stableKey?: string;
                annotationId?: string | null;
            },
        ) => true),
        clearPendingImagePlacement: vi.fn(),
        restorePendingImagePlacement: vi.fn(),
        restoreAnnotationToInternalCache: vi.fn(),
    };

    const annotationTool = ref<TAnnotationTool>('highlight');
    const dragMode = ref(true);
    const handleAnnotationToolChange = vi.fn((tool: TAnnotationTool) => {
        annotationTool.value = tool;
        dragMode.value = false;
    });

    const runWithDocumentOperationLease: TRunWithDocumentOperationLeaseMock = vi.fn(async <T>(
        _kind: TDocumentOperationKind,
        operation: () => Promise<T>,
    ) => operation()) as TRunWithDocumentOperationLeaseMock;
    const embedPlacedImageToPage = vi.fn<(
        data: Uint8Array | null,
        placement: IPdfPlacedImageFinalizePayload,
    ) => Promise<TPdfPlacedImageEmbeddingResult>>(async () => Uint8Array.of(7, 7));
    const deps = {
        pdfViewerRef: ref(viewer),
        annotationTool,
        annotationKeepActive: ref(false),
        annotationSettings: ref({ ...DEFAULT_ANNOTATION_SETTINGS }),
        annotationActiveCommentStableKey: ref<string | null>(null),
        annotationContextMenu: ref({
            visible: true,
            comment: null as IAnnotationCommentSummary | null,
            hasSelection: false,
            selectionText: '',
            pageNumber: null as number | null,
            pageX: null as number | null,
            pageY: null as number | null,
        }),
        showSidebar: ref(false),
        sidebarTab: ref<'annotations' | 'thumbnails' | 'bookmarks' | 'search'>('search'),
        dragMode,
        currentPage: ref(3),
        workingCopyPath: ref<string | null>('browser://documents/work.pdf'),
        closeAnnotationContextMenu: vi.fn(),
        showAnnotationContextMenu: vi.fn(),
        handleAnnotationToolChange,
        openAnnotationNoteWindow: vi.fn(),
        removeAnnotationNoteWindow: vi.fn(),
        setAnnotationNoteWindowError: vi.fn(),
        isSameAnnotationComment: vi.fn((a: IAnnotationCommentSummary, b: IAnnotationCommentSummary) => a.stableKey === b.stableKey),
        annotationNoteWindows: ref<Array<{
            annotationId: string;
            draftText: string;
            createdAtMs?: number | undefined;
        }>>([]),
        loadPdfFromData: vi.fn(async (_data: Uint8Array, _opts?: {
            pushHistory?: boolean;
            persistWorkingCopy?: boolean;
        }) => {}),
        loadPdfFromPath: vi.fn(async (_path: string, _opts?: { markDirty?: boolean }) => {}),
        saveAnnotationsForPageMutation: vi.fn(async () => true),
        waitForPdfReload: vi.fn(async (_page: number) => {}),
        invalidateThumbnailPages: vi.fn(),
        removeAnnotationFromCache: vi.fn(),
        restoreAnnotationToCache: vi.fn(),
        deleteEmbeddedAnnotationDeferred: vi.fn(),
        undeleteEmbeddedAnnotationDeferred: vi.fn(),
        isNativeFreeTextNoteSaved: vi.fn(() => false),
        getAnnotationCommentsSnapshot: vi.fn((): IAnnotationCommentSummary[] => []),
        getAnnotationCommentsStatusSnapshot: vi.fn((): TAnnotationCommentsStatus => 'loading'),
        getEmbeddedMutationBaseData: vi.fn(async () => Uint8Array.of(6, 6)),
        embedPlacedImageToPage,
        runWithDocumentOperationLease,
    };

    return {
        viewer,
        selectedShape,
        viewerContainer,
        deps,
        actions: usePageAnnotationActions(deps),
    };
}

beforeEach(() => {
    vi.stubGlobal('useTypedI18n', () => ({
        t: (key: string) => key,
        setLocale: vi.fn(async () => {}),
        loadLocaleMessages: vi.fn(async () => {}),
    }));
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('usePageAnnotationActions', () => {
    it('keeps a newly opened editor note in the sidebar cache before text is entered', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-26T12:00:00Z'));
        try {
            const {
                deps,
                actions,
            } = createHarness();
            const comment = createComment('new-editor-note');
            comment.source = 'editor';
            comment.subtype = 'FreeText';
            comment.hasNote = true;
            comment.text = '\u200B';

            actions.handleOpenAnnotationNote(comment);

            const expected = expect.objectContaining({
                stableKey: 'ann:0:new-editor-note',
                createdAt: new Date('2026-05-26T12:00:00Z').getTime(),
            });
            expect(deps.openAnnotationNoteWindow).toHaveBeenCalledWith(expected);
            expect(deps.annotationActiveCommentStableKey.value).toBe('anno-new-editor-note');
        } finally {
            vi.useRealTimers();
        }
    });

    it('leaves fresh editor note history to the canonical annotation command path', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-26T12:00:00Z'));
        try {
            const {
                deps,
                viewer,
                actions,
            } = createHarness();
            const comment = createComment('fresh-editor-note');
            comment.source = 'editor';
            comment.subtype = 'FreeText';
            comment.hasNote = true;
            comment.text = '\u200B\uFEFF ';

            actions.handleOpenAnnotationNote(comment);
            const noteComment = deps.openAnnotationNoteWindow.mock.calls[0]?.[0];
            deps.annotationNoteWindows.value = [{
                annotationId: annotationIdForSummary(noteComment!),
                draftText: noteComment!.text,
            }];
            vi.runOnlyPendingTimers();

            expect(noteComment).toEqual(expect.objectContaining({
                stableKey: 'ann:0:fresh-editor-note',
                createdAt: new Date('2026-05-26T12:00:00Z').getTime(),
            }));
            expect(viewer.registerAnnotationHistoryCommand).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not add a second command after note identity synchronization', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-26T12:00:00Z'));
        try {
            const {
                deps,
                viewer,
                actions,
            } = createHarness();
            const comment = createComment('transient-note');
            comment.source = 'editor';
            comment.id = 'transient-note';
            comment.subtype = 'FreeText';
            comment.hasNote = true;
            comment.text = '\u200B';
            comment.markerRect = {
                left: 0.25,
                top: 0.35,
                width: 0.01,
                height: 0.01,
            };

            actions.handleOpenAnnotationNote(comment);
            const noteComment = deps.openAnnotationNoteWindow.mock.calls[0]?.[0] as IAnnotationCommentSummary;
            deps.annotationNoteWindows.value = [{
                draftText: '',
                annotationId: annotationIdForSummary(noteComment),
            }];
            vi.runOnlyPendingTimers();

            expect(viewer.registerAnnotationHistoryCommand).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not capture mutable note-window state in an executor closure', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-26T12:00:00Z'));
        try {
            const {
                deps,
                viewer,
                actions,
            } = createHarness();
            const comment = createComment('transient-note');
            comment.source = 'editor';
            comment.id = 'transient-note';
            comment.subtype = 'FreeText';
            comment.hasNote = true;
            comment.text = '\u200B';
            comment.markerRect = {
                left: 0.25,
                top: 0.35,
                width: 0.01,
                height: 0.01,
            };

            actions.handleOpenAnnotationNote(comment);
            const openedComment = deps.openAnnotationNoteWindow.mock.calls[0]?.[0] as IAnnotationCommentSummary;
            const savedComment: IAnnotationCommentSummary = {
                ...openedComment,
                id: 'actual-editor',
                uid: 'actual-editor',
                stableKey: 'ann:0:actual-editor',
                text: 'Saved note text',
                modifiedAt: Date.now() + 1_000,
            };
            deps.annotationNoteWindows.value = [{
                draftText: 'Saved note text',
                annotationId: annotationIdForSummary(savedComment),
            }];
            vi.runOnlyPendingTimers();

            expect(viewer.registerAnnotationHistoryCommand).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not expose a parallel fresh-note undo fallback outside app history', () => {
        const {actions} = createHarness();

        expect(actions).not.toHaveProperty('undoLatestFreshAnnotationNoteCreation');
    });

    it('selects the canonical note tool without creating a selection-based note', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();

        deps.showSidebar.value = true;
        deps.sidebarTab.value = 'bookmarks';

        await actions.handleQuickNoteAction();

        expect(viewer.commentSelection).not.toHaveBeenCalled();
        expect(deps.annotationTool.value).toBe('note');
        expect(deps.dragMode.value).toBe(false);
        expect(deps.showSidebar.value).toBe(true);
        expect(deps.sidebarTab.value).toBe('bookmarks');
    });

    it('clamps shape context menu popover coordinates to viewport bounds', () => {
        vi.stubGlobal('window', {
            innerWidth: 320,
            innerHeight: 220,
        });

        const {
            deps,
            actions,
        } = createHarness();

        actions.handleShapeContextMenu({
            shapeId: 'shape-1',
            clientX: 999,
            clientY: -25,
        });

        expect(deps.closeAnnotationContextMenu).toHaveBeenCalledOnce();
        expect(actions.shapePropertiesPopover.value).toEqual({
            visible: true,
            x: 52,
            y: 8,
        });
    });

    it('updates selected shape properties when selectedShapeId is exposed as unwrapped value', () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();

        viewer.selectedShapeId = 'shape-1';

        actions.handleShapePropertyUpdate({ strokeWidth: 7.5 });

        expect(deps.annotationSettings.value.shapeStrokeWidth).toBe(7.5);
        expect(viewer.updateShape).toHaveBeenCalledWith('shape-1', { strokeWidth: 7.5 });
    });

    it('updates draw defaults when the selected shape is an ink drawing', () => {
        const {
            deps,
            viewer,
            selectedShape,
            actions,
        } = createHarness();

        selectedShape.value = {
            id: 'shape-ink',
            type: 'polyline',
            pageIndex: 0,
            x: 0.2,
            y: 0.2,
            width: 0.2,
            height: 0.2,
            color: '#e11d48',
            opacity: 0.9,
            strokeWidth: 2,
            source: 'embedded',
            pdfSubtype: 'Ink',
            points: [
                {
                    x: 0.2,
                    y: 0.2,
                },
                {
                    x: 0.4,
                    y: 0.4,
                },
            ],
            strokes: [[
                {
                    x: 0.2,
                    y: 0.2,
                },
                {
                    x: 0.4,
                    y: 0.4,
                },
            ]],
        };
        deps.pdfViewerRef.value = {
            ...viewer,
            selectedShapeId: 'shape-ink',
        };

        actions.handleShapePropertyUpdate({ opacity: 0.45 });

        expect(deps.annotationSettings.value.inkOpacity).toBe(0.45);
        expect(viewer.updateShape).toHaveBeenCalledWith('shape-ink', { opacity: 0.45 });
    });

    it('opens shape properties automatically for a newly selected shape', async () => {
        const {
            deps,
            viewer,
            selectedShape,
            viewerContainer,
            actions,
        } = createHarness();

        vi.stubGlobal('window', {
            innerWidth: 1400,
            innerHeight: 1000,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        });

        viewerContainer.value = {
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            querySelector: (selector: string) => (
                selector === '.page_container[data-page="1"]'
                    ? { getBoundingClientRect: () => createTestDomRect({
                        left: 100,
                        top: 80,
                        width: 600,
                        height: 800,
                    }) }
                    : null
            ),
        };

        selectedShape.value = {
            id: 'shape-1',
            type: 'line',
            pageIndex: 0,
            x: 0.25,
            y: 0.4,
            x2: 0.8,
            y2: 0.2,
            width: 0.55,
            height: 0.2,
            color: '#3b82f6',
            opacity: 1,
            strokeWidth: 4,
        };
        deps.pdfViewerRef.value = {
            ...viewer,
            selectedShapeId: 'shape-1',
        };

        await nextTick();
        await nextTick();

        expect(actions.selectedShapeForProperties.value?.id).toBe('shape-1');
        expect(actions.shapePropertiesPopover.value.visible).toBe(true);
        expect(actions.shapePropertiesPopover.value.x).toBeGreaterThan(580);
        expect(actions.shapePropertiesPopover.value.y).toBeGreaterThanOrEqual(200);
    });

    it('creates markup from context menu and resets tool when keep-active is disabled', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();

        await actions.createContextMenuMarkup('underline');

        expect(deps.handleAnnotationToolChange).toHaveBeenCalledWith('underline');
        expect(viewer.highlightSelection).toHaveBeenCalledOnce();
        expect(deps.annotationTool.value).toBe('none');
        expect(deps.closeAnnotationContextMenu).toHaveBeenCalledOnce();
    });

    it.each([
        {
            settingsKey: 'highlightColor',
            subtype: 'Highlight',
        },
        {
            settingsKey: 'underlineColor',
            subtype: 'Underline',
        },
        {
            settingsKey: 'strikethroughColor',
            subtype: 'StrikeOut',
        },
        {
            settingsKey: 'squigglyColor',
            subtype: 'Squiggly',
        },
    ] as const)(
        'updates %s materialized context menu color without reloading and records history',
        async ({
            settingsKey,
            subtype,
        }) => {
            const {
                deps,
                viewer,
                actions,
            } = createHarness();
            const comment = createComment(`context-color-${subtype}`);
            comment.subtype = subtype;
            comment.color = '#22c55e';
            deps.annotationContextMenu.value.comment = comment;

            actions.handleContextTextMarkupColorUpdate('#ef4444');

            expect(viewer.updateTextMarkupAnnotationColor).toHaveBeenCalledWith(
                expect.objectContaining({
                    stableKey: comment.stableKey,
                    color: '#22c55e',
                    colorEdited: true,
                }),
                '#ef4444',
            );
            expect(deps.annotationContextMenu.value.comment?.color).toBe('#ef4444');
            expect(deps.annotationContextMenu.value.comment?.colorEdited).toBe(true);
            expect(deps.annotationSettings.value[settingsKey]).toBe('#ef4444');
            expect(deps.loadPdfFromData).not.toHaveBeenCalled();
            expect(viewer.registerAnnotationHistoryCommand).toHaveBeenCalledOnce();
            const historyCommand = viewer.registerAnnotationHistoryCommand.mock.calls[0]?.[0];
            historyCommand?.undo();
            expect(viewer.updateTextMarkupAnnotationColor).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    stableKey: comment.stableKey,
                    color: '#ef4444',
                    colorEdited: false,
                }),
                '#22c55e',
            );
            historyCommand?.cmd();
            expect(viewer.updateTextMarkupAnnotationColor).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    stableKey: comment.stableKey,
                    color: '#22c55e',
                }),
                '#ef4444',
            );
        },
    );

    it('keeps rapid materialized text markup color updates latest-wins without reload', () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        const comment = createComment('context-color-rapid');
        comment.subtype = 'Underline';
        comment.color = '#dc2626';
        viewer.updateTextMarkupAnnotationColor.mockReturnValue(false);
        deps.annotationContextMenu.value.comment = comment;

        actions.handleContextTextMarkupColorUpdate('#22c55e');
        deps.annotationContextMenu.value.comment = {
            ...comment,
            color: '#22c55e',
            colorEdited: true,
        };
        actions.handleContextTextMarkupColorUpdate('#2563eb');

        expect(deps.annotationContextMenu.value.comment?.color).toBe('#2563eb');
        expect(deps.loadPdfFromData).not.toHaveBeenCalled();
        expect(viewer.registerAnnotationHistoryCommand).toHaveBeenCalledTimes(2);
    });

    it('closes the context menu when free note placement fails', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        deps.annotationContextMenu.value.pageNumber = 1;
        deps.annotationContextMenu.value.pageX = 0.25;
        deps.annotationContextMenu.value.pageY = 0.5;
        viewer.commentAtPoint.mockRejectedValueOnce(new Error('stale editor'));

        await actions.createContextMenuFreeNote();

        expect(viewer.commentAtPoint).toHaveBeenCalledWith(
            1,
            0.25,
            0.5,
            { preferTextAnchor: false },
        );
        expect(deps.closeAnnotationContextMenu).toHaveBeenCalledOnce();
    });

    it('starts an image placement session from file without switching annotation tools', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        const {
            documentFiles,
            documentPicker,
            documentWorkingCopy,
        } = installSplitImagePickerPlatform('/tmp/test.png');

        await actions.insertImageFromFileAt(2, 0.25, 0.5);

        expect(deps.handleAnnotationToolChange).not.toHaveBeenCalledWith('stamp');
        expect(deps.annotationTool.value).toBe('highlight');
        expect(viewer.startImagePlacement).toHaveBeenCalledOnce();
        const placedFile = viewer.startImagePlacement.mock.calls[0]?.[0] as File;
        expect(placedFile.name).toBe('test.png');
        expect(placedFile.type).toBe('image/png');
        expect(Array.from(new Uint8Array(await placedFile.arrayBuffer()))).toEqual([
            1,
            2,
            3,
        ]);
        expect(viewer.startImagePlacement).toHaveBeenCalledWith(
            expect.any(File),
            {
                pageNumber: 2,
                pageX: 0.25,
                pageY: 0.5,
            },
        );
        expect(documentPicker.openImageDialog).toHaveBeenCalledOnce();
        expect(documentFiles.statFile).toHaveBeenCalledWith('/tmp/test.png');
        expect(documentFiles.readFile).toHaveBeenCalledWith('/tmp/test.png');
        expect(documentWorkingCopy.cleanupFile).not.toHaveBeenCalled();
    });

    it('reopens an app-owned image replacement with its persisted stamp identity', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        installSplitImagePickerPlatform('/tmp/replacement.png');
        deps.annotationContextMenu.value.comment = {
            ...createComment('reopened-image'),
            subtype: 'Stamp',
            annotationName: 'placed-image-app-1',
            annotationId: '44R',
            pageIndex: 6,
            pageNumber: 7,
            markerRect: {
                left: 0.2,
                top: 0.3,
                width: 0.4,
                height: 0.2,
            },
        };
        deps.annotationContextMenu.value.pageNumber = 7;
        deps.annotationContextMenu.value.pageX = 0.9;
        deps.annotationContextMenu.value.pageY = 0.9;

        await actions.insertContextMenuImageFromFile();

        expect(viewer.startImagePlacement).toHaveBeenCalledWith(
            expect.any(File),
            {
                pageNumber: 7,
                pageX: 0.4,
                pageY: 0.4,
                stableKey: 'placed-image-app-1',
                annotationId: '44R',
            },
        );
    });

    it('uses the viewer current page for clipboard placement when no explicit target is supplied', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        viewer.getCurrentPage.mockReturnValue(31);
        vi.stubGlobal('navigator', {clipboard: {read: vi.fn(async () => [{
            types: ['image/jpeg'],
            getType: vi.fn(async () => new Blob([Uint8Array.of(1, 2, 3)], {type: 'image/jpeg'})),
        }])}});

        await actions.pasteImageFromClipboardAt();

        expect(viewer.startImagePlacement).toHaveBeenCalledWith(
            expect.any(File),
            {pageNumber: 31},
        );
        expect(deps.closeAnnotationContextMenu).toHaveBeenCalledOnce();
    });

    it('contains image picker read failures without tearing down the document workspace', async () => {
        const {
            viewer,
            actions,
        } = createHarness();
        const {documentFiles} = installSplitImagePickerPlatform('/tmp/test.png');
        documentFiles.statFile.mockRejectedValueOnce(new Error('image read rejected'));

        await expect(actions.insertImageFromFileAt(2, 0.25, 0.5)).resolves.toBeUndefined();

        expect(viewer.startImagePlacement).not.toHaveBeenCalled();
    });

    it('cleans up browser image refs through the split working-copy capability', async () => {
        const {
            viewer,
            actions,
        } = createHarness();
        const imagePath = 'browser://documents/image-picker/test.webp';
        const {
            documentFiles,
            documentPicker,
            documentWorkingCopy,
        } = installSplitImagePickerPlatform(imagePath, { cleanupError: new Error('cleanup failed') });

        await expect(actions.insertImageFromFileAt(2, 0.25, 0.5)).resolves.toBeUndefined();

        expect(viewer.startImagePlacement).toHaveBeenCalledOnce();
        const placedFile = viewer.startImagePlacement.mock.calls[0]?.[0] as File;
        expect(placedFile.name).toBe('test.webp');
        expect(placedFile.type).toBe('image/webp');
        expect(documentPicker.openImageDialog).toHaveBeenCalledOnce();
        expect(documentFiles.statFile).toHaveBeenCalledWith(imagePath);
        expect(documentFiles.readFile).toHaveBeenCalledWith(imagePath);
        expect(documentWorkingCopy.cleanupFile).toHaveBeenCalledWith(imagePath);
    });

    it('finalizes a placed image by embedding it into the reloaded PDF', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        const finalized = await actions.handleFinalizePlacedImage(placedImagePayload(90));

        expect(finalized).toBe(true);
        expect(deps.embedPlacedImageToPage).toHaveBeenCalledWith(Uint8Array.of(6, 6), expect.objectContaining({
            pageNumber: 4,
            rotationDegrees: 90,
            targetPixelWidth: 240,
            targetPixelHeight: 120,
        }));
        expect(deps.waitForPdfReload).toHaveBeenCalledWith(4);
        expect(deps.loadPdfFromData).toHaveBeenCalledWith(Uint8Array.of(7, 7), {
            pushHistory: true,
            persistWorkingCopy: true,
        });
        expect(viewer.clearPendingImagePlacement).toHaveBeenCalledOnce();
        expect(viewer.saveDocument).not.toHaveBeenCalled();
    });

    it('reloads the working-copy path after native placed-image persistence', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        deps.workingCopyPath.value = '/tmp/work.pdf';
        deps.embedPlacedImageToPage.mockResolvedValueOnce({
            kind: 'native-path',
            path: '/tmp/work.pdf',
            revisionToken: requireDocumentRevisionToken('drt1:test:placed-image-native'),
        });

        const finalized = await actions.handleFinalizePlacedImage(placedImagePayload(90));

        expect(finalized).toBe(true);
        expect(deps.loadPdfFromPath).toHaveBeenCalledWith('/tmp/work.pdf', {markDirty: true});
        expect(deps.loadPdfFromData).not.toHaveBeenCalled();
        expect(viewer.clearPendingImagePlacement).toHaveBeenCalledOnce();
    });

    it('restores the image draft when native placement fails before reload', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        deps.workingCopyPath.value = '/tmp/work.pdf';
        deps.embedPlacedImageToPage.mockRejectedValueOnce(new Error('native placement failed'));

        await expect(actions.handleFinalizePlacedImage(placedImagePayload(90))).resolves.toBe(false);

        expect(viewer.restorePendingImagePlacement).toHaveBeenCalledOnce();
        expect(viewer.clearPendingImagePlacement).not.toHaveBeenCalled();
        expect(deps.loadPdfFromPath).not.toHaveBeenCalled();
        expect(deps.loadPdfFromData).not.toHaveBeenCalled();
    });

    it.each([
        {
            label: 'clean',
            pendingAnnotations: false,
        },
        {
            label: 'pending annotations',
            pendingAnnotations: true,
        },
    ])('keeps $label native placed-image finalization path-backed for large documents', async ({pendingAnnotations}) => {
        const {
            deps,
            actions,
        } = createHarness();
        deps.workingCopyPath.value = '/tmp/large-work.pdf';
        const appliedMutations: string[] = [];
        deps.saveAnnotationsForPageMutation.mockImplementationOnce(async () => {
            if (pendingAnnotations) {
                appliedMutations.push('annotations');
            }
            return true;
        });
        deps.embedPlacedImageToPage.mockImplementationOnce(async (data) => {
            expect(data).toBeNull();
            appliedMutations.push('placed-image');
            return {
                kind: 'native-path',
                path: '/tmp/large-work.pdf',
                revisionToken: requireDocumentRevisionToken('drt1:test:large-placed-image'),
            };
        });

        const finalized = await actions.handleFinalizePlacedImage(placedImagePayload(90));

        expect(finalized).toBe(true);
        expect(deps.saveAnnotationsForPageMutation).toHaveBeenCalledOnce();
        expect(deps.getEmbeddedMutationBaseData).not.toHaveBeenCalled();
        expect(deps.embedPlacedImageToPage).toHaveBeenCalledWith(null, expect.any(Object));
        expect(deps.loadPdfFromPath).toHaveBeenCalledWith('/tmp/large-work.pdf', {markDirty: true});
        expect(deps.loadPdfFromData).not.toHaveBeenCalled();
        expect(appliedMutations).toEqual(pendingAnnotations
            ? [
                'annotations',
                'placed-image',
            ]
            : ['placed-image']);
    });

    it('runs placed image working-copy writes through the document operation lease', async () => {
        const {
            deps,
            actions,
        } = createHarness();
        const leaseGate = Promise.withResolvers<undefined>();
        deps.runWithDocumentOperationLease.mockImplementationOnce(async <T>(
            kind: TDocumentOperationKind,
            operation: () => Promise<T>,
        ) => {
            expect(kind).toBe('page-operation');
            await leaseGate.promise;
            return operation();
        });

        const finalizePromise = actions.handleFinalizePlacedImage(placedImagePayload(90));
        await Promise.resolve();

        expect(deps.runWithDocumentOperationLease).toHaveBeenCalledWith('page-operation', expect.any(Function));
        expect(deps.getEmbeddedMutationBaseData).not.toHaveBeenCalled();
        expect(deps.loadPdfFromData).not.toHaveBeenCalled();

        leaseGate.resolve(undefined);
        await expect(finalizePromise).resolves.toBe(true);

        expect(deps.loadPdfFromData).toHaveBeenCalledWith(Uint8Array.of(7, 7), {
            pushHistory: true,
            persistWorkingCopy: true,
        });
    });

    it('clears pending image placement when finalization resolves after the working copy changes', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        deps.embedPlacedImageToPage.mockImplementationOnce(async () => {
            deps.workingCopyPath.value = 'browser://documents/other.pdf';
            return Uint8Array.of(7, 7);
        });

        const finalized = await actions.handleFinalizePlacedImage(placedImagePayload(0));

        expect(finalized).toBe(false);
        expect(viewer.clearPendingImagePlacement).toHaveBeenCalledOnce();
        expect(viewer.restorePendingImagePlacement).not.toHaveBeenCalled();
        expect(deps.loadPdfFromData).not.toHaveBeenCalled();
    });

    it('uses planned embedded mutation bytes before finalizing placed images', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        deps.getEmbeddedMutationBaseData.mockResolvedValueOnce(Uint8Array.of(9, 9));

        await actions.handleFinalizePlacedImage(placedImagePayload(0));

        expect(viewer.saveDocument).not.toHaveBeenCalled();
        expect(deps.embedPlacedImageToPage).toHaveBeenCalledWith(Uint8Array.of(9, 9), expect.any(Object));
    });

    it('serializes delete requests through a single queue', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        const commentA = createComment('a');
        const commentB = createComment('b');
        commentA.source = 'editor';
        commentB.source = 'editor';
        deps.annotationNoteWindows.value = [
            {
                annotationId: annotationIdForSummary(commentA),
                draftText: commentA.text,
            },
            {
                annotationId: annotationIdForSummary(commentB),
                draftText: commentB.text,
            },
        ];

        const gate = Promise.withResolvers<undefined>();
        const deleteOrder: string[] = [];
        viewer.deleteAnnotationComment.mockImplementation(async (comment: IAnnotationCommentSummary) => {
            deleteOrder.push(comment.stableKey);
            if (comment.stableKey === 'ann:0:a') {
                await gate.promise;
            }
            return true;
        });

        const deleteA = actions.handleDeleteAnnotationComment(commentA);
        const deleteB = actions.handleDeleteAnnotationComment(commentB);

        await waitForCondition(() => deleteOrder.length === 1);
        expect(deleteOrder).toEqual(['ann:0:a']);

        gate.resolve(undefined);
        await Promise.all([
            deleteA,
            deleteB,
        ]);

        expect(deleteOrder).toEqual([
            'ann:0:a',
            'ann:0:b',
        ]);
        expect(deps.removeAnnotationNoteWindow).toHaveBeenCalledWith('anno-a');
        expect(deps.removeAnnotationNoteWindow).toHaveBeenCalledWith('anno-b');
    });

    it('serializes repeated delete commands without a parallel pending-key authority', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        const comment = createComment('rapid-delete-note');
        comment.source = 'editor';
        deps.annotationNoteWindows.value = [{
            annotationId: annotationIdForSummary(comment),
            draftText: comment.text,
        }];
        const gate = Promise.withResolvers<boolean>();
        viewer.deleteAnnotationComment.mockImplementation(async () => gate.promise);

        const deleteA = actions.handleDeleteAnnotationComment(comment);
        const deleteB = actions.handleDeleteAnnotationComment(comment);

        await waitForCondition(() => viewer.deleteAnnotationComment.mock.calls.length === 1);
        gate.resolve(true);
        await Promise.all([
            deleteA,
            deleteB,
        ]);

        expect(viewer.deleteAnnotationComment).toHaveBeenCalledTimes(2);
        expect(deps.removeAnnotationNoteWindow).toHaveBeenCalledWith(comment.appAnnotationId);
    });

    it('uses the embedded delete path directly for PDF-backed highlights', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        const comment = createComment('editor-backed-highlight');
        comment.source = 'editor';
        comment.annotationId = '12R';
        comment.subtype = 'Highlight';

        await actions.handleDeleteAnnotationComment(comment);

        expect(viewer.deleteAnnotationComment).not.toHaveBeenCalled();
        expect(viewer.deleteAnnotationEditor).not.toHaveBeenCalled();
        expect(viewer.deleteReopenedEditorAnnotation).not.toHaveBeenCalled();
        expect(viewer.removeAnnotationFromDom).toHaveBeenCalledWith(comment);
        expect(viewer.removeAnnotationFromInternalCache).toHaveBeenCalledWith(comment.stableKey);
        expect(deps.invalidateThumbnailPages).toHaveBeenCalledWith([1]);
        expect(viewer.deleteEmbeddedAnnotationDeferred).toHaveBeenCalledWith(comment);
        expect(viewer.registerAnnotationHistoryCommand).not.toHaveBeenCalled();
    });

    it('uses the atomic reopened FreeText editor deletion transaction', async () => {
        const {
            viewer,
            actions,
        } = createHarness();
        const comment = createPdfFreeTextComment({
            annotationId: '44R',
            subtype: 'FreeText',
        });

        await actions.handleDeleteAnnotationComment(comment);

        expect(viewer.deleteReopenedEditorAnnotation).toHaveBeenCalledWith(comment);
        expect(viewer.deleteAnnotationEditor).not.toHaveBeenCalled();
        expect(viewer.deleteEmbeddedAnnotationDeferred).not.toHaveBeenCalled();
        expect(viewer.deleteAnnotationComment).not.toHaveBeenCalled();
        expect(viewer.removeAnnotationFromDom).toHaveBeenCalledWith(comment);
        expect(viewer.removeAnnotationFromInternalCache).toHaveBeenCalledWith(comment.stableKey);
    });

    it('falls back to the legacy live editor delete when the atomic API is unavailable', async () => {
        const {
            viewer,
            actions,
        } = createHarness();
        const events: string[] = [];
        const comment = createPdfFreeTextComment({
            annotationId: '44R',
            subtype: 'FreeText',
        });
        Reflect.deleteProperty(viewer, 'deleteReopenedEditorAnnotation');
        viewer.deleteAnnotationEditor.mockImplementationOnce(async () => {
            events.push('live-editor');
            return true;
        });
        viewer.deleteEmbeddedAnnotationDeferred.mockImplementationOnce(() => {
            events.push('canonical');
            return true;
        });

        await actions.handleDeleteAnnotationComment(comment);

        expect(events).toEqual([
            'live-editor',
            'canonical',
        ]);
        expect(viewer.deleteAnnotationEditor).toHaveBeenCalledWith(comment);
        expect(viewer.deleteEmbeddedAnnotationDeferred).toHaveBeenCalledWith(comment);
        expect(viewer.removeAnnotationFromDom).toHaveBeenCalledWith(comment);
        expect(viewer.removeAnnotationFromInternalCache).toHaveBeenCalledWith(comment.stableKey);
    });

    it.each([
        [
            'returns false',
            vi.fn(async () => false),
        ],
        [
            'throws',
            vi.fn(async () => { throw new Error('atomic delete failed'); }),
        ],
    ])('fails closed when reopened FreeText deletion %s', async (_label, deleteReopenedEditorAnnotation) => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        const comment = createPdfFreeTextComment({
            annotationId: '44R',
            subtype: 'FreeText',
        });
        viewer.deleteReopenedEditorAnnotation.mockImplementationOnce(deleteReopenedEditorAnnotation);

        await actions.handleDeleteAnnotationComment(comment);

        expect(viewer.deleteEmbeddedAnnotationDeferred).not.toHaveBeenCalled();
        expect(viewer.removeAnnotationFromDom).not.toHaveBeenCalled();
        expect(viewer.removeAnnotationFromInternalCache).not.toHaveBeenCalled();
        expect(deps.setAnnotationNoteWindowError).toHaveBeenCalled();
    });

    it('closes remaining note windows when an explicit delete drains the annotation cache', async () => {
        const {
            deps,
            actions,
        } = createHarness();
        const comment = createPdfFreeTextComment({
            text: 'orphan note text',
            markerRect: {
                left: 0.1,
                top: 0.1,
                width: 0.01,
                height: 0.01,
            },
        });
        const openNote = createEditorOpenNote(comment, {markerRect: {
            left: 0.8,
            top: 0.8,
            width: 0.01,
            height: 0.01,
        }});
        deps.getAnnotationCommentsSnapshot.mockReturnValue([comment]);
        deps.annotationNoteWindows.value = [{
            annotationId: annotationIdForSummary(openNote),
            draftText: openNote.text,
        }];
        deps.annotationActiveCommentStableKey.value = openNote.appAnnotationId ?? null;

        await actions.handleDeleteAnnotationComment(comment);

        expect(deps.removeAnnotationNoteWindow).toHaveBeenCalledWith(openNote.appAnnotationId);
        expect(deps.annotationActiveCommentStableKey.value).toBeNull();
    });

    it('closes a stale note window when a fast delete sees an already-empty ready cache', async () => {
        const {
            deps,
            actions,
        } = createHarness();
        const comment = createPdfFreeTextComment({ text: 'stale note text' });
        const openNote = createEditorOpenNote(comment);
        deps.getAnnotationCommentsSnapshot.mockReturnValue([]);
        deps.getAnnotationCommentsStatusSnapshot.mockReturnValue('ready');
        deps.annotationNoteWindows.value = [{
            annotationId: annotationIdForSummary(openNote),
            draftText: openNote.text,
        }];

        await actions.handleDeleteAnnotationComment(comment);

        expect(deps.removeAnnotationNoteWindow).toHaveBeenCalledWith(openNote.appAnnotationId);
    });

    it('closes a canonically matched note window during a loading sync gap', async () => {
        const {
            deps,
            actions,
        } = createHarness();
        const comment = createPdfFreeTextComment();
        const openNote = createEditorOpenNote(comment);
        deps.getAnnotationCommentsSnapshot.mockReturnValue([]);
        deps.getAnnotationCommentsStatusSnapshot.mockReturnValue('loading');
        deps.annotationNoteWindows.value = [{
            annotationId: annotationIdForSummary(openNote),
            draftText: openNote.text,
        }];

        await actions.handleDeleteAnnotationComment(comment);

        expect(deps.removeAnnotationNoteWindow).toHaveBeenCalledWith(openNote.appAnnotationId);
    });

    it('resolves embedded refs from stable keys before suppressing and queueing deletes', async () => {
        const {
            viewer,
            actions,
        } = createHarness();
        const comment = createComment('12R0');
        comment.source = 'editor';
        comment.annotationId = null;
        comment.subtype = 'Highlight';

        await actions.handleDeleteAnnotationComment(comment);

        expect(viewer.deleteAnnotationComment).not.toHaveBeenCalled();
        expect(viewer.deleteEmbeddedAnnotationDeferred).toHaveBeenCalledWith(expect.objectContaining({
            stableKey: comment.stableKey,
            annotationId: '12R',
        }));
        expect(viewer.removeAnnotationFromDom).toHaveBeenCalledWith(expect.objectContaining({ annotationId: '12R' }));
    });

    it('lets PDF.js own newly-created editor highlight deletes', async () => {
        const {
            viewer,
            actions,
        } = createHarness();
        const comment = createComment('new-editor-highlight');
        comment.source = 'editor';
        comment.annotationId = 'pdfjs_internal_editor_12';
        comment.subtype = 'Highlight';

        await actions.handleDeleteAnnotationComment(comment);

        expect(viewer.deleteAnnotationComment).toHaveBeenCalledWith(comment);
        expect(viewer.deleteEmbeddedAnnotationDeferred).not.toHaveBeenCalled();
    });

    it('lets the canonical viewer delete editor FreeText notes', async () => {
        const {
            viewer,
            actions,
        } = createHarness();
        const comment = createComment('pdfjs_internal_editor_0');
        comment.source = 'editor';
        comment.annotationId = 'pdfjs_internal_editor_0';
        comment.uid = 'pdfjs_internal_editor_0';
        comment.subtype = 'Typewriter';
        comment.hasNote = true;
        comment.markerRect = {
            left: 0.1,
            top: 0.2,
            width: 0.0016,
            height: 0.0016,
        };
        await actions.handleDeleteAnnotationComment(comment);

        expect(viewer.deleteAnnotationComment).toHaveBeenCalledWith(comment);
        expect(viewer.deleteEmbeddedAnnotationDeferred).not.toHaveBeenCalled();
    });

    it('lets the viewer own shape annotation deletes even when they have embedded refs', async () => {
        const {
            viewer,
            actions,
        } = createHarness();
        const comment = createComment('shape:0:evb-shape:embedded-rect');
        comment.source = 'shape';
        comment.annotationId = '12R';
        comment.subtype = 'Square';

        await actions.handleDeleteAnnotationComment(comment);

        expect(viewer.deleteAnnotationComment).toHaveBeenCalledWith(comment);
        expect(viewer.deleteEmbeddedAnnotationDeferred).not.toHaveBeenCalled();
    });

    it('does not invent an embedded delete when a runtime editor highlight cannot be deleted by PDF.js', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        const comment = createComment('new-editor-highlight-failed-delete');
        comment.source = 'editor';
        comment.annotationId = 'pdfjs_internal_editor_12';
        comment.subtype = 'Highlight';
        viewer.deleteAnnotationComment.mockResolvedValue(false);

        await actions.handleDeleteAnnotationComment(comment);

        expect(viewer.deleteAnnotationComment).toHaveBeenCalledWith(comment);
        expect(viewer.deleteEmbeddedAnnotationDeferred).not.toHaveBeenCalled();
        expect(deps.setAnnotationNoteWindowError).toHaveBeenCalledWith(
            comment.stableKey,
            'errors.annotation.delete',
        );
    });

    it('leaves deferred delete history to the canonical store', async () => {
        const {
            viewer,
            actions,
        } = createHarness();
        const comment = createComment('undoable-delete');
        comment.annotationId = '12R';
        viewer.deleteAnnotationComment.mockResolvedValue(false);

        await actions.handleDeleteAnnotationComment(comment);

        expect(viewer.deleteEmbeddedAnnotationDeferred).toHaveBeenCalledWith(comment);
        expect(viewer.registerAnnotationHistoryCommand).not.toHaveBeenCalled();
    });

    it('defers embedded stamp deletes and refreshes the hidden annotation page without reloading', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        const comment = createComment('stamp-delete');
        comment.source = 'editor';
        comment.annotationId = '12R';
        comment.subtype = 'Stamp';
        viewer.deleteAnnotationComment.mockResolvedValue(false);

        await actions.handleDeleteAnnotationComment(comment);

        expect(viewer.saveDocument).not.toHaveBeenCalled();
        expect(deps.loadPdfFromData).not.toHaveBeenCalled();
        expect(deps.waitForPdfReload).not.toHaveBeenCalled();
        expect(deps.getEmbeddedMutationBaseData).not.toHaveBeenCalled();
        expect(viewer.removeAnnotationFromDom).toHaveBeenCalledWith(comment);
        expect(viewer.deleteEmbeddedAnnotationDeferred).toHaveBeenCalledWith(comment);
        expect(viewer.registerAnnotationHistoryCommand).not.toHaveBeenCalled();
    });

    it('does not serialize planned embedded mutation bytes before embedded stamp delete save', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        deps.getEmbeddedMutationBaseData.mockResolvedValueOnce(Uint8Array.of(9, 9));
        const comment = createComment('stamp-delete-with-live-edits');
        comment.source = 'editor';
        comment.annotationId = '12R';
        comment.subtype = 'Stamp';
        viewer.deleteAnnotationComment.mockResolvedValue(false);

        await actions.handleDeleteAnnotationComment(comment);

        expect(viewer.saveDocument).not.toHaveBeenCalled();
        expect(deps.getEmbeddedMutationBaseData).not.toHaveBeenCalled();
        expect(deps.loadPdfFromData).not.toHaveBeenCalled();
        expect(viewer.deleteEmbeddedAnnotationDeferred).toHaveBeenCalledWith(comment);
    });

    it('marks embedded delete dirty when viewer delete could not resolve the note locally', async () => {
        const {
            viewer,
            actions,
        } = createHarness();
        const comment = createComment('queued-delete');
        viewer.deleteAnnotationComment.mockResolvedValue(false);

        await actions.handleDeleteAnnotationComment(comment);

        expect(viewer.deleteEmbeddedAnnotationDeferred).toHaveBeenCalledWith(comment);
    });

});
