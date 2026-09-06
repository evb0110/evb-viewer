import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IOcrWord } from '@contracts/shared';
import type {IPdfViewport} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import { cast } from '@tests/helpers/cast';

vi.mock('@app/constants/storageKeys', () => ({STORAGE_KEYS: {OCR_DEBUG_BOXES: 'pdfOcrDebugBoxes'}}));

const { isOcrDebugEnabled } = await import('@app/modules/pdf-viewer/engine/ocr/pdf-word-box-geometry/isOcrDebugEnabled');
const { transformOcrWordToViewport } = await import('@app/modules/pdf-viewer/engine/ocr/pdf-word-box-geometry/transformOcrWordToViewport');
const { transformWordBox } = await import('@app/modules/pdf-viewer/engine/ocr/pdf-word-box-geometry/transformWordBox');

describe('transformOcrWordToViewport', () => {
    const baseWord: IOcrWord = {
        text: 'hello',
        x: 100,
        y: 50,
        width: 200,
        height: 30,
    };

    it('maps OCR pixels through the PDF viewport', () => {
        const viewport = cast<IPdfViewport>({convertToViewportRectangle: vi.fn((rect: readonly number[]) => [
            rect[0]! + 10,
            rect[1]! + 20,
            rect[2]! + 10,
            rect[3]! + 20,
        ])});

        expect(transformOcrWordToViewport(
            baseWord,
            {render: {imagePx: {
                w: 1000,
                h: 500,
            }}},
            2000,
            1000,
            viewport,
        )).toEqual({
            x: 210,
            y: 860,
            width: 400,
            height: 60,
        });
        expect(viewport.convertToViewportRectangle).toHaveBeenCalledWith([
            200,
            840,
            600,
            900,
        ]);
    });

    it('returns null when OCR render geometry is absent', () => {
        const viewport = cast<IPdfViewport>({convertToViewportRectangle: vi.fn()});

        expect(transformOcrWordToViewport(baseWord, {}, 2000, 1000, viewport)).toBeNull();
        expect(viewport.convertToViewportRectangle).not.toHaveBeenCalled();
    });

    it('returns null when the viewport returns an invalid rectangle', () => {
        const viewport = cast<IPdfViewport>({convertToViewportRectangle: vi.fn(() => [
            0,
            Number.NaN,
            10,
            20,
        ])});

        expect(transformOcrWordToViewport(
            baseWord,
            {render: {imagePx: {
                w: 1000,
                h: 500,
            }}},
            2000,
            1000,
            viewport,
        )).toBeNull();
    });
});

describe('transformWordBox', () => {
    const baseWord: IOcrWord = {
        text: 'hello',
        x: 100,
        y: 50,
        width: 200,
        height: 30,
    };

    it('scales word box proportionally when scales are equal', () => {
        const result = transformWordBox(baseWord, 1000, 500, 2000, 1000);

        expect(result.x).toBe(200);
        expect(result.y).toBe(100);
        expect(result.width).toBe(400);
        expect(result.height).toBe(60);
        expect(result.isCurrent).toBe(false);
    });

    it('uses per-axis scaling when rendered dimensions are not proportional', () => {
        const result = transformWordBox(baseWord, 1000, 500, 2000, 900);

        expect(result.x).toBeCloseTo(baseWord.x * 2);
        expect(result.y).toBeCloseTo(baseWord.y * 1.8);
        expect(result.width).toBeCloseTo(baseWord.width * 2);
        expect(result.height).toBeCloseTo(baseWord.height * 1.8);
    });

    it('fails loudly for rotated OCR artifacts because this legacy transform is rotation-blind', () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        expect(() => transformWordBox(baseWord, 1000, 500, 2000, 1000, 90))
            .toThrow('transformOcrWordToViewport');
    });

    it('returns zero-size box when image dimensions are missing', () => {
        const result = transformWordBox(baseWord, undefined, undefined, 800, 600);

        expect(result).toEqual({
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            isCurrent: false,
        });
    });

    it('returns zero-size box when imageDimensionWidth is 0', () => {
        const result = transformWordBox(baseWord, 0, 500, 800, 600);

        expect(result).toEqual({
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            isCurrent: false,
        });
    });

    it('handles word at origin (0,0)', () => {
        const originWord: IOcrWord = {
            text: 'origin',
            x: 0,
            y: 0,
            width: 50,
            height: 20,
        };

        const result = transformWordBox(originWord, 1000, 1000, 500, 500);

        expect(result.x).toBe(0);
        expect(result.y).toBe(0);
        expect(result.width).toBe(25);
        expect(result.height).toBe(10);
    });

    it('handles 1:1 scale (no scaling needed)', () => {
        const result = transformWordBox(baseWord, 1000, 500, 1000, 500);

        expect(result.x).toBe(baseWord.x);
        expect(result.y).toBe(baseWord.y);
        expect(result.width).toBe(baseWord.width);
        expect(result.height).toBe(baseWord.height);
    });

    it('handles very small scale factor', () => {
        const result = transformWordBox(baseWord, 10000, 10000, 100, 100);

        const scale = 0.01;
        expect(result.x).toBeCloseTo(baseWord.x * scale);
        expect(result.y).toBeCloseTo(baseWord.y * scale);
        expect(result.width).toBeCloseTo(baseWord.width * scale);
        expect(result.height).toBeCloseTo(baseWord.height * scale);
    });
});

describe('isOcrDebugEnabled', () => {
    const globalObject = globalThis as {window?: unknown;};
    const originalWindow = globalObject.window;

    afterEach(() => {
        globalObject.window = originalWindow;
    });

    it('returns false when window is undefined', () => {
        globalObject.window = undefined;
        expect(isOcrDebugEnabled()).toBe(false);
    });

    it('returns false when localStorage.getItem is missing', () => {
        globalObject.window = { localStorage: {} };
        expect(isOcrDebugEnabled()).toBe(false);
    });

    it('returns true when debug flag is enabled in localStorage', () => {
        globalObject.window = {localStorage: {getItem: (key: string) => (key === 'pdfOcrDebugBoxes' ? '1' : null)}};

        expect(isOcrDebugEnabled()).toBe(true);
    });
});
