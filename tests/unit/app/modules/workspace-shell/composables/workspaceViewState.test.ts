import {
    describe, expect, it, vi,
} from 'vitest';
import {ref} from 'vue';
import type {IDocumentNavigationRequest} from '@app/modules/document-viewer/public';
import {useWorkspaceViewState} from '@app/modules/workspace-shell/composables/useWorkspaceViewState';

function createState(overrides: Partial<Parameters<typeof useWorkspaceViewState>[0]> = {}) {
    return useWorkspaceViewState({
        fitMode: ref('width'),
        zoomMode: ref('fit-width'),
        zoom: ref(1),
        dragMode: ref(false),
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
        hasOpenAnnotationNotes: ref(false),
        canUndoHistory: ref(false),
        canRedoHistory: ref(false),
        currentPage: ref(1),
        totalPages: ref(10),
        documentViewerRef: ref({
            getViewerContainer: () => null,
            scrollToPage: vi.fn(),
        }),
        ...overrides,
    });
}

describe('useWorkspaceViewState', () => {
    it('publishes a complete navigation request through the shared owner', () => {
        const requestPageNavigation = vi.fn((request: IDocumentNavigationRequest) => {
            void request;
            return null;
        });
        const invalidateBookmarkNavigationRequests = vi.fn();
        const state = createState({
            requestPageNavigation,
            invalidateBookmarkNavigationRequests,
        });

        state.handleGoToPage(4, {navigationSource: 'thumbnail'});

        expect(requestPageNavigation).toHaveBeenCalledOnce();
        expect(requestPageNavigation.mock.calls[0]?.[0]).toMatchObject({
            source: 'thumbnail',
            target: {
                kind: 'page',
                page: 4,
            },
            supersession: 'latest-wins',
        });
        expect(invalidateBookmarkNavigationRequests).toHaveBeenCalledOnce();
    });

    it('keeps bookmark requests distinct and preserves their scroll options', () => {
        const requestPageNavigation = vi.fn((request: IDocumentNavigationRequest) => {
            void request;
            return null;
        });
        const state = createState({requestPageNavigation});

        state.handleGoToPage(7, {
            navigationSource: 'bookmark',
            pageYRatio: 0.25,
            preferExactDom: true,
        });

        expect(requestPageNavigation).toHaveBeenCalledWith(expect.objectContaining({
            source: 'bookmark',
            alignment: 'page-top',
            target: expect.objectContaining({
                kind: 'rect',
                page: 7,
                rect: {
                    left: 0.5,
                    top: 0.25,
                    width: 0,
                    height: 0,
                },
            }),
        }));
    });

    it('uses the legacy viewer fallback only when the shared owner is unavailable', () => {
        const scrollToPage = vi.fn();
        const state = createState({documentViewerRef: ref({
            getViewerContainer: () => null,
            scrollToPage,
        })});

        state.handleGoToPage(3);
        expect(scrollToPage).toHaveBeenCalledWith(3, undefined);
    });

    it('keeps fit changes as geometry work instead of cancelling navigation', async () => {
        const applyFitWidthToCurrentPage = vi.fn(async () => true);
        const state = createState({documentViewerRef: ref({
            getViewerContainer: () => null,
            scrollToPage: vi.fn(),
            getPendingNavigationTargetPage: () => 8,
            applyFitWidthToCurrentPage,
        })});

        state.handleFitMode('width');
        await Promise.resolve();
        expect(applyFitWidthToCurrentPage).toHaveBeenCalledWith({page: 8});
    });
});
