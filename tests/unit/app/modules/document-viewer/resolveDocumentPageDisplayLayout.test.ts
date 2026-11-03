import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    resolveDocumentPageDisplayLayouts,
    resolveDocumentPageDisplayScale,
} from '@app/modules/document-viewer/layout/resolveDocumentPageDisplayLayout';

const variablePageSizes = [
    {
        height: 1_000,
        width: 800,
    },
    {
        height: 1_200,
        width: 600,
    },
];

describe('document page display layout', () => {
    it('fits each page on its own in paged mode', () => {
        const layouts = resolveDocumentPageDisplayLayouts({
            availableHeight: 500,
            availableWidth: 600,
            manualZoom: 1,
            pageSizes: variablePageSizes,
            zoomMode: 'fit-width',
            continuousScroll: false,
        });

        expect(layouts).toEqual([
            {
                height: 750,
                scale: 0.75,
                width: 600,
            },
            {
                height: 1_200,
                scale: 1,
                width: 600,
            },
        ]);
    });

    it('fits the widest page in continuous scroll, one scale for every page', () => {
        expect(resolveDocumentPageDisplayLayouts({
            availableHeight: 500,
            availableWidth: 600,
            manualZoom: 1,
            pageSizes: variablePageSizes,
            zoomMode: 'fit-width',
            continuousScroll: true,
        })).toEqual([
            {
                height: 750,
                scale: 0.75,
                width: 600,
            },
            {
                height: 900,
                scale: 0.75,
                width: 450,
            },
        ]);
    });

    it('shares fit-height and custom semantics across renderers', () => {
        expect(resolveDocumentPageDisplayLayouts({
            availableHeight: 600,
            availableWidth: 1_000,
            manualZoom: 1,
            pageSizes: variablePageSizes,
            zoomMode: 'fit-height',
            continuousScroll: true,
        })).toEqual([
            {
                height: 600,
                scale: 0.6,
                width: 480,
            },
            {
                height: 600,
                scale: 0.5,
                width: 300,
            },
        ]);
        expect(resolveDocumentPageDisplayLayouts({
            availableHeight: 600,
            availableWidth: 1_000,
            manualZoom: 1.25,
            pageSizes: variablePageSizes,
            zoomMode: 'custom',
            continuousScroll: true,
        })).toEqual([
            {
                height: 1_250,
                scale: 1.25,
                width: 1_000,
            },
            {
                height: 1_500,
                scale: 1.25,
                width: 750,
            },
        ]);
    });

    it('falls back to clamped manual zoom without page geometry', () => {
        expect(resolveDocumentPageDisplayScale({
            availableHeight: 500,
            availableWidth: 600,
            manualZoom: 1.5,
            pageSize: null,
            zoomMode: 'fit-width',
        })).toBe(1.5);
    });
});
