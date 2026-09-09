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
import type {
    IDocumentBookmarkTreeItem,
    TDocumentBookmarkDisplayMode,
} from '@app/utils/document-viewer/bookmarks/documentBookmarks';
import DocumentBookmarkTree from '@app/components/document-viewer/DocumentBookmarkTree.vue';

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string) => key}),
}));

const IconStub = defineComponent({
    props: {name: {
        type: String,
        required: true,
    }},
    setup: props => () => h('i', {'data-icon': props.name}),
});

interface IBookmarkTreeHarnessState {
    items: IDocumentBookmarkTreeItem[];
    activeId: string | null;
    displayMode: TDocumentBookmarkDisplayMode;
    expandedIds: ReadonlySet<string>;
    activePathIds: ReadonlySet<string>;
}

function bookmark(
    id: string,
    children: IDocumentBookmarkTreeItem[] = [],
    overrides: Partial<IDocumentBookmarkTreeItem> = {},
): IDocumentBookmarkTreeItem {
    return {
        id,
        title: `Bookmark ${id}`,
        pageNumber: null,
        children,
        ...overrides,
    };
}

function harnessState(overrides: Partial<IBookmarkTreeHarnessState> = {}) {
    return reactive<IBookmarkTreeHarnessState>({
        items: [
            bookmark('a', [
                bookmark('a1', [bookmark('a2')]),
                bookmark('a3'),
            ]),
            bookmark('b'),
        ],
        activeId: null,
        displayMode: 'all-expanded',
        expandedIds: new Set<string>(),
        activePathIds: new Set<string>(),
        ...overrides,
    });
}

const activeUnmounts = new Set<() => void>();
const revealTrackerRestores: Array<() => void> = [];

afterEach(() => {
    for (const unmount of [...activeUnmounts]) {
        unmount();
    }
    for (const restore of revealTrackerRestores.splice(0)) {
        restore();
    }
});

async function mountTree(state: IBookmarkTreeHarnessState) {
    const events: Array<{
        name: 'activate' | 'toggle-expand';
        id: string;
    }> = [];
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(defineComponent({setup: () => () => h(DocumentBookmarkTree, {
        items: state.items,
        activeId: state.activeId,
        displayMode: state.displayMode,
        expandedIds: state.expandedIds,
        activePathIds: state.activePathIds,
        onActivate: (id: string) => events.push({
            name: 'activate',
            id,
        }),
        onToggleExpand: (id: string) => events.push({
            name: 'toggle-expand',
            id,
        }),
    })}));
    app.component('UIcon', IconStub);
    app.mount(host);
    // useVirtualList fills its rendered window from a pre-flush watch that
    // fires after the container ref binds, so rows exist only after a tick.
    await nextTick();
    const unmount = () => {
        app.unmount();
        host.remove();
        activeUnmounts.delete(unmount);
    };
    activeUnmounts.add(unmount);
    return {
        host,
        events,
        unmount,
    };
}

function renderedIds(host: HTMLElement) {
    return [...host.querySelectorAll<HTMLElement>('[data-bookmark-id]')]
        .map(row => row.dataset.bookmarkId);
}

type TScrollIntoView = (...args: unknown[]) => void;

/**
 * happy-dom leaves `scrollIntoView` unimplemented, so patching it is both the
 * stub the component needs and the record of which row it revealed.
 */
function trackRevealedRows() {
    const revealed: string[] = [];
    const prototype = Element.prototype as Element & {scrollIntoView?: TScrollIntoView};
    const original = prototype.scrollIntoView;
    prototype.scrollIntoView = function trackReveal(this: HTMLElement) {
        revealed.push(this.dataset.bookmarkId ?? '');
    };
    revealTrackerRestores.push(() => {
        prototype.scrollIntoView = original;
    });
    return revealed;
}

function row(host: HTMLElement, id: string) {
    const found = host.querySelector<HTMLElement>(`[data-bookmark-id="${id}"]`);
    expect(found).not.toBeNull();
    return found!;
}

describe('DocumentBookmarkTree', () => {
    it('flattens every level with depth indents in all-expanded mode', async () => {
        const {host} = await mountTree(harnessState());
        expect(renderedIds(host)).toEqual([
            'a',
            'a1',
            'a2',
            'a3',
            'b',
        ]);
        expect(row(host, 'a').getAttribute('style')).toContain('calc(0 *');
        expect(row(host, 'a1').getAttribute('style')).toContain('calc(1 *');
        expect(row(host, 'a2').getAttribute('style')).toContain('calc(2 *');
    });

    it('collapses children behind expandedIds in top-level mode and follows toggles', async () => {
        const state = harnessState({displayMode: 'top-level'});
        const {host} = await mountTree(state);
        expect(renderedIds(host)).toEqual([
            'a',
            'b',
        ]);
        state.expandedIds = new Set(['a']);
        await nextTick();
        expect(renderedIds(host)).toEqual([
            'a',
            'a1',
            'a3',
            'b',
        ]);
    });

    it('expands the active path without collapsing disclosed branches', async () => {
        const state = harnessState({
            displayMode: 'current-expanded',
            expandedIds: new Set(['a1']),
            activePathIds: new Set([
                'a',
                'a1',
            ]),
        });
        const {host} = await mountTree(state);
        expect(renderedIds(host)).toEqual([
            'a',
            'a1',
            'a2',
            'a3',
            'b',
        ]);
        state.activePathIds = new Set(['a']);
        await nextTick();
        expect(renderedIds(host)).toEqual([
            'a',
            'a1',
            'a2',
            'a3',
            'b',
        ]);
    });

    it('marks the active row', async () => {
        const {host} = await mountTree(harnessState({activeId: 'b'}));
        const activeRow = row(host, 'b');
        expect(activeRow.classList.contains('is-active')).toBe(true);
        expect(activeRow.getAttribute('aria-current')).toBe('location');
        expect(row(host, 'a').classList.contains('is-active')).toBe(false);
    });

    it('emits activate on row click and toggle-expand without activate on the caret', async () => {
        const state = harnessState({
            displayMode: 'top-level',
            expandedIds: new Set(['a']),
        });
        const {
            host,
            events,
        } = await mountTree(state);
        row(host, 'a3').click();
        expect(events).toEqual([{
            name: 'activate',
            id: 'a3',
        }]);
        const toggle = row(host, 'a').querySelector<HTMLElement>('.document-bookmark-item__toggle');
        expect(toggle).not.toBeNull();
        toggle!.click();
        expect(events).toEqual([
            {
                name: 'activate',
                id: 'a3',
            },
            {
                name: 'toggle-expand',
                id: 'a',
            },
        ]);
    });

    it('reflects the expansion state on the caret button', async () => {
        const state = harnessState({
            displayMode: 'top-level',
            expandedIds: new Set(['a']),
        });
        const {host} = await mountTree(state);
        const expandedToggle = row(host, 'a').querySelector('.document-bookmark-item__toggle')!;
        expect(expandedToggle.getAttribute('aria-expanded')).toBe('true');
        const collapsedToggle = row(host, 'a1').querySelector('.document-bookmark-item__toggle')!;
        expect(collapsedToggle.getAttribute('aria-expanded')).toBe('false');
        expect(row(host, 'a3').querySelector('.document-bookmark-item__toggle')).toBeNull();
    });

    it('reveals the nearest visible ancestor when collapsed ancestors hide the active row', async () => {
        const state = harnessState({
            displayMode: 'top-level',
            expandedIds: new Set(['a']),
            activePathIds: new Set([
                'a',
                'a1',
                'a2',
            ]),
        });
        const scrolled = trackRevealedRows();
        const {host} = await mountTree(state);

        state.activeId = 'a2';
        await nextTick();
        await nextTick();

        expect(renderedIds(host)).not.toContain('a2');
        expect(scrolled).toEqual(['a1']);
    });

    it('re-reveals the active row when a display-mode change makes it visible', async () => {
        const state = harnessState({
            displayMode: 'top-level',
            expandedIds: new Set(),
            activePathIds: new Set([
                'a',
                'a1',
                'a2',
            ]),
            activeId: 'a2',
        });
        const scrolled = trackRevealedRows();
        const {host} = await mountTree(state);

        state.displayMode = 'all-expanded';
        await nextTick();
        await nextTick();

        expect(renderedIds(host)).toContain('a2');
        expect(scrolled).toEqual(['a2']);
    });

    it('reveals the active row once expansion uncovers it, without rewriting expansion', async () => {
        const state = harnessState({
            displayMode: 'top-level',
            expandedIds: new Set(),
            activePathIds: new Set([
                'a',
                'a1',
                'a2',
            ]),
            activeId: 'a2',
        });
        const scrolled = trackRevealedRows();
        const {events} = await mountTree(state);

        state.expandedIds = new Set([
            'a',
            'a1',
        ]);
        await nextTick();
        await nextTick();
        expect(scrolled).toEqual(['a2']);

        // A re-emitted expansion set keeps the same reveal target, so the tree
        // leaves the user's scroll position alone.
        state.expandedIds = new Set([
            'a',
            'a1',
        ]);
        await nextTick();
        await nextTick();

        expect(scrolled).toEqual(['a2']);
        expect(state.expandedIds).toEqual(new Set([
            'a',
            'a1',
        ]));
        expect(events).toEqual([]);
    });

    it('falls back to the untitled label and applies bookmark text styling', async () => {
        const {host} = await mountTree(harnessState({items: [
            bookmark('untitled', [], {title: ''}),
            bookmark('styled', [], {
                bold: true,
                italic: true,
                color: '#ff0000',
            }),
        ]}));
        const untitled = row(host, 'untitled').querySelector('.document-bookmark-item__title')!;
        expect(untitled.textContent?.trim()).toBe('bookmarks.untitled');
        const styled = row(host, 'styled').querySelector('.document-bookmark-item__title')!;
        const style = styled.getAttribute('style') ?? '';
        expect(style).toContain('font-weight: 600');
        expect(style).toContain('font-style: italic');
        // happy-dom may serialize the hex color as rgb().
        expect(style).toMatch(/color: (#ff0000|rgb\(255, 0, 0\))/);
    });
});
