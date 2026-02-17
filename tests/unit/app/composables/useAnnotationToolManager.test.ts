import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ref,
    shallowRef,
    type ShallowRef,
} from 'vue';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type { IAnnotationSettings } from '@app/types/annotations';

function cast<T>(obj: unknown): T {
    return obj as T;
}

vi.mock('pdfjs-dist', () => ({
    AnnotationEditorType: {
        NONE: 0,
        FREETEXT: 1,
        INK: 2,
        STAMP: 3,
        POPUP: 4,
    },
    AnnotationEditorParamsType: {
        INK_COLOR: 1,
        INK_OPACITY: 2,
        INK_THICKNESS: 3,
        FREETEXT_COLOR: 4,
        FREETEXT_SIZE: 5,
    },
}));

type TUiManagerLike = {
    updateMode: ReturnType<typeof vi.fn>;
    waitForEditorsRendered: ReturnType<typeof vi.fn>;
    updateParams: ReturnType<typeof vi.fn>;
};

function createAnnotationSettings(): IAnnotationSettings {
    return {
        highlightColor: '#ffff00',
        highlightOpacity: 0.6,
        highlightThickness: 12,
        highlightFree: false,
        highlightShowAll: true,
        underlineColor: '#00ff00',
        underlineOpacity: 0.7,
        strikethroughColor: '#ff0000',
        strikethroughOpacity: 0.8,
        squigglyColor: '#0000ff',
        squigglyOpacity: 0.5,
        inkColor: '#111111',
        inkOpacity: 0.9,
        inkThickness: 2,
        textColor: '#222222',
        textSize: 14,
        shapeColor: '#333333',
        shapeFillColor: '#444444',
        shapeOpacity: 0.4,
        shapeStrokeWidth: 3,
    };
}

function createUiManager(overrides: Partial<TUiManagerLike> = {}) {
    return {
        updateMode: vi.fn(async (_mode: number) => {}),
        waitForEditorsRendered: vi.fn(async (_pageNumber: number) => {}),
        updateParams: vi.fn(),
        ...overrides,
    };
}

function mockUiManagerRef(uiManager: ReturnType<typeof createUiManager>) {
    return cast<ShallowRef<AnnotationEditorUIManager | null>>(shallowRef(uiManager));
}

describe('useAnnotationToolManager', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('retries mode switch once after waiting for editors', async () => {
        const { useAnnotationToolManager } = await import('@app/composables/pdf/useAnnotationToolManager');
        const firstError = new Error('mode not ready');
        const uiManager = createUiManager({updateMode: vi.fn()
            .mockRejectedValueOnce(firstError)
            .mockResolvedValueOnce(undefined)});

        const manager = useAnnotationToolManager({
            annotationUiManager: mockUiManagerRef(uiManager),
            currentPage: ref(3),
            annotationTool: ref('none'),
            annotationCursorMode: ref(false),
            annotationKeepActive: ref(false),
            freeTextResize: {patchResizableFreeTextEditors: vi.fn()} as never,
            markupSubtype: {
                applyHighlightParamsForTool: vi.fn(),
                syncMarkupSubtypePresentationForEditors: vi.fn(),
            } as never,
            emitAnnotationToolAutoReset: vi.fn(),
        });

        const expectedMode = manager.getAnnotationMode('text');
        const result = await manager.updateModeWithRetry(uiManager as never, expectedMode, 3);
        expect(result).toBeNull();
        expect(uiManager.updateMode).toHaveBeenCalledTimes(2);
        expect(uiManager.waitForEditorsRendered).toHaveBeenCalledWith(3);
    });

    it('returns retry error when second mode switch fails', async () => {
        const { useAnnotationToolManager } = await import('@app/composables/pdf/useAnnotationToolManager');
        const retryError = new Error('still failing');
        const uiManager = createUiManager({
            updateMode: vi.fn()
                .mockRejectedValueOnce(new Error('initial failure'))
                .mockRejectedValueOnce(retryError),
            waitForEditorsRendered: vi.fn(async () => {
                throw new Error('wait failed');
            }),
        });

        const manager = useAnnotationToolManager({
            annotationUiManager: mockUiManagerRef(uiManager),
            currentPage: ref(1),
            annotationTool: ref('none'),
            annotationCursorMode: ref(false),
            annotationKeepActive: ref(false),
            freeTextResize: {patchResizableFreeTextEditors: vi.fn()} as never,
            markupSubtype: {
                applyHighlightParamsForTool: vi.fn(),
                syncMarkupSubtypePresentationForEditors: vi.fn(),
            } as never,
            emitAnnotationToolAutoReset: vi.fn(),
        });

        const expectedMode = manager.getAnnotationMode('draw');
        const result = await manager.updateModeWithRetry(uiManager as never, expectedMode, 1);
        expect(result).toBe(retryError);
    });

    it('serializes rapid tool changes and applies only latest pending mode', async () => {
        const { useAnnotationToolManager } = await import('@app/composables/pdf/useAnnotationToolManager');
        const uiManager = createUiManager();
        const applyHighlightParamsForTool = vi.fn();
        const syncMarkupSubtypePresentationForEditors = vi.fn();
        const patchResizableFreeTextEditors = vi.fn();

        const manager = useAnnotationToolManager({
            annotationUiManager: mockUiManagerRef(uiManager),
            currentPage: ref(1),
            annotationTool: ref('none'),
            annotationCursorMode: ref(false),
            annotationKeepActive: ref(false),
            freeTextResize: {patchResizableFreeTextEditors} as never,
            markupSubtype: {
                applyHighlightParamsForTool,
                syncMarkupSubtypePresentationForEditors,
            } as never,
            emitAnnotationToolAutoReset: vi.fn(),
        });

        manager.applyAnnotationSettings(createAnnotationSettings());
        await Promise.all([
            manager.setAnnotationTool('text'),
            manager.setAnnotationTool('draw'),
        ]);

        expect(uiManager.updateMode).toHaveBeenCalledTimes(1);
        expect(uiManager.updateMode).toHaveBeenCalledWith(manager.getAnnotationMode('draw'));
        expect(applyHighlightParamsForTool).toHaveBeenCalled();
        expect(patchResizableFreeTextEditors).toHaveBeenCalled();
        expect(syncMarkupSubtypePresentationForEditors).toHaveBeenCalled();
    });

    it('auto-resets tool when keep-active is disabled', async () => {
        const { useAnnotationToolManager } = await import('@app/composables/pdf/useAnnotationToolManager');
        const emitAnnotationToolAutoReset = vi.fn();
        const manager = useAnnotationToolManager({
            annotationUiManager: mockUiManagerRef(createUiManager()),
            currentPage: ref(1),
            annotationTool: ref('text'),
            annotationCursorMode: ref(false),
            annotationKeepActive: ref(false),
            freeTextResize: {patchResizableFreeTextEditors: vi.fn()} as never,
            markupSubtype: {
                applyHighlightParamsForTool: vi.fn(),
                syncMarkupSubtypePresentationForEditors: vi.fn(),
            } as never,
            emitAnnotationToolAutoReset,
        });

        manager.maybeAutoResetAnnotationTool();
        await Promise.resolve();

        expect(emitAnnotationToolAutoReset).toHaveBeenCalledTimes(1);
    });
});
