import {
    describe,
    expect,
    it,
} from 'vitest';
import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import {requirePageIndex} from '@contracts/pageNumbers';
import {
    createAgentPageLabelPlan,
    createAgentPageLabelSnapshot,
} from '@app/modules/workspace-shell/agent/createDocumentAgentPageLabels';
import {
    createAgentBookmarkPlan,
    createAgentBookmarkSnapshot,
} from '@app/modules/workspace-shell/agent/createDocumentAgentBookmarks';

const DEFAULT_RANGES = [{
    startPage: 1,
    style: 'D' as const,
    prefix: '',
    startNumber: 1,
}];

function bookmark(overrides: Partial<IPdfBookmarkEntry>): IPdfBookmarkEntry {
    return {
        title: 'Bookmark',
        pageIndex: requirePageIndex(0),
        namedDest: null,
        bold: false,
        italic: false,
        color: null,
        items: [],
        ...overrides,
    };
}

describe('agentMetadataPlans', () => {
    it('keeps nested bookmark depths equal to the flat view and summary maximum', () => {
        const snapshot = createAgentBookmarkSnapshot([
            bookmark({
                title: 'Parent',
                items: [bookmark({
                    title: 'Child',
                    items: [bookmark({title: 'Grandchild'})],
                })],
            }),
            bookmark({title: 'Other root'}),
        ], {dirty: false});
        const nestedEntries: Array<{
            path: unknown;
            depth: unknown
        }> = [];
        const visit = (entries: Array<Record<string, unknown>>) => {
            for (const entry of entries) {
                nestedEntries.push({
                    path: entry.path,
                    depth: entry.depth,
                });
                visit(entry.items as Array<Record<string, unknown>>);
            }
        };
        visit(snapshot.bookmarks);

        expect(nestedEntries).toEqual(snapshot.flat.map(({
            path, depth,
        }) => ({
            path,
            depth,
        })));
        expect(nestedEntries.map(entry => entry.depth)).toEqual([
            0,
            1,
            2,
            0,
        ]);
        expect(snapshot.summary.maxDepth).toBe(2);
        expect(snapshot.summary.maxDepth).toBe(Math.max(...nestedEntries.map(entry => Number(entry.depth))));
    });

    it('previews page numbering from inclusive segments with samples and diffs', () => {
        const plan = createAgentPageLabelPlan({
            input: {
                base: 'default',
                segments: [
                    {
                        startPage: 1,
                        endPage: 3,
                        style: 'roman-lower',
                        startNumber: 1,
                    },
                    {
                        startPage: 4,
                        endPage: 8,
                        style: 'decimal',
                        startNumber: 4,
                    },
                ],
            },
            totalPages: 8,
            currentRanges: DEFAULT_RANGES,
            currentLabels: null,
            dirty: false,
            actionId: 'page_labels.preview',
        });

        expect(plan.inputMode).toBe('segments');
        expect(plan.ranges).toEqual([
            {
                startPage: 1,
                style: 'r',
                prefix: '',
                startNumber: 1,
            },
            {
                startPage: 4,
                style: 'D',
                prefix: '',
                startNumber: 4,
            },
        ]);
        expect(plan.diff).toMatchObject({
            wouldChange: true,
            changedPageCount: 3,
            firstChangedPage: 1,
            lastChangedPage: 3,
        });
        expect(plan.proposed.segments).toEqual([
            expect.objectContaining({
                startPage: 1,
                endPage: 3,
                startLabel: 'i',
                endLabel: 'iii',
            }),
            expect.objectContaining({
                startPage: 4,
                endPage: 8,
                startLabel: '4',
                endLabel: '8',
            }),
        ]);
        expect(plan.proposed.samples).toContainEqual({
            page: 3,
            label: 'iii',
        });
    });

    it('returns page-label snapshot summaries and repeated literal hints', () => {
        const snapshot = createAgentPageLabelSnapshot({
            totalPages: 3,
            dirty: true,
            pageLabelRanges: [{
                startPage: 1,
                style: null,
                prefix: 'Cover',
                startNumber: 1,
            }],
            pageLabels: null,
        });

        expect(snapshot).toMatchObject({
            dirty: true,
            isDefault: false,
            summary: {
                rangeCount: 1,
                duplicateLabelCount: 1,
            },
        });
        expect(snapshot.issues).toEqual(expect.arrayContaining([expect.objectContaining({code: 'repeated_literal_label_range'})]));
    });

    it('keeps million-page agent plans range-based and reports a bounded diff', () => {
        const totalPages = 1_000_000;
        const plan = createAgentPageLabelPlan({
            input: {segments: [{
                startPage: 400_000,
                endPage: 400_010,
                style: 'roman-lower',
                prefix: 'Section ',
                startNumber: 1,
            }]},
            totalPages,
            currentRanges: DEFAULT_RANGES,
            currentLabels: null,
            dirty: false,
            actionId: 'page_labels.preview',
        });

        expect(plan.proposed.labels).toBeNull();
        expect(plan.ranges).toHaveLength(3);
        expect(plan.proposed.summary.firstLabel).toBe('1');
        expect(plan.proposed.summary.lastLabel).toBe(String(totalPages));
        expect(plan.diff).toMatchObject({
            wouldChange: true,
            changedPageCount: 11,
            firstChangedPage: 400_000,
            lastChangedPage: 400_010,
        });
        expect(plan.proposed.segments).toEqual(expect.arrayContaining([expect.objectContaining({
            startPage: 400_000,
            endPage: 400_010,
            startLabel: 'Section i',
            endLabel: 'Section xi',
        })]));
    });

    it('keeps the small agent snapshot labels exactly compatible with ranges', () => {
        const snapshot = createAgentPageLabelSnapshot({
            totalPages: 8,
            dirty: false,
            pageLabelRanges: [
                {
                    startPage: 1,
                    style: 'r',
                    prefix: 'Front ',
                    startNumber: 1,
                },
                {
                    startPage: 4,
                    style: 'D',
                    prefix: 'Body ',
                    startNumber: 1,
                },
            ],
            pageLabels: null,
        });

        expect(snapshot.labels).toEqual([
            'Front i',
            'Front ii',
            'Front iii',
            'Body 1',
            'Body 2',
            'Body 3',
            'Body 4',
            'Body 5',
        ]);
        expect(snapshot.segments).toEqual([
            expect.objectContaining({
                startPage: 1,
                endPage: 3,
                startLabel: 'Front i',
                endLabel: 'Front iii',
            }),
            expect.objectContaining({
                startPage: 4,
                endPage: 8,
                startLabel: 'Body 1',
                endLabel: 'Body 5',
            }),
        ]);
    });

    it('previews nested bookmarks from flat outline entries', () => {
        const plan = createAgentBookmarkPlan({
            input: {entries: [
                {
                    level: 1,
                    title: 'Introduction',
                    page: 1,
                },
                {
                    level: 2,
                    title: 'Scope',
                    page: 2,
                },
                {
                    level: 1,
                    title: 'Chapter 1',
                    page: 5,
                    bold: true,
                },
            ]},
            currentBookmarks: [],
            totalPages: 8,
            dirty: false,
            untitledTitle: 'Untitled',
            actionId: 'bookmarks.preview_tree',
        });

        expect(plan.inputMode).toBe('flat');
        expect(plan.bookmarks).toEqual([
            expect.objectContaining({
                title: 'Introduction',
                pageIndex: requirePageIndex(0),
                items: [expect.objectContaining({
                    title: 'Scope',
                    pageIndex: 1,
                })],
            }),
            expect.objectContaining({
                title: 'Chapter 1',
                pageIndex: 4,
                bold: true,
            }),
        ]);
        expect(plan.diff).toMatchObject({
            wouldChange: true,
            addedCount: 3,
            removedCount: 0,
            updatedCount: 0,
        });
        expect(plan.proposed.flat).toEqual([
            expect.objectContaining({
                path: [0],
                depth: 0,
                title: 'Introduction',
            }),
            expect.objectContaining({
                path: [
                    0,
                    0,
                ],
                depth: 1,
                title: 'Scope',
            }),
            expect.objectContaining({
                path: [1],
                depth: 0,
                title: 'Chapter 1',
            }),
        ]);
    });

    it('accepts children as a nested bookmark alias', () => {
        const plan = createAgentBookmarkPlan({
            input: {bookmarks: [{
                title: 'Part I',
                page: 1,
                children: [{
                    title: 'Chapter 1',
                    page: 2,
                }],
            }]},
            currentBookmarks: [],
            totalPages: 4,
            dirty: false,
            untitledTitle: 'Untitled',
            actionId: 'bookmarks.preview_tree',
        });

        expect(plan.inputMode).toBe('nested');
        expect(plan.bookmarks).toEqual([expect.objectContaining({
            title: 'Part I',
            items: [expect.objectContaining({
                title: 'Chapter 1',
                pageIndex: 1,
            })],
        })]);
    });

    it('preserves pageYRatio anchors in bookmark plans and snapshots', () => {
        const plan = createAgentBookmarkPlan({
            input: {bookmarks: [{
                title: 'Lesson 5',
                page: 12,
                pageYRatio: 0.375,
            }]},
            currentBookmarks: [],
            totalPages: 20,
            dirty: false,
            untitledTitle: 'Untitled',
            actionId: 'bookmarks.preview_tree',
        });

        expect(plan.bookmarks[0]).toMatchObject({
            pageIndex: 11,
            pageYRatio: 0.375,
        });
        expect(plan.proposed.flat[0]).toMatchObject({
            pageNumber: 12,
            pageYRatio: 0.375,
        });
        expect(plan.proposed.bookmarks[0]).toMatchObject({
            pageNumber: 12,
            pageYRatio: 0.375,
        });
        expect(plan.proposed.summary.anchoredPageDestinationCount).toBe(1);
    });

    it('flags child bookmark clusters that reuse the exact parent destination', () => {
        const plan = createAgentBookmarkPlan({
            input: {bookmarks: [{
                title: 'Lesson 5',
                page: 10,
                children: [
                    {
                        title: '10 Paragraph',
                        page: 10,
                    },
                    {
                        title: '11 Paragraph',
                        page: 10,
                    },
                ],
            }]},
            currentBookmarks: [],
            totalPages: 20,
            dirty: false,
            untitledTitle: 'Untitled',
            actionId: 'bookmarks.preview_tree',
        });

        expect(plan.issues).toEqual(expect.arrayContaining([expect.objectContaining({
            severity: 'error',
            code: 'bookmark_children_share_parent_destination',
            path: [0],
        })]));
    });

    it('allows same-page children when their pageYRatio anchors differ from the parent', () => {
        const plan = createAgentBookmarkPlan({
            input: {bookmarks: [{
                title: 'Lesson 5',
                page: 10,
                children: [
                    {
                        title: '10 Paragraph',
                        page: 10,
                        pageYRatio: 0.2,
                    },
                    {
                        title: '11 Paragraph',
                        page: 10,
                        pageYRatio: 0.6,
                    },
                ],
            }]},
            currentBookmarks: [],
            totalPages: 20,
            dirty: false,
            untitledTitle: 'Untitled',
            actionId: 'bookmarks.preview_tree',
        });

        expect(plan.issues).not.toEqual(expect.arrayContaining([expect.objectContaining({code: 'bookmark_children_share_parent_destination'})]));
    });

    it('reports bookmark validation hints for awkward assistant plans', () => {
        const plan = createAgentBookmarkPlan({
            input: {entries: [
                {
                    depth: 2,
                    title: 'Orphaned deep heading',
                    page: 2,
                },
                {
                    depth: 0,
                    title: 'No destination',
                },
            ]},
            currentBookmarks: [bookmark({
                title: 'Old',
                pageIndex: requirePageIndex(0),
            })],
            totalPages: 4,
            dirty: false,
            untitledTitle: 'Untitled',
            actionId: 'bookmarks.preview_tree',
        });

        expect(plan.issues).toEqual(expect.arrayContaining([
            expect.objectContaining({code: 'flat_bookmark_missing_parent'}),
            expect.objectContaining({code: 'bookmark_without_destination'}),
        ]));

        const snapshot = createAgentBookmarkSnapshot(plan.bookmarks, {dirty: false});
        expect(snapshot.summary).toMatchObject({
            rootCount: 2,
            totalCount: 2,
            destinationlessCount: 1,
        });
    });
});
