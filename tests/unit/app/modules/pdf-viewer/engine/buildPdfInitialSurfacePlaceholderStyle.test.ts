import {describe, expect, it} from 'vitest';
import {buildPdfInitialSurfacePlaceholderStyle} from '@app/modules/pdf-viewer/engine/pdf-initial-surface-placeholder/buildPdfInitialSurfacePlaceholderStyle';

describe('buildPdfInitialSurfacePlaceholderStyle', () => {
    it('aligns the measured placeholder with the viewport page padding', () => {
        expect(
            buildPdfInitialSurfacePlaceholderStyle({
                pageStyle: {
                    width: '612px',
                    height: '792px',
                },
                scaledMargin: 20,
            }),
        ).toEqual({
            width: '612px',
            height: '792px',
            marginTop: '20px',
        });
    });

    it('does not create measured geometry before page metrics exist', () => {
        expect(
            buildPdfInitialSurfacePlaceholderStyle({
                pageStyle: null,
                scaledMargin: 20,
            }),
        ).toBeNull();
    });

    it('does not double the margin when the shared chassis owns viewport padding', () => {
        expect(
            buildPdfInitialSurfacePlaceholderStyle({
                pageStyle: {
                    width: '612px',
                    height: '792px',
                },
                scaledMargin: 20,
                viewportOwnsPadding: true,
            }),
        ).toEqual({
            width: '612px',
            height: '792px',
            marginTop: '0px',
        });
    });
});
