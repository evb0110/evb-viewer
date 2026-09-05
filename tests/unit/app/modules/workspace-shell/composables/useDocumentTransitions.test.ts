import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    nextTick,
    ref,
    shallowRef,
} from 'vue';
import { useDocumentTransitions } from '@app/modules/workspace-shell/composables/useDocumentTransitions';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { TPdfSource } from '@app/types/pdfUi';

function createDeps() {
    return {
        pdfSrc: ref<TPdfSource | null>({} as TPdfSource),
        workingCopyPath: ref('/tmp/test.pdf'),
        isDjvuMode: ref(false),
        djvuSourcePath: ref<string | null>(null),
        pdfError: ref<unknown>(null),
        currentPage: ref(7),
        totalPages: ref(23),
        pdfDocument: shallowRef<unknown | null>({ id: 'doc' }),
        dragMode: ref(false),
        showSidebar: ref(false),
        sidebarTab: ref<'annotations' | 'thumbnails' | 'bookmarks' | 'search'>('thumbnails'),
        annotationTool: ref<'none'>('none'),
        annotationComments: ref<IAnnotationCommentSummary[]>([{
            id: 'note-1',
            stableKey: 'ann:0:note-1',
            pageIndex: 0,
            pageNumber: 1,
            text: 'Note',
            author: null,
            modifiedAt: null,
            color: null,
            uid: null,
            annotationId: null,
            source: 'pdf' as const,
        }]),
        markAnnotationCommentsLoading: vi.fn(),
        clearAnnotationComments: vi.fn(),
        annotationActiveCommentStableKey: ref<string | null>('note-1'),
        annotationEditorState: ref({
            isEditing: true,
            isEmpty: false,
            hasSomethingToUndo: true,
            hasSomethingToRedo: true,
            hasSelectedEditor: true,
        }),
        bookmarkItems: ref([{}]),
        bookmarksDirty: ref(true),
        bookmarkEditMode: ref(true),
        pageLabels: ref<string[] | null>(['1']),
        pageLabelRanges: ref([{}]),
        pageLabelsDirty: ref(true),
        pdfViewerRef: ref({clearShapes: vi.fn()}),
        resetAnnotationTracking: vi.fn(),
        resetSearchCache: vi.fn(),
        closeSearch: vi.fn(),
        closeAnnotationContextMenu: vi.fn(),
        closePageContextMenu: vi.fn(),
        closeAllAnnotationNotes: vi.fn(async () => true),
        loadRecentFiles: vi.fn(),
    };
}

describe('useDocumentTransitions', () => {
    it('clears viewer page state when the document unloads', async () => {
        const deps = createDeps();
        deps.showSidebar.value = true;

        useDocumentTransitions(deps);

        deps.pdfSrc.value = null;
        await nextTick();

        expect(deps.currentPage.value).toBe(1);
        expect(deps.totalPages.value).toBe(0);
        expect(deps.pdfDocument.value).toBeNull();
        expect(deps.showSidebar.value).toBe(false);
        expect(deps.clearAnnotationComments).toHaveBeenCalledOnce();
    });

    it('marks annotation comments loading and keeps existing comments during source reload', async () => {
        const deps = createDeps();
        const previousComments = deps.annotationComments.value;

        useDocumentTransitions(deps);

        deps.pdfSrc.value = {} as TPdfSource;
        await nextTick();

        expect(deps.markAnnotationCommentsLoading).toHaveBeenCalledOnce();
        expect(deps.clearAnnotationComments).not.toHaveBeenCalled();
        expect(deps.annotationComments.value).toBe(previousComments);
    });

    it('keeps preserved bookmark metadata during source reloads', async () => {
        const deps = {
            ...createDeps(),
            consumePreservedSourceReloadMetadata: vi.fn(() => true),
        };
        const previousBookmarks = deps.bookmarkItems.value;

        useDocumentTransitions(deps);

        deps.pdfSrc.value = {} as TPdfSource;
        await nextTick();

        expect(deps.consumePreservedSourceReloadMetadata).toHaveBeenCalledOnce();
        expect(deps.bookmarkItems.value).toBe(previousBookmarks);
        expect(deps.bookmarksDirty.value).toBe(true);
    });

    it('refreshes recent files when the open document changes without unloading first', async () => {
        const deps = createDeps();

        useDocumentTransitions(deps);

        deps.workingCopyPath.value = '/tmp/next.pdf';
        deps.pdfSrc.value = {} as TPdfSource;
        await nextTick();

        expect(deps.loadRecentFiles).toHaveBeenCalledOnce();
    });

    it('refreshes recent files when DjVu mode opens a source document', async () => {
        const deps = createDeps();

        useDocumentTransitions(deps);

        deps.isDjvuMode.value = true;
        deps.djvuSourcePath.value = 'browser://documents/source/test.djvu';
        await nextTick();

        expect(deps.loadRecentFiles).toHaveBeenCalledOnce();
    });
});
