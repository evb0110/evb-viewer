import type * as TViMockOriginalModule from '@app/composables/useTypedI18n';

import { requirePageIndex } from '@contracts/pageNumbers';
// @vitest-environment happy-dom

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
    IBookmarkItem,
    IBookmarkStyleSummary,
} from '@app/types/pdfOutline';
import { BOOKMARK_COLOR_PRESETS } from '@app/constants/pdfColors';
import PdfOutlineContextMenu from '@app/modules/pdf-viewer/components/PdfOutlineContextMenu.vue';

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

const bookmark: IBookmarkItem = {
    id: 'first',
    title: 'First',
    dest: null,
    pageIndex: requirePageIndex(0),
    bold: false,
    italic: false,
    color: null,
    items: [],
};

function styleSummary(overrides: Partial<IBookmarkStyleSummary> = {}): IBookmarkStyleSummary {
    return {
        targetCount: 1,
        bold: 'off',
        italic: 'off',
        color: null,
        colorMixed: false,
        ...overrides,
    };
}

const activeUnmounts = new Set<() => void>();

afterEach(() => {
    for (const unmount of [...activeUnmounts]) {
        unmount();
    }
});

async function mountMenu(summary: IBookmarkStyleSummary) {
    const state = reactive({summary});
    const colorEvents: Array<{
        id: string;
        color: string | null;
    }> = [];
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(defineComponent({setup: () => () => h(PdfOutlineContextMenu, {
        visible: true,
        x: 0,
        y: 0,
        bookmark,
        styleSummary: state.summary,
        removeLabel: 'remove',
        onSetColor: (payload: {
            id: string;
            color: string | null;
        }) => colorEvents.push(payload),
    })}));
    app.component('UIcon', IconStub);
    app.mount(host);
    await nextTick();
    const unmount = () => {
        app.unmount();
        host.remove();
        activeUnmounts.delete(unmount);
    };
    activeUnmounts.add(unmount);
    return {
        host,
        state,
        colorEvents,
    };
}

function swatches(host: HTMLElement) {
    return [...host.querySelectorAll<HTMLButtonElement>('.bookmarks-context-menu-color-row .bookmarks-color-swatch')];
}

describe('PdfOutlineContextMenu style controls', () => {
    it('leads the color row with a default-color swatch that clears the color', async () => {
        const {
            host,
            colorEvents,
        } = await mountMenu(styleSummary());
        const [
            reset,
            ...presets
        ] = swatches(host);

        expect(reset?.getAttribute('aria-label')).toBe('bookmarks.defaultColor');
        expect(reset?.hasAttribute('title')).toBe(false);
        expect(reset?.classList.contains('is-active')).toBe(true);
        expect(reset?.getAttribute('aria-pressed')).toBe('true');
        expect(presets.map(swatch => swatch.getAttribute('aria-pressed'))).toEqual(
            BOOKMARK_COLOR_PRESETS.map(() => 'false'),
        );
        expect(presets.map(swatch => swatch.classList.contains('is-active'))).toEqual(
            BOOKMARK_COLOR_PRESETS.map(() => false),
        );

        reset?.click();
        expect(colorEvents).toEqual([{
            id: 'first',
            color: null,
        }]);
    });

    it('marks the matching preset active and no swatch when colors are mixed', async () => {
        const {
            host,
            state,
        } = await mountMenu(styleSummary({color: BOOKMARK_COLOR_PRESETS[1]}));
        const [
            reset,
            ...presets
        ] = swatches(host);

        expect(reset?.classList.contains('is-active')).toBe(false);
        expect(reset?.getAttribute('aria-pressed')).toBe('false');
        expect(presets[1]?.classList.contains('is-active')).toBe(true);
        expect(presets[1]?.getAttribute('aria-pressed')).toBe('true');

        state.summary = styleSummary({colorMixed: true});
        await nextTick();
        expect(swatches(host).some(swatch => swatch.classList.contains('is-active'))).toBe(false);
        expect(swatches(host).every(swatch => swatch.getAttribute('aria-pressed') === 'false')).toBe(true);
    });

    it('reports a mixed bold selection as an indeterminate toggle', async () => {
        const {host} = await mountMenu(styleSummary({
            targetCount: 2,
            bold: 'mixed',
            italic: 'on',
        }));
        const [
            boldToggle,
            italicToggle,
        ] = host.querySelectorAll<HTMLButtonElement>('.bookmarks-style-toggle');

        expect(boldToggle?.getAttribute('aria-pressed')).toBe('mixed');
        expect(boldToggle?.classList.contains('is-mixed')).toBe(true);
        expect(boldToggle?.getAttribute('aria-label')).toBe('bookmarks.enableBold');
        expect(boldToggle?.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('i-ph-text-b-bold');
        expect(italicToggle?.getAttribute('aria-pressed')).toBe('true');
        expect(italicToggle?.getAttribute('aria-label')).toBe('bookmarks.disableItalic');
        expect(host.querySelector('.bookmarks-context-menu-style-scope')?.textContent?.trim())
            .toBe('bookmarks.styleSelectedBookmarks');
    });
});
