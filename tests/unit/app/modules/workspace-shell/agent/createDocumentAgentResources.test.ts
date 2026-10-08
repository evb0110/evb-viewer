import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import type {
    IAnnotationCommentSummary,
    IAnnotationInventoryCompleteness,
    TAnnotationCommentsStatus,
} from '@app/types/annotations';
import type { IAnnotationNoteWindowViewModel } from '@app/types/annotationNoteWindow';
import type { TDocumentRef } from '@contracts/documentRef';
import { createDocumentAgentResources } from '@app/modules/workspace-shell/agent/createDocumentAgentResources';

function createResources(inventory: IAnnotationInventoryCompleteness | null, bookmarks: unknown[] = []) {
    return createDocumentAgentResources({
        annotationComments: ref<IAnnotationCommentSummary[]>([]),
        annotationCommentsStatus: ref<TAnnotationCommentsStatus>('ready'),
        annotationInventory: ref(inventory),
        annotationDirty: ref(false),
        canSave: ref(false),
        createAgentBookmarkSnapshot: () => ({
            bookmarks,
            count: bookmarks.length,
            dirty: false,
            flat: [],
            issues: [],
            summary: {},
        }),
        createAgentPageLabelSnapshot: () => ({}),
        currentPage: ref(1),
        hasPdf: ref(true),
        isAnySaving: ref(false),
        normalizeAgentAnnotationComment: vi.fn(() => ({})),
        originalPath: ref<TDocumentRef | null>(null),
        sortedAnnotationNoteWindows: ref<IAnnotationNoteWindowViewModel[]>([]),
        tabId: 'tab-1',
        totalPages: ref(3),
        workingCopyPath: ref<TDocumentRef | null>(null),
    });
}

describe('createDocumentAgentResources annotation inventory completeness', () => {
    it.each([
        'bookmarks',
        'toc',
    ])('returns the advertised %s tree without a second serialized alias', async (kind) => {
        const bookmarks = [{
            title: 'Chapter α',
            items: [{title: 'Child'}],
        }];
        const {readAgentResource} = createResources(null, bookmarks);
        const uri = `evb://document/tab-1/${kind}`;
        const resource = JSON.parse(JSON.stringify(await readAgentResource(uri)));
        expect(resource).toEqual({
            uri,
            tabId: 'tab-1',
            status: 'ready',
            schemaVersion: 2,
            treeField: kind,
            count: 1,
            dirty: false,
            flat: [],
            issues: [],
            summary: {},
            [kind]: bookmarks,
        });
    });

    it('marks status, annotation, and note resources as incomplete when the scan omitted pages', async () => {
        const { readAgentResource } = createResources({
            complete: false,
            omissions: ['page-parse-failure'],
            scannedPageCount: 2,
            totalPageCount: 3,
            failedPageCount: 1,
        });

        for (const kind of [
            'status',
            'annotations',
            'notes',
        ]) {
            // An automation client must not read a truncated listing as the
            // whole document.
            await expect(readAgentResource(`evb://document/tab-1/${kind}`)).resolves.toMatchObject({
                inventoryComplete: false,
                inventoryOmissions: ['page-parse-failure'],
                inventoryScannedPageCount: 2,
                inventoryTotalPageCount: 3,
                inventoryFailedPageCount: 1,
            });
        }
    });

    it('reports a complete scan and an unreported scan distinctly', async () => {
        const complete = createResources({
            complete: true,
            omissions: [],
            scannedPageCount: 3,
            totalPageCount: 3,
            failedPageCount: 0,
        });
        await expect(complete.readAgentResource('evb://document/tab-1/annotations'))
            .resolves.toMatchObject({ inventoryComplete: true });

        const unreported = createResources(null);
        await expect(unreported.readAgentResource('evb://document/tab-1/annotations'))
            .resolves.toMatchObject({ inventoryComplete: null });
    });
});
