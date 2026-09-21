import {
    describe,
    expect,
    it,
} from 'vitest';
import {requireEpochMs} from '@contracts/timestamps';
import {requirePageNumber} from '@contracts/pageNumbers';
import {resolvePdfOpeningPageFrameDocumentFitWidthStyle} from '@app/modules/workspace-shell/composables/document-session/stagePdfOpeningPreview';

const firstPageNumber = requirePageNumber(1);
const modifiedAt = requireEpochMs(200);

describe('stagePdfOpeningPreview', () => {
    it('fits the opening page to the widest document page in continuous Fit Width', () => {
        const options = {
            frame: {
                generation: 1,
                ownerId: 'document-viewer-runtime:1',
                pageNumber: firstPageNumber,
                intentKey: 'fit-width:1',
                sourceRevisionKey: '100:200',
                style: {
                    width: '960px',
                    height: '1523.028px',
                },
            },
            geometry: {
                pageNumber: firstPageNumber,
                pageCount: 2,
                width: 482,
                height: 765,
                rotation: 0,
                size: 100,
                modifiedAt,
            },
            pageSizes: [
                {
                    width: 482,
                    height: 765,
                },
                {
                    width: 765,
                    height: 482,
                },
            ],
            policy: {
                fitMode: 'width',
                viewMode: 'single',
                zoom: 1,
                zoomMode: 'fit-width',
                continuousScroll: true,
            },
            rawSize: 1000,
        } as const;
        const style = resolvePdfOpeningPageFrameDocumentFitWidthStyle(options);

        expect(style?.width).toBe(`${String(482 * (960 / 765))}px`);
        expect(style?.height).toBe(`${String(765 * (960 / 765))}px`);
        expect(resolvePdfOpeningPageFrameDocumentFitWidthStyle({
            ...options,
            frame: {
                ...options.frame,
                style: style ?? options.frame.style,
            },
        })).toEqual(style);
    });

    it('does not change paged Fit Width or incomplete native page metadata', () => {
        const base = {
            frame: {
                generation: 1,
                ownerId: 'document-viewer-runtime:1',
                pageNumber: firstPageNumber,
                intentKey: 'fit-width:1',
                sourceRevisionKey: '100:200',
                style: {
                    width: '960px',
                    height: '1523.028px',
                },
            },
            geometry: {
                pageNumber: firstPageNumber,
                pageCount: 2,
                width: 482,
                height: 765,
                rotation: 0 as const,
                size: 100,
                modifiedAt,
            },
            pageSizes: [
                {
                    width: 482,
                    height: 765,
                },
                {
                    width: 765,
                    height: 482,
                },
            ],
            rawSize: 1000,
        } as const;

        expect(resolvePdfOpeningPageFrameDocumentFitWidthStyle({
            ...base,
            policy: {
                fitMode: 'width',
                viewMode: 'single',
                zoom: 1,
                zoomMode: 'fit-width',
                continuousScroll: false,
            },
        })).toBeNull();
        expect(resolvePdfOpeningPageFrameDocumentFitWidthStyle({
            ...base,
            pageSizes: base.pageSizes.slice(0, 1),
            policy: {
                fitMode: 'width',
                viewMode: 'single',
                zoom: 1,
                zoomMode: 'fit-width',
                continuousScroll: true,
            },
        })).toBeNull();
    });
});
