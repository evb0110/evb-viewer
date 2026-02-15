import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    buildCanvasCapturePlan,
    intersectClientRects,
    normalizeClientRect,
    writePngBlobToClipboard,
} from '@app/composables/pdf/usePdfRegionSnip';

describe('pdfRegionSnip geometry', () => {
    it('normalizes rectangle regardless of drag direction', () => {
        expect(normalizeClientRect(100, 200, 250, 320)).toEqual({
            left: 100,
            top: 200,
            right: 250,
            bottom: 320,
        });
        expect(normalizeClientRect(250, 320, 100, 200)).toEqual({
            left: 100,
            top: 200,
            right: 250,
            bottom: 320,
        });
        expect(normalizeClientRect(250, 200, 100, 320)).toEqual({
            left: 100,
            top: 200,
            right: 250,
            bottom: 320,
        });
    });

    it('computes intersections and auto-trims to page pixel bounds', () => {
        const selection = normalizeClientRect(50, 60, 360, 460);
        const firstCanvas = {
            width: 1200,
            height: 1600, 
        } as HTMLCanvasElement;
        const secondCanvas = {
            width: 1000,
            height: 1400, 
        } as HTMLCanvasElement;

        const plan = buildCanvasCapturePlan(selection, [
            {
                canvas: firstCanvas,
                rect: {
                    left: 100,
                    top: 100,
                    right: 300,
                    bottom: 300,
                },
            },
            {
                canvas: secondCanvas,
                rect: {
                    left: 260,
                    top: 280,
                    right: 420,
                    bottom: 480,
                },
            },
        ]);

        expect(plan.outputRect).toEqual({
            left: 100,
            top: 100,
            right: 360,
            bottom: 460,
        });
        expect(plan.fragments).toHaveLength(2);

        expect(plan.fragments[0]?.intersection).toEqual({
            left: 100,
            top: 100,
            right: 300,
            bottom: 300,
        });
        expect(plan.fragments[1]?.intersection).toEqual({
            left: 260,
            top: 280,
            right: 360,
            bottom: 460,
        });
    });

    it('returns no output when selection does not intersect any rendered page canvas', () => {
        const selection = normalizeClientRect(10, 10, 40, 40);
        const plan = buildCanvasCapturePlan(selection, [{
            canvas: {
                width: 800,
                height: 1000, 
            } as HTMLCanvasElement,
            rect: {
                left: 100,
                top: 100,
                right: 300,
                bottom: 300,
            },
        }]);

        expect(plan.outputRect).toBeNull();
        expect(plan.fragments).toHaveLength(0);
        expect(intersectClientRects(selection, {
            left: 100,
            top: 100,
            right: 300,
            bottom: 300,
        })).toBeNull();
    });
});

describe('pdfRegionSnip clipboard', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('writes png blob to clipboard when API is available', async () => {
        const write = vi.fn(async (_items: unknown[]) => {});
        const ClipboardItemMock = vi.fn(function ClipboardItem(
            this: { items: Record<string, Blob> },
            items: Record<string, Blob>,
        ) {
            this.items = items;
        });

        vi.stubGlobal('navigator', { clipboard: { write } });
        vi.stubGlobal('ClipboardItem', ClipboardItemMock);

        await writePngBlobToClipboard(new Blob(['ok'], { type: 'image/png' }));

        expect(ClipboardItemMock).toHaveBeenCalledOnce();
        expect(write).toHaveBeenCalledOnce();
    });

    it('surfaces clipboard write failures', async () => {
        const write = vi.fn(async () => {
            throw new Error('permission denied');
        });
        const ClipboardItemMock = vi.fn(function ClipboardItem(
            this: { items: Record<string, Blob> },
            items: Record<string, Blob>,
        ) {
            this.items = items;
        });

        vi.stubGlobal('navigator', { clipboard: { write } });
        vi.stubGlobal('ClipboardItem', ClipboardItemMock);

        await expect(writePngBlobToClipboard(new Blob(['x'], { type: 'image/png' }))).rejects.toThrow('permission denied');
    });
});
