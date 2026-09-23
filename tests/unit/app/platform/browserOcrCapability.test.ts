import {
    readdirSync,
    statSync,
} from 'fs';
import { resolve } from 'path';
import {
    beforeAll,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireRequestId} from '@contracts/shared';
import {requirePageNumber} from '@contracts/pageNumbers';

const browserPlatformWiringTimeoutMs = 8_000;

function listFilesRecursive(path: string): string[] {
    try {
        return readdirSync(path)
            .flatMap((entry) => {
                const entryPath = resolve(path, entry);

                return statSync(entryPath).isDirectory()
                    ? listFilesRecursive(entryPath)
                    : [entryPath];
            });
    } catch {
        return [];
    }
}

describe('browser OCR capability', {timeout: 20_000}, () => {
    beforeAll(async () => {
        // The first import transforms the whole browser platform, which takes
        // seconds on a loaded machine. Pay that once here so the wiring budget
        // below measures the wiring, not the transform.
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            await import('@app/platform/browserPlatformApi');
        } finally {
            consoleError.mockRestore();
        }
    });

    it('does not ship browser Tesseract assets', () => {
        expect(listFilesRecursive(resolve(process.cwd(), 'public/tesseract'))).toEqual([]);
    });

    it('reports OCR as unavailable in browser runtime', async () => {
        const { browserOcrCapability } = await import('@app/platform/browser-api/browserOcrCapability');

        await expect(browserOcrCapability.getLanguages()).resolves.toEqual([]);
    });

    it('does not create searchable PDFs in browser runtime', async () => {
        const { browserOcrCapability } = await import('@app/platform/browser-api/browserOcrCapability');

        await expect(browserOcrCapability.createSearchablePdf(requireDocumentRef('/tmp/in.pdf'), [{
            pageNumber: requirePageNumber(1),
            languages: ['eng'],
        }], requireRequestId('request-2'))).resolves.toMatchObject({
            started: false,
            jobId: expect.stringMatching(/^ocr-unavailable-[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/u),
            installed: [],
            error: 'Browser OCR is unavailable; use the desktop app to create searchable PDFs.',
            errorEnvelope: { code: 'OCR_WORKER_UNAVAILABLE' },
        });
    });

    it('returns Electron-compatible unavailable shapes for browser-only OCR operations', async () => {
        const { browserOcrCapability } = await import('@app/platform/browser-api/browserOcrCapability');

        await expect(browserOcrCapability.cancel(requireRequestId('request-5'))).resolves.toMatchObject({
            canceled: false,
            reason: 'not-found',
            errorEnvelope: { code: 'OCR_WORKER_UNAVAILABLE' },
        });
        await expect(browserOcrCapability.acknowledgeResultFile(requireRequestId('request-5'))).resolves.toMatchObject({
            cleaned: false,
            errorEnvelope: { code: 'OCR_WORKER_UNAVAILABLE' },
        });
    });

    it('keeps browser OCR event hooks inert', async () => {
        const { browserOcrCapability } = await import('@app/platform/browser-api/browserOcrCapability');
        const onProgress = vi.fn();
        const onComplete = vi.fn();

        const unsubscribeProgress = browserOcrCapability.onProgress(onProgress);
        const unsubscribeComplete = browserOcrCapability.onComplete(onComplete);
        unsubscribeProgress();
        unsubscribeComplete();

        expect(onProgress).not.toHaveBeenCalled();
        expect(onComplete).not.toHaveBeenCalled();
    });

    it('wires the browser platform to the unavailable OCR capability', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { browserPlatformApi } = await import('@app/platform/browserPlatformApi');

        await expect(browserPlatformApi.ocr.createSearchablePdf(requireDocumentRef('/tmp/source.pdf'), [], requireRequestId('request-4')))
            .resolves.toMatchObject({
                started: false,
                jobId: expect.stringMatching(/^ocr-unavailable-[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/u),
                errorEnvelope: { code: 'OCR_WORKER_UNAVAILABLE' },
            });
    }, browserPlatformWiringTimeoutMs);
});
