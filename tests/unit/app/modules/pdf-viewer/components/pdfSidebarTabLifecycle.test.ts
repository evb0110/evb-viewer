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
    reactive,
} from 'vue';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import type { TPdfSidebarTab } from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerExpose.types';
import PdfSidebar from '@app/modules/pdf-viewer/components/PdfSidebar.vue';

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string) => key}),
}));

function stubPanel(marker: string) {
    const component = defineComponent({
        inheritAttrs: false,
        setup: (_props, {
            attrs,
            slots,
        }) => () => h('div', {
            ...attrs,
            [marker]: '',
        }, [
            slots.header?.(),
            slots.default?.(),
            slots.footer?.(),
        ]),
    });
    return {default: component};
}

function activeStateStub(marker: string) {
    const component = defineComponent({
        inheritAttrs: false,
        props: {isActive: {
            type: Boolean,
            required: true,
        }},
        setup: (props, {
            attrs,
            slots,
        }) => () => h('div', {
            ...attrs,
            [marker]: '',
            'data-active-state': String(props.isActive),
        }, [
            slots.header?.(),
            slots.default?.(),
            slots.footer?.(),
        ]),
    });
    return {default: component};
}

vi.mock('@app/modules/pdf-viewer/components/PdfOutline.vue', () => stubPanel('data-outline-stub'));
vi.mock('@app/modules/pdf-viewer/components/PdfAnnotationsPanel.vue', () => stubPanel('data-annotations-stub'));
vi.mock('@app/modules/pdf-viewer/components/PdfThumbnails.vue', () => activeStateStub('data-thumbnails-stub'));
vi.mock('@app/modules/pdf-viewer/components/PdfPageSelectionBar.vue', () => stubPanel('data-page-selection-stub'));
vi.mock('@app/modules/pdf-viewer/components/PdfSidebarPageNumbering.vue', () => stubPanel('data-page-numbering-stub'));
vi.mock('@app/components/document-viewer/DocumentSearchPanel.vue', () => activeStateStub('data-search-stub'));
vi.mock('@app/components/document-viewer/DocumentSidebarPagesPanel.vue', () => stubPanel('data-pages-panel-stub'));

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
            outerScroll: Boolean,
        },
        emits: ['update:model-value'],
        setup: (props, {
            emit,
            slots,
        }) => () => vue.h('aside', {'data-shell-stub': ''}, [
            (props.tabs as Array<{value: string}>).map(tab => vue.h('button', {
                key: tab.value,
                type: 'button',
                'data-tab': tab.value,
                onClick: () => emit('update:model-value', tab.value),
            })),
            slots.default?.(),
        ]),
    })};
});

const activeUnmounts = new Set<() => void>();

afterEach(() => {
    for (const unmount of [...activeUnmounts]) {
        unmount();
    }
});

async function mountSidebar(overrides: {
    activeTab?: TPdfSidebarTab;
    isActive?: boolean;
    isDjvuMode?: boolean;
} = {}) {
    const state = reactive({
        activeTab: overrides.activeTab ?? ('search' as TPdfSidebarTab),
        isOpen: true,
    });
    const cancelSearch = vi.fn();
    const publishedTabs: TPdfSidebarTab[][] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(defineComponent({setup: () => () => h(PdfSidebar, {
        activeTab: state.activeTab,
        annotationComments: [],
        annotationCommentsStatus: 'ready',
        annotationKeepActive: false,
        annotationSettings: DEFAULT_ANNOTATION_SETTINGS,
        annotationTool: 'none',
        bookmarkEditMode: false,
        bookmarkItems: [],
        bookmarkNavigationIntentVersion: 0,
        bookmarksDirty: false,
        currentPage: 1,
        currentResultIndex: -1,
        currentResultNavigationId: 0,
        isOpen: state.isOpen,
        isSearching: true,
        pdfDocument: null,
        rasterScheduler: null,
        searchOptions: {
            matchCase: false,
            useRegex: false,
            wholeWord: false,
        },
        searchQuery: 'needle',
        searchResults: [],
        selectedThumbnailPages: [],
        totalPages: 4,
        isDjvuMode: overrides.isDjvuMode ?? false,
        isActive: overrides.isActive ?? true,
        'onCancel-search': cancelSearch,
        'onUpdate:availableTabs': (tabs: TPdfSidebarTab[]) => {
            publishedTabs.push(tabs);
        },
        'onUpdate:activeTab': (value: TPdfSidebarTab) => {
            state.activeTab = value;
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

    async function selectTab(tab: TPdfSidebarTab) {
        host.querySelector<HTMLElement>(`[data-tab="${tab}"]`)?.click();
        await nextTick();
        await nextTick();
    }

    async function setOpen(isOpen: boolean) {
        state.isOpen = isOpen;
        await nextTick();
        await nextTick();
    }

    return {
        cancelSearch,
        host,
        publishedTabs,
        selectTab,
        setOpen,
        state,
        unmount,
    };
}

describe('PdfSidebar tab lifecycle', () => {
    it('cancels the running search when the search tab is left', async () => {
        const {
            cancelSearch,
            selectTab,
        } = await mountSidebar();

        expect(cancelSearch).not.toHaveBeenCalled();

        await selectTab('thumbnails');

        expect(cancelSearch).toHaveBeenCalledTimes(1);
    });

    it('cancels the running search when the sidebar closes on the search tab', async () => {
        const {
            cancelSearch,
            setOpen,
        } = await mountSidebar();

        await setOpen(false);

        expect(cancelSearch).toHaveBeenCalledTimes(1);
    });

    it('leaves the search running while the search tab stays active', async () => {
        const {
            cancelSearch,
            selectTab,
        } = await mountSidebar({activeTab: 'thumbnails'});

        await selectTab('bookmarks');
        await selectTab('search');

        expect(cancelSearch).not.toHaveBeenCalled();
    });

    it('deactivates render-backed panels when the sidebar owner is hidden', async () => {
        const {host} = await mountSidebar({isActive: false});

        expect(host.querySelector('[data-thumbnails-stub]')?.getAttribute('data-active-state')).toBe('false');
        expect(host.querySelector('[data-search-stub]')?.getAttribute('data-active-state')).toBe('false');
    });

    it('publishes the tabs the document actually supports', async () => {
        const pdf = await mountSidebar();
        const djvu = await mountSidebar({isDjvuMode: true});

        expect(pdf.publishedTabs.at(-1)).toEqual([
            'annotations',
            'thumbnails',
            'bookmarks',
            'search',
        ]);
        expect(djvu.publishedTabs.at(-1)).toEqual([
            'thumbnails',
            'bookmarks',
            'search',
        ]);
    });
});
