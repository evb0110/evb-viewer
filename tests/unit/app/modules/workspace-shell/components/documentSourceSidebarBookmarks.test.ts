// @vitest-environment happy-dom

import type * as TViMockOriginalModule from '@app/composables/useTypedI18n';

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
    ref,
    shallowRef,
} from 'vue';
import { requireDocumentRef } from '@contracts/documentRef';
import type {
    IDocumentOutlineItem,
    IDocumentPageSource,
} from '@app/utils/document-viewer/source/documentPageSource';
import type { IDocumentSearchSession } from '@app/utils/document-viewer/search/documentSearch';
import type { TDocumentSidebarTab } from '@app/utils/document-viewer/sidebar/documentSidebarTabs';
import DocumentSourceSidebar from '@app/modules/workspace-shell/components/DocumentSourceSidebar.vue';

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string) => key}),
}));

function stub(marker: string) {
    return {default: defineComponent({
        inheritAttrs: false,
        setup: (_props, {
            attrs,
            slots,
        }) => () => h('div', {
            ...attrs,
            [marker]: '',
        }, slots.default?.()),
    })};
}

vi.mock('@app/components/document-viewer/DocumentBookmarkToolbar.vue', () => stub('data-bookmark-toolbar-stub'));
vi.mock('@app/components/document-viewer/DocumentBookmarkTree.vue', () => stub('data-bookmark-tree-stub'));
vi.mock('@app/components/document-viewer/DocumentPanelEmptyState.vue', () => stub('data-empty-state-stub'));
vi.mock('@app/components/document-viewer/DocumentSearchPanel.vue', () => stub('data-search-stub'));
vi.mock('@app/components/document-viewer/DocumentThumbnailList.vue', () => stub('data-thumbnails-stub'));
vi.mock('@app/components/document-viewer/DocumentSidebarPagesPanel.vue', () => stub('data-pages-panel-stub'));
vi.mock('@app/components/sidebar/AppSidebarShell.vue', async () => {
    const vue = await import('vue');
    return {default: vue.defineComponent({
        props: {
            modelValue: {
                type: String,
                required: true,
            },
            tabs: {
                type: Array,
                required: true,
            },
        },
        emits: ['update:model-value'],
        setup: (_props, {slots}) => () => vue.h('aside', {'data-shell-stub': ''}, slots.default?.()),
    })};
});

function createSearchSession(): IDocumentSearchSession {
    return {
        query: ref(''),
        submittedQuery: ref(''),
        options: ref({
            matchCase: false,
            wholeWord: false,
            useRegex: false,
        }),
        results: ref([]),
        currentResultIndex: ref(-1),
        currentResultNavigationId: ref(0),
        isSearching: ref(false),
        error: ref(null),
        progress: ref(undefined),
        isTruncated: ref(false),
        minQueryLength: ref(2),
        setQuery: vi.fn(),
        setOptions: vi.fn(),
        run: vi.fn(async () => false),
        clear: vi.fn(),
        cancel: vi.fn(),
        select: vi.fn(() => false),
        navigate: vi.fn(() => false),
    };
}

function createSource(getOutline: () => Promise<IDocumentOutlineItem[]>): IDocumentPageSource {
    return {
        kind: 'djvu',
        documentRef: requireDocumentRef('/tmp/test.djvu'),
        pageCount: 2,
        outlineProvider: {getOutline},
        getPageMetrics: vi.fn(),
        renderPage: vi.fn(),
        dispose: vi.fn(),
    };
}

const activeUnmounts = new Set<() => void>();

afterEach(() => {
    for (const unmount of [...activeUnmounts]) {
        unmount();
    }
});

async function mountSidebar(source: IDocumentPageSource | null) {
    const availableTabs: TDocumentSidebarTab[][] = [];
    const activeTab = shallowRef<TDocumentSidebarTab>('bookmarks');
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(defineComponent({setup: () => () => h(DocumentSourceSidebar, {
        activeTab: activeTab.value,
        currentPage: 1,
        searchSession: createSearchSession(),
        source,
        'onUpdate:activeTab': (value: TDocumentSidebarTab) => {
            activeTab.value = value;
        },
        'onUpdate:availableTabs': (tabs: TDocumentSidebarTab[]) => {
            availableTabs.push(tabs);
        },
    })}));
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
        availableTabs,
        host,
        settle,
        unmount,
    };
}

function toolbar(host: HTMLElement) {
    return host.querySelector('[data-bookmark-toolbar-stub]');
}

describe('DocumentSourceSidebar bookmarks panel', () => {
    it('hides the display-mode toolbar while the outline is loading', async () => {
        const sidebar = await mountSidebar(createSource(() => new Promise<IDocumentOutlineItem[]>(() => undefined)));

        expect(toolbar(sidebar.host)).toBeNull();
        expect(sidebar.host.querySelector('.document-source-sidebar__status')).not.toBeNull();
    });

    it('hides the display-mode toolbar while the outline is in an error state', async () => {
        const sidebar = await mountSidebar(createSource(() => Promise.reject(new Error('outline stream is corrupt'))));

        await sidebar.settle();

        expect(toolbar(sidebar.host)).toBeNull();
        expect(sidebar.host.querySelector('[data-empty-state-stub]')).not.toBeNull();
    });

    it('shows the display-mode toolbar once the outline is available', async () => {
        const sidebar = await mountSidebar(createSource(() => Promise.resolve([{
            title: 'Part',
            pageNumber: 1,
            children: [],
        }])));

        await sidebar.settle();

        expect(toolbar(sidebar.host)).not.toBeNull();
        expect(sidebar.host.querySelector('[data-bookmark-tree-stub]')).not.toBeNull();
    });

    it('publishes the tabs the source actually supports', async () => {
        const sidebar = await mountSidebar(createSource(() => Promise.resolve([])));

        expect(sidebar.availableTabs.at(-1)).toEqual(['bookmarks']);
    });

    it('publishes no tabs while no source is attached', async () => {
        const sidebar = await mountSidebar(null);

        expect(sidebar.availableTabs.at(-1)).toEqual([]);
    });
});
