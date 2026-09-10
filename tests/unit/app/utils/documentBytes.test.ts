import type * as TViMockOriginalModule from '@app/utils/platformDocuments';

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    readDocumentBytes,
    readDocumentBytesIfBelowLimit,
} from '@app/utils/documentBytes';
import { MAX_DOCUMENT_ALLOCATION_BYTES } from '@contracts/electronApiDocuments';
import {requireDocumentRef} from '@contracts/documentRef';

const mockDocuments = {
    statFile: vi.fn(),
    readFile: vi.fn(),
    readFileRange: vi.fn(),
};

vi.mock('@app/utils/platformDocuments', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    getDocumentFilesCapability: () => mockDocuments,
}));

describe('documentBytes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockDocuments.statFile.mockReset();
        mockDocuments.readFile.mockReset();
        mockDocuments.readFileRange.mockReset();
    });

    it('uses direct reads for small files', async () => {
        const bytes = Uint8Array.from([
            1,
            2,
            3,
        ]);
        mockDocuments.statFile.mockResolvedValue({ size: bytes.byteLength });
        mockDocuments.readFile.mockResolvedValue(bytes);

        await expect(readDocumentBytes(requireDocumentRef('/tmp/doc.pdf'))).resolves.toEqual(bytes);
        expect(mockDocuments.readFile).toHaveBeenCalledWith('/tmp/doc.pdf');
        expect(mockDocuments.readFileRange).not.toHaveBeenCalled();
    });

    it('assembles large files from chunked range reads', async () => {
        const firstChunk = new Uint8Array(64 * 1024).fill(1);
        const secondChunk = new Uint8Array(64 * 1024).fill(2);
        const finalChunk = Uint8Array.from([
            3,
            4,
        ]);
        const expected = new Uint8Array(
            firstChunk.byteLength + secondChunk.byteLength + finalChunk.byteLength,
        );
        expected.set(firstChunk, 0);
        expected.set(secondChunk, firstChunk.byteLength);
        expected.set(finalChunk, firstChunk.byteLength + secondChunk.byteLength);

        mockDocuments.statFile.mockResolvedValue({ size: expected.byteLength });
        mockDocuments.readFileRange
            .mockResolvedValueOnce(firstChunk)
            .mockResolvedValueOnce(secondChunk)
            .mockResolvedValueOnce(finalChunk);

        await expect(readDocumentBytes(requireDocumentRef('/tmp/doc.pdf'), {chunkSize: 64 * 1024})).resolves.toEqual(expected);
        expect(mockDocuments.readFile).not.toHaveBeenCalled();
        expect(mockDocuments.readFileRange).toHaveBeenNthCalledWith(1, '/tmp/doc.pdf', 0, 64 * 1024);
        expect(mockDocuments.readFileRange).toHaveBeenNthCalledWith(2, '/tmp/doc.pdf', 64 * 1024, 64 * 1024);
        expect(mockDocuments.readFileRange).toHaveBeenNthCalledWith(3, '/tmp/doc.pdf', 128 * 1024, 2);
    });

    it('returns null when the document exceeds the requested limit', async () => {
        mockDocuments.statFile.mockResolvedValue({ size: 100 });

        await expect(readDocumentBytesIfBelowLimit(requireDocumentRef('/tmp/doc.pdf'), 64)).resolves.toBeNull();
        expect(mockDocuments.readFile).not.toHaveBeenCalled();
        expect(mockDocuments.readFileRange).not.toHaveBeenCalled();
    });

    it('rejects direct reads that grow beyond the requested limit after stat', async () => {
        mockDocuments.statFile.mockResolvedValue({ size: 4 });
        mockDocuments.readFile.mockResolvedValue(new Uint8Array(128));

        await expect(readDocumentBytes(requireDocumentRef('/tmp/doc.pdf'), {maxBytes: 64}))
            .rejects
            .toThrow('Document exceeds in-memory read limit (64 bytes)');
    });

    it('rejects direct reads that no longer match the resolved size', async () => {
        mockDocuments.statFile.mockResolvedValue({ size: 4 });
        mockDocuments.readFile.mockResolvedValue(Uint8Array.from([
            1,
            2,
            3,
        ]));

        await expect(readDocumentBytes(requireDocumentRef('/tmp/doc.pdf')))
            .rejects
            .toThrow('expected 4 bytes, read 3 bytes');
    });

    it('rejects range reads that return fewer bytes than requested', async () => {
        mockDocuments.statFile.mockResolvedValue({ size: 128 * 1024 });
        mockDocuments.readFileRange.mockResolvedValueOnce(new Uint8Array(64 * 1024));
        mockDocuments.readFileRange.mockResolvedValueOnce(new Uint8Array(1));

        await expect(readDocumentBytes(requireDocumentRef('/tmp/doc.pdf'), {chunkSize: 64 * 1024}))
            .rejects
            .toThrow('expected 65536 bytes, read 1 bytes');
    });

    it('rejects oversized allocation sizes before reading or allocating', async () => {
        mockDocuments.statFile.mockResolvedValue({ size: MAX_DOCUMENT_ALLOCATION_BYTES + 1 });

        await expect(readDocumentBytes(requireDocumentRef('/tmp/oversized.pdf')))
            .rejects
            .toThrow(`no greater than ${MAX_DOCUMENT_ALLOCATION_BYTES} bytes`);
        expect(mockDocuments.readFile).not.toHaveBeenCalled();
        expect(mockDocuments.readFileRange).not.toHaveBeenCalled();
    });
});
