import type * as TViMockOriginalModule from '@app/utils/platformDocuments';

import { requireDocumentRef } from '@contracts/documentRef';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    documentHasEmbeddedShapeCandidates,
    hasEmbeddedShapeCandidateBytes,
} from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/scanDocumentForEmbeddedShapeCandidates';

const mockDocuments = {readFileChunks: vi.fn()};

vi.mock('@app/utils/platformDocuments', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    getDocumentFilesCapability: () => mockDocuments,
}));

const encode = (value: string) => new TextEncoder().encode(value);

describe('scanDocumentForEmbeddedShapeCandidates', () => {
    beforeEach(() => {
        mockDocuments.readFileChunks.mockReset();
    });

    it('recognizes managed keys and geometric annotation names without matching name prefixes', () => {
        expect(hasEmbeddedShapeCandidateBytes(encode('<< /EVBShapeKey <1234> >>'))).toBe(true);
        expect(hasEmbeddedShapeCandidateBytes(encode('<< /Subtype /Square >>'))).toBe(true);
        expect(hasEmbeddedShapeCandidateBytes(encode('<< /Linearized 1 >>'))).toBe(false);
    });

    it('finds a candidate split across bounded range chunks and stops scanning immediately', async () => {
        const deliveredChunks = [
            encode('<< /EVBSh'),
            encode('apeKey <1234> >>'),
            encode('must-not-be-read'),
        ];
        let deliveredCount = 0;
        mockDocuments.readFileChunks.mockImplementation(async (_path, options, onChunk) => {
            expect(options.chunkBytes).toBe(1024 * 1024);
            for (const chunk of deliveredChunks) {
                deliveredCount += 1;
                await onChunk(chunk, 0);
            }
            return {
                size: 68 * 1024 * 1024,
                bytesRead: 0,
                chunks: deliveredCount,
            };
        });

        await expect(documentHasEmbeddedShapeCandidates(requireDocumentRef('/tmp/large.pdf'))).resolves.toBe(true);
        expect(deliveredCount).toBe(2);
    });

    it('does not treat a PDF name prefix split at a chunk boundary as a shape token', async () => {
        mockDocuments.readFileChunks.mockImplementation(async (_path, _options, onChunk) => {
            await onChunk(encode('<< /Line'), 0);
            await onChunk(encode('arized 1 >>'), 8);
            return {
                size: 21,
                bytesRead: 21,
                chunks: 2,
            };
        });

        await expect(documentHasEmbeddedShapeCandidates(requireDocumentRef('/tmp/linearized.pdf'))).resolves.toBe(false);
    });

    it('scans a logical sparse PDF above 64 MiB with bounded chunks and no whole-file allocation', async () => {
        const chunk = new Uint8Array(1024 * 1024);
        const logicalSize = 68 * 1024 * 1024;
        let maxDeliveredBytes = 0;
        mockDocuments.readFileChunks.mockImplementation(async (_path, _options, onChunk) => {
            let offset = 0;
            let chunks = 0;
            while (offset < logicalSize) {
                maxDeliveredBytes = Math.max(maxDeliveredBytes, chunk.byteLength);
                await onChunk(chunk, offset);
                offset += chunk.byteLength;
                chunks += 1;
            }
            return {
                size: logicalSize,
                bytesRead: logicalSize,
                chunks,
            };
        });

        await expect(documentHasEmbeddedShapeCandidates(requireDocumentRef('/tmp/sparse-large.pdf'))).resolves.toBe(false);
        expect(maxDeliveredBytes).toBe(1024 * 1024);
        expect(mockDocuments.readFileChunks).toHaveBeenCalledOnce();
    });
});
