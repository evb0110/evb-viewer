// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { nextTick } from 'vue';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import {
    mountAnnotationCommentsList,
    unmountAnnotationCommentsLists,
} from '@tests/helpers/pdfAnnotationCommentsListHarness';

vi.mock('@app/composables/useTypedI18n', () => ({useTypedI18n: () => ({t: (key: string) => key})}));

afterEach(() => {
    unmountAnnotationCommentsLists();
});

function createForeignNote(): IAnnotationCommentSummary {
    return {
        annotationId: '12 0 R',
        author: 'Document author',
        color: '#f59e0b',
        createdAt: 1_700_000_000_000,
        hasNote: true,
        id: '12R0',
        markerRect: {
            left: 0.2,
            top: 0.3,
            width: 0.04,
            height: 0.04,
        },
        modifiedAt: 1_700_000_000_001,
        pageIndex: 0,
        pageNumber: 1,
        replies: [
            {
                author: 'Reviewer',
                contents: 'Please check the cited paragraph.',
                createdAt: 1_700_000_000_002,
                generationNumber: 0,
                modifiedAt: 1_700_000_000_002,
                objectNumber: 13,
            },
            {
                author: null,
                contents: 'Second reply remains readable and has no editing control.',
                createdAt: null,
                generationNumber: 0,
                modifiedAt: null,
                objectNumber: 14,
            },
        ],
        source: 'pdf',
        stableKey: 'ann:0:12R0',
        subtype: 'Text',
        text: 'Original foreign note',
        uid: null,
    };
}

describe('PdfAnnotationCommentsList foreign note replies', () => {
    it('renders replies as read-only children and deletes them with their parent', async () => {
        const comment = createForeignNote();
        const {
            events,
            host,
        } = mountAnnotationCommentsList({comments: [comment]});
        await nextTick();
        const row = host.querySelector<HTMLElement>('.note-item');

        expect(row).not.toBeNull();
        expect(row?.querySelector('.note-item-content')?.tagName).toBe('BUTTON');
        expect(row?.querySelector('.note-item-replies')?.textContent)
            .toContain('Please check the cited paragraph.');
        expect(row?.querySelector('.note-item-replies')?.textContent)
            .toContain('Second reply remains readable and has no editing control.');
        expect(row?.querySelectorAll('.note-item-reply')).toHaveLength(2);
        expect(row?.querySelector('.note-item-replies button')).toBeNull();

        row?.querySelector<HTMLButtonElement>('.note-item-delete')?.click();

        expect(events.deleted).toStrictEqual([comment]);
    });
});
