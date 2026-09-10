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
    IAnnotationCommentSummary,
    IAnnotationInventoryCompleteness,
    TAnnotationCommentsStatus,
} from '@app/types/annotations';
import PdfAnnotationCommentsList from '@app/modules/pdf-viewer/components/PdfAnnotationCommentsList.vue';

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string) => key}),
}));

function stubElement(tag: string, marker: string) {
    return defineComponent({
        inheritAttrs: false,
        setup: (_props, {
            attrs,
            slots,
        }) => () => h(tag, {
            ...attrs,
            [marker]: '',
        }, slots.default?.()),
    });
}

const activeUnmounts = new Set<() => void>();

afterEach(() => {
    for (const unmount of [...activeUnmounts]) {
        unmount();
    }
});

function mountCommentsList(overrides: {
    inventory?: IAnnotationInventoryCompleteness | null;
    status?: TAnnotationCommentsStatus;
    comments?: IAnnotationCommentSummary[];
} = {}) {
    const state = reactive<{
        inventory: IAnnotationInventoryCompleteness | null;
        status: TAnnotationCommentsStatus;
    }>({
        inventory: overrides.inventory ?? null,
        status: overrides.status ?? 'ready',
    });
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(defineComponent({setup: () => () => h(PdfAnnotationCommentsList, {
        comments: overrides.comments ?? [],
        status: state.status,
        inventory: state.inventory,
    })}));
    app.component('UButton', stubElement('button', 'data-ubutton-stub'));
    app.component('UIcon', stubElement('span', 'data-uicon-stub'));
    app.mount(host);
    const unmount = () => {
        app.unmount();
        host.remove();
        activeUnmounts.delete(unmount);
    };
    activeUnmounts.add(unmount);

    return {
        host,
        state,
        unmount,
        readNotice: () => host.querySelector('[data-testid="annotation-inventory-incomplete"]'),
    };
}

function createCompleteness(
    overrides: Partial<IAnnotationInventoryCompleteness> = {},
): IAnnotationInventoryCompleteness {
    return {
        complete: false,
        omissions: ['page-parse-failure'],
        scannedPageCount: 2,
        totalPageCount: 3,
        failedPageCount: 1,
        ...overrides,
    };
}

describe('PdfAnnotationCommentsList incomplete inventory', () => {
    it('announces unreadable pages with accessible live-region copy', () => {
        const { readNotice } = mountCommentsList({ inventory: createCompleteness() });

        const notice = readNotice();
        expect(notice).not.toBeNull();
        expect(notice?.getAttribute('role')).toBe('status');
        expect(notice?.getAttribute('aria-live')).toBe('polite');
        expect(notice?.textContent).toContain('annotations.inventoryIncompleteTitle');
        expect(notice?.textContent).toContain('annotations.inventoryIncompleteUnreadablePages');
        expect(notice?.textContent).not.toContain('annotations.inventoryIncompleteScanLimit');
    });

    it('explains a cap-truncated scan without blaming unreadable pages', () => {
        const { readNotice } = mountCommentsList({ inventory: createCompleteness({
            omissions: ['page-cap'],
            failedPageCount: 0,
        }) });

        expect(readNotice()?.textContent).toContain('annotations.inventoryIncompleteScanLimit');
        expect(readNotice()?.textContent).not.toContain('annotations.inventoryIncompleteUnreadablePages');
    });

    it('lists both causes when a scan both failed a page and hit a cap', () => {
        const { readNotice } = mountCommentsList({ inventory: createCompleteness({ omissions: [
            'record-cap',
            'page-parse-failure',
        ] }) });

        const text = readNotice()?.textContent ?? '';
        expect(text).toContain('annotations.inventoryIncompleteUnreadablePages');
        expect(text).toContain('annotations.inventoryIncompleteScanLimit');
    });

    it('stays visible while the list is still loading', () => {
        const { readNotice } = mountCommentsList({
            inventory: createCompleteness(),
            status: 'loading',
        });

        expect(readNotice()).not.toBeNull();
    });

    it('shows nothing for an unreported or complete inventory', async () => {
        const {
            readNotice,
            state,
        } = mountCommentsList();
        expect(readNotice()).toBeNull();

        state.inventory = {
            complete: true,
            omissions: [],
            scannedPageCount: 3,
            totalPageCount: 3,
            failedPageCount: 0,
        };
        await nextTick();
        expect(readNotice()).toBeNull();
    });

    it('clears the notice when a later scan recovers the missing pages', async () => {
        const {
            readNotice,
            state,
        } = mountCommentsList({ inventory: createCompleteness() });
        expect(readNotice()).not.toBeNull();

        state.inventory = {
            complete: true,
            omissions: [],
            scannedPageCount: 3,
            totalPageCount: 3,
            failedPageCount: 0,
        };
        await nextTick();

        expect(readNotice()).toBeNull();
    });
});
