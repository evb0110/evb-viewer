// @vitest-environment happy-dom

import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    assertPdfjsVendoredAssetVersion,
    getPdfjsBrowserRuntimeProbeFailures,
} from '@app/services/pdfjs/runtimeLib';

// What every PDF.js document open needs; preparation checks these before it
// configures the worker or builds document options.
function createCompatibleRuntime(overrides: Record<PropertyKey, unknown> = {}) {
    return {
        version: '6.3.311',
        getDocument() {},
        GlobalWorkerOptions: {workerSrc: './pdf.worker.mjs'},
        VerbosityLevel: {ERRORS: 0},
        PDFDataRangeTransport: function MockPdfDataRangeTransport() {},
        ...overrides,
    };
}

describe('pdf.js runtime adapter probes', () => {
    it('accepts the installed pdf.js runtime', () => {
        expect(getPdfjsBrowserRuntimeProbeFailures()).toEqual([]);
    });

    it('reports clear core browser runtime failures', () => {
        const runtime = createCompatibleRuntime({
            version: '',
            PDFDataRangeTransport: undefined,
        });

        expect(getPdfjsBrowserRuntimeProbeFailures(runtime)).toEqual([
            'version export is missing',
            'PDFDataRangeTransport export is not a constructor',
        ]);
    });

    it('asserts vendored asset stamps against the runtime version', async () => {
        const runtime = createCompatibleRuntime();

        await expect(assertPdfjsVendoredAssetVersion(runtime, {
            force: true,
            readVersionStamp: async () => '6.3.311\n',
        })).resolves.toBeUndefined();
    });

    it('rejects missing and mismatched vendored asset stamps clearly', async () => {
        const runtime = createCompatibleRuntime();

        await expect(assertPdfjsVendoredAssetVersion(runtime, {
            force: true,
            readVersionStamp: async () => '',
        })).rejects.toThrow('PDF.js vendored asset version stamp is empty');

        await expect(assertPdfjsVendoredAssetVersion(runtime, {
            force: true,
            readVersionStamp: async () => '5.7.283',
        })).rejects.toThrow('installed runtime is 6.3.311, vendored assets are 5.7.283');
    });
});
