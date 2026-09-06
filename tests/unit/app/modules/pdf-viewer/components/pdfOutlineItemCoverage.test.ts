// @vitest-environment happy-dom

import {
    computed,
    createApp,
    defineComponent,
    h,
    ref,
} from 'vue';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {IBookmarkItem} from '@app/types/pdfOutline';
import type {IPdfOutlineTreeContext} from '@app/modules/pdf-viewer/engine/pdf-outline-tree-context/pdfOutlineTreeContext';
import { pdfOutlineTreeKey } from '@app/modules/pdf-viewer/engine/pdf-outline-tree-context/pdfOutlineTreeKey';
import PdfOutlineItem from '@app/modules/pdf-viewer/components/PdfOutlineItem.vue';
import { cast } from '@tests/helpers/cast';

vi.mock('@app/composables/useTypedI18n', () => ({useTypedI18n: () => ({t: (key: string) => key})}));

const AppTooltipStub = defineComponent({
    inheritAttrs: false,
    setup: (_props, {slots}) => () => slots.default?.(),
});

const IconStub = defineComponent({
    props: {name: {
        type: String,
        required: true,
    }},
    setup: props => () => h('i', {'data-icon': props.name}),
});

const mountedApps = new Set<{
    app: ReturnType<typeof createApp>;
    host: HTMLDivElement;
}>();

afterEach(() => {
    for (const mounted of mountedApps) {
        mounted.app.unmount();
        mounted.host.remove();
    }
    mountedApps.clear();
});

function createTreeContext(): IPdfOutlineTreeContext {
    return cast<IPdfOutlineTreeContext>({
        expandedBookmarkIds: ref(new Set<string>()),
        activeItemId: ref(null),
        editingItemId: ref(null),
        selectedBookmarkIds: ref(new Set<string>()),
        displayMode: ref('all-expanded'),
        isEditMode: computed(() => false),
        draggingItemIds: ref(new Set<string>()),
        dropTarget: ref(null),
        activePathBookmarkIds: computed(() => new Set<string>()),
        beginBookmarkNavigationRequest: () => 1,
        isBookmarkNavigationRequestCurrent: () => true,
    });
}

function createBookmark(): IBookmarkItem {
    return {
        id: 'bookmark-1',
        title: 'First bookmark',
        pageIndex: 0,
        pageYRatio: null,
        dest: null,
        bold: false,
        italic: false,
        color: null,
        items: [],
    };
}

describe('PdfOutlineItem', () => {
    it('renders a bookmark item against the renderer-owned document contract', () => {
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp(defineComponent({setup: () => () => h(PdfOutlineItem, {
            item: createBookmark(),
            pdfDocument: null,
        })}));
        app.component('AppTooltip', AppTooltipStub);
        app.component('UIcon', IconStub);
        app.provide(pdfOutlineTreeKey, createTreeContext());
        app.mount(host);
        mountedApps.add({
            app,
            host,
        });

        expect(host.querySelector('.pdf-bookmark-item-title')?.textContent)
            .toBe('First bookmark');
    });
});
