// @vitest-environment happy-dom

import type * as TViMockOriginalModule from '@app/composables/useTypedI18n';

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    defineComponent,
    h,
    nextTick,
    shallowRef,
} from 'vue';
import type {PropType} from 'vue';
import { requireDocumentRef } from '@contracts/documentRef';
import type {IDocumentBookmarkTreeItem} from '@app/utils/document-viewer/bookmarks/documentBookmarks';
import type {
    IDocumentPageSource,
    IDocumentSurfaceLease,
} from '@app/utils/document-viewer/source/documentPageSource';
import type {TDocumentSidebarTab} from '@app/utils/document-viewer/sidebar/documentSidebarTabs';
import type {IDocumentThumbnailCommittedState} from '@app/utils/document-viewer/thumbnails/documentThumbnailScheduler';
import type {IDocumentThumbnailVirtualItem} from '@app/utils/document-viewer/thumbnails/useDocumentThumbnailController';
import DocumentSourceSidebar from '@app/modules/workspace-shell/components/DocumentSourceSidebar.vue';
import {
    createDocumentSearchSessionDouble,
    mountDocumentSidebarHost,
    unmountDocumentSidebarHosts,
} from '@tests/helpers/document-viewer/documentSourceSidebarHarness';

/**
 * The sidebar sits between the shared thumbnail rail and whoever owns
 * navigation, and it is the only place that can hand the user's own click
 * onward. A consumer that wants ctrl/shift multi-select has to read those
 * modifiers off the real event; a consumer that only navigates keeps ignoring
 * the second argument, which is why bookmark rows still navigate without one.
 *
 * The rail's controller is a double so the scenario is about the click path
 * rather than about rendering, but every component and emit between the row
 * and the consumer is the real one.
 */
const controller = vi.hoisted(() => ({
    contentHeight: '400px',
    handlePointerDown: () => {},
    handleScroll: () => {},
    handleWheel: () => {},
    renderErrors: new Set<number>(),
    retryRender: vi.fn(),
    states: new Map<number, IDocumentThumbnailCommittedState>(),
    virtualItems: [] as IDocumentThumbnailVirtualItem[],
}));

vi.mock(
    '@app/utils/document-viewer/thumbnails/useDocumentThumbnailController',
    () => ({useDocumentThumbnailController: () => controller}),
);

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
// The real tree virtualizes against a measured container, which a jsdom-style
// environment reports as zero-height; the rows it would render are stood in
// for here so the activation path stays reachable.
vi.mock('@app/components/document-viewer/DocumentBookmarkTree.vue', async () => {
    const vue = await import('vue');
    return {default: vue.defineComponent({
        props: {items: {
            type: Array as PropType<IDocumentBookmarkTreeItem[]>,
            required: true,
        }},
        emits: ['activate'],
        setup: (props, {emit}) => () => vue.h('div', props.items.map(item => vue.h('button', {
            'data-bookmark-row': item.id,
            onClick: (event: MouseEvent) => emit('activate', item.id, event),
        }, item.title))),
    })};
});
vi.mock('@app/components/document-viewer/DocumentSearchPanel.vue', () => stub('data-search-stub'));
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

function createSurfaceLease(): IDocumentSurfaceLease {
    return {
        widthPx: 180,
        heightPx: 252,
        bytes: 126_000,
        surface: document.createElement('canvas'),
        release: vi.fn(),
    };
}

function createSource(): IDocumentPageSource {
    return {
        kind: 'djvu',
        documentRef: requireDocumentRef('/tmp/test.djvu'),
        pageCount: 4,
        outlineProvider: {getOutline: () => Promise.resolve([{
            title: 'Part two',
            pageNumber: 2,
            children: [],
        }])},
        thumbnailProvider: {renderThumbnail: vi.fn(async () => createSurfaceLease())},
        getPageMetrics: vi.fn(async () => ({
            widthPoints: 500,
            heightPoints: 700,
            rotation: 0 as const,
        })),
        renderPage: vi.fn(async () => createSurfaceLease()),
        dispose: vi.fn(),
    };
}

class ResizeObserverStub implements ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
}

const originalResizeObserver = globalThis.ResizeObserver;

beforeEach(() => {
    globalThis.ResizeObserver = ResizeObserverStub;
    controller.renderErrors.clear();
    controller.retryRender.mockClear();
    controller.states.clear();
    controller.virtualItems.length = 0;
    for (const pageNumber of [
        1,
        2,
        3,
    ]) {
        controller.virtualItems.push({
            aspectRatio: '5 / 7',
            height: 200,
            pageNumber,
            top: (pageNumber - 1) * 200,
        });
    }
});

afterEach(() => {
    unmountDocumentSidebarHosts();
    globalThis.ResizeObserver = originalResizeObserver;
    document.body.innerHTML = '';
});

interface INavigation {
    event: MouseEvent | undefined;
    pageNumber: number;
}

async function mountSidebar(tab: TDocumentSidebarTab) {
    const activeTab = shallowRef<TDocumentSidebarTab>(tab);
    const navigations: INavigation[] = [];
    const mountedHost = await mountDocumentSidebarHost(
        () => h(DocumentSourceSidebar, {
            activeTab: activeTab.value,
            currentPage: 1,
            searchSession: createDocumentSearchSessionDouble(),
            source: createSource(),
            'onUpdate:activeTab': (value: TDocumentSidebarTab) => {
                activeTab.value = value;
            },
            onGoToPage: (pageNumber: number, event?: MouseEvent) => navigations.push({
                event,
                pageNumber,
            }),
        }),
        app => {
            app.component('UIcon', defineComponent({
                props: {name: {
                    type: String,
                    required: true,
                }},
                setup: props => () => h('span', {'data-icon': props.name}),
            }));
        },
    );
    return {
        host: mountedHost.host,
        navigations,
        unmount: mountedHost.unmount,
    };
}

function clickRow(host: HTMLElement, pageNumber: number, init: MouseEventInit) {
    const row = host.querySelector<HTMLElement>(`[data-thumbnail-page="${String(pageNumber)}"]`);
    if (!row) {
        throw new Error(`thumbnail row ${String(pageNumber)} is not rendered`);
    }
    const event = new MouseEvent('click', {
        bubbles: true,
        ...init,
    });
    row.dispatchEvent(event);
    return event;
}

describe('DocumentSourceSidebar thumbnail selection', () => {
    it('forwards the ctrl-click that selected a thumbnail row', async () => {
        const sidebar = await mountSidebar('thumbnails');

        const click = clickRow(sidebar.host, 2, {ctrlKey: true});

        expect(sidebar.navigations).toHaveLength(1);
        expect(sidebar.navigations[0]?.pageNumber).toBe(2);
        expect(sidebar.navigations[0]?.event).toBe(click);
        expect(sidebar.navigations[0]?.event?.ctrlKey).toBe(true);
    });

    it('forwards the shift-click that extends a thumbnail range', async () => {
        const sidebar = await mountSidebar('thumbnails');

        const click = clickRow(sidebar.host, 3, {shiftKey: true});

        expect(sidebar.navigations[0]?.pageNumber).toBe(3);
        expect(sidebar.navigations[0]?.event).toBe(click);
        expect(sidebar.navigations[0]?.event?.shiftKey).toBe(true);
    });

    it('navigates on a plain click with no modifier claimed', async () => {
        const sidebar = await mountSidebar('thumbnails');

        const click = clickRow(sidebar.host, 1, {});

        expect(sidebar.navigations[0]?.pageNumber).toBe(1);
        expect(sidebar.navigations[0]?.event).toBe(click);
        expect(sidebar.navigations[0]?.event?.ctrlKey).toBe(false);
        expect(sidebar.navigations[0]?.event?.metaKey).toBe(false);
        expect(sidebar.navigations[0]?.event?.shiftKey).toBe(false);
    });

    it('navigates from a bookmark row without claiming a selection event', async () => {
        const sidebar = await mountSidebar('bookmarks');

        const row = sidebar.host.querySelector<HTMLElement>('[data-bookmark-row]');
        row?.dispatchEvent(new MouseEvent('click', {bubbles: true}));
        await nextTick();

        expect(sidebar.navigations).toEqual([{
            event: undefined,
            pageNumber: 2,
        }]);
    });
});
