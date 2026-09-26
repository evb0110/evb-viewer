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
    createApp,
    defineComponent,
    h,
    nextTick,
    reactive,
} from 'vue';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/engine/pdf-outline-navigation/scrollToPageOptions';
import PdfThumbnails from '@app/modules/pdf-viewer/components/PdfThumbnails.vue';
import {
    createDocumentThumbnailSourceHarness,
    installDocumentThumbnailListEnvironment,
    restoreDocumentThumbnailListEnvironment,
    settleDocumentThumbnailList,
} from '@tests/helpers/document-viewer/documentThumbnailListHarness';

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
    isActive: boolean;
    selectedPages: number[];
    totalPages: number;
}

const activeUnmounts = new Set<() => void>();

beforeEach(installDocumentThumbnailListEnvironment);
afterEach(() => {
    for (const unmount of [...activeUnmounts]) {
        unmount();
    }
    restoreDocumentThumbnailListEnvironment();
});

async function mountThumbnails(overrides: Partial<IThumbnailHarnessState> = {}) {
    const state = reactive<IThumbnailHarnessState>({
        currentPage: 3,
        isActive: true,
        selectedPages: [2],
        totalPages: 12,
        ...overrides,
    });
    const {source} = createDocumentThumbnailSourceHarness(state.totalPages);
    const goToPage: Array<{
        page: number;
        options?: IScrollToPageOptions | undefined;
    }> = [];
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(defineComponent({setup: () => () => h(PdfThumbnails, {
        source,
        currentPage: state.currentPage,
        totalPages: state.totalPages,
        selectedPages: state.selectedPages,
        isActive: state.isActive,
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
    await settleDocumentThumbnailList();
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
    };
}

function rows(host: HTMLElement) {
    return [...host.querySelectorAll<HTMLElement>('[data-thumbnail-page]')];
}

function row(host: HTMLElement, page: number) {
    const found = host.querySelector<HTMLElement>(`[data-thumbnail-page="${page}"]`);
    expect(found).not.toBeNull();
    return found!;
}

function tabStopPages(host: HTMLElement) {
    return rows(host)
        .filter(element => element.getAttribute('tabindex') === '0')
        .map(element => Number(element.dataset.thumbnailPage));
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
        await settleDocumentThumbnailList();
        expect(document.activeElement).toBe(row(host, 4));

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
        await settleDocumentThumbnailList();
        expect(document.activeElement).toBe(row(host, 4));

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
        await settleDocumentThumbnailList();
        expect(document.activeElement).toBe(row(host, 4));

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

    it('reveals a row outside the mounted window before moving focus to it', async () => {
        const {host} = await mountThumbnails({
            currentPage: 3,
            selectedPages: [],
            totalPages: 300,
        });
        expect(rows(host).map(element => Number(element.dataset.thumbnailPage))).not.toContain(300);

        row(host, 3).focus();
        pressKey(row(host, 3), 'End');
        await settleDocumentThumbnailList();

        expect(tabStopPages(host)).toEqual([300]);
        expect(document.activeElement).toBe(row(host, 300));
    });
});
