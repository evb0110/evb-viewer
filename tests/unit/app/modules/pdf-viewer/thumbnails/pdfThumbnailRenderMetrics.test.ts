import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    resolveThumbnailItemChromeHeightFromStyles,
    resolveThumbnailRasterWidth,
    resolveThumbnailRenderWidthFromStyles,
    type IThumbnailStyleLike,
} from '@app/modules/document-viewer/public';

function style(values: Record<string, string>): IThumbnailStyleLike {
    return {getPropertyValue(property: string) {
        return values[property] ?? '';
    }};
}

describe('pdfThumbnailRenderMetrics', () => {
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
});
