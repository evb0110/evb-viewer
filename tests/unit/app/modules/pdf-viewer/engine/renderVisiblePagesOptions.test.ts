import {describe, expect, it} from 'vitest';
import {bindPdfOpenSurfaceRenderContext} from '@app/modules/pdf-viewer/engine/pdf-page-render-pipeline/bindPdfOpenSurfaceRenderContext';

describe('bindPdfOpenSurfaceRenderContext', () => {
    it('binds every render request to the authority context at dispatch time', () => {
        expect(
            bindPdfOpenSurfaceRenderContext(
                {
                    bufferOverride: 0,
                    openSurfaceGeneration: 0,
                    openSurfaceRevision: '',
                },
                {
                    openSurfaceGeneration: 7,
                    openSurfaceRevision: 'load:3',
                },
            ),
        ).toEqual({
            bufferOverride: 0,
            openSurfaceGeneration: 7,
            openSurfaceRevision: 'load:3',
        });
    });

    it('leaves requests unchanged when no surface authority is installed', () => {
        const options = {bufferOverride: 0};
        expect(bindPdfOpenSurfaceRenderContext(options, undefined)).toBe(options);
    });
});
