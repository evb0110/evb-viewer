import type * as TViMockOriginalModule from '@app/platform/browser-api/browserYield';

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { PDFDocument } from 'pdf-lib';

const pdfjsModule = vi.hoisted(() => ({
    version: '6.3.311',
    GlobalWorkerOptions: {},
    PDFDataRangeTransport: function MockPdfDataRangeTransport() {},
    VerbosityLevel: {ERRORS: 3},
    getDocument: vi.fn(),
}));

vi.mock('pdfjs-dist', () => pdfjsModule);
vi.mock('@app/platform/browser-api/browserYield', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    yieldToBrowser: () => Promise.resolve(),
}));

describe('createBrowserDocumentsFileCapability validation', () => {
    beforeEach(() => {
        vi.resetModules();
        pdfjsModule.getDocument.mockReset();
    });

    it('validates pdf bytes with pdf.js instead of pdf-lib parsing', async () => {
        const destroy = vi.fn(async () => {});
        pdfjsModule.getDocument.mockReturnValue({promise: Promise.resolve({destroy})});

        const loadSpy = vi.spyOn(PDFDocument, 'load');
        const { createBrowserDocumentsFileCapability } = await import('@app/platform/browser-api/createBrowserDocumentsFileCapability');
        const capability = createBrowserDocumentsFileCapability({ clearSearchCaches: () => {} });

        await expect(
            capability.validatePdfData(new Uint8Array([
                1,
                2,
                3,
            ])),
        ).resolves.toEqual({
            isValid: true,
            tool: 'browser',
            errors: [],
            warnings: [],
        });

        expect(pdfjsModule.getDocument).toHaveBeenCalledTimes(1);
        const firstCall = pdfjsModule.getDocument.mock.calls[0]?.[0] as { data: Uint8Array };
        expect(firstCall.data).not.toBeUndefined();
        expect(loadSpy).not.toHaveBeenCalled();
        expect(destroy).toHaveBeenCalledTimes(1);
    });

    it('passes cloned bytes to pdf.js validation so caller data stays owned', async () => {
        const destroy = vi.fn(async () => {});
        pdfjsModule.getDocument.mockReturnValue({promise: Promise.resolve({destroy})});

        const { createBrowserDocumentsFileCapability } = await import('@app/platform/browser-api/createBrowserDocumentsFileCapability');
        const capability = createBrowserDocumentsFileCapability({ clearSearchCaches: () => {} });
        const input = new Uint8Array([
            7,
            8,
            9,
        ]);

        await capability.validatePdfData(input);

        const firstCall = pdfjsModule.getDocument.mock.calls[0]?.[0] as { data: Uint8Array };
        expect(firstCall.data).not.toBe(input);
        expect(Array.from(firstCall.data)).toEqual(Array.from(input));
        expect(Array.from(input)).toEqual([
            7,
            8,
            9,
        ]);
    });
});
