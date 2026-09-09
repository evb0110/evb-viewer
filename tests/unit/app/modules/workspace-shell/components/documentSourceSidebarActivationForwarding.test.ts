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
} from 'vue';
import { requireDocumentRef } from '@contracts/documentRef';
import type {IDocumentPageSource} from '@app/utils/document-viewer/source/documentPageSource';
import DocumentSourceSidebar from '@app/modules/workspace-shell/components/DocumentSourceSidebar.vue';
import {
    createDocumentSearchSessionDouble,
    mountDocumentSidebarHost,
    unmountDocumentSidebarHosts,
} from '@tests/helpers/document-viewer/documentSourceSidebarHarness';

/**
 * The selection contract says the rail hands over the click that activated a
 * row, but a contract only holds if the sidebar between the rail and the
 * consumer passes that same object on. An inline `$event` handler, for
 * instance, satisfies every type in sight and still delivers the page number
 * with no event at all.
 *
 * Everything but the sidebar is a stub here, including the rail: the rail's
 * own rendering is covered elsewhere, and isolating it keeps this scenario
 * about the sidebar's forwarding path even if the rail's rows are later
 * rewritten.
 */

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string) => key}),
}));

function slotStub(marker: string) {
    return {default: defineComponent({
        inheritAttrs: false,
        setup: (_props, {slots}) => () => h('div', {[marker]: ''}, slots.default?.()),
    })};
}

vi.mock('@app/components/document-viewer/DocumentBookmarkToolbar.vue', () => slotStub('data-bookmark-toolbar-stub'));
vi.mock('@app/components/document-viewer/DocumentBookmarkTree.vue', () => slotStub('data-bookmark-tree-stub'));
vi.mock('@app/components/document-viewer/DocumentPanelEmptyState.vue', () => slotStub('data-empty-state-stub'));
vi.mock('@app/components/document-viewer/DocumentSearchPanel.vue', () => slotStub('data-search-stub'));
vi.mock('@app/components/document-viewer/DocumentSidebarPagesPanel.vue', () => slotStub('data-pages-panel-stub'));
vi.mock('@app/components/sidebar/AppSidebarShell.vue', () => slotStub('data-shell-stub'));

/**
 * A rail that emits the very click it received, so the consumer's event can be
 * compared by identity rather than by shape.
 */
vi.mock('@app/components/document-viewer/DocumentThumbnailList.vue', () => ({default: defineComponent({
    emits: ['go-to-page'],
    setup: (_props, {emit}) => () => h('button', {
        'data-thumbnail-stub': '',
        onClick: (event: MouseEvent) => emit('go-to-page', 4, event),
    }),
})}));

function createThumbnailSource(): IDocumentPageSource {
    return {
        kind: 'djvu',
        documentRef: requireDocumentRef('/tmp/test.djvu'),
        pageCount: 4,
        // Present only so the sidebar counts pages as an available capability;
        // the stubbed rail never asks it for a surface.
        thumbnailProvider: {renderThumbnail: vi.fn(async () => {
            throw new Error('the stubbed rail renders no thumbnails');
        })},
        getPageMetrics: vi.fn(async () => ({
            widthPoints: 500,
            heightPoints: 700,
            rotation: 0 as const,
        })),
        renderPage: vi.fn(async () => {
            throw new Error('this scenario renders no pages');
        }),
        dispose: vi.fn(),
    };
}

interface INavigation {
    event: MouseEvent | undefined;
    pageNumber: number;
}

async function mountSidebar() {
    const navigations: INavigation[] = [];
    const mounted = await mountDocumentSidebarHost(() => h(DocumentSourceSidebar, {
        activeTab: 'thumbnails',
        currentPage: 1,
        searchSession: createDocumentSearchSessionDouble(),
        source: createThumbnailSource(),
        onGoToPage: (pageNumber: number, event?: MouseEvent) => navigations.push({
            event,
            pageNumber,
        }),
    }));
    const rail = mounted.host.querySelector<HTMLElement>('[data-thumbnail-stub]');
    if (!rail) {
        throw new Error('the thumbnail rail is not rendered');
    }
    return {
        navigations,
        rail,
    };
}

afterEach(unmountDocumentSidebarHosts);

describe('DocumentSourceSidebar activation forwarding', () => {
    it('re-emits the rail\'s own activation event object', async () => {
        const sidebar = await mountSidebar();
        const click = new MouseEvent('click', {
            bubbles: true,
            ctrlKey: true,
        });

        sidebar.rail.dispatchEvent(click);

        expect(sidebar.navigations).toHaveLength(1);
        expect(sidebar.navigations[0]?.pageNumber).toBe(4);
        expect(sidebar.navigations[0]?.event).toBe(click);
        expect(sidebar.navigations[0]?.event?.ctrlKey).toBe(true);
    });

    it('forwards a second activation as its own distinct event', async () => {
        const sidebar = await mountSidebar();
        const first = new MouseEvent('click', {bubbles: true});
        const second = new MouseEvent('click', {
            bubbles: true,
            shiftKey: true,
        });

        sidebar.rail.dispatchEvent(first);
        sidebar.rail.dispatchEvent(second);

        expect(sidebar.navigations.map(navigation => navigation.event)).toEqual([
            first,
            second,
        ]);
        expect(sidebar.navigations[1]?.event?.shiftKey).toBe(true);
    });
});
