import type * as TViMockOriginalModule from '@app/utils/platformDocuments';

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { readPdfConformanceProfile } from '@app/services/pdf-file/readPdfConformanceProfile';
import { requireDocumentRef } from '@contracts/documentRef';

const mocks = vi.hoisted(() => ({
    browserLogger: { warn: vi.fn() },
    documentPdf: { analyzePdfConformance: vi.fn() },
}));

vi.mock('@app/utils/browserLogger', () => ({ BrowserLogger: mocks.browserLogger }));
vi.mock('@app/utils/platformDocuments', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    getDocumentPdfCapability: () => mocks.documentPdf,
}));

describe('readPdfConformanceProfile', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.documentPdf.analyzePdfConformance.mockResolvedValue({
            profile: 'PDF/A-2u',
            isPdfA: true,
            isTagged: true,
            hasSignatures: false,
        });
    });

    it('reads conformance through the split pdf capability', async () => {
        const workingPath = requireDocumentRef('/tmp/working.pdf');
        const result = await readPdfConformanceProfile(workingPath);

        expect(result).toEqual({
            profile: 'PDF/A-2u',
            isPdfA: true,
            isTagged: true,
            hasSignatures: false,
        });
        expect(mocks.documentPdf.analyzePdfConformance).toHaveBeenCalledWith(workingPath);
    });

    it('logs and returns null when conformance analysis fails', async () => {
        const error = new Error('analysis failed');
        mocks.documentPdf.analyzePdfConformance.mockRejectedValueOnce(error);

        const workingPath = requireDocumentRef('/tmp/working.pdf');
        const result = await readPdfConformanceProfile(workingPath);

        expect(result).toBeNull();
        expect(mocks.browserLogger.warn).toHaveBeenCalledWith(
            'pdf-file',
            'Failed to analyze PDF conformance profile',
            {
                path: workingPath,
                error,
            },
        );
    });
});
