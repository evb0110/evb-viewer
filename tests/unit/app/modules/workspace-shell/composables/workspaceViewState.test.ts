import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    nextTick,
    ref,
} from 'vue';
import { useWorkspaceViewState } from '@app/modules/workspace-shell/composables/useWorkspaceViewState';

function createState(options?: {
    dragMode?: boolean;
    hasOpenAnnotationNotes?: boolean;
    overrides?: Partial<Parameters<typeof useWorkspaceViewState>[0]>;
}) {
    return useWorkspaceViewState({
        fitMode: ref('width'),
        zoomMode: ref('fit-width'),
        zoom: ref(1),
        dragMode: ref(
            options?.dragMode ?? false,
        ),
        showSidebar: ref(false),
        sidebarTab: ref('thumbnails'),
        annotationTool: ref('none'),
        annotationEditorState: ref({
            isEditing: false,
            isEmpty: true,
            hasSomethingToUndo: false,
            hasSomethingToRedo: false,
            hasSelectedEditor: false,
        }),
        appAnnotationUndoDepth: ref(0),
        hasOpenAnnotationNotes: ref(options?.hasOpenAnnotationNotes ?? false),
        canUndoHistory: ref(false),
        canRedoHistory: ref(false),
        currentPage: ref(1),
        totalPages: ref(1),
        documentViewerRef: ref({
            getViewerContainer: () => null,
            scrollToPage: () => {},
        }),
        ...options?.overrides,
    });
}

describe('useWorkspaceViewState', () => {
    it('arms the navigation fence with the source that requested the page', () => {
        const beginProgrammaticPageNavigation = vi.fn();
        const state = createState({overrides: {
            totalPages: ref(10),
            beginProgrammaticPageNavigation,
        }});

        state.handleGoToPage(4, {navigationSource: 'thumbnail'});
        expect(beginProgrammaticPageNavigation).toHaveBeenLastCalledWith(4, 'thumbnail');

        state.handleGoToPage(5);
        expect(beginProgrammaticPageNavigation).toHaveBeenLastCalledWith(5, null);
    });

    it('preserves the latest of five immediate Recent-open page requests before metadata and viewer mount', () => {
        const scrollToPage = vi.fn();
        const beginProgrammaticPageNavigation = vi.fn();
        const requestPageNavigation = vi.fn((page: number) => page);
        const documentViewerRef = ref<Parameters<typeof useWorkspaceViewState>[0]['documentViewerRef']['value']>(null);
        const state = createState({overrides: {
            totalPages: ref(0),
            beginProgrammaticPageNavigation,
            requestPageNavigation,
            documentViewerRef,
        }});

        for (let page = 2; page <= 6; page += 1) {
            state.handleGoToPage(page);
        }

        expect(beginProgrammaticPageNavigation).toHaveBeenCalledTimes(5);
        expect(beginProgrammaticPageNavigation).toHaveBeenLastCalledWith(6, null);
        expect(requestPageNavigation).toHaveBeenCalledTimes(5);
        expect(requestPageNavigation).toHaveBeenLastCalledWith(6);
        expect(scrollToPage).not.toHaveBeenCalled();

        documentViewerRef.value = {
            getViewerContainer: () => null,
            scrollToPage,
        };

        expect(scrollToPage).toHaveBeenCalledOnce();
        expect(scrollToPage).toHaveBeenCalledWith(6, undefined);
    });

    it('marks fit width active at zoom 1', () => {
        const state = createState();
        expect(state.isFitWidthActive.value).toBe(true);
        expect(state.isFitHeightActive.value).toBe(false);
    });

    it('resets zoom when fit mode changes via helper', () => {
        const state = createState();
        state.handleFitMode('height');

        expect(state.isFitHeightActive.value).toBe(true);
        expect(state.isFitWidthActive.value).toBe(false);
    });

    it('preserves viewport navigation authority while changing fit mode', () => {
        const cancelProgrammaticNavigation = vi.fn();
        const state = createState({overrides: {documentViewerRef: ref({
            getViewerContainer: () => null,
            scrollToPage: () => {},
            cancelProgrammaticNavigation,
        })}});

        state.handleFitMode('height');

        expect(cancelProgrammaticNavigation).not.toHaveBeenCalled();
    });

    it('contains fit-width apply failures after mode state changes', async () => {
        const applyFitWidthToCurrentPage = vi.fn(async () => {
            throw new Error('fit failed');
        });
        const state = createState({overrides: {
            fitMode: ref('height'),
            zoomMode: ref('fit-height'),
            zoom: ref(2),
            documentViewerRef: ref({
                getViewerContainer: () => null,
                scrollToPage: () => {},
                applyFitWidthToCurrentPage,
            }),
        }});

        state.handleFitMode('width');
        await nextTick();
        await Promise.resolve();

        expect(state.isFitWidthActive.value).toBe(true);
        expect(applyFitWidthToCurrentPage).toHaveBeenCalledOnce();
    });

    it('disables annotation cursor when drag mode is enabled', () => {
        const state = createState({ dragMode: true });
        expect(state.annotationCursorMode.value).toBe(false);
    });

    it('keeps annotation cursor enabled for open note windows in drag mode', () => {
        const state = createState({
            dragMode: true,
            hasOpenAnnotationNotes: true,
        });
        expect(state.annotationCursorMode.value).toBe(true);
    });

    it('keeps annotation cursor enabled outside hand-tool mode', () => {
        const state = createState();
        expect(state.annotationCursorMode.value).toBe(true);
    });

    it('enables annotation undo for app-managed annotation commands', () => {
        const appAnnotationUndoDepth = ref(1);
        const state = createState({overrides: {appAnnotationUndoDepth}});

        expect(state.isAnnotationUndoContext.value).toBe(true);
        expect(state.canUndoAnnotation.value).toBe(true);
        expect(state.canUndo.value).toBe(false);

        appAnnotationUndoDepth.value = 0;
        expect(state.canUndoAnnotation.value).toBe(false);
    });

    it('ignores stale PDF.js annotation undo state when file history can undo', () => {
        const state = createState({overrides: {
            sidebarTab: ref('annotations'),
            annotationEditorState: ref({
                isEditing: false,
                isEmpty: false,
                hasSomethingToUndo: true,
                hasSomethingToRedo: false,
                hasSelectedEditor: false,
            }),
            canUndoHistory: ref(true),
        }});

        expect(state.isAnnotationUndoContext.value).toBe(false);
        expect(state.canUndoAnnotation.value).toBe(false);
        expect(state.canUndo.value).toBe(true);
    });

    it('keeps document undo available while an annotation tool is active', () => {
        const state = createState({overrides: {
            sidebarTab: ref('annotations'),
            annotationTool: ref('highlight'),
            canUndoHistory: ref(true),
            canRedoHistory: ref(true),
        }});

        expect(state.isAnnotationUndoContext.value).toBe(true);
        expect(state.canUndoAnnotation.value).toBe(false);
        expect(state.canRedoAnnotation.value).toBe(false);
        expect(state.canUndo.value).toBe(true);
        expect(state.canRedo.value).toBe(true);
    });

    it('enables app-routed PDF.js annotation undo before live dirty detection catches up', () => {
        const state = createState({overrides: {
            sidebarTab: ref('annotations'),
            annotationEditorState: ref({
                isEditing: false,
                isEmpty: false,
                hasSomethingToUndo: true,
                hasSomethingToRedo: false,
                hasSelectedEditor: false,
                hasAppAnnotationUndoHistory: true,
            }),
        }});

        expect(state.isAnnotationUndoContext.value).toBe(true);
        expect(state.canUndoAnnotation.value).toBe(true);
        expect(state.canUndo.value).toBe(false);
    });

    it('scrolls to an explicit bookmark target even when the page is already current', () => {
        const requestPageNavigation = vi.fn();
        const scrollToPage = vi.fn();
        const state = createState({overrides: {
            showSidebar: ref(true),
            sidebarTab: ref('bookmarks'),
            currentPage: ref(3),
            totalPages: ref(10),
            requestPageNavigation,
            documentViewerRef: ref({
                getViewerContainer: () => null,
                scrollToPage,
            }),
        }});
        const scrollOptions = {pageYRatio: 0};

        state.handleGoToPage(3, scrollOptions);

        expect(scrollToPage).toHaveBeenCalledWith(3, scrollOptions);
        expect(requestPageNavigation).not.toHaveBeenCalled();
    });

    it('forwards a same-page command so an evicted current canvas can recover', () => {
        const beginProgrammaticPageNavigation = vi.fn();
        const scrollToPage = vi.fn();
        const state = createState({overrides: {
            currentPage: ref(3),
            totalPages: ref(10),
            beginProgrammaticPageNavigation,
            documentViewerRef: ref({
                getViewerContainer: () => null,
                scrollToPage,
            }),
        }});

        state.handleGoToPage(3);

        expect(beginProgrammaticPageNavigation).toHaveBeenCalledWith(3, null);
        expect(scrollToPage).toHaveBeenCalledWith(3, undefined);
    });

    it('forwards a same-page request when it cancels a conflicting pending viewer target', () => {
        const beginProgrammaticPageNavigation = vi.fn();
        const invalidateBookmarkNavigationRequests = vi.fn();
        const scrollToPage = vi.fn();
        const state = createState({overrides: {
            fitMode: ref('height'),
            zoomMode: ref('fit-height'),
            totalPages: ref(10),
            beginProgrammaticPageNavigation,
            invalidateBookmarkNavigationRequests,
            documentViewerRef: ref({
                getViewerContainer: () => null,
                scrollToPage,
                getPendingNavigationTargetPage: () => 6,
            }),
        }});

        state.handleGoToPage(1);

        expect(invalidateBookmarkNavigationRequests).toHaveBeenCalledOnce();
        expect(beginProgrammaticPageNavigation).toHaveBeenCalledWith(1, null);
        expect(scrollToPage).toHaveBeenCalledWith(1, undefined);
    });

    it('preserves bookmark replay intent for bookmark-originated page requests', () => {
        const beginProgrammaticPageNavigation = vi.fn();
        const invalidateBookmarkNavigationRequests = vi.fn();
        const scrollToPage = vi.fn();
        const state = createState({overrides: {
            fitMode: ref('height'),
            zoomMode: ref('fit-height'),
            sidebarTab: ref('bookmarks'),
            totalPages: ref(10),
            beginProgrammaticPageNavigation,
            invalidateBookmarkNavigationRequests,
            documentViewerRef: ref({
                getViewerContainer: () => null,
                scrollToPage,
            }),
        }});
        const options = {
            navigationSource: 'bookmark' as const,
            pageYRatio: 0.25,
            preferExactDom: true,
        };

        state.handleGoToPage(4, options);

        expect(invalidateBookmarkNavigationRequests).not.toHaveBeenCalled();
        expect(beginProgrammaticPageNavigation).toHaveBeenCalledWith(4, 'bookmark');
        expect(scrollToPage).toHaveBeenCalledWith(4, options);
    });
});
