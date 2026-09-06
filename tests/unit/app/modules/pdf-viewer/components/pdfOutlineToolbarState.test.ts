import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import { cast } from '@tests/helpers/cast';
// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createApp,
    defineComponent,
    h,
    nextTick,
    reactive,
} from 'vue';
import PdfOutline from '@app/modules/pdf-viewer/components/PdfOutline.vue';
import type {IPdfBookmarkEntry} from '@contracts/pdfBookmarkEntry';

vi.mock('@app/composables/useTypedI18n', () => ({useTypedI18n: () => ({t: (key: string, parameters?: Record<string, string | number>) => parameters ? `${key} ${Object.values(parameters).join(' ')} retained read-only` : key})}));

function stub(marker: string) {
    return {default: defineComponent({
        inheritAttrs: false,
        setup: (_props, {attrs}) => () => h('div', {
            ...attrs,
            [marker]: '',
        }),
    })};
}

vi.mock('@app/components/AppSpinner.vue', () => stub('data-spinner-stub'));
vi.mock('@app/components/document-viewer/DocumentBookmarkToolbar.vue', () => stub('data-bookmark-toolbar-stub'));
vi.mock('@app/components/document-viewer/DocumentBookmarkTree.vue', () => stub('data-bookmark-tree-stub'));
vi.mock('@app/components/document-viewer/DocumentPanelEmptyState.vue', () => stub('data-empty-state-stub'));
vi.mock('@app/modules/pdf-viewer/components/PdfOutlineContextMenu.vue', () => stub('data-context-menu-stub'));
vi.mock('@app/modules/pdf-viewer/components/PdfOutlineItem.vue', () => stub('data-outline-item-stub'));

const activeUnmounts = new Set<() => void>();

afterEach(() => {
    for (const unmount of [...activeUnmounts]) {
        unmount();
    }
});

function createPdfDocument(getOutline: () => Promise<unknown[] | null>) {
    return cast<IPdfDocument>({
        _transport: {},
        getOutline,
    });
}

async function mountOutline(getOutline: () => Promise<unknown[] | null>) {
    const host = document.createElement('div');
    document.body.append(host);
    const editModeUpdates: boolean[] = [];
    const viewProps = reactive({
        bookmarkItems: [] as IPdfBookmarkEntry[],
        bookmarksDirty: false,
        currentPage: 1,
        isEditMode: false,
        pdfDocument: createPdfDocument(getOutline),
    });
    const app = createApp(defineComponent({setup: () => () => h(PdfOutline, {
        ...viewProps,
        'onUpdate:isEditMode': (value: boolean) => editModeUpdates.push(value),
    })}));
    app.component('UButton', defineComponent({setup: () => () => h('button')}));
    app.mount(host);
    await nextTick();

    const unmount = () => {
        app.unmount();
        host.remove();
        activeUnmounts.delete(unmount);
    };
    activeUnmounts.add(unmount);

    async function settle() {
        await nextTick();
        await new Promise(resolve => setTimeout(resolve, 0));
        await nextTick();
    }

    return {
        applyExternalBookmarks(items: IPdfBookmarkEntry[]) {
            viewProps.bookmarkItems = items;
            viewProps.bookmarksDirty = true;
        },
        editModeUpdates,
        host,
        setEditMode(value: boolean) {
            viewProps.isEditMode = value;
        },
        settle,
        unmount,
    };
}

function toolbar(host: HTMLElement) {
    return host.querySelector('[data-bookmark-toolbar-stub]');
}

function createDeepBookmarkEntries(depth: number) {
    const root: IPdfBookmarkEntry = {
        title: 'Bookmark 0',
        pageIndex: 0,
        namedDest: null,
        bold: false,
        italic: false,
        color: null,
        items: [],
    };
    let current = root;
    for (let index = 1; index < depth; index += 1) {
        const child: IPdfBookmarkEntry = {
            title: `Bookmark ${index}`,
            pageIndex: index,
            namedDest: null,
            bold: false,
            italic: false,
            color: null,
            items: [],
        };
        current.items = [child];
        current = child;
    }
    return [root];
}

describe('PdfOutline bookmark toolbar state', () => {
    it('defers the loading spinner while bookmarks are loading', async () => {
        const outline = await mountOutline(() => new Promise(() => undefined));

        expect(toolbar(outline.host)).toBeNull();
        expect(outline.host.querySelector('[data-spinner-stub]')).toBeNull();
    });

    it('shows the loading spinner when bookmark loading outlasts the delay', async () => {
        vi.useFakeTimers();
        try {
            const outline = await mountOutline(() => new Promise(() => undefined));

            expect(outline.host.querySelector('[data-spinner-stub]')).toBeNull();
            await vi.advanceTimersByTimeAsync(149);
            await nextTick();
            expect(outline.host.querySelector('[data-spinner-stub]')).toBeNull();

            await vi.advanceTimersByTimeAsync(1);
            await nextTick();

            expect(outline.host.querySelector('[data-spinner-stub]')).not.toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('hides the toolbar and exposes an error state when loading fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const outline = await mountOutline(() => Promise.reject(new Error('outline stream is corrupt')));

        await outline.settle();

        expect(toolbar(outline.host)).toBeNull();
        expect(outline.host.querySelector('[data-empty-state-stub]')?.getAttribute('title'))
            .toBe('bookmarks.unavailable');
    });

    it('shows the toolbar once an empty outline has loaded successfully', async () => {
        const outline = await mountOutline(() => Promise.resolve([]));

        expect(outline.host.querySelector('[data-spinner-stub]')).toBeNull();
        await outline.settle();

        expect(toolbar(outline.host)).not.toBeNull();
        expect(outline.host.querySelector('[data-spinner-stub]')).toBeNull();
        expect(outline.host.querySelector('[data-empty-state-stub]')?.getAttribute('title'))
            .toBe('bookmarks.noBookmarks');
    });

    it('keeps more than 10000 outline entries editable for native continuation', async () => {
        const outline = await mountOutline(() => Promise.resolve([]));
        await outline.settle();
        outline.setEditMode(true);
        await outline.settle();
        outline.editModeUpdates.length = 0;
        outline.applyExternalBookmarks(Array.from({length: 10_001}, (_, index) => ({
            title: `Bookmark ${index}`,
            pageIndex: index,
            namedDest: null,
            bold: false,
            italic: false,
            color: null,
            items: [],
        })));

        await outline.settle();

        expect(outline.host.querySelector('[data-bookmark-persistence-refusal]')).toBeNull();
        expect(toolbar(outline.host)).not.toBeNull();
        expect(outline.editModeUpdates).toEqual([]);
    });

    it('keeps native bookmark depth 64 editable', async () => {
        const outline = await mountOutline(() => Promise.resolve([]));
        await outline.settle();
        outline.applyExternalBookmarks(createDeepBookmarkEntries(65));

        await outline.settle();

        expect(outline.host.querySelector('[data-bookmark-persistence-refusal]')).toBeNull();
        expect(toolbar(outline.host)).not.toBeNull();
    });

    it('surfaces a typed persistence refusal when native bookmark depth is exceeded', async () => {
        const outline = await mountOutline(() => Promise.resolve([]));
        await outline.settle();
        outline.applyExternalBookmarks(createDeepBookmarkEntries(66));

        await outline.settle();

        const refusal = outline.host.querySelector('[data-bookmark-persistence-refusal]');
        expect(refusal).not.toBeNull();
        expect(refusal?.getAttribute('data-bookmark-persistence-reason')).toBe('depth');
        expect(refusal?.textContent).toContain('64');
        expect(refusal?.textContent).toMatch(/read-only|readonly/iu);
    });

    it('recovers from a load error when external bookmarks arrive', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const outline = await mountOutline(() => Promise.reject(new Error('outline stream is corrupt')));

        await outline.settle();
        outline.applyExternalBookmarks([{
            title: 'Recovered bookmark',
            pageIndex: 0,
            namedDest: null,
            bold: false,
            italic: false,
            color: null,
            items: [],
        }]);
        await outline.settle();

        expect(toolbar(outline.host)).not.toBeNull();
        expect(outline.host.querySelector('[data-empty-state-stub]')).toBeNull();
    });
});
