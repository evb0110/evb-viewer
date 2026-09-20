import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { usePdfScale } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScale';
import { ZOOM } from '@app/constants/pdfLayout';
import type {
    TFitMode,
    TZoomMode,
} from '@app/types/pdfContracts';
import type { IPdfPageMetric } from '@app/types/pdfUi';
import type {
    TPdfViewMode,
    TPdfViewRotation,
} from '@contracts/shared';

function createContainer(
    width: number,
    height: number,
    physicalHeight = height,
) {
    return {
        clientWidth: width,
        clientHeight: height,
        getBoundingClientRect: () => ({
            width,
            height: physicalHeight,
        }),
    } as HTMLElement;
}

function createScaleComposable(options: {
    width: number;
    height: number;
    pageMetrics?: IPdfPageMetric[];
    mode?: TFitMode;
    zoomMode?: TZoomMode;
    zoom?: number;
    viewMode?: TPdfViewMode;
    viewRotation?: TPdfViewRotation;
    currentPage?: number;
    continuousScroll?: boolean;
}) {
    const zoom = ref(options.zoom ?? 1);
    const fitMode = ref<TFitMode>(options.mode ?? 'width');
    const zoomMode = ref<TZoomMode>(options.zoomMode ?? (
        fitMode.value === 'height' ? 'fit-height' : 'fit-width'
    ));
    const viewMode = ref<TPdfViewMode>(options.viewMode ?? 'single');
    const viewRotation = ref<TPdfViewRotation>(options.viewRotation ?? 0);
    const pageMetrics = ref(options.pageMetrics ?? [{
        width: options.width,
        height: options.height,
    }]);
    const pageMetricsVersion = ref(0);
    const numPages = ref(pageMetrics.value.length);
    const baseWidth = ref(options.width);
    const baseHeight = ref(options.height);
    const currentPage = ref(options.currentPage ?? 1);

    return {
        baseWidth,
        baseHeight,
        pageMetrics,
        currentPage,
        scale: usePdfScale(
            zoom,
            zoomMode,
            fitMode,
            viewMode,
            viewRotation,
            numPages,
            pageMetrics,
            pageMetricsVersion,
            baseWidth,
            baseHeight,
            currentPage,
            options.continuousScroll ?? false,
        ),
    };
}

describe('usePdfScale', () => {
    it('seeds the canonical first render from the prepared opening frame scale', () => {
        const {scale} = createScaleComposable({
            width: 612,
            height: 792,
            mode: 'width',
        });

        expect(scale.seedOpeningFitScale(845 / 612)).toBe(true);
        expect(scale.effectiveScale.value * 612).toBeCloseTo(845, 6);
        expect(scale.seedOpeningFitScale(Number.NaN)).toBe(false);
    });

    it('fits inside the fractional viewport height without rounding up into overflow', () => {
        const {scale} = createScaleComposable({
            width: 338,
            height: 593.3,
            mode: 'height',
        });
        const container = createContainer(1_000, 546, 545.6015625);

        scale.computeFitWidthScale(container);

        expect(scale.effectiveScale.value * 593.3 + 40).toBeLessThanOrEqual(545.6015625);
    });

    it('updates fit-height when a one-pixel resize changes scale by less than 0.001', () => {
        const {scale} = createScaleComposable({
            width: 1_000,
            height: 2_000,
            mode: 'height',
        });
        scale.computeFitWidthScale(createContainer(1_000, 900));
        const smaller = createContainer(1_000, 899);

        expect(scale.isFitWidthScaleCurrent(smaller)).toBe(false);
        expect(scale.computeFitWidthScale(smaller)).toBe(true);
        expect(scale.effectiveScale.value * 2_000 + 40).toBe(899);
    });

    it('keeps viewer spacing fixed while fitting width', () => {
        const { scale } = createScaleComposable({
            width: 227.04,
            height: 350.64,
            mode: 'width',
        });
        const container = createContainer(1536, 900);

        const updated = scale.computeFitWidthScale(container);

        expect(updated).toBe(true);
        expect(scale.containerStyle.value).toEqual({
            padding: '20px',
            gap: '20px',
        });
        expect(scale.scaledMargin.value).toBe(20);
        expect(scale.effectiveScale.value * 227.04).toBeCloseTo(1496, 6);
    });

    it('fits the projected page width after a quarter-turn view rotation', () => {
        const { scale } = createScaleComposable({
            width: 600,
            height: 800,
            mode: 'width',
            viewRotation: 90,
        });

        scale.computeFitWidthScale(createContainer(1_000, 900));

        expect(scale.effectiveScale.value * 800).toBeCloseTo(960, 6);
    });

    it('uses a separate live layout preview without committing effective zoom', () => {
        const {scale} = createScaleComposable({
            width: 500,
            height: 700,
            mode: 'width',
        });
        scale.computeFitWidthScale(createContainer(1_000, 900));
        const committedScale = scale.effectiveScale.value;

        scale.computeFitWidthScale(createContainer(1_300, 900), {preview: true});

        expect(scale.effectiveScale.value).toBe(committedScale);
        expect(scale.layoutScale.value).toBeGreaterThan(committedScale);
        expect(scale.previewFitScale.value).toBe(scale.layoutScale.value);

        scale.settlePreviewFitScale();
        expect(scale.layoutScale.value).toBe(committedScale);
    });

    it('promotes the exact live fit preview without changing published layout scale', () => {
        const {scale} = createScaleComposable({
            width: 500,
            height: 700,
            mode: 'width',
        });
        scale.computeFitWidthScale(createContainer(1_000, 900));
        scale.computeFitWidthScale(createContainer(1_300, 900), {preview: true});
        const publishedPreviewScale = scale.layoutScale.value;

        expect(scale.settlePreviewFitScale(true)).toBe(true);

        expect(scale.previewFitScale.value).toBeNull();
        expect(scale.effectiveScale.value).toBe(publishedPreviewScale);
        expect(scale.layoutScale.value).toBe(publishedPreviewScale);
    });

    it('produces similar rendered page width for different PDF page sizes', () => {
        const first = createScaleComposable({
            width: 227.04,
            height: 350.64,
            mode: 'width',
        });
        const second = createScaleComposable({
            width: 504,
            height: 648,
            mode: 'width',
        });
        const container = createContainer(1536, 900);

        first.scale.computeFitWidthScale(container);
        second.scale.computeFitWidthScale(container);

        const firstRenderedWidth = first.scale.effectiveScale.value * first.baseWidth.value;
        const secondRenderedWidth = second.scale.effectiveScale.value * second.baseWidth.value;

        expect(firstRenderedWidth).toBeCloseTo(1496, 6);
        expect(secondRenderedWidth).toBeCloseTo(1496, 6);
    });

    it('accounts for fixed margins in fit-height mode', () => {
        const { scale } = createScaleComposable({
            width: 504,
            height: 648,
            mode: 'height',
        });
        const container = createContainer(1536, 900);

        scale.computeFitWidthScale(container);

        expect(scale.effectiveScale.value * 648).toBeCloseTo(860, 6);
        expect(scale.containerStyle.value).toEqual({
            padding: '20px',
            gap: '20px',
        });
    });

    it('fits the current page width instead of the widest page in single-page mode', () => {
        const { scale } = createScaleComposable({
            width: 400,
            height: 500,
            pageMetrics: [
                {
                    width: 400,
                    height: 500,
                },
                {
                    width: 180,
                    height: 500,
                },
                {
                    width: 700,
                    height: 500,
                },
            ],
            mode: 'width',
            currentPage: 2,
        });
        const container = createContainer(1000, 900);

        scale.computeFitWidthScale(container);

        expect(scale.effectiveScale.value * 180).toBeCloseTo(960, 6);
    });

    it('fits the current spread width in facing-page mode', () => {
        const pageMetrics = [
            {
                width: 300,
                height: 500,
            },
            {
                width: 220,
                height: 500,
            },
            {
                width: 280,
                height: 500,
            },
            {
                width: 600,
                height: 500,
            },
        ] satisfies IPdfPageMetric[];
        const { scale } = createScaleComposable({
            width: 300,
            height: 500,
            pageMetrics,
            mode: 'width',
            viewMode: 'facing',
            currentPage: 2,
        });
        const container = createContainer(1000, 900);

        scale.computeFitWidthScale(container);

        expect(
            scale.effectiveScale.value * (pageMetrics[0]!.width + pageMetrics[1]!.width),
        ).toBeCloseTo(940, 6);
    });

    it('uses the active facing spread row height for fit-height scale', () => {
        const pageMetrics = [
            {
                width: 600,
                height: 1000,
            },
            {
                width: 600,
                height: 700,
            },
            {
                width: 600,
                height: 800,
            },
        ] satisfies IPdfPageMetric[];
        const { scale } = createScaleComposable({
            width: 600,
            height: 1000,
            pageMetrics,
            mode: 'height',
            viewMode: 'facing-first-single',
            currentPage: 2,
        });
        const container = createContainer(1536, 900);

        scale.computeFitWidthScale(container);

        expect(scale.effectiveScale.value * pageMetrics[2]!.height).toBeCloseTo(860, 6);
    });

    it('can fit-height against a pending navigation target before current page commits', () => {
        const pageMetrics = [
            {
                width: 320,
                height: 500,
            },
            {
                width: 600,
                height: 860,
            },
            {
                width: 600,
                height: 1_000,
            },
        ] satisfies IPdfPageMetric[];
        const {
            scale,
            currentPage,
        } = createScaleComposable({
            width: 320,
            height: 500,
            pageMetrics,
            mode: 'height',
            currentPage: 1,
        });
        const container = createContainer(1536, 900);

        scale.computeFitWidthScale(container, { page: 3 });

        expect(currentPage.value).toBe(1);
        expect(scale.effectiveScale.value * pageMetrics[2]!.height).toBeCloseTo(860, 6);
    });

    it('keeps custom zoom absolute after fit scale recomputes', () => {
        const { scale } = createScaleComposable({
            width: 500,
            height: 700,
            mode: 'width',
            zoomMode: 'custom',
            zoom: 1,
        });
        const container = createContainer(1_000, 900);

        scale.computeFitWidthScale(container);

        expect(scale.fitWidthScale.value).toBeCloseTo(1.92, 6);
        expect(scale.effectiveScale.value).toBe(1);
    });

    it('resolves BHS-like fit-height below the manual minimum zoom', () => {
        const { scale } = createScaleComposable({
            width: 4_766.9,
            height: 6_355.86,
            mode: 'height',
        });
        const container = createContainer(1_100, 820);

        scale.computeFitWidthScale(container);

        const expectedScale = (820 - 40) / 6_355.86;
        expect(expectedScale).toBeGreaterThan(ZOOM.FIT_MIN);
        expect(expectedScale).toBeLessThan(ZOOM.MIN);
        expect(scale.fitWidthScale.value).toBeCloseTo(expectedScale, 6);
        expect(scale.effectiveScale.value).toBeCloseTo(expectedScale, 6);
    });

    it('clamps fit-width scale to the fit maximum zoom level', () => {
        const { scale } = createScaleComposable({
            width: 10,
            height: 10,
            mode: 'width',
        });
        const container = createContainer(10_000, 900);

        scale.computeFitWidthScale(container);

        expect(scale.fitWidthScale.value).toBe(ZOOM.MAX);
        expect(scale.isFitWidthScaleCurrent(container)).toBe(true);
    });

    it('clamps fit-height scale to the fit minimum zoom level', () => {
        const { scale } = createScaleComposable({
            width: 10_000,
            height: 10_000,
            mode: 'height',
        });
        const container = createContainer(1_000, 100);

        scale.computeFitWidthScale(container);

        expect(scale.fitWidthScale.value).toBe(ZOOM.FIT_MIN);
        expect(scale.fitWidthScale.value).toBeLessThan(ZOOM.MIN);
        expect(scale.isFitWidthScaleCurrent(container)).toBe(true);
    });

    it('keeps continuous fit-width stable across mixed-width pages', () => {
        const {
            scale, currentPage,
        } = createScaleComposable({
            width: 300,
            height: 500,
            continuousScroll: true,
            pageMetrics: [
                {
                    width: 300,
                    height: 500,
                },
                {
                    width: 1200,
                    height: 800,
                },
                {
                    width: 600,
                    height: 500,
                },
            ],
        });
        const container = createContainer(1000, 900);
        scale.computeFitWidthScale(container);
        expect(scale.effectiveScale.value * 1200).toBeCloseTo(960, 6);
        const openingScale = scale.effectiveScale.value;
        currentPage.value = 3;
        scale.computeFitWidthScale(container);
        expect(scale.effectiveScale.value).toBe(openingScale);
        expect(scale.isFitWidthScaleCurrent(container)).toBe(true);
    });

    it('includes the extra gutter when a facing spread is narrower than the cover', () => {
        const {scale} = createScaleComposable({
            width: 1000,
            height: 500,
            continuousScroll: true,
            viewMode: 'facing-first-single',
            pageMetrics: [
                {
                    width: 1000,
                    height: 500,
                },
                {
                    width: 495,
                    height: 500,
                },
                {
                    width: 495,
                    height: 500,
                },
            ],
        });
        scale.computeFitWidthScale(createContainer(1000, 900));
        expect(scale.effectiveScale.value * 990 + 60).toBeCloseTo(1000, 6);
        expect(scale.effectiveScale.value * 1000 + 40).toBeLessThan(1000);

        // Only the cover has usable content width in an extremely narrow pane.
        const narrowContainer = createContainer(50, 900);
        expect(scale.computeFitWidthScale(narrowContainer)).toBe(true);
        expect(scale.effectiveScale.value).toBe(ZOOM.FIT_MIN);
        expect(scale.isFitWidthScaleCurrent(narrowContainer)).toBe(true);
    });

    it('fits the widest estimated row without materializing a million pages', () => {
        const pageMetrics: IPdfPageMetric[] = [];
        pageMetrics[0] = {
            width: 300,
            height: 500,
        };
        pageMetrics[999_999] = {
            width: 1200,
            height: 800,
        };
        const {scale} = createScaleComposable({
            width: 300,
            height: 500,
            pageMetrics,
            continuousScroll: true,
        });
        scale.computeFitWidthScale(createContainer(1000, 900));
        expect(scale.effectiveScale.value * 1200).toBeCloseTo(960, 6);
    });

    it('computes fit scale from sparse million-page metrics without iterating them', () => {
        const pageMetrics: IPdfPageMetric[] = [];
        pageMetrics[0] = {
            width: 300,
            height: 500,
        };
        pageMetrics[999_999] = {
            width: 320,
            height: 520,
        };
        const iteratorSpy = vi.spyOn(pageMetrics, Symbol.iterator).mockImplementation(() => {
            throw new Error('fit scale must not iterate sparse metrics');
        });
        try {
            const {scale} = createScaleComposable({
                width: 300,
                height: 500,
                pageMetrics,
                mode: 'width',
            });

            expect(scale.computeFitWidthScale(createContainer(1_000, 900))).toBe(true);
            expect(scale.effectiveScale.value * pageMetrics[0]!.width).toBeCloseTo(960, 6);
        } finally {
            iteratorSpy.mockRestore();
        }
    });
});
