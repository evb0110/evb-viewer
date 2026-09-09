import type * as TViMockOriginalModule from '@app/platform/browser-api/browserYield';

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { BROWSER_MAX_FULL_READ_BYTES } from '@app/platform/browser/browserDocumentConstants';

const browserDocumentStoreMock = vi.hoisted(() => ({
    stat: vi.fn(),
    read: vi.fn(),
    readRange: vi.fn(),
}));

vi.mock('@app/platform/browserDocumentStore', () => ({browserDocumentStore: browserDocumentStoreMock}));
vi.mock('@app/platform/browser-api/browserPdfjsDocumentInit', () => ({
    createPdfjsDocumentInit: vi.fn(),
    createPdfjsDocumentInitFromBrowserDocument: vi.fn(),
    getPdfjsLib: vi.fn(),
}));
vi.mock('@app/platform/browser-api/browserYield', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    yieldToBrowser: vi.fn(async () => {}),
}));

describe('browserPdfValidation', () => {
    beforeEach(() => {
        vi.resetModules();
        browserDocumentStoreMock.stat.mockReset();
        browserDocumentStoreMock.read.mockReset();
        browserDocumentStoreMock.readRange.mockReset();
        browserDocumentStoreMock.readRange.mockImplementation(
            async (_path: string, _offset: number, length: number) => new Uint8Array(length),
        );
        browserDocumentStoreMock.read.mockResolvedValue(new Uint8Array([
            0x25,
            0x50,
            0x44,
            0x46,
        ]));
    });

    it.each([
        {
            expectedWholeReadCount: 1,
            size: BROWSER_MAX_FULL_READ_BYTES,
        },
        {
            expectedWholeReadCount: 0,
            size: BROWSER_MAX_FULL_READ_BYTES + 1,
        },
    ])('uses whole-value conformance analysis only at the 16 MiB boundary ($size bytes)', async ({
        expectedWholeReadCount,
        size,
    }) => {
        browserDocumentStoreMock.stat.mockResolvedValue({size});

        const { analyzeBrowserPdfConformance } = await import('@app/platform/browser-api/browserPdfValidation');
        await expect(analyzeBrowserPdfConformance('/tmp/browser.pdf')).resolves.toMatchObject({canIncrementalSave: expect.any(Boolean)});

        expect(browserDocumentStoreMock.read).toHaveBeenCalledTimes(expectedWholeReadCount);
        expect(browserDocumentStoreMock.readRange).toHaveBeenCalledTimes(2);
    });
});
