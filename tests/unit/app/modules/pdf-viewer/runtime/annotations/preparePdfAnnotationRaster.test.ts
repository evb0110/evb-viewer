// @vitest-environment happy-dom
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type * as BrowserImageApi from '@app/platform/browser-api/public';
import type {IPdfPlacedImageFinalizePayload} from '@app/types/pdfImagePlacement';
import {preparePdfAnnotationRaster} from '@app/modules/pdf-viewer/runtime/annotations/preparePdfAnnotationRaster';

const {createPreview} = vi.hoisted(() => ({createPreview: vi.fn(async () => new Blob([Uint8Array.of(4, 5, 6)], {type: 'image/png'}))}));
vi.mock('@app/platform/browser-api/public', async importOriginal => ({
    ...await importOriginal<typeof BrowserImageApi>(),
    createStaticBrowserImagePreview: createPreview,
}));

function payload(mimeType: string, sourceOrientation = 1): IPdfPlacedImageFinalizePayload {
    return {
        pageNumber: 1,
        viewRotation: 0,
        x: 0.1,
        y: 0.1,
        width: 0.3,
        height: 0.2,
        rotationDegrees: 0,
        fileName: 'image.jpg',
        mimeType,
        bytes: Uint8Array.of(1, 2, 3),
        sourcePixelWidth: 1200,
        sourcePixelHeight: 800,
        sourceOrientation,
        targetPixelWidth: 300,
        targetPixelHeight: 200,
    };
}

describe('preparePdfAnnotationRaster', () => {
    beforeEach(() => {
        createPreview.mockClear();
    });
    it('retains ordinary JPEG bytes and their exact content fingerprint', async () => {
        const image = await preparePdfAnnotationRaster(payload('image/jpeg'));
        expect(image).toMatchObject({
            mimeType: 'image/jpeg',
            dataBase64: 'AQID',
            byteLength: 3,
            sha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
        });
        expect(createPreview).not.toHaveBeenCalled();
    });

    it.each([
        2,
        3,
        4,
        5,
        6,
        7,
        8,
    ])('bakes JPEG EXIF orientation %i into PNG before committing history', async sourceOrientation => {
        const image = await preparePdfAnnotationRaster(payload('image/jpeg', sourceOrientation));
        expect(image).toMatchObject({
            mimeType: 'image/png',
            dataBase64: 'BAUG',
            width: 1200,
            height: 800,
        });
        expect(createPreview).toHaveBeenCalledOnce();
        expect(createPreview).toHaveBeenCalledWith(expect.objectContaining({
            width: 1200,
            height: 800,
        }), 32768, undefined);
    });

    it('normalizes a browser-only image format to lossless PNG', async () => {
        const image = await preparePdfAnnotationRaster(payload('image/webp'));
        expect(image).toMatchObject({
            mimeType: 'image/png',
            dataBase64: 'BAUG',
        });
        expect(createPreview).toHaveBeenCalledOnce();
    });
    it('flattens animated PNG to the static frame shown during placement', async () => {
        const image = await preparePdfAnnotationRaster({
            ...payload('image/png'),
            sourceFrameCount: 2,
        });
        expect(image).toMatchObject({
            mimeType: 'image/png',
            dataBase64: 'BAUG',
        });
        expect(createPreview).toHaveBeenCalledOnce();
    });

});
