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
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/engine/pdf-outline-navigation/scrollToPageOptions';
import PdfThumbnails from '@app/modules/pdf-viewer/components/PdfThumbnails.vue';

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (
        key: string,
        parameters?: Record<string, string | number>,
    ) => (parameters ? `${key}:${String(Object.values(parameters)[0])}` : key)}),
}));

// The reorder/file-drop composable reaches for the Nuxt UI toast singleton,
// which no unit environment provides; the rail's keyboard contract does not
// depend on it.
vi.mock('@app/modules/pdf-viewer/runtime/composables/pdf/usePageDragDrop', async () => {
    const vue = await import('vue');
    return {usePageDragDrop: () => ({
        isDragging: vue.ref(false),
        isExternalDragOver: vue.ref(false),
        draggedPages: vue.ref([] as number[]),
        dropInsertIndex: vue.ref(null),
        handleMouseDown: () => undefined,
        handlePointerCancel: () => undefined,
        consumeClickSkip: () => false,
        handleDragEnter: () => undefined,
        handleDragOver: () => undefined,
        handleDragLeave: () => undefined,
        handleExternalDrop: () => undefined,
    })};
});

const PassThroughStub = defineComponent({setup: (_props, {slots}) => () => h('span', slots.default?.())});

interface IThumbnailHarnessState {
    currentPage: number;
    selectedPages: number[];
    totalPages: number;
}

const activeUnmounts = new Set<() => void>();
const geometryRestores: Array<() => void> = [];

afterEach(() => {
    for (const unmount of [...activeUnmounts]) {
        unmount();
    }
    for (const restore of geometryRestores.splice(0).toReversed()) {
        restore();
    }
});

const RAIL_VIEWPORT_HEIGHT_PX = 400;

/**
 * happy-dom reports zero geometry, which makes the rail read as hidden and
 * freezes the virtualized window. Give the rail (and only the rail, so row
 * chrome measurement keeps its defaults) a real viewport.
 */
function stubRailGeometry() {
    const isRail = (element: HTMLElement) => element.classList.contains('pdf-thumbnails');
    const descriptors: Array<[string, PropertyDescriptor]> = [
        [
            'clientWidth',
            {get(this: HTMLElement) {
                return isRail(this) ? 200 : 0;
            }},
        ],
        [
            'clientHeight',
            {get(this: HTMLElement) {
                return isRail(this) ? RAIL_VIEWPORT_HEIGHT_PX : 0;
            }},
        ],
        [
            'scrollHeight',
            {get(this: HTMLElement) {
                if (!isRail(this)) {
                    return 0;
                }
                const wrapper = this.querySelector<HTMLElement>('.pdf-thumbnails-virtual-wrapper');
                return Number.parseFloat(wrapper?.style.height ?? '0') || 0;
            }},
        ],
    ];
    for (const [
        name,
        descriptor,
    ] of descriptors) {
        const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
        Object.defineProperty(HTMLElement.prototype, name, {
            ...descriptor,
            configurable: true,
        });
        geometryRestores.push(() => {
            if (original) {
                Object.defineProperty(HTMLElement.prototype, name, original);
            } else {
                Reflect.deleteProperty(HTMLElement.prototype, name);
            }
        });
    }

    const originalRectDescriptor = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        'getBoundingClientRect',
    );
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function railRect(this: HTMLElement) {
        return isRail(this)
            ? {
                width: 200,
                height: RAIL_VIEWPORT_HEIGHT_PX,
                top: 0,
                left: 0,
                bottom: RAIL_VIEWPORT_HEIGHT_PX,
                right: 200,
                x: 0,
                y: 0,
                toJSON: () => ({}),
            } as DOMRect
            : originalRect.call(this);
    };
    geometryRestores.push(() => {
        if (originalRectDescriptor) {
            Object.defineProperty(
                HTMLElement.prototype,
                'getBoundingClientRect',
                originalRectDescriptor,
            );
        } else {
            Reflect.deleteProperty(HTMLElement.prototype, 'getBoundingClientRect');
        }
    });
}

async function mountThumbnails(overrides: Partial<IThumbnailHarnessState> = {}) {
    const state = reactive<IThumbnailHarnessState>({
        currentPage: 3,
        selectedPages: [2],
        totalPages: 12,
        ...overrides,
    });
    const goToPage: Array<{
        page: number;
        options?: IScrollToPageOptions | undefined;
    }> = [];
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(defineComponent({setup: () => () => h(PdfThumbnails, {
        pdfDocument: null,
        rasterScheduler: null,
        currentPage: state.currentPage,
        totalPages: state.totalPages,
        selectedPages: state.selectedPages,
        isActive: true,
        'onGo-to-page': (page: number, options?: IScrollToPageOptions) => goToPage.push({
            page,
            options,
        }),
        'onUpdate:selected-pages': (pages: number[]) => {
            state.selectedPages = pages;
        },
    })}));
    app.component('UIcon', PassThroughStub);
    app.component('AppTooltip', PassThroughStub);
    app.mount(host);
    await nextTick();
    const unmount = () => {
        app.unmount();
        host.remove();
        activeUnmounts.delete(unmount);
    };
    activeUnmounts.add(unmount);
    return {
        goToPage,
        host,
        rail: host.querySelector<HTMLElement>('.pdf-thumbnails')!,
        state,
        unmount,
    };
}

function rows(host: HTMLElement) {
    return [...host.querySelectorAll<HTMLElement>('.pdf-thumbnail')];
}

function row(host: HTMLElement, page: number) {
    const found = host.querySelector<HTMLElement>(`.pdf-thumbnail[data-page="${page}"]`);
    expect(found).not.toBeNull();
    return found!;
}

function tabStopPages(host: HTMLElement) {
    return rows(host)
        .filter(element => element.getAttribute('tabindex') === '0')
        .map(element => Number(element.dataset.page));
}

function pressKey(target: HTMLElement, key: string, init: KeyboardEventInit = {}) {
    const event = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        ...init,
    });
    target.dispatchEvent(event);
    return event;
}

describe('PdfThumbnails keyboard navigation', () => {
    it('exposes listbox semantics with one roving tab stop on the current page', async () => {
        const {
            host,
            rail,
        } = await mountThumbnails();

        expect(rail.getAttribute('role')).toBe('listbox');
        expect(rail.getAttribute('aria-multiselectable')).toBe('true');
        expect(rail.getAttribute('tabindex')).toBe('-1');
        expect(rail.firstElementChild?.getAttribute('role')).toBe('presentation');
        expect(rows(host).every(element => element.getAttribute('role') === 'option')).toBe(true);
        expect(tabStopPages(host)).toEqual([3]);
        // Selection stays a separate axis from the roving focus.
        expect(row(host, 2).getAttribute('aria-selected')).toBe('true');
        expect(row(host, 3).getAttribute('aria-selected')).toBe('false');
    });

    it('moves the tab stop and DOM focus with arrow keys without changing selection', async () => {
        const {
            goToPage,
            host,
            state,
        } = await mountThumbnails();
        const currentRow = row(host, 3);
        currentRow.focus();

        const event = pressKey(currentRow, 'ArrowDown');
        await vi.waitFor(() => {
            expect(document.activeElement).toBe(row(host, 4));
        });

        expect(event.defaultPrevented).toBe(true);
        expect(tabStopPages(host)).toEqual([4]);
        expect(state.selectedPages).toEqual([2]);
        expect(goToPage).toEqual([]);
    });

    it('activates the focused row with Enter and Space', async () => {
        const {
            goToPage,
            host,
        } = await mountThumbnails();
        const currentRow = row(host, 3);
        currentRow.focus();
        pressKey(currentRow, 'ArrowDown');
        await vi.waitFor(() => {
            expect(document.activeElement).toBe(row(host, 4));
        });

        pressKey(row(host, 4), 'Enter');
        pressKey(row(host, 4), ' ');

        expect(goToPage).toEqual([
            {
                page: 4,
                options: {navigationSource: 'thumbnail'},
            },
            {
                page: 4,
                options: {navigationSource: 'thumbnail'},
            },
        ]);
    });

    it('extends the selection with Shift+Arrow and carries the roving focus along', async () => {
        const {
            host,
            state,
        } = await mountThumbnails({selectedPages: []});
        const currentRow = row(host, 3);
        currentRow.focus();

        pressKey(currentRow, 'ArrowDown', {shiftKey: true});
        await vi.waitFor(() => {
            expect(document.activeElement).toBe(row(host, 4));
        });

        expect(state.selectedPages).toEqual([
            3,
            4,
        ]);
        expect(tabStopPages(host)).toEqual([4]);
        expect(document.activeElement).toBe(row(host, 4));
    });

    it('leaves keys pressed on a nested control to that control', async () => {
        const {
            goToPage,
            host,
            state,
        } = await mountThumbnails();
        const currentRow = row(host, 3);
        const nestedControl = document.createElement('button');
        currentRow.append(nestedControl);

        const enter = pressKey(nestedControl, 'Enter');
        const arrow = pressKey(nestedControl, 'ArrowDown');
        await nextTick();

        expect(enter.defaultPrevented).toBe(false);
        expect(arrow.defaultPrevented).toBe(false);
        expect(goToPage).toEqual([]);
        expect(tabStopPages(host)).toEqual([3]);

        const toggle = currentRow.querySelector<HTMLButtonElement>('.pdf-thumbnail-selection-toggle')!;
        expect(toggle.tagName).toBe('BUTTON');
        expect(toggle.getAttribute('aria-hidden')).toBeNull();
        expect(toggle.getAttribute('aria-pressed')).toBe('false');
        expect(toggle.getAttribute('aria-label')).toContain('pageOps.selectPage');

        toggle.focus();
        const keyboardEvent = pressKey(toggle, 'Enter');
        await nextTick();
        expect(keyboardEvent.defaultPrevented).toBe(false);
        expect(toggle.getAttribute('aria-pressed')).toBe('false');

        toggle.click();
        await nextTick();
        expect(toggle.getAttribute('aria-pressed')).toBe('true');

        toggle.click();
        await nextTick();
        expect(toggle.getAttribute('aria-pressed')).toBe('false');
        expect(state.selectedPages).toEqual([2]);
        expect(goToPage).toEqual([]);
    });

    it('tracks an external current-page change before keyboard focus enters the rail', async () => {
        const {
            host,
            state,
        } = await mountThumbnails();

        state.currentPage = 6;
        await nextTick();

        expect(tabStopPages(host)).toEqual([6]);
    });

    it('keeps a distant current page row mounted before the hidden rail is measured', async () => {
        const {host} = await mountThumbnails({
            currentPage: 18,
            totalPages: 300,
        });

        expect(row(host, 18).getAttribute('aria-current')).toBe('page');
    });

    it('reveals a virtualized row before moving focus to it', async () => {
        stubRailGeometry();
        const {host} = await mountThumbnails({
            currentPage: 3,
            selectedPages: [],
            totalPages: 300,
        });
        const renderedPages = () => rows(host).map(element => Number(element.dataset.page));
        expect(renderedPages()).not.toContain(300);

        const currentRow = row(host, 3);
        currentRow.focus();
        pressKey(currentRow, 'End');
        await vi.waitFor(() => {
            expect(renderedPages()).toContain(300);
            expect(tabStopPages(host)).toEqual([300]);
            expect(document.activeElement).toBe(row(host, 300));
        });
    });

    it('switches physical segments before focusing a distant keyboard target', async () => {
        stubRailGeometry();
        const {host} = await mountThumbnails({
            currentPage: 3,
            selectedPages: [],
            totalPages: 138_000,
        });
        const rail = host.querySelector<HTMLElement>('.pdf-thumbnails')!;
        const wrapper = host.querySelector<HTMLElement>('.pdf-thumbnails-virtual-wrapper')!;
        expect(Number(wrapper.dataset.thumbnailScrollSegment)).toBe(0);
        expect(rows(host).map(element => Number(element.dataset.page))).not.toContain(138_000);

        row(host, 3).focus();
        pressKey(row(host, 3), 'End');

        await vi.waitFor(() => {
            expect(Number(wrapper.dataset.thumbnailScrollSegment)).toBeGreaterThan(0);
            expect(rows(host).map(element => Number(element.dataset.page))).toContain(138_000);
            expect(rows(host).map(element => Number(element.dataset.page))).not.toContain(3);
            expect(document.activeElement).toBe(row(host, 138_000));
        });
        expect(rail.scrollTop).toBeGreaterThan(0);
    });

    it('switches back to the first physical segment before focusing Home', async () => {
        stubRailGeometry();
        const {
            host,
            rail,
        } = await mountThumbnails({
            currentPage: 3,
            selectedPages: [],
            totalPages: 138_000,
        });
        const wrapper = host.querySelector<HTMLElement>('.pdf-thumbnails-virtual-wrapper')!;

        row(host, 3).focus();
        pressKey(row(host, 3), 'End');
        await vi.waitFor(() => {
            expect(Number(wrapper.dataset.thumbnailScrollSegment)).toBeGreaterThan(0);
            expect(document.activeElement).toBe(row(host, 138_000));
        });

        pressKey(row(host, 138_000), 'Home');
        await vi.waitFor(() => {
            expect(Number(wrapper.dataset.thumbnailScrollSegment)).toBe(0);
            expect(document.activeElement).toBe(row(host, 1));
        });
        expect(rail.scrollTop).toBe(0);
    });
});
