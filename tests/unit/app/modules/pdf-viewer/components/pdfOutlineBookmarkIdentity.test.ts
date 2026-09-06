import type {
    IPdfDocument,
    IPdfPage,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { PropType } from 'vue';
import {
    createApp,
    defineComponent,
    h,
    nextTick,
    reactive,
} from 'vue';
import type { IBookmarkItem } from '@app/types/pdfOutline';
import type {IPdfBookmarkEntry} from '@app/types/pdfContracts';
import type { IPdfBookmarkChangePayload } from '@app/types/pdfUi';
import type { IDocumentBookmarkTreeItem } from '@app/utils/document-viewer/bookmarks/documentBookmarks';
import PdfOutline from '@app/modules/pdf-viewer/components/PdfOutline.vue';
import { cast } from '@tests/helpers/cast';

vi.mock('@app/composables/useTypedI18n', () => ({useTypedI18n: () => ({t: (key: string) => key})}));

interface ITreeStubState {
    items: readonly IDocumentBookmarkTreeItem[];
    expandedIds: ReadonlySet<string>;
    toggleExpand: (id: string) => void;
}

const treeStub: ITreeStubState = {
    items: [],
    expandedIds: new Set<string>(),
    toggleExpand: () => undefined,
};

const outlineItemRenames = new Map<string, (title: string) => void>();

vi.mock('@app/components/document-viewer/DocumentBookmarkTree.vue', async () => {
    const vue = await import('vue');
    return {default: vue.defineComponent({
        props: {
            items: {
                type: Array as PropType<IDocumentBookmarkTreeItem[]>,
                required: true,
            },
            activeId: {
                type: String,
                default: null,
            },
            displayMode: {
                type: String,
                required: true,
            },
            expandedIds: {
                type: Object as PropType<Set<string>>,
                required: true,
            },
            activePathIds: {
                type: Object as PropType<Set<string>>,
                required: true,
            },
        },
        emits: [
            'activate',
            'toggle-expand',
        ],
        setup: (props, {emit}) => {
            vue.watchEffect(() => {
                treeStub.items = props.items;
                treeStub.expandedIds = props.expandedIds;
            });
            treeStub.toggleExpand = (id: string) => emit('toggle-expand', id);
            return () => vue.h('div', {'data-tree-stub': ''});
        },
    })};
});

vi.mock('@app/modules/pdf-viewer/components/PdfOutlineItem.vue', async () => {
    const vue = await import('vue');
    return {default: vue.defineComponent({
        props: {
            item: {
                type: Object as PropType<IBookmarkItem>,
                required: true,
            },
            pdfDocument: {
                type: Object,
                default: null,
            },
        },
        emits: [
            'go-to-page',
            'activate',
            'toggle-expand',
            'open-actions',
            'save-edit',
            'cancel-edit',
            'drag-start',
            'drag-hover',
            'drop-bookmark',
            'drag-end',
        ],
        setup: (props, {emit}) => {
            vue.watchEffect(() => {
                outlineItemRenames.set(props.item.id, (title: string) => emit('save-edit', {
                    id: props.item.id,
                    title,
                }));
            });
            return () => vue.h('div', {'data-outline-item': props.item.id});
        },
    })};
});

function stubComponent(marker: string) {
    const component = defineComponent({
        inheritAttrs: false,
        setup: () => () => h('div', {[marker]: ''}),
    });
    return {default: component};
}

vi.mock('@app/components/document-viewer/DocumentBookmarkToolbar.vue', () => stubComponent('data-toolbar-stub'));
vi.mock('@app/components/document-viewer/DocumentPanelEmptyState.vue', () => stubComponent('data-empty-stub'));
vi.mock('@app/components/AppSpinner.vue', () => stubComponent('data-spinner-stub'));
vi.mock('@app/modules/pdf-viewer/components/PdfOutlineContextMenu.vue', () => stubComponent('data-context-menu-stub'));

const activeUnmounts = new Set<() => void>();

afterEach(() => {
    for (const unmount of [...activeUnmounts]) {
        unmount();
    }
    outlineItemRenames.clear();
    treeStub.items = [];
    treeStub.expandedIds = new Set<string>();
});

function createEntry(
    title: string,
    overrides: Partial<IPdfBookmarkEntry> = {},
): IPdfBookmarkEntry {
    return {
        title,
        pageIndex: 1,
        pageYRatio: null,
        namedDest: null,
        bold: false,
        italic: false,
        color: null,
        items: [],
        ...overrides,
    };
}

function createPdfDocumentStub(outline: unknown[]) {
    return cast<IPdfDocument>({
        numPages: 10,
        getOutline: vi.fn(async () => outline),
        getDestination: vi.fn(async (_name: string) => [
            {
                num: 12,
                gen: 0,
            },
            { name: 'Fit' },
        ]),
        getPageIndex: vi.fn(async (_ref: unknown) => 3),
        getPage: vi.fn(async (_pageNumber: number) => cast<IPdfPage>({
            view: [
                0,
                0,
                612,
                792,
            ],
            getViewport: vi.fn(() => ({ height: 792 })),
        })),
    });
}

async function mountOutline(options: {
    bookmarkItems: IPdfBookmarkEntry[];
    isEditMode?: boolean;
    pdfDocument?: IPdfDocument | null;
}) {
    const state = reactive({
        bookmarkItems: options.bookmarkItems,
        bookmarksDirty: false,
        isEditMode: options.isEditMode ?? false,
    });
    const changes: IPdfBookmarkChangePayload[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(defineComponent({setup: () => () => h(PdfOutline, {
        pdfDocument: options.pdfDocument ?? null,
        currentPage: 1,
        isEditMode: state.isEditMode,
        bookmarkItems: state.bookmarkItems,
        bookmarksDirty: state.bookmarksDirty,
        navigationIntentVersion: 0,
        onBookmarksChange: (payload: IPdfBookmarkChangePayload) => {
            changes.push(payload);
        },
        'onUpdate:isEditMode': (value: boolean) => {
            state.isEditMode = value;
        },
    })}));
    app.component('UButton', stubComponent('data-button-stub').default);
    app.mount(host);
    await nextTick();
    const unmount = () => {
        app.unmount();
        host.remove();
        activeUnmounts.delete(unmount);
    };
    activeUnmounts.add(unmount);

    async function applyExternalBookmarks(entries: IPdfBookmarkEntry[]) {
        state.bookmarkItems = entries;
        state.bookmarksDirty = true;
        await nextTick();
        await nextTick();
    }

    return {
        applyExternalBookmarks,
        changes,
        host,
        state,
        unmount,
    };
}

function collectTreeIds(items: readonly IDocumentBookmarkTreeItem[]): string[] {
    return items.flatMap(item => [
        item.id,
        ...collectTreeIds(item.children),
    ]);
}

function createBaseOutline() {
    return [
        createEntry('Alpha', { pageIndex: 1 }),
        createEntry('Beta', {
            pageIndex: 2,
            items: [createEntry('Beta child', { pageIndex: 3 })],
        }),
    ];
}

describe('PdfOutline bookmark identity and dirty comparison', () => {
    it('keeps bookmark ids when an unrelated bookmark is inserted externally', async () => {
        const outline = await mountOutline({ bookmarkItems: createBaseOutline() });
        const baselineIds = collectTreeIds(treeStub.items);

        await outline.applyExternalBookmarks([
            createEntry('Inserted', { pageIndex: 0 }),
            ...createBaseOutline(),
        ]);
        const nextIds = collectTreeIds(treeStub.items);

        expect(baselineIds).toHaveLength(3);
        expect(nextIds.slice(1)).toEqual(baselineIds);
        expect(nextIds[0]).not.toBe(baselineIds[0]);
    });

    it('keeps expansion state when the same outline arrives with different object shapes', async () => {
        const outline = await mountOutline({ bookmarkItems: createBaseOutline() });
        const expandableId = treeStub.items[1]?.id ?? '';
        treeStub.toggleExpand(expandableId);
        await nextTick();
        expect(treeStub.expandedIds.has(expandableId)).toBe(true);

        await outline.applyExternalBookmarks([
            {
                items: [],
                color: null,
                italic: false,
                bold: false,
                namedDest: null,
                pageIndex: 1,
                title: '  Alpha  ',
            },
            {
                title: 'Beta',
                pageIndex: 2,
                namedDest: null,
                bold: false,
                italic: false,
                color: null,
                items: [createEntry('Beta child', { pageIndex: 3 })],
            },
        ]);

        expect(collectTreeIds(treeStub.items)).toHaveLength(3);
        expect(treeStub.expandedIds.has(expandableId)).toBe(true);
    });

    it('reports dirty only while the outline differs from its baseline', async () => {
        const outline = await mountOutline({
            bookmarkItems: createBaseOutline(),
            isEditMode: true,
        });
        const firstId = [...outlineItemRenames.keys()][0] ?? '';

        outlineItemRenames.get(firstId)?.('Renamed');
        await nextTick();
        expect(outline.changes.at(-1)?.dirty).toBe(true);

        outlineItemRenames.get(firstId)?.('  Alpha  ');
        await nextTick();
        expect(outline.changes.at(-1)?.dirty).toBe(false);
    });

    it('keeps ids across an external apply when a resolved bookmark carries no title', async () => {
        const outline = await mountOutline({
            bookmarkItems: [],
            pdfDocument: createPdfDocumentStub([
                {
                    title: '',
                    dest: 'sec-a',
                    items: [{
                        title: 'Child',
                        dest: null,
                    }],
                },
                {
                    title: 'Named',
                    dest: null,
                },
            ]),
        });
        await vi.waitFor(() => {
            expect(collectTreeIds(treeStub.items)).toHaveLength(3);
        });
        const baselineIds = collectTreeIds(treeStub.items);

        // Exactly what persistence would have written for the outline above,
        // where the untitled bookmark is saved under the untitled label, plus
        // one unrelated root so the panel actually rebuilds.
        await outline.applyExternalBookmarks([
            createEntry('Inserted', { pageIndex: 0 }),
            {
                title: 'bookmarks.untitled',
                pageIndex: 3,
                pageYRatio: null,
                namedDest: 'sec-a',
                bold: false,
                italic: false,
                color: null,
                items: [createEntry('Child', { pageIndex: null })],
            },
            createEntry('Named', { pageIndex: null }),
        ]);

        expect(collectTreeIds(treeStub.items).slice(1)).toEqual(baselineIds);
    });

    it('never persists bookmark ids, so no positional identity can leak into saved state', async () => {
        const outline = await mountOutline({
            bookmarkItems: createBaseOutline(),
            isEditMode: true,
        });
        const firstId = [...outlineItemRenames.keys()][0] ?? '';
        outlineItemRenames.get(firstId)?.('Renamed');
        await nextTick();

        const persisted = outline.changes.at(-1)?.bookmarks ?? [];
        function assertIdFree(entries: readonly IPdfBookmarkEntry[]) {
            for (const entry of entries) {
                expect(Object.keys(entry)).not.toContain('id');
                assertIdFree(entry.items);
            }
        }

        expect(persisted).not.toHaveLength(0);
        assertIdFree(persisted);
    });
});
