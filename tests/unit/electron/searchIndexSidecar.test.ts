import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    COMPACT_SEARCH_INDEX_HEADER_SIZE,
    COMPACT_SEARCH_INDEX_MAGIC,
    COMPACT_SEARCH_INDEX_PAGE_RECORD_SIZE,
    COMPACT_SEARCH_INDEX_SCHEMA_VERSION,
    COMPACT_SEARCH_INDEX_SOURCE_KIND_GENERIC,
    COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER,
    COMPACT_SEARCH_INDEX_STREAMING_FLAG_COMPLETE,
    COMPACT_SEARCH_INDEX_STREAMING_FLAG_PARTIAL_COVERAGE,
    COMPACT_SEARCH_INDEX_STREAMING_FLAG_TRUNCATED_COVERAGE,
    COMPACT_SEARCH_INDEX_STREAMING_FOOTER_MAGIC,
    COMPACT_SEARCH_INDEX_STREAMING_MAGIC,
    COMPACT_SEARCH_INDEX_STREAMING_SCHEMA_VERSION,
    getCompactSearchIndexPath,
    loadCompactSearchIndex,
    openCompactSearchIndexWriter,
    persistCompactSearchIndexStreaming,
    persistCompactSearchIndex,
} from '@electron/features/search/searchIndexSidecar';
import { OCR_TEXT_LAYER_INDEX_VERSION } from '@contracts/ocrText';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {requirePageNumber} from '@contracts/pageNumbers';

const DOCUMENT_REVISION = requireDocumentRevisionToken('revision-token');

describe('compact search index sidecar', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-search-sidecar-'));
    });

    afterEach(async () => {
        await rm(tempDir, {
            recursive: true,
            force: true,
        });
    });

    it('writes the native-search-compatible header, records, and UTF-8 page text', async () => {
        const pdfPath = join(tempDir, 'work.pdf');

        await persistCompactSearchIndex(pdfPath, {
            documentRevision: DOCUMENT_REVISION,
            pageCount: 2,
            textSource: {
                kind: COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER,
                version: OCR_TEXT_LAYER_INDEX_VERSION,
            },
            pages: [
                {
                    pageNumber: requirePageNumber(2),
                    text: 'second page',
                },
                {
                    pageNumber: requirePageNumber(1),
                    text: 'first page',
                },
            ],
        });

        const sidecar = await readFile(getCompactSearchIndexPath(pdfPath));
        expect(sidecar.toString('ascii', 0, 8)).toBe(COMPACT_SEARCH_INDEX_MAGIC);
        expect(sidecar.readUInt32LE(8)).toBe(COMPACT_SEARCH_INDEX_SCHEMA_VERSION);
        expect(sidecar.readUInt32LE(12)).toBe(COMPACT_SEARCH_INDEX_HEADER_SIZE);
        expect(sidecar.readUInt32LE(16)).toBe(2);
        expect(sidecar.readUInt32LE(20)).toBe(2);
        expect(sidecar.readUInt32LE(24)).toBe(
            COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER + OCR_TEXT_LAYER_INDEX_VERSION * 0x10000,
        );
        expect(sidecar.readUInt32LE(28)).toBe(Buffer.byteLength(DOCUMENT_REVISION, 'utf8'));
        expect(sidecar.subarray(64, 64 + DOCUMENT_REVISION.length).toString('utf8')).toBe(DOCUMENT_REVISION);

        const firstRecordOffset = COMPACT_SEARCH_INDEX_HEADER_SIZE + Buffer.byteLength(DOCUMENT_REVISION, 'utf8');
        expect(sidecar.readUInt32LE(firstRecordOffset)).toBe(1);
        expect(sidecar.readUInt32LE(firstRecordOffset + COMPACT_SEARCH_INDEX_PAGE_RECORD_SIZE)).toBe(2);

        const loaded = await loadCompactSearchIndex(pdfPath, {
            documentRevision: DOCUMENT_REVISION,
            expectedPageCount: 2,
        });
        expect(loaded).toEqual({
            documentRevision: DOCUMENT_REVISION,
            pageCount: 2,
            textSource: {
                kind: COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER,
                version: OCR_TEXT_LAYER_INDEX_VERSION,
            },
            pages: [
                {
                    pageNumber: 1,
                    text: 'first page',
                },
                {
                    pageNumber: 2,
                    text: 'second page',
                },
            ],
        });

        await expect(loadCompactSearchIndex(pdfPath, {
            documentRevision: DOCUMENT_REVISION,
            expectedPageCount: 2,
            metadataOnly: true,
        })).resolves.toEqual({
            documentRevision: DOCUMENT_REVISION,
            pageCount: 2,
            textSource: {
                kind: COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER,
                version: OCR_TEXT_LAYER_INDEX_VERSION,
            },
            pages: [],
        });
    });

    it('applies a caller-specific aggregate text budget before allocating page strings', async () => {
        const pdfPath = join(tempDir, 'caller-budget.pdf');
        await persistCompactSearchIndex(pdfPath, {
            documentRevision: DOCUMENT_REVISION,
            pageCount: 1,
            pages: [{
                pageNumber: requirePageNumber(1),
                text: 'bounded text',
            }],
        });

        await expect(loadCompactSearchIndex(pdfPath, {
            documentRevision: DOCUMENT_REVISION,
            maxTotalTextBytes: 4,
        })).resolves.toBeNull();
    });

    it('rejects stale sidecars when the source mtime is newer', async () => {
        const pdfPath = join(tempDir, 'work.pdf');
        await persistCompactSearchIndex(pdfPath, {
            documentRevision: DOCUMENT_REVISION,
            pageCount: 1,
            pages: [{
                pageNumber: requirePageNumber(1),
                text: 'current text',
            }],
        });

        const sidecarStat = await stat(getCompactSearchIndexPath(pdfPath));

        await expect(loadCompactSearchIndex(pdfPath, {
            documentRevision: DOCUMENT_REVISION,
            expectedPageCount: 1,
            minSourceMtimeMs: sidecarStat.mtimeMs + 1000,
        })).resolves.toBeNull();

        await expect(loadCompactSearchIndex(pdfPath, {
            documentRevision: DOCUMENT_REVISION,
            expectedPageCount: 1,
            minSourceMtimeMs: sidecarStat.mtimeMs,
        })).resolves.toEqual({
            documentRevision: DOCUMENT_REVISION,
            pageCount: 1,
            textSource: {
                kind: COMPACT_SEARCH_INDEX_SOURCE_KIND_GENERIC,
                version: 0,
            },
            pages: [{
                pageNumber: 1,
                text: 'current text',
            }],
        });
    });

    it('requires expected page coverage before loading', async () => {
        const pdfPath = join(tempDir, 'partial.pdf');
        await persistCompactSearchIndex(pdfPath, {
            documentRevision: DOCUMENT_REVISION,
            pageCount: 3,
            pages: [{
                pageNumber: requirePageNumber(1),
                text: 'partial text',
            }],
        });

        await expect(loadCompactSearchIndex(pdfPath, {
            documentRevision: DOCUMENT_REVISION,
            expectedPageCount: 3,
        })).resolves.toBeNull();
        await expect(loadCompactSearchIndex(pdfPath, {
            documentRevision: DOCUMENT_REVISION,
            expectedPageCount: 1,
        })).resolves.toEqual({
            documentRevision: DOCUMENT_REVISION,
            pageCount: 3,
            textSource: {
                kind: COMPACT_SEARCH_INDEX_SOURCE_KIND_GENERIC,
                version: 0,
            },
            pages: [{
                pageNumber: 1,
                text: 'partial text',
            }],
        });
    });

    it('rejects sidecars that do not match the required text source', async () => {
        const pdfPath = join(tempDir, 'generic.pdf');
        await persistCompactSearchIndex(pdfPath, {
            documentRevision: DOCUMENT_REVISION,
            pageCount: 1,
            pages: [{
                pageNumber: requirePageNumber(1),
                text: 'generic text',
            }],
        });

        await expect(loadCompactSearchIndex(pdfPath, {
            documentRevision: DOCUMENT_REVISION,
            expectedPageCount: 1,
            requiredTextSource: {
                kind: COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER,
                version: OCR_TEXT_LAYER_INDEX_VERSION,
            },
        })).resolves.toBeNull();
    });

    it('rejects sidecars whose record count exceeds the bounded load budget', async () => {
        const pdfPath = join(tempDir, 'huge-record-count.pdf');
        const header = Buffer.alloc(COMPACT_SEARCH_INDEX_HEADER_SIZE);
        header.write(COMPACT_SEARCH_INDEX_MAGIC, 0, 'ascii');
        header.writeUInt32LE(COMPACT_SEARCH_INDEX_SCHEMA_VERSION, 8);
        header.writeUInt32LE(COMPACT_SEARCH_INDEX_HEADER_SIZE, 12);
        header.writeUInt32LE(1_000_001, 16);
        header.writeUInt32LE(1_000_001, 20);
        header.writeUInt32LE(COMPACT_SEARCH_INDEX_SOURCE_KIND_GENERIC, 24);
        header.writeUInt32LE(DOCUMENT_REVISION.length, 28);
        header.writeBigUInt64LE(BigInt(COMPACT_SEARCH_INDEX_HEADER_SIZE), 32);
        header.writeBigUInt64LE(BigInt(COMPACT_SEARCH_INDEX_HEADER_SIZE + DOCUMENT_REVISION.length), 40);
        header.writeBigUInt64LE(BigInt(COMPACT_SEARCH_INDEX_HEADER_SIZE + DOCUMENT_REVISION.length), 48);
        await writeFile(getCompactSearchIndexPath(pdfPath), header);

        await expect(loadCompactSearchIndex(pdfPath, {documentRevision: DOCUMENT_REVISION})).resolves.toBeNull();
    });

    it('streams sparse first and last records for a million-page document', async () => {
        const pdfPath = join(tempDir, 'million-pages.pdf');
        const pageCount = 1_000_001;
        const result = await persistCompactSearchIndexStreaming(
            pdfPath,
            {
                documentRevision: DOCUMENT_REVISION,
                pageCount,
            },
            [
                {
                    pageNumber: requirePageNumber(1),
                    text: 'first',
                },
                {
                    pageNumber: requirePageNumber(pageCount),
                    text: 'last',
                },
            ],
        );

        expect(result).toMatchObject({
            pageCount,
            pagesScanned: pageCount,
            pagesWritten: 2,
            complete: true,
            partialCoverage: false,
            truncatedCoverage: false,
        });
        const sidecar = await readFile(getCompactSearchIndexPath(pdfPath));
        expect(sidecar.toString('ascii', 0, 8)).toBe(COMPACT_SEARCH_INDEX_STREAMING_MAGIC);
        expect(sidecar.readUInt32LE(8)).toBe(COMPACT_SEARCH_INDEX_STREAMING_SCHEMA_VERSION);
        expect(sidecar.readUInt32LE(16)).toBe(pageCount);
        expect(sidecar.readUInt32LE(20)).toBe(2);
        const footerOffset = Number(sidecar.readBigUInt64LE(56));
        expect(footerOffset).toBeGreaterThan(pageCount * 24);
        expect(sidecar.toString('ascii', footerOffset, footerOffset + 8)).toBe(
            COMPACT_SEARCH_INDEX_STREAMING_FOOTER_MAGIC,
        );
        expect(sidecar.readUInt32LE(footerOffset + 16)).toBe(COMPACT_SEARCH_INDEX_STREAMING_FLAG_COMPLETE);
        expect(sidecar.readBigUInt64LE(footerOffset + 56)).toBe(BigInt(pageCount));

        await expect(loadCompactSearchIndex(pdfPath, {
            documentRevision: DOCUMENT_REVISION,
            expectedPageCount: pageCount,
        })).resolves.toMatchObject({
            pageCount,
            pages: [
                {
                    pageNumber: 1,
                    text: 'first',
                },
                {
                    pageNumber: pageCount,
                    text: 'last',
                },
            ],
            coverage: {
                pagesScanned: pageCount,
                pagesWritten: 2,
                partialCoverage: false,
                truncatedCoverage: false,
            },
        });
    });

    it('allows a sparse v3 directory beyond the legacy 320 MiB file budget', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const pdfPath = join(tempDir, 'directory-over-legacy-budget.pdf');
        const pageCount = 13_981_009;
        await persistCompactSearchIndexStreaming(
            pdfPath,
            {
                documentRevision: DOCUMENT_REVISION,
                pageCount,
                pagesScanned: 0,
                truncatedCoverage: true,
            },
            [],
        );

        const sidecarStat = await stat(getCompactSearchIndexPath(pdfPath));
        expect(sidecarStat.size).toBeGreaterThan(320 * 1024 * 1024);
        await expect(loadCompactSearchIndex(pdfPath, {
            documentRevision: DOCUMENT_REVISION,
            metadataOnly: true,
        })).resolves.toMatchObject({
            pageCount,
            pages: [],
            coverage: {
                pagesScanned: 0,
                pagesWritten: 0,
                truncatedCoverage: true,
            },
        });
    }, 15_000);

    it('streams and loads a v3 page larger than the legacy per-page budget', async () => {
        const pdfPath = join(tempDir, 'page-over-legacy-budget.pdf');
        const text = 'x'.repeat(32 * 1024 * 1024 + 1);
        const result = await persistCompactSearchIndexStreaming(
            pdfPath,
            {
                documentRevision: DOCUMENT_REVISION,
                pageCount: 1,
            },
            [{
                pageNumber: requirePageNumber(1),
                text,
            }],
        );

        expect(result).toMatchObject({
            pageCount: 1,
            pagesScanned: 1,
            pagesWritten: 1,
            bytesWritten: text.length,
        });
        await expect(loadCompactSearchIndex(pdfPath, {
            documentRevision: DOCUMENT_REVISION,
            expectedPageCount: 1,
        })).resolves.toMatchObject({
            pageCount: 1,
            pages: [{
                pageNumber: 1,
                text,
            }],
            coverage: {
                pagesScanned: 1,
                pagesWritten: 1,
            },
        });
    });

    it('counts only nonempty records while preserving complete blank-page coverage', async () => {
        const pdfPath = join(tempDir, 'blank-pages.pdf');
        const result = await persistCompactSearchIndexStreaming(
            pdfPath,
            {
                documentRevision: DOCUMENT_REVISION,
                pageCount: 3,
                pagesScanned: 3,
            },
            [
                {
                    pageNumber: requirePageNumber(1),
                    text: '',
                },
                {
                    pageNumber: requirePageNumber(2),
                    text: 'text',
                },
                {
                    pageNumber: requirePageNumber(3),
                    text: '',
                },
            ],
        );

        expect(result.pagesWritten).toBe(1);
        await expect(loadCompactSearchIndex(pdfPath, {
            documentRevision: DOCUMENT_REVISION,
            expectedPageCount: 3,
        })).resolves.toMatchObject({
            pageCount: 3,
            pages: [{
                pageNumber: 2,
                text: 'text',
            }],
            coverage: {
                pagesScanned: 3,
                pagesWritten: 1,
                partialCoverage: false,
                truncatedCoverage: false,
            },
        });
    });

    it('rejects duplicate page writes, including duplicate blank pages', async () => {
        const pdfPath = join(tempDir, 'duplicate-pages.pdf');
        const writer = await openCompactSearchIndexWriter(pdfPath, {
            documentRevision: DOCUMENT_REVISION,
            pageCount: 2,
        });

        await writer.writePage({
            pageNumber: requirePageNumber(1),
            text: '',
        });
        await expect(writer.writePage({
            pageNumber: requirePageNumber(1),
            text: '',
        })).rejects.toThrow(
            'Duplicate pageNumber',
        );
        await expect(stat(writer.temporaryPath)).rejects.toThrow();
    });

    it('publishes truncated coverage and rejects it for a full-page load', async () => {
        const pdfPath = join(tempDir, 'truncated-pages.pdf');
        await persistCompactSearchIndexStreaming(
            pdfPath,
            {
                documentRevision: DOCUMENT_REVISION,
                pageCount: 3,
                pagesScanned: 2,
                truncatedCoverage: true,
            },
            [{
                pageNumber: requirePageNumber(1),
                text: 'text',
            }],
        );

        await expect(loadCompactSearchIndex(pdfPath, {
            documentRevision: DOCUMENT_REVISION,
            expectedPageCount: 3,
        })).resolves.toBeNull();
        await expect(loadCompactSearchIndex(pdfPath, {
            documentRevision: DOCUMENT_REVISION,
            expectedPageCount: 1,
        })).resolves.toMatchObject({coverage: {
            pagesScanned: 2,
            pagesWritten: 1,
            flags: COMPACT_SEARCH_INDEX_STREAMING_FLAG_COMPLETE
                    | COMPACT_SEARCH_INDEX_STREAMING_FLAG_PARTIAL_COVERAGE
                    | COMPACT_SEARCH_INDEX_STREAMING_FLAG_TRUNCATED_COVERAGE,
            partialCoverage: true,
            truncatedCoverage: true,
        }});
    });

    it('removes a temp file and preserves the canonical sidecar when beforePublish fails', async () => {
        const pdfPath = join(tempDir, 'before-publish-failure.pdf');
        await persistCompactSearchIndexStreaming(
            pdfPath,
            {
                documentRevision: DOCUMENT_REVISION,
                pageCount: 1,
            },
            [{
                pageNumber: requirePageNumber(1),
                text: 'old',
            }],
        );
        const indexPath = getCompactSearchIndexPath(pdfPath);
        const canonicalBefore = await readFile(indexPath);
        const writer = await openCompactSearchIndexWriter(pdfPath, {
            documentRevision: DOCUMENT_REVISION,
            pageCount: 1,
        });
        await writer.writePage({
            pageNumber: requirePageNumber(1),
            text: 'new',
        });

        await expect(writer.finalize({
            pagesScanned: 1,
            truncatedCoverage: false,
            beforePublish: async () => {
                throw new Error('revision changed');
            },
        })).rejects.toThrow('revision changed');
        await expect(readFile(indexPath)).resolves.toEqual(canonicalBefore);
        await expect(stat(writer.temporaryPath)).rejects.toThrow();
    });

    it('rejects a v3 sidecar when the completion footer is incomplete', async () => {
        const pdfPath = join(tempDir, 'incomplete-footer.pdf');
        await persistCompactSearchIndexStreaming(
            pdfPath,
            {
                documentRevision: DOCUMENT_REVISION,
                pageCount: 1,
            },
            [{
                pageNumber: requirePageNumber(1),
                text: 'text',
            }],
        );
        const indexPath = getCompactSearchIndexPath(pdfPath);
        const sidecarStat = await stat(indexPath);
        await writeFile(indexPath, (await readFile(indexPath)).subarray(0, sidecarStat.size - 1));

        await expect(loadCompactSearchIndex(pdfPath, {documentRevision: DOCUMENT_REVISION})).resolves.toBeNull();
    });
});
