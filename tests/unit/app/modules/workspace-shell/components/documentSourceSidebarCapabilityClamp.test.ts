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
    defineComponent,
    h,
    shallowRef,
} from 'vue';
import { requireDocumentRef } from '@contracts/documentRef';
import type {
    IDocumentOutlineItem,
    IDocumentPageSource,
    IDocumentSurfaceLease,
} from '@app/utils/document-viewer/source/documentPageSource';
import type { TDocumentSidebarTab } from '@app/utils/document-viewer/sidebar/documentSidebarTabs';
import DocumentSourceSidebar from '@app/modules/workspace-shell/components/DocumentSourceSidebar.vue';
import {
    createDocumentSearchSessionDouble,
    mountDocumentSidebarHost,
    unmountDocumentSidebarHosts,
} from '@tests/helpers/document-viewer/documentSourceSidebarHarness';

/**
 * The sidebar's active tab is a projection of what the open format can
 * actually show. A preference the current source cannot serve (or cannot serve
 * yet, while its providers are still being resolved) must leave every panel
 * closed instead of opening one whose capability is missing; the preference
 * itself is shared workspace state and stays untouched so it can be re-adopted
 * the moment the capability comes back.
 */

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string) => key}),
}));

function panelStub(marker: string) {
    return {default: defineComponent({
        inheritAttrs: false,
        setup: (_props, {slots}) => () => h('div', {[marker]: ''}, slots.default?.()),
    })};
}

vi.mock('@app/components/document-viewer/DocumentBookmarkToolbar.vue', () => panelStub('data-bookmark-toolbar-stub'));
vi.mock('@app/components/document-viewer/DocumentBookmarkTree.vue', () => panelStub('data-bookmark-tree-stub'));
vi.mock('@app/components/document-viewer/DocumentPanelEmptyState.vue', () => panelStub('data-empty-state-stub'));
vi.mock('@app/components/document-viewer/DocumentThumbnailList.vue', () => panelStub('data-thumbnails-stub'));
vi.mock('@app/components/document-viewer/DocumentSidebarPagesPanel.vue', () => panelStub('data-pages-panel-stub'));
vi.mock('@app/components/document-viewer/DocumentSearchPanel.vue', async () => {
    const vue = await import('vue');
    return {default: vue.defineComponent({
        props: {isActive: {
            type: Boolean,
            default: false,
        }},
        setup: props => () => vue.h('div', {
            'data-search-stub': '',
            'data-search-active': props.isActive ? 'true' : 'false',
        }),
    })};
});
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
        setup: (props, {slots}) => () => vue.h('aside', {
            'data-shell-stub': '',
            'data-shell-active-tab': props.modelValue,
            'data-shell-tab-count': String(props.tabs.length),
        }, slots.default?.()),
    })};
});

interface ICapabilityOptions {
    outline?: boolean;
    search?: boolean;
    thumbnails?: boolean;
}

function createSurfaceLease(): IDocumentSurfaceLease {
    return {
        widthPx: 180,
        heightPx: 252,
        bytes: 126_000,
        surface: document.createElement('canvas'),
        release: vi.fn(),
    };
}

function createSource(capabilities: ICapabilityOptions): IDocumentPageSource {
    const outline: IDocumentOutlineItem[] = [{
        title: 'Part',
        pageNumber: 1,
        children: [],
    }];
    return {
        kind: 'djvu',
        documentRef: requireDocumentRef('/tmp/test.djvu'),
        pageCount: 2,
        ...(capabilities.outline ? {outlineProvider: {getOutline: () => Promise.resolve(outline)}} : {}),
        ...(capabilities.search ? {textProvider: {getPageText: vi.fn(async () => '')}} : {}),
        ...(capabilities.thumbnails
            ? {thumbnailProvider: {renderThumbnail: vi.fn(async () => createSurfaceLease())}}
            : {}),
        getPageMetrics: vi.fn(async () => ({
            widthPoints: 500,
            heightPoints: 700,
            rotation: 0 as const,
        })),
        renderPage: vi.fn(async () => createSurfaceLease()),
        dispose: vi.fn(),
    };
}

afterEach(() => {
    unmountDocumentSidebarHosts();
});

async function mountSidebar(source: IDocumentPageSource | null, tab: TDocumentSidebarTab) {
    const activeTab = shallowRef<TDocumentSidebarTab>(tab);
    const mountedHost = await mountDocumentSidebarHost(() => h(DocumentSourceSidebar, {
        activeTab: activeTab.value,
        currentPage: 1,
        searchSession: createDocumentSearchSessionDouble(),
        source,
        'onUpdate:activeTab': (value: TDocumentSidebarTab) => {
            activeTab.value = value;
        },
    }));
    return {
        activeTab,
        host: mountedHost.host,
        unmount: mountedHost.unmount,
    };
}

function isVisible(element: Element | null) {
    return element instanceof HTMLElement && element.style.display !== 'none';
}

function shell(host: HTMLElement) {
    return host.querySelector<HTMLElement>('[data-shell-stub]');
}

function searchPanel(host: HTMLElement) {
    return host.querySelector<HTMLElement>('[data-search-stub]');
}

function bookmarksPanel(host: HTMLElement) {
    return host.querySelector<HTMLElement>('.document-source-sidebar__bookmarks');
}

describe('DocumentSourceSidebar capability clamp', () => {
    it('opens no panel and marks no tab active while the source is still resolving', async () => {
        const sidebar = await mountSidebar(null, 'search');

        expect(isVisible(searchPanel(sidebar.host))).toBe(false);
        expect(searchPanel(sidebar.host)?.dataset.searchActive).toBe('false');
        expect(isVisible(bookmarksPanel(sidebar.host))).toBe(false);
        expect(shell(sidebar.host)?.dataset.shellTabCount).toBe('0');
        expect(shell(sidebar.host)?.dataset.shellActiveTab).toBe('');
        expect(sidebar.activeTab.value).toBe('search');
    });

    it('opens no bookmarks panel for a settled source that has no sidebar capability at all', async () => {
        const sidebar = await mountSidebar(createSource({}), 'bookmarks');

        expect(isVisible(bookmarksPanel(sidebar.host))).toBe(false);
        expect(isVisible(searchPanel(sidebar.host))).toBe(false);
        expect(shell(sidebar.host)?.dataset.shellTabCount).toBe('0');
        expect(shell(sidebar.host)?.dataset.shellActiveTab).toBe('');
        expect(sidebar.activeTab.value).toBe('bookmarks');
    });

    it('falls back to an available tab rather than to the unavailable preference', async () => {
        const sidebar = await mountSidebar(createSource({thumbnails: true}), 'bookmarks');

        expect(shell(sidebar.host)?.dataset.shellActiveTab).toBe('thumbnails');
        expect(isVisible(sidebar.host.querySelector('[data-pages-panel-stub]'))).toBe(true);
        expect(isVisible(bookmarksPanel(sidebar.host))).toBe(false);
        expect(sidebar.activeTab.value).toBe('bookmarks');
    });

    it('keeps a preference the settled source can serve', async () => {
        const sidebar = await mountSidebar(createSource({
            outline: true,
            thumbnails: true,
        }), 'bookmarks');

        expect(shell(sidebar.host)?.dataset.shellActiveTab).toBe('bookmarks');
        expect(isVisible(bookmarksPanel(sidebar.host))).toBe(true);
        expect(sidebar.host.querySelector('[data-bookmark-tree-stub]')).not.toBeNull();
    });
});
