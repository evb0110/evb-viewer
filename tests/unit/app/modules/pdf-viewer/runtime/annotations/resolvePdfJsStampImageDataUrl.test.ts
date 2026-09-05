import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {createPdfStampImageCache} from '@app/modules/pdf-viewer/runtime/annotations/createPdfAnnotationStampImageResolver';
import { resolvePdfJsStampImageDataUrl } from '@app/modules/pdf-viewer/runtime/annotations/resolvePdfJsStampImageDataUrl';

const imageReference = {
    objectNumber: 11,
    generationNumber: 0,
    byteLength: 6,
    sha256: 'a'.repeat(64),
};

describe('resolvePdfJsStampImageDataUrl', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('finds the native image reference in PDF.js page objects and encodes its pixels', () => {
        const output = {data: new Uint8ClampedArray(8)};
        const context = {
            createImageData: vi.fn(() => output),
            putImageData: vi.fn(),
        };
        const canvas = {
            width: 0,
            height: 0,
            getContext: vi.fn(() => context),
            toDataURL: vi.fn(() => 'data:image/png;base64,stamp'),
        };
        vi.stubGlobal('document', {createElement: vi.fn(() => canvas)});

        const page = {objs: new Map([[
            'img_p0_1',
            {
                ref: '11R',
                width: 2,
                height: 1,
                kind: 2,
                data: new Uint8Array([
                    1,
                    2,
                    3,
                    4,
                    5,
                    6,
                ]),
            },
        ]])};

        expect(resolvePdfJsStampImageDataUrl(page, imageReference)).toBe('data:image/png;base64,stamp');
        expect(context.createImageData).toHaveBeenCalledWith(2, 1);
        expect(output.data).toEqual(new Uint8ClampedArray([
            1,
            2,
            3,
            255,
            4,
            5,
            6,
            255,
        ]));
        expect(context.putImageData).toHaveBeenCalledWith(output, 0, 0);
    });

    it('ignores trailing bytes in an oversized RGBA image buffer', () => {
        const output = {data: new Uint8ClampedArray(8)};
        const context = {
            createImageData: vi.fn(() => output),
            putImageData: vi.fn(),
        };
        const canvas = {
            width: 0,
            height: 0,
            getContext: vi.fn(() => context),
            toDataURL: vi.fn(() => 'data:image/png;base64,stamp'),
        };
        vi.stubGlobal('document', {createElement: vi.fn(() => canvas)});

        const page = {objs: new Map([[
            'img_p0_1',
            {
                ref: '11R',
                width: 2,
                height: 1,
                kind: 3,
                data: new Uint8Array([
                    1,
                    2,
                    3,
                    4,
                    5,
                    6,
                    7,
                    8,
                    9,
                    10,
                ]),
            },
        ]])};

        expect(resolvePdfJsStampImageDataUrl(page, imageReference)).toBe('data:image/png;base64,stamp');
        expect(output.data).toEqual(new Uint8ClampedArray([
            1,
            2,
            3,
            4,
            5,
            6,
            7,
            8,
        ]));
    });

    it('returns null when the page has no matching decoded image', () => {
        const page = {objs: new Map([[
            'img_p0_1',
            {
                ref: '12R',
                width: 1,
                height: 1,
                kind: 2,
                data: new Uint8Array([
                    1,
                    2,
                    3,
                ]),
            },
        ]])};

        expect(resolvePdfJsStampImageDataUrl(page, imageReference)).toBeNull();
    });

    it('infers the RGB format when PDF.js omits the image kind', () => {
        const output = {data: new Uint8ClampedArray(8)};
        const context = {
            createImageData: vi.fn(() => output),
            putImageData: vi.fn(),
        };
        const canvas = {
            width: 0,
            height: 0,
            getContext: vi.fn(() => context),
            toDataURL: vi.fn(() => 'data:image/png;base64,stamp'),
        };
        vi.stubGlobal('document', {createElement: vi.fn(() => canvas)});

        const page = {objs: new Map([[
            'img_p0_1',
            {
                ref: '11R',
                width: 2,
                height: 1,
                data: new Uint8Array([
                    1,
                    2,
                    3,
                    4,
                    5,
                    6,
                ]),
            },
        ]])};

        expect(resolvePdfJsStampImageDataUrl(page, imageReference)).toBe('data:image/png;base64,stamp');
        expect(output.data).toEqual(new Uint8ClampedArray([
            1,
            2,
            3,
            255,
            4,
            5,
            6,
            255,
        ]));
    });

    it('encodes a bitmap-backed page object used by browser PDF.js builds', () => {
        const bitmap = {
            width: 2,
            height: 1,
        };
        const context = {drawImage: vi.fn()};
        const canvas = {
            width: 0,
            height: 0,
            getContext: vi.fn(() => context),
            toDataURL: vi.fn(() => 'data:image/png;base64,bitmap-stamp'),
        };
        vi.stubGlobal('document', {createElement: vi.fn(() => canvas)});

        const page = {objs: new Map([[
            'img_p0_1',
            {
                ref: '11R',
                width: 2,
                height: 1,
                data: null,
                bitmap,
            },
        ]])};

        expect(resolvePdfJsStampImageDataUrl(page, imageReference)).toBe('data:image/png;base64,bitmap-stamp');
        expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 2, 1);
    });

    it('keeps the stamp data-url cache within its byte budget using LRU eviction', () => {
        const cache = createPdfStampImageCache(10);

        cache.set('first', '1234');
        cache.set('second', '5678');
        expect(cache.byteLength).toBe(8);

        expect(cache.get('first')).toBe('1234');
        cache.set('third', 'abcd');

        expect(cache.get('second')).toBeUndefined();
        expect(cache.get('first')).toBe('1234');
        expect(cache.get('third')).toBe('abcd');
        expect(cache.byteLength).toBe(8);

        cache.set('too-large', '12345678901');
        expect(cache.get('too-large')).toBeUndefined();
        expect(cache.byteLength).toBe(8);
    });
});
