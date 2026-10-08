import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createDjvuCanvas,
    encodeDjvuCanvas,
    fetchDjvuObjectUrlBytes,
    getDjvuCanvas2dContext,
    loadDjvuBitmap,
    releaseDjvuCanvas,
    toOwnedArrayBuffer,
    type TDjvuCanvas,
} from '@app/platform/browser-api/browserDjvuCanvas';

afterEach(() => {
    vi.unstubAllGlobals();
});

function asDjvuCanvas(canvas: object) {
    return canvas as TDjvuCanvas;
}

describe('toOwnedArrayBuffer', () => {
    it('returns the backing buffer when the view covers it fully', () => {
        const bytes = new Uint8Array([
            1,
            2,
            3,
        ]);
        expect(toOwnedArrayBuffer(bytes)).toBe(bytes.buffer);
    });

    it('copies when the view is a window into a larger buffer', () => {
        const backing = new Uint8Array([
            1,
            2,
            3,
            4,
            5,
        ]);
        const view = backing.subarray(1, 4);
        const owned = toOwnedArrayBuffer(view);
        expect(owned).not.toBe(backing.buffer);
        expect([...new Uint8Array(owned)]).toEqual([
            2,
            3,
            4,
        ]);
        // The copy must be detached from the source buffer.
        backing[2] = 99;
        expect([...new Uint8Array(owned)]).toEqual([
            2,
            3,
            4,
        ]);
    });
});

describe('createDjvuCanvas', () => {
    it('throws when no canvas implementation exists in the runtime', () => {
        expect(() => createDjvuCanvas(10, 5)).toThrow('Canvas is unavailable');
    });

    it('prefers OffscreenCanvas when available', () => {
        class FakeOffscreenCanvas {
            constructor(public width: number, public height: number) {}
        }
        vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
        const canvas = createDjvuCanvas(10, 5);
        expect(canvas).toBeInstanceOf(FakeOffscreenCanvas);
        expect(canvas.width).toBe(10);
        expect(canvas.height).toBe(5);
    });

    it('falls back to a document-created canvas element', () => {
        const created = {
            width: 0,
            height: 0,
        };
        const createElement = vi.fn(() => created);
        vi.stubGlobal('document', {createElement});
        const canvas = createDjvuCanvas(10, 5);
        expect(createElement).toHaveBeenCalledWith('canvas');
        expect(canvas).toBe(created);
        expect(created).toMatchObject({
            width: 10,
            height: 5,
        });
    });
});

describe('getDjvuCanvas2dContext', () => {
    it('resolves the 2d context for both canvas kinds', () => {
        const context = {};
        const offscreenLike = {getContext: vi.fn(() => context)};
        expect(getDjvuCanvas2dContext(asDjvuCanvas(offscreenLike))).toBe(context);
        expect(offscreenLike.getContext).toHaveBeenCalledWith('2d');

        class FakeHtmlCanvasElement {
            getContext = vi.fn(() => context);
        }
        vi.stubGlobal('HTMLCanvasElement', FakeHtmlCanvasElement);
        const htmlCanvas = new FakeHtmlCanvasElement();
        expect(getDjvuCanvas2dContext(asDjvuCanvas(htmlCanvas))).toBe(context);
        expect(htmlCanvas.getContext).toHaveBeenCalledWith('2d');
    });
});

describe('encodeDjvuCanvas', () => {
    it('encodes via convertToBlob for OffscreenCanvas and forwards quality', async () => {
        class FakeOffscreenCanvas {
            convertToBlob = vi.fn(async () => new Blob([new Uint8Array([
                7,
                8,
            ])]));
        }
        vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
        const canvas = new FakeOffscreenCanvas();
        const bytes = await encodeDjvuCanvas(asDjvuCanvas(canvas), 'image/jpeg', 0.8);
        expect(canvas.convertToBlob).toHaveBeenCalledWith({
            type: 'image/jpeg',
            quality: 0.8,
        });
        expect([...bytes]).toEqual([
            7,
            8,
        ]);
    });

    it('omits the quality option when none is provided', async () => {
        class FakeOffscreenCanvas {
            convertToBlob = vi.fn(async () => new Blob([new Uint8Array([7])]));
        }
        vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
        const canvas = new FakeOffscreenCanvas();
        await encodeDjvuCanvas(asDjvuCanvas(canvas), 'image/png');
        expect(canvas.convertToBlob).toHaveBeenCalledWith({type: 'image/png'});
    });

    it('falls back to toBlob for canvas elements', async () => {
        const toBlob = vi.fn((
            callback: (blob: Blob | null) => void,
        ) => callback(new Blob([new Uint8Array([9])])));
        const bytes = await encodeDjvuCanvas(asDjvuCanvas({toBlob}), 'image/png', 0.5);
        expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png', 0.5);
        expect([...bytes]).toEqual([9]);
    });

    it('rejects when toBlob produces no blob', async () => {
        const canvas = {toBlob: (callback: (blob: Blob | null) => void) => callback(null)};
        await expect(encodeDjvuCanvas(asDjvuCanvas(canvas), 'image/png'))
            .rejects
            .toThrow('Failed to encode canvas as image/png');
    });
});

describe('fetchDjvuObjectUrlBytes', () => {
    it('returns the fetched bytes', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([
            1,
            2,
        ]))));
        const bytes = await fetchDjvuObjectUrlBytes('blob:doc');
        expect([...bytes]).toEqual([
            1,
            2,
        ]);
    });

    it('throws with the HTTP status on failure', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {status: 404})));
        await expect(fetchDjvuObjectUrlBytes('blob:doc'))
            .rejects
            .toThrow('Failed to read DjVu page image: 404');
    });
});

describe('loadDjvuBitmap', () => {
    it('rejects when the runtime has no image decoder', async () => {
        await expect(loadDjvuBitmap(new Uint8Array([1])))
            .rejects
            .toThrow('Image decoding is unavailable');
    });
});

describe('releaseDjvuCanvas', () => {
    it('zeroes the canvas dimensions', () => {
        const canvas = {
            width: 100,
            height: 50,
        };
        releaseDjvuCanvas(asDjvuCanvas(canvas));
        expect(canvas).toMatchObject({
            width: 0,
            height: 0,
        });
    });
});
