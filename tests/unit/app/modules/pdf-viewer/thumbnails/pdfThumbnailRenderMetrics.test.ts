import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    buildThumbnailRenderTransform,
    isThumbnailRasterWidthReady,
    parseCssPixelValue,
    resolveHorizontalInset,
    resolveSeededThumbnailMetrics,
    resolveThumbnailItemChromeHeightFromStyles,
    resolveThumbnailRasterWidth,
    resolveThumbnailRenderWidthFromStyles,
    roundMetric,
    type IThumbnailStyleLike,
} from '@app/modules/document-viewer/public';

function style(values: Record<string, string>): IThumbnailStyleLike {
    return {getPropertyValue(property: string) {
        return values[property] ?? '';
    }};
}

describe('pdfThumbnailRenderMetrics', () => {
    it('rounds metrics and parses CSS pixel values', () => {
        expect(roundMetric(12.345)).toBe(12.35);
        expect(parseCssPixelValue('8.5px')).toBe(8.5);
        expect(parseCssPixelValue('bad-value')).toBe(0);
        expect(parseCssPixelValue('')).toBe(0);
    });

    it('sums horizontal style insets', () => {
        expect(resolveHorizontalInset(
            style({
                'border-left-width': '1px',
                'border-right-width': '2.5px',
                'padding-left': '4px',
                'padding-right': '6px',
            }),
            'padding-left',
            'padding-right',
            'border-left-width',
            'border-right-width',
        )).toBe(13.5);
    });

    it('resolves render width from container and thumbnail styles', () => {
        expect(resolveThumbnailRenderWidthFromStyles({
            containerClientWidth: 260,
            containerStyle: style({
                'padding-left': '10px',
                'padding-right': '14px',
            }),
            minWidth: 120,
            thumbnailStyle: style({
                'border-left-width': '1px',
                'border-right-width': '1px',
                'padding-left': '8px',
                'padding-right': '8px',
            }),
        })).toBe(218);
    });

    it('resolves virtual row chrome from the rendered thumbnail CSS', () => {
        expect(resolveThumbnailItemChromeHeightFromStyles({
            labelHeight: 16,
            thumbnailStyle: style({
                'border-bottom-width': '1px',
                'border-top-width': '1px',
                'padding-bottom': '7.2px',
                'padding-top': '7.2px',
                'row-gap': '4px',
            }),
        })).toBeCloseTo(36.4);
    });

    it('clamps render width to the minimum thumbnail width', () => {
        expect(resolveThumbnailRenderWidthFromStyles({
            containerClientWidth: 80,
            containerStyle: style({
                'padding-left': '10px',
                'padding-right': '10px',
            }),
            minWidth: 120,
            thumbnailStyle: null,
        })).toBe(120);
    });

    it('rounds raster widths up so a resized preview is never stretched past its bitmap', () => {
        expect(resolveThumbnailRasterWidth(218)).toBe(224);
        expect(resolveThumbnailRasterWidth(224)).toBe(224);
        expect(resolveThumbnailRasterWidth(225)).toBe(256);
        expect(resolveThumbnailRasterWidth(0)).toBe(32);
        expect(resolveThumbnailRasterWidth(218, 16)).toBe(224);
    });

    it('requires the raster bucket to cover the measured thumbnail width', () => {
        expect(isThumbnailRasterWidthReady(218, 224)).toBe(true);
        expect(isThumbnailRasterWidthReady(225, 224)).toBe(false);
        expect(isThumbnailRasterWidthReady(150, 150)).toBe(false);
    });

    it('resolves seeded preview metrics from source dimensions and output scale', () => {
        expect(resolveSeededThumbnailMetrics({
            cssWidth: 120,
            outputScale: 2,
            sourceHeight: 600,
            sourceWidth: 300,
        })).toEqual({
            cssHeight: 240,
            cssWidth: 120,
            pixelHeight: 480,
            pixelWidth: 240,
            sourceAspectRatio: 2,
        });
    });

    it('rejects invalid seeded preview dimensions', () => {
        expect(resolveSeededThumbnailMetrics({
            cssWidth: 120,
            outputScale: 2,
            sourceHeight: 0,
            sourceWidth: 300,
        })).toBeNull();
        expect(resolveSeededThumbnailMetrics({
            cssWidth: 120,
            outputScale: 2,
            sourceHeight: 600,
            sourceWidth: 0,
        })).toBeNull();
    });

    it('builds a PDF render transform only when scaling is needed', () => {
        expect(buildThumbnailRenderTransform(1, 1)).toBeUndefined();
        expect(buildThumbnailRenderTransform(2, 3)).toEqual([
            2,
            0,
            0,
            3,
            0,
            0,
        ]);
    });
});
