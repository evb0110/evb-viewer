// @vitest-environment happy-dom

import type * as TViMockOriginalModule from '@app/composables/useTypedI18n';

import { chromium } from 'playwright';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { nextTick } from 'vue';
import type { ISerializedElement } from '@tests/helpers/serializeDomElement';
import { compileAppStylesheet } from '@tests/helpers/compileAppStylesheet';
import { resolveAnnotationCommentRowMetrics } from '@app/utils/pdfAnnotationCommentRowMetrics';
import { serializeDomElement } from '@tests/helpers/serializeDomElement';
import {
    ANNOTATION_COMMENT_FIXTURE_COUNT,
    ANNOTATION_COMMENT_UI_SCALE_MATRIX,
    applyRootFontSizePx,
    mountAnnotationCommentsList,
    readRows,
    readWrapper,
    unmountAnnotationCommentsLists,
} from '@tests/helpers/pdfAnnotationCommentsListHarness';

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string) => key}),
}));

const ACTIVE_COMMENT_INDEX = 2;
const SIDEBAR_HEIGHT_PX = 480;
const SIDEBAR_WIDTH_PX = 320;
const BROWSER_TEST_TIMEOUT_MS = 120_000;

interface IPaintedRowGeometry {
    activeRowCount: number;
    containerScrollHeightPx: number;
    firstRowTopPx: number;
    rowBoxSizings: string[];
    rowOverflows: string[];
    rowVerticalBordersPx: number[];
    rowPaintedHeightsPx: number[];
    rowVerticalPaddingsPx: number[];
    rootFontSizePx: number;
    strideDeltasPx: number[];
    wrapperHeightPx: number;
    wrapperMarginTopPx: number;
    wrapperTopPx: number;
}

/**
 * Vitest compiles the component's `<style lang="scss" scoped>` block through the
 * same Vue plugin the app build uses and injects the result into the test
 * document, so this collects the component's real CSS rather than a copy of it.
 */
function collectCompiledComponentStyles() {
    const styles = [...document.querySelectorAll('style')]
        .map(style => style.textContent ?? '')
        .filter(css => css.trim().length > 0);
    if (!styles.some(css => css.includes('.note-item'))) {
        throw new Error('Vitest did not inject the annotation comments list styles into the test document');
    }
    return styles;
}

/**
 * The utility classes the compiled app stylesheet has to carry are exactly the
 * ones the component put on its own elements, so render it once and read them
 * off. They do not vary with UI scale.
 */
async function harvestUtilityCandidates() {
    const list = mountAnnotationCommentsList({activeIndex: ACTIVE_COMMENT_INDEX});
    await nextTick();
    const candidates = new Set<string>();
    for (const element of list.host.querySelectorAll('[class]')) {
        for (const token of element.getAttribute('class')?.split(/\s+/u) ?? []) {
            if (token) {
                candidates.add(token);
            }
        }
    }
    list.unmount();
    return candidates;
}

function buildPageMarkup(appStylesheet: string, componentStylesheets: string[]) {
    const componentStyles = componentStylesheets
        .map(css => `<style>${css}</style>`)
        .join('\n');
    // The sidebar column the panel really lives in: a definite height and a flex
    // column, so `.notes-list` resolves to a real bounded scroll container.
    return `<!doctype html>
<html>
<head>
<style>${appStylesheet}</style>
${componentStyles}
</head>
<body style="margin: 0">
<div
    id="sidebar"
    style="height: ${String(SIDEBAR_HEIGHT_PX)}px; width: ${String(SIDEBAR_WIDTH_PX)}px; display: flex; flex-direction: column"
></div>
</body>
</html>`;
}

function measurePaintedGeometry(tree: ISerializedElement): IPaintedRowGeometry {
    function rebuild(node: ISerializedElement | string): Node {
        if (typeof node === 'string') {
            return document.createTextNode(node);
        }
        const element = document.createElement(node.tagName);
        for (const [
            name,
            value,
        ] of node.attributes) {
            element.setAttribute(name, value);
        }
        for (const child of node.children) {
            element.append(rebuild(child));
        }
        return element;
    }

    const sidebar = document.querySelector<HTMLElement>('#sidebar');
    if (!sidebar) {
        throw new Error('Layout page lost its sidebar host');
    }
    sidebar.replaceChildren(rebuild(tree));

    const container = sidebar.querySelector<HTMLElement>('.notes-list');
    const wrapper = container?.firstElementChild;
    if (!container || !(wrapper instanceof HTMLElement)) {
        throw new Error('Rendered annotation comments list is missing its scroll container or virtual wrapper');
    }
    const rows = [...wrapper.children].filter((row): row is HTMLElement => row instanceof HTMLElement);
    const rects = rows.map(row => row.getBoundingClientRect());
    const styles = rows.map(row => globalThis.getComputedStyle(row));

    return {
        activeRowCount: sidebar.querySelectorAll('.note-item.is-active').length,
        containerScrollHeightPx: container.scrollHeight,
        firstRowTopPx: rects[0]?.top ?? Number.NaN,
        rowBoxSizings: styles.map(style => style.boxSizing),
        rowOverflows: styles.map(style => style.overflow),
        rowVerticalBordersPx: styles.map(style =>
            Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth)),
        rowPaintedHeightsPx: rects.map(rect => rect.height),
        rowVerticalPaddingsPx: styles.map(style =>
            Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom)),
        rootFontSizePx: Number.parseFloat(
            globalThis.getComputedStyle(document.documentElement).fontSize,
        ),
        strideDeltasPx: rects.slice(1).map((rect, index) => rect.top - rects[index]!.top),
        wrapperHeightPx: wrapper.getBoundingClientRect().height,
        wrapperMarginTopPx: Number.parseFloat(globalThis.getComputedStyle(wrapper).marginTop),
        wrapperTopPx: wrapper.getBoundingClientRect().top,
    };
}

afterEach(() => {
    unmountAnnotationCommentsLists();
});

describe('annotation comment row geometry in Chromium', () => {
    it('paints the list it rendered on exactly the virtualization stride at every supported UI scale', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            await page.setContent(buildPageMarkup(
                await compileAppStylesheet(await harvestUtilityCandidates()),
                collectCompiledComponentStyles(),
            ));

            for (const scale of ANNOTATION_COMMENT_UI_SCALE_MATRIX) {
                // `useUiScale.applyUiScaleToDocument` writes exactly this property.
                await page.evaluate((uiScale) => {
                    document.documentElement.style.setProperty('--app-ui-scale', String(uiScale));
                }, scale);

                // Chromium owns the rem base: `--app-ui-scale` feeds the product's own
                // `html { font-size: calc(16px * var(--app-ui-scale, 1)) }` rule, and the
                // resolved value is what `useRootFontSize` would read in the app. Render
                // the component against that measurement, then lay its output back out.
                const rootFontSizePx = await page.evaluate(() =>
                    Number.parseFloat(getComputedStyle(document.documentElement).fontSize));
                expect(rootFontSizePx).toBeCloseTo(16 * scale, 3);

                applyRootFontSizePx(rootFontSizePx);
                const list = mountAnnotationCommentsList({activeIndex: ACTIVE_COMMENT_INDEX});
                await nextTick();
                const listRoot = list.host.firstElementChild;
                if (!listRoot) {
                    throw new Error('Annotation comments list rendered no root element');
                }

                const metrics = resolveAnnotationCommentRowMetrics(rootFontSizePx);
                const geometry = await page.evaluate(
                    measurePaintedGeometry,
                    serializeDomElement(listRoot),
                );

                expect(geometry.rowPaintedHeightsPx.length).toBeGreaterThan(1);
                expect(geometry.rootFontSizePx).toBeCloseTo(rootFontSizePx, 5);

                // What a real layout engine paints, measured before anything the
                // component declared is read back: every row occupies the row box the
                // metrics resolve to, and each one starts exactly one stride below the
                // last, so the list can never overlap or gap its rows.
                expect(new Set(geometry.rowPaintedHeightsPx)).toStrictEqual(new Set([metrics.rowHeightPx]));
                expect(new Set(geometry.strideDeltasPx)).toStrictEqual(new Set([metrics.rowStridePx]));
                // The painted window starts where the virtual spacer places it, and the
                // scrollable extent stays one stride per comment.
                expect(geometry.firstRowTopPx).toBeCloseTo(geometry.wrapperTopPx, 5);
                expect(geometry.containerScrollHeightPx)
                    .toBe(ANNOTATION_COMMENT_FIXTURE_COUNT * metrics.rowStridePx);

                // The same numbers, as the component itself declared them: the painted
                // geometry above is the consequence of these, not a coincidence.
                const wrapper = readWrapper(list.host);
                const rows = readRows(list.host);

                expect(rows).toHaveLength(geometry.rowPaintedHeightsPx.length);
                expect(wrapper.marginTopPx + wrapper.heightPx)
                    .toBe(ANNOTATION_COMMENT_FIXTURE_COUNT * metrics.rowStridePx);
                expect(new Set(rows.map(row => row.heightPx))).toStrictEqual(new Set([metrics.rowHeightPx]));
                expect(new Set(rows.map(row => row.gapPx))).toStrictEqual(new Set([metrics.rowGapPx]));
                expect(geometry.wrapperMarginTopPx).toBe(wrapper.marginTopPx);
                expect(geometry.wrapperHeightPx).toBe(wrapper.heightPx);

                // A row that let its padding or its long body escape the pixel budget
                // would paint taller than the stride the list scrolls by; the painted
                // heights above already prove it did not, and these are the properties
                // that keep it that way.
                expect(new Set(geometry.rowBoxSizings)).toStrictEqual(new Set(['border-box']));
                expect(new Set(geometry.rowOverflows)).toStrictEqual(new Set(['hidden']));
                expect(geometry.rowVerticalPaddingsPx.every(padding => padding > 0)).toBe(true);
                expect(geometry.rowVerticalBordersPx.every(border => border > 0)).toBe(true);
                expect(geometry.rowVerticalPaddingsPx.every((padding, index) =>
                    padding + geometry.rowVerticalBordersPx[index]! < geometry.rowPaintedHeightsPx[index]!))
                    .toBe(true);
                expect(geometry.activeRowCount).toBe(1);
                for (const width of [
                    240,
                    SIDEBAR_WIDTH_PX,
                    480,
                ]) {
                    await page.locator('#sidebar').evaluate((sidebar, sidebarWidth) => {
                        (sidebar as HTMLElement).style.width = `${sidebarWidth}px`;
                    }, width);
                    const button = page.locator('.note-item-delete').first();
                    const box = await button.boundingBox();
                    expect(box).not.toBeNull();
                    expect(box!.width).toBeCloseTo(box!.height, 1);
                    for (const [
                        x,
                        y,
                    ] of [
                            [
                                box!.x + 2,
                                box!.y + 2,
                            ],
                            [
                                box!.x + box!.width - 2,
                                box!.y + box!.height - 2,
                            ],
                            [
                                box!.x + box!.width / 2,
                                box!.y + box!.height / 2,
                            ],
                        ]) {
                        await page.mouse.move(x!, y!);
                        expect(await button.evaluate((element, point) => ({
                            hit: element.contains(document.elementFromPoint(point.x, point.y)),
                            hovered: element.matches(':hover'),
                        }), {
                            x: x!,
                            y: y!,
                        })).toEqual({
                            hit: true,
                            hovered: true,
                        });
                    }
                }
                await page.locator('#sidebar').evaluate((sidebar, width) => {
                    (sidebar as HTMLElement).style.width = `${width}px`;
                }, SIDEBAR_WIDTH_PX);

                list.unmount();
            }
        } finally {
            await browser.close();
        }
    }, BROWSER_TEST_TIMEOUT_MS);
});
