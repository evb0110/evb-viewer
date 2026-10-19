import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireRequestId} from '@contracts/shared';
import {requirePageNumber} from '@contracts/pageNumbers';

const browserPlatformWiringTimeoutMs = 8_000;

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

    it('refuses OCR with its reason when the browser cannot run the engine', async () => {
        vi.stubGlobal('Worker', undefined);
        try {
            const { browserOcrCapability } = await import('@app/platform/browser-api/browserOcrCapability');

            await expect(browserOcrCapability.getLanguages()).resolves.toEqual([]);
            await expect(browserOcrCapability.createSearchablePdf(requireDocumentRef('browser://documents/a/in.pdf'), [{
                pageNumber: requirePageNumber(1),
                languages: ['eng'],
            }], requireRequestId('request-2'))).resolves.toMatchObject({
                started: false,
                errorEnvelope: {
                    code: 'OCR_BROWSER_UNSUPPORTED',
                    message: 'OCR_BROWSER_UNSUPPORTED',
                },
            });
        } finally {
            vi.unstubAllGlobals();
        }
    });

    describe('in a browser that can run the engine', () => {
        beforeEach(() => {
            vi.stubGlobal('Worker', function Worker() {});
            vi.stubGlobal('caches', {open: () => Promise.resolve({match: () => Promise.resolve(undefined)})});
        });
        afterEach(() => {
            vi.unstubAllGlobals();
        });

        it('offers the eight browser languages, each still to download', async () => {
            const { browserOcrCapability } = await import('@app/platform/browser-api/browserOcrCapability');

            const languages = await browserOcrCapability.getLanguages();
            expect(languages.map(language => language.code).sort())
                .toEqual([
                    'deu',
                    'eng',
                    'fra',
                    'ita',
                    'nld',
                    'por',
                    'rus',
                    'spa',
                ]);
            expect(new Set(languages.map(language => language.modelState))).toEqual(new Set(['missing']));
        });

        it('refuses a language only the desktop app recognizes', async () => {
            const { browserOcrCapability } = await import('@app/platform/browser-api/browserOcrCapability');

            await expect(browserOcrCapability.createSearchablePdf(requireDocumentRef('browser://documents/a/in.pdf'), [{
                pageNumber: requirePageNumber(1),
                languages: ['lat'],
            }], requireRequestId('request-3'))).resolves.toMatchObject({
                started: false,
                error: expect.stringContaining('lat needs the desktop app'),
                errorEnvelope: {code: 'OCR_INVALID_PAYLOAD'},
            });
        });
    });

    it('reports unknown jobs and results without touching documents', async () => {
        const { browserOcrCapability } = await import('@app/platform/browser-api/browserOcrCapability');

        await expect(browserOcrCapability.cancel(requireRequestId('request-5'))).resolves.toEqual({
            canceled: false,
            reason: 'not-found',
        });
        await expect(browserOcrCapability.acknowledgeResultFile(
            requireRequestId('request-5'),
            requireDocumentRef('browser://documents/b/result.pdf'),
        )).resolves.toEqual({cleaned: false});
    });

    it('wires the browser platform to the browser OCR capability', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { browserPlatformApi } = await import('@app/platform/browserPlatformApi');
        const { browserOcrCapability } = await import('@app/platform/browser-api/browserOcrCapability');

        expect(browserPlatformApi.ocr).toBe(browserOcrCapability);
    }, browserPlatformWiringTimeoutMs);
});
