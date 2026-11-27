// @vitest-environment happy-dom

import type * as TViMockOriginalModule from '@app/composables/useTypedI18n';

import {
    afterEach,
    describe,
    expect,
    inject,
    it,
    vi,
} from 'vitest';
import {
    createApp,
    defineComponent,
    h,
    nextTick,
} from 'vue';
import type { IDocumentBookmarkTreeItem } from '@app/modules/document-viewer/bookmarks/documentBookmarks';
import DocumentBookmarkTree from '@app/components/document-viewer/DocumentBookmarkTree.vue';
import {
    closeChromiumBrowser,
    connectOrLaunchChromium,
} from './browserIntegrationChromium';

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

const activeUnmounts = new Set<() => void>();

afterEach(() => {
    for (const unmount of [...activeUnmounts]) {
        unmount();
    }
});

async function renderBookmarkTreeSnapshot(items: IDocumentBookmarkTreeItem[]) {
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(defineComponent({setup: () => () => h(DocumentBookmarkTree, {
        items,
        activeId: null,
        displayMode: 'all-expanded',
        expandedIds: new Set<string>(),
        activePathIds: new Set<string>(),
    })}));
    app.component('UIcon', IconStub);
    app.component('AppTooltip', defineComponent({
        inheritAttrs: false,
        setup: (_props, {slots}) => () => slots.default?.(),
    }));
    app.mount(host);
    await nextTick();
    const unmount = () => {
        app.unmount();
        host.remove();
        activeUnmounts.delete(unmount);
    };
    activeUnmounts.add(unmount);
    const compiledStyles = [...document.head.querySelectorAll('style')]
        .map(style => style.outerHTML)
        .join('\n');
    return {
        compiledStyles,
        markup: host.innerHTML,
    };
}

describe('DocumentBookmarkTree visual styling in Chromium', () => {
    it('computes real depth indentation and bookmark title styling from scoped CSS', async () => {
        const origin = inject('browserIntegrationOrigin');
        const {
            compiledStyles,
            markup,
        } = await renderBookmarkTreeSnapshot([
            bookmark('a', [
                bookmark('a1', [bookmark('a2')]),
            ]),
            bookmark('styled', [], {
                bold: true,
                italic: true,
                color: '#ff0000',
            }),
        ]);
        expect(compiledStyles.length).toBeGreaterThan(0);

        const browser = await connectOrLaunchChromium();
        try {
            const page = await browser.newPage();
            const url = `${origin}/__bookmark-tree-visual`;
            await page.route(url, route => route.fulfill({
                contentType: 'text/html',
                body: `<!doctype html><html><head>${compiledStyles}</head><body><div id="mount" style="width: 320px; height: 400px">${markup}</div></body></html>`,
            }));
            await page.goto(url, {waitUntil: 'domcontentloaded'});
            await page.evaluate('import(\'/_nuxt/assets/css/main.css\').then(() => undefined)');

            const metrics = await page.evaluate(() => {
                const readRow = (id: string) => {
                    const element = document.querySelector<HTMLElement>(`[data-bookmark-id="${id}"]`);
                    if (!element) {
                        throw new Error(`Missing bookmark row ${id}`);
                    }
                    const style = getComputedStyle(element);
                    const title = element.querySelector<HTMLElement>('.document-bookmark-item__title');
                    if (!title) {
                        throw new Error(`Missing bookmark title ${id}`);
                    }
                    const titleStyle = getComputedStyle(title);
                    return {
                        marginInlineStart: Number.parseFloat(style.marginInlineStart),
                        left: element.getBoundingClientRect().left,
                        fontWeight: titleStyle.fontWeight,
                        fontStyle: titleStyle.fontStyle,
                        color: titleStyle.color,
                    };
                };
                return {
                    depth0: readRow('a'),
                    depth1: readRow('a1'),
                    depth2: readRow('a2'),
                    styled: readRow('styled'),
                };
            });

            expect(metrics.depth0.marginInlineStart).toBe(0);
            expect(metrics.depth1.marginInlineStart).toBeGreaterThan(0);
            expect(metrics.depth2.marginInlineStart).toBeCloseTo(metrics.depth1.marginInlineStart * 2, 1);
            expect(metrics.depth1.left - metrics.depth0.left).toBeCloseTo(metrics.depth1.marginInlineStart, 1);
            expect(metrics.depth2.left - metrics.depth0.left).toBeCloseTo(metrics.depth2.marginInlineStart, 1);

            expect(metrics.depth0.fontWeight).toBe('500');
            expect(metrics.depth0.fontStyle).toBe('normal');

            expect(metrics.styled.fontWeight).toBe('600');
            expect(metrics.styled.fontStyle).toBe('italic');
            expect(metrics.styled.color).toBe('rgb(255, 0, 0)');
        } finally {
            await closeChromiumBrowser(browser);
        }
    });
});
