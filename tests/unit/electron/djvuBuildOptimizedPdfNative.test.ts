import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({nativeBuild: vi.fn()}));

vi.mock('@electron/image/tryCreatePdfWithNativeImageCombiner', () => ({tryBuildOptimizedPdfWithNativeImageCombiner: (...args: unknown[]) => mocks.nativeBuild(...args)}));

describe('DjVu optimized PDF native fast path', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns the native PDF when the Netpbm helper accepts the input', async () => {
        const nativeBytes = new Uint8Array([
            1,
            2,
            3,
        ]);
        mocks.nativeBuild.mockResolvedValueOnce(nativeBytes);

        const { buildOptimizedPdf } = await import('@electron/djvu/buildOptimizedPdf');
        const onPageProcessed = vi.fn();

        await expect(buildOptimizedPdf([
            '/tmp/page-1.pgm',
            '/tmp/page-2.pgm',
        ], 300, onPageProcessed)).resolves.toBe(nativeBytes);

        expect(mocks.nativeBuild).toHaveBeenCalledWith([
            '/tmp/page-1.pgm',
            '/tmp/page-2.pgm',
        ], 300, onPageProcessed, undefined);
    });

    it('passes abort signals into the native optimized PDF builder', async () => {
        const nativeBytes = new Uint8Array([
            4,
            5,
            6,
        ]);
        const controller = new AbortController();
        mocks.nativeBuild.mockResolvedValueOnce(nativeBytes);

        const { buildOptimizedPdf } = await import('@electron/djvu/buildOptimizedPdf');
        const onPageProcessed = vi.fn();

        await expect(buildOptimizedPdf(['/tmp/page-1.pgm'], 300, onPageProcessed, {signal: controller.signal})).resolves.toBe(nativeBytes);

        expect(mocks.nativeBuild).toHaveBeenCalledWith(['/tmp/page-1.pgm'], 300, onPageProcessed, {signal: controller.signal});
    });

    it('checks for cancellation after the native builder declines the input', async () => {
        const controller = new AbortController();
        mocks.nativeBuild.mockImplementationOnce(() => {
            controller.abort(new DOMException('canceled after native build', 'AbortError'));
            return Promise.resolve(null);
        });

        const { buildOptimizedPdf } = await import('@electron/djvu/buildOptimizedPdf');

        await expect(buildOptimizedPdf(['/tmp/missing-page.pgm'], 300, undefined, {signal: controller.signal})).rejects.toThrow('canceled after native build');
    });

    it('fails closed when native output is unavailable', async () => {
        mocks.nativeBuild.mockResolvedValueOnce(null);

        const { buildOptimizedPdf } = await import('@electron/djvu/buildOptimizedPdf');
        await expect(buildOptimizedPdf(['/tmp/page.pgm'], 200)).rejects.toMatchObject({
            name: 'PdfCombineCapabilityError',
            code: 'native-failure',
            operation: 'djvu-pdf',
        });
    });
});
