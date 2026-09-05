// @vitest-environment happy-dom

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
    nextTick,
} from 'vue';
import { resolveAnnotationCommentRowMetrics } from '@app/utils/pdfAnnotationCommentRowMetrics';
import { useTypedI18n } from '@app/composables/useTypedI18n';
import { BASE_ROOT_FONT_SIZE_PX } from '@app/utils/rootFontSize';
import {
    ANNOTATION_COMMENT_FIXTURE_COUNT,
    ANNOTATION_COMMENT_UI_SCALE_MATRIX,
    applyUiScale,
    mountAnnotationCommentsList,
    readRows,
    readWrapper,
    unmountAnnotationCommentsLists,
} from '@tests/helpers/pdfAnnotationCommentsListHarness';

vi.mock('@app/composables/useTypedI18n', () => ({useTypedI18n: () => ({t: (key: string) => key})}));

function stub(marker: string) {
    return {default: defineComponent({
        inheritAttrs: false,
        setup: (_props, {attrs}) => () => h('div', {
            ...attrs,
            [marker]: '',
        }),
    })};
}

vi.mock('@app/components/AppSearchInput.vue', () => stub('data-search-input-stub'));
vi.mock('@app/components/document-viewer/DocumentPanelEmptyState.vue', () => stub('data-empty-state-stub'));

afterEach(() => {
    unmountAnnotationCommentsLists();
});

/**
 * A row shows `${t('annotations.page')} ${comment.pageNumber}`, and the fixture at
 * index N carries page number N + 1. Reading the key back through the translator
 * this spec mocked above pins the whole label without restating either the mock's
 * output or a shipped translation.
 */
const { t } = useTypedI18n();

function expectedPageLabel(rowIndex: number) {
    return `${t('annotations.page')} ${rowIndex + 1}`;
}

/**
 * Where the user is looking, in the terms the component's own output offers: the
 * logical row the top edge of the viewport falls in, how deep into the list that
 * is measured in rows, and the label that row is showing. Everything comes from
 * the scroll container and the virtual spacer, never from component internals.
 */
function readViewportTop(host: HTMLElement, container: HTMLElement, stridePx: number) {
    const firstRenderedIndex = readWrapper(host).marginTopPx / stridePx;
    const topRowIndex = Math.floor(container.scrollTop / stridePx);

    return {
        depthInRows: container.scrollTop / stridePx,
        pageLabel: readRows(host)[topRowIndex - firstRenderedIndex]?.pageLabel,
        topRowIndex,
    };
}

/**
 * The sidebar as it comes out on a large display: many more rows fit at once than
 * the overscan margin can hide, so a rendered window that was sized for a coarser
 * scale visibly runs out before the bottom edge of the viewport.
 */
const TALL_SIDEBAR_HEIGHT_PX = 2000;

/**
 * The rendered window has to span the visible part of the list: from the scroll
 * offset down to the bottom edge of the viewport, or to the end of the list when
 * that comes first. Anything less is blank space where rows should be.
 */
function expectRenderedWindowCoversViewport(
    host: HTMLElement,
    container: HTMLElement,
    stridePx: number,
    clientHeightPx: number,
) {
    const wrapper = readWrapper(host);
    const renderedRowCount = readRows(host).length;
    const listHeightPx = ANNOTATION_COMMENT_FIXTURE_COUNT * stridePx;

    expect(wrapper.marginTopPx).toBeLessThanOrEqual(container.scrollTop);
    expect(wrapper.marginTopPx + renderedRowCount * stridePx)
        .toBeGreaterThanOrEqual(Math.min(container.scrollTop + clientHeightPx, listHeightPx));
}

/**
 * A scale change propagates through a mutation observer, a computed remeasure
 * and a virtual-list recalculation, so the number of flushes it takes is an
 * implementation detail. Wait for the observable end state instead: the virtual
 * spacer and every rendered row agreeing on the new stride.
 */
async function waitForRenderedStride(host: HTMLElement, expectedStridePx: number) {
    await vi.waitFor(() => {
        const wrapper = readWrapper(host);
        const rows = readRows(host);

        expect(wrapper.heightPx + wrapper.marginTopPx).toBe(ANNOTATION_COMMENT_FIXTURE_COUNT * expectedStridePx);
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
            expect(row.heightPx + row.gapPx).toBe(expectedStridePx);
        }
    });
}

describe('annotation comments list under UI scaling', () => {
    it.each(ANNOTATION_COMMENT_UI_SCALE_MATRIX)('renders rows on the virtual stride at scale %s', async (scale) => {
        applyUiScale(scale);
        const {host} = mountAnnotationCommentsList();
        await nextTick();

        const metrics = resolveAnnotationCommentRowMetrics(BASE_ROOT_FONT_SIZE_PX * scale);
        const wrapper = readWrapper(host);
        const rows = readRows(host);

        expect(rows.length).toBeGreaterThan(0);
        // Spacer height is `count * itemHeight`: it exposes the stride the virtual
        // list actually scrolls by.
        expect(wrapper.heightPx + wrapper.marginTopPx).toBe(ANNOTATION_COMMENT_FIXTURE_COUNT * metrics.rowStridePx);
        for (const row of rows) {
            expect(row.heightPx).toBe(metrics.rowHeightPx);
            expect(row.gapPx).toBe(metrics.rowGapPx);
            expect(row.heightPx + row.gapPx).toBe(metrics.rowStridePx);
        }
    });

    it.each(ANNOTATION_COMMENT_UI_SCALE_MATRIX)('keeps scroll offsets on the same stride at scale %s', async (scale) => {
        applyUiScale(scale);
        const {
            host,
            scrollTo,
        } = mountAnnotationCommentsList();
        await nextTick();

        const metrics = resolveAnnotationCommentRowMetrics(BASE_ROOT_FONT_SIZE_PX * scale);
        const targetIndex = 9;
        await scrollTo(targetIndex * metrics.rowStridePx);

        const wrapper = readWrapper(host);
        const rows = readRows(host);
        const firstRenderedIndex = wrapper.marginTopPx / metrics.rowStridePx;

        expect(Number.isInteger(firstRenderedIndex)).toBe(true);
        // The first rendered row must sit exactly where the spacer claims it does.
        expect(rows[0]?.pageLabel).toBe(expectedPageLabel(firstRenderedIndex));
        expect(wrapper.heightPx).toBe((ANNOTATION_COMMENT_FIXTURE_COUNT - firstRenderedIndex) * metrics.rowStridePx);
        expect(firstRenderedIndex).toBeLessThanOrEqual(targetIndex);
    });

    it('re-derives the row box and the stride when the UI scale changes live', async () => {
        applyUiScale(1);
        const {host} = mountAnnotationCommentsList();
        await nextTick();

        const defaultMetrics = resolveAnnotationCommentRowMetrics(BASE_ROOT_FONT_SIZE_PX);
        expect(readWrapper(host).heightPx).toBe(ANNOTATION_COMMENT_FIXTURE_COUNT * defaultMetrics.rowStridePx);

        const largeMetrics = resolveAnnotationCommentRowMetrics(BASE_ROOT_FONT_SIZE_PX * 1.25);
        expect(largeMetrics.rowStridePx).not.toBe(defaultMetrics.rowStridePx);

        applyUiScale(1.25);
        await waitForRenderedStride(host, largeMetrics.rowStridePx);

        // The stride is settled; the row box must split it the same way the
        // shipped resolver does rather than merely summing to it.
        for (const row of readRows(host)) {
            expect(row.heightPx).toBe(largeMetrics.rowHeightPx);
            expect(row.gapPx).toBe(largeMetrics.rowGapPx);
        }
    });

    it('keeps rows keyboard reachable and preserves focus across a scale change', async () => {
        applyUiScale(0.9);
        const {host} = mountAnnotationCommentsList();
        await nextTick();

        const rows = readRows(host);
        for (const row of rows) {
            expect(row.element.tagName).toBe('DIV');
            const content = row.element.querySelector<HTMLButtonElement>('.note-item-content');
            expect(content?.tagName).toBe('BUTTON');
            expect(content?.hasAttribute('disabled')).toBe(false);
        }

        const focusTarget = rows[2]?.element.querySelector<HTMLButtonElement>('.note-item-content');
        focusTarget?.focus();
        expect(document.activeElement).toBe(focusTarget);

        applyUiScale(1.25);
        await waitForRenderedStride(
            host,
            resolveAnnotationCommentRowMetrics(BASE_ROOT_FONT_SIZE_PX * 1.25).rowStridePx,
        );

        // Rescaling must not re-key or remount rows: keyboard focus survives the
        // completed remeasurement, not just the tick before it lands.
        expect(document.activeElement).toBe(focusTarget);
    });

    it('keeps the active row rendered and marked at a non-default scale', async () => {
        applyUiScale(1.1);
        const {
            host,
            scrollTo,
        } = mountAnnotationCommentsList({activeIndex: 2});
        await nextTick();

        const metrics = resolveAnnotationCommentRowMetrics(BASE_ROOT_FONT_SIZE_PX * 1.1);
        await scrollTo(0);

        const activeRows = host.querySelectorAll('.note-item.is-active');

        expect(activeRows).toHaveLength(1);
        const activeRow = activeRows[0] as HTMLElement;
        expect(activeRow.style.height).toBe(`${metrics.rowHeightPx}px`);

        const wrapper = readWrapper(host);
        const rows = readRows(host);
        const activeOffsetPx = wrapper.marginTopPx
            + rows.findIndex(row => row.element === activeRow) * metrics.rowStridePx;

        // Row index 2 lives at exactly two strides from the top of the list; if the
        // rendered geometry and the virtual stride disagreed, this offset would drift.
        expect(activeOffsetPx).toBe(2 * metrics.rowStridePx);
    });

    it('keeps the same comment at the top of the viewport when the UI scale changes', async () => {
        applyUiScale(1);
        const {
            container,
            host,
            scrollTo,
        } = mountAnnotationCommentsList();
        await nextTick();

        const before = resolveAnnotationCommentRowMetrics(BASE_ROOT_FONT_SIZE_PX);
        const after = resolveAnnotationCommentRowMetrics(BASE_ROOT_FONT_SIZE_PX * 1.25);
        const topRowIndex = 9;
        await scrollTo(topRowIndex * before.rowStridePx);

        const seen = readViewportTop(host, container, before.rowStridePx);
        expect(seen.topRowIndex).toBe(topRowIndex);
        expect(seen.pageLabel).toBe(expectedPageLabel(topRowIndex));

        applyUiScale(1.25);
        await waitForRenderedStride(host, after.rowStridePx);

        // The scroll offset is pixels; the stride it addresses just changed. Left
        // alone, 9 old strides would land inside comment 7 and the list would jump
        // under the user, so the offset has to be restated in the new stride.
        const now = readViewportTop(host, container, after.rowStridePx);
        expect(now.topRowIndex).toBe(topRowIndex);
        expect(now.pageLabel).toBe(expectedPageLabel(topRowIndex));
        expect(container.scrollTop).toBe(topRowIndex * after.rowStridePx);
    });

    it('keeps the rendered window covering a tall sidebar after a scale change', async () => {
        applyUiScale(1.25);
        const {
            clientHeightPx,
            container,
            host,
        } = mountAnnotationCommentsList({clientHeightPx: TALL_SIDEBAR_HEIGHT_PX});
        await nextTick();

        const before = resolveAnnotationCommentRowMetrics(BASE_ROOT_FONT_SIZE_PX * 1.25);
        const after = resolveAnnotationCommentRowMetrics(BASE_ROOT_FONT_SIZE_PX * 0.85);
        expectRenderedWindowCoversViewport(host, container, before.rowStridePx, clientHeightPx);

        // Scaling down at the top of the list: the scroll offset does not move, so
        // nothing but the rescale itself can tell the list that shorter rows mean
        // more of them are on screen now.
        applyUiScale(0.85);
        await waitForRenderedStride(host, after.rowStridePx);

        expect(container.scrollTop).toBe(0);
        expectRenderedWindowCoversViewport(host, container, after.rowStridePx, clientHeightPx);
    });

    it.each([
        [
            1,
            1.25,
        ],
        [
            1.25,
            0.9,
        ],
    ])('preserves a part-way scroll position from scale %s to %s', async (fromScale, toScale) => {
        applyUiScale(fromScale);
        const {
            container,
            host,
            scrollTo,
        } = mountAnnotationCommentsList();
        await nextTick();

        const before = resolveAnnotationCommentRowMetrics(BASE_ROOT_FONT_SIZE_PX * fromScale);
        const after = resolveAnnotationCommentRowMetrics(BASE_ROOT_FONT_SIZE_PX * toScale);
        const topRowIndex = 8;
        // Part-way down a row, at an offset whose rescaled value is not a whole
        // number of pixels in either direction.
        const withinRowPx = 37;
        await scrollTo(topRowIndex * before.rowStridePx + withinRowPx);

        const seen = readViewportTop(host, container, before.rowStridePx);
        expect(seen.topRowIndex).toBe(topRowIndex);
        expect(seen.depthInRows).not.toBe(topRowIndex);

        applyUiScale(toScale);
        await waitForRenderedStride(host, after.rowStridePx);

        const now = readViewportTop(host, container, after.rowStridePx);
        expect(now.topRowIndex).toBe(topRowIndex);
        expect(now.pageLabel).toBe(seen.pageLabel);
        expect(now.pageLabel).toBe(expectedPageLabel(topRowIndex));
        // Scroll offsets stay on whole pixels like the stride does, so how far
        // into the list the viewport sits may only move by the half pixel that
        // rounding is allowed to cost.
        expect(Number.isInteger(container.scrollTop)).toBe(true);
        expect(Math.abs(now.depthInRows - seen.depthInRows))
            .toBeLessThanOrEqual(0.5 / after.rowStridePx);
    });
});
