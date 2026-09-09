import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    COMPACT_SEARCH_INDEX_HEADER_SIZE,
    COMPACT_SEARCH_INDEX_MAGIC,
    COMPACT_SEARCH_INDEX_SCHEMA_VERSION,
    COMPACT_SEARCH_INDEX_STREAMING_DIRECTORY_ENTRY_SIZE,
    COMPACT_SEARCH_INDEX_STREAMING_FLAG_COMPLETE,
    COMPACT_SEARCH_INDEX_STREAMING_FLAG_PARTIAL_COVERAGE,
    COMPACT_SEARCH_INDEX_STREAMING_FOOTER_MAGIC,
    COMPACT_SEARCH_INDEX_STREAMING_FLAG_TRUNCATED_COVERAGE,
    COMPACT_SEARCH_INDEX_STREAMING_FOOTER_SIZE,
    COMPACT_SEARCH_INDEX_STREAMING_HEADER_SIZE,
    COMPACT_SEARCH_INDEX_STREAMING_MAGIC,
    COMPACT_SEARCH_INDEX_STREAMING_SCHEMA_VERSION,
} from '@contracts/searchIndexSidecar';
import { requireDocumentRevisionToken } from '@contracts/documentRevision';
import { isNativeSearchSupportedOptions } from '@electron/features/search/nativeSearch';

const mocks = vi.hoisted(() => ({
    open: vi.fn(),
    stat: vi.fn(),
    loadSearchIndex: vi.fn(),
    resolveNativeToolPath: vi.fn(),
    runNativeToolCommand: vi.fn(),
    tryRunPersistentNativeSearch: vi.fn(),
}));

vi.mock('fs/promises', () => ({
    open: mocks.open,
    stat: mocks.stat,
}));
vi.mock('@electron/features/search/indexBuilder', () => ({
    SEARCH_INDEX_SCHEMA_VERSION: 7,
    loadSearchIndex: mocks.loadSearchIndex,
}));
vi.mock('@electron/native-tools/resolveNativeToolPath', () => ({resolveNativeToolPath: mocks.resolveNativeToolPath}));
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: mocks.runNativeToolCommand}));
vi.mock('@electron/features/search/tryRunPersistentNativeSearch', () => ({tryRunPersistentNativeSearch: mocks.tryRunPersistentNativeSearch}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
})}));

const DOCUMENT_REVISION = requireDocumentRevisionToken('revision-token');
const REVISION_OFFSET = COMPACT_SEARCH_INDEX_HEADER_SIZE;
const PAGE_TABLE_OFFSET = 256;
const TEXT_DATA_OFFSET = 512;

function createNativeSearchIndexHeader() {
    const header = Buffer.alloc(COMPACT_SEARCH_INDEX_HEADER_SIZE);
    header.write(COMPACT_SEARCH_INDEX_MAGIC, 0, 'ascii');
    header.writeUInt32LE(COMPACT_SEARCH_INDEX_SCHEMA_VERSION, 8);
    header.writeUInt32LE(COMPACT_SEARCH_INDEX_HEADER_SIZE, 12);
    header.writeUInt32LE(4, 16);
    header.writeUInt32LE(4, 20);
    header.writeUInt32LE(Buffer.byteLength(DOCUMENT_REVISION), 28);
    header.writeBigUInt64LE(BigInt(REVISION_OFFSET), 32);
    header.writeBigUInt64LE(BigInt(PAGE_TABLE_OFFSET), 40);
    header.writeBigUInt64LE(BigInt(TEXT_DATA_OFFSET), 48);
    return header;
}

function createNativeSearchIndexFile() {
    const header = createNativeSearchIndexHeader();
    return {
        read: vi.fn(async (
            buffer: Buffer,
            offset: number,
            length: number,
            position: number,
        ) => {
            const source = position === 0
                ? header
                : Buffer.from(DOCUMENT_REVISION, 'utf8');
            const bytesRead = source.copy(buffer, offset, 0, length);
            return {bytesRead};
        }),
        stat: vi.fn(async () => ({size: 4096})),
        close: vi.fn(async () => undefined),
    };
}

function createNativeSearchResult(resultCount: number) {
    return {
        pageCount: 4,
        truncated: false,
        results: Array.from({length: resultCount}, (_value, index) => ({
            pageNumber: 2,
            pageMatchIndex: index,
            matchIndex: index,
            startOffset: 0,
            endOffset: 6,
            excerpt: {
                prefix: false,
                suffix: false,
                before: '',
                match: 'needle',
                after: '',
            },
        })),
    };
}

function createStreamingSearchIndexFile(flags: number) {
    const pageCount = 4;
    const revisionOffset = COMPACT_SEARCH_INDEX_STREAMING_HEADER_SIZE;
    const directoryOffset = revisionOffset + Buffer.byteLength(DOCUMENT_REVISION);
    const textDataOffset = directoryOffset + pageCount * COMPACT_SEARCH_INDEX_STREAMING_DIRECTORY_ENTRY_SIZE;
    const footerOffset = textDataOffset;
    const fileSize = footerOffset + COMPACT_SEARCH_INDEX_STREAMING_FOOTER_SIZE;
    const header = Buffer.alloc(COMPACT_SEARCH_INDEX_STREAMING_HEADER_SIZE);
    header.write(COMPACT_SEARCH_INDEX_STREAMING_MAGIC, 0, 'ascii');
    header.writeUInt32LE(COMPACT_SEARCH_INDEX_STREAMING_SCHEMA_VERSION, 8);
    header.writeUInt32LE(COMPACT_SEARCH_INDEX_STREAMING_HEADER_SIZE, 12);
    header.writeUInt32LE(pageCount, 16);
    header.writeUInt32LE(pageCount, 20);
    header.writeUInt32LE(flags, 24);
    header.writeUInt32LE(Buffer.byteLength(DOCUMENT_REVISION), 28);
    header.writeBigUInt64LE(BigInt(revisionOffset), 32);
    header.writeBigUInt64LE(BigInt(directoryOffset), 40);
    header.writeBigUInt64LE(BigInt(textDataOffset), 48);
    header.writeBigUInt64LE(BigInt(footerOffset), 56);

    const footer = Buffer.alloc(COMPACT_SEARCH_INDEX_STREAMING_FOOTER_SIZE);
    footer.write(COMPACT_SEARCH_INDEX_STREAMING_FOOTER_MAGIC, 0, 'ascii');
    footer.writeUInt32LE(COMPACT_SEARCH_INDEX_STREAMING_SCHEMA_VERSION, 8);
    footer.writeUInt32LE(COMPACT_SEARCH_INDEX_STREAMING_FOOTER_SIZE, 12);
    footer.writeUInt32LE(flags, 16);
    footer.writeUInt32LE(pageCount, 24);
    footer.writeBigUInt64LE(0n, 32);
    footer.writeBigUInt64LE(BigInt(fileSize), 40);
    footer.writeBigUInt64LE(BigInt(pageCount * COMPACT_SEARCH_INDEX_STREAMING_DIRECTORY_ENTRY_SIZE), 48);
    footer.writeBigUInt64LE(BigInt(pageCount), 56);

    return {
        read: vi.fn(async (
            buffer: Buffer,
            offset: number,
            length: number,
            position: number,
        ) => {
            const source = position === 0
                ? header
                : position === revisionOffset
                    ? Buffer.from(DOCUMENT_REVISION, 'utf8')
                    : footer;
            const bytesRead = source.copy(buffer, offset, 0, length);
            return {bytesRead};
        }),
        stat: vi.fn(async () => ({size: fileSize})),
        close: vi.fn(async () => undefined),
    };
}

describe('native search geometry attachment', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv('EVB_PDF_SEARCH_ENABLE', '1');
        mocks.resolveNativeToolPath.mockReturnValue('/tools/evb-pdf-search');
        mocks.stat.mockResolvedValue({mtimeMs: 10});
        mocks.open.mockResolvedValue(createNativeSearchIndexFile());
        mocks.loadSearchIndex.mockResolvedValue({
            schemaVersion: 7,
            pages: [{
                pageNumber: 2,
                text: 'needle',
                pageWidth: 100,
                pageHeight: 200,
                words: [{
                    text: 'needle',
                    x: 1,
                    y: 2,
                    width: 3,
                    height: 4,
                    startOffset: 0,
                    endOffset: 6,
                }],
            }],
        });
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('does not read the legacy JSON index when the query has no matches', async () => {
        const { tryRunNativeSearch } = await import('@electron/features/search/nativeSearch');
        mocks.tryRunPersistentNativeSearch.mockResolvedValue(createNativeSearchResult(0));

        const result = await tryRunNativeSearch({
            pdfPath: '/tmp/file.pdf',
            documentRevision: DOCUMENT_REVISION,
            query: 'needle',
            matchCase: false,
            wholeWord: false,
            useRegex: false,
        });

        expect(result?.response.results).toEqual([]);
        expect(mocks.loadSearchIndex).not.toHaveBeenCalled();
    });

    it('attaches word geometry from the legacy JSON index to matched pages', async () => {
        const { tryRunNativeSearch } = await import('@electron/features/search/nativeSearch');
        mocks.tryRunPersistentNativeSearch.mockResolvedValue(createNativeSearchResult(1));

        const result = await tryRunNativeSearch({
            pdfPath: '/tmp/file.pdf',
            documentRevision: DOCUMENT_REVISION,
            query: 'needle',
            matchCase: false,
            wholeWord: false,
            useRegex: false,
        });

        expect(mocks.loadSearchIndex).toHaveBeenCalledOnce();
        expect(result?.response.results[0]).toEqual(expect.objectContaining({
            pageNumber: 2,
            pageWidth: 100,
            pageHeight: 200,
            words: [expect.objectContaining({text: 'needle'})],
        }));
    });

    it('searches a complete streaming sidecar', async () => {
        const {tryRunNativeSearch} = await import('@electron/features/search/nativeSearch');
        mocks.open.mockResolvedValueOnce(createStreamingSearchIndexFile(COMPACT_SEARCH_INDEX_STREAMING_FLAG_COMPLETE));
        mocks.tryRunPersistentNativeSearch.mockResolvedValue(createNativeSearchResult(0));

        const result = await tryRunNativeSearch({
            pdfPath: '/tmp/file.pdf',
            documentRevision: DOCUMENT_REVISION,
            query: 'needle',
            matchCase: false,
            wholeWord: false,
            useRegex: false,
            pageCount: 4,
        });

        expect(result?.response.results).toEqual([]);
        expect(mocks.tryRunPersistentNativeSearch).toHaveBeenCalledOnce();
    });

    it.each([
        COMPACT_SEARCH_INDEX_STREAMING_FLAG_COMPLETE | COMPACT_SEARCH_INDEX_STREAMING_FLAG_PARTIAL_COVERAGE,
        COMPACT_SEARCH_INDEX_STREAMING_FLAG_COMPLETE | COMPACT_SEARCH_INDEX_STREAMING_FLAG_TRUNCATED_COVERAGE,
    ])('rejects a sidecar marked partial or truncated even when its page count is complete', async (flags) => {
        const {tryRunNativeSearch} = await import('@electron/features/search/nativeSearch');
        mocks.open.mockResolvedValueOnce(createStreamingSearchIndexFile(flags));

        await expect(tryRunNativeSearch({
            pdfPath: '/tmp/file.pdf',
            documentRevision: DOCUMENT_REVISION,
            query: 'needle',
            matchCase: false,
            wholeWord: false,
            useRegex: false,
            pageCount: 4,
        })).resolves.toBeNull();
        expect(mocks.tryRunPersistentNativeSearch).not.toHaveBeenCalled();
        expect(mocks.runNativeToolCommand).not.toHaveBeenCalled();
    });
});

describe('native search routing', () => {
    it('only routes literal searches whose matching semantics are preserved', () => {
        expect(isNativeSearchSupportedOptions({
            query: 'needle',
            matchCase: false,
            wholeWord: false,
            useRegex: false,
        })).toBe(true);
        expect(isNativeSearchSupportedOptions({
            query: 'ёж',
            matchCase: false,
            wholeWord: false,
            useRegex: false,
        })).toBe(true);
        expect(isNativeSearchSupportedOptions({
            query: 'İ',
            matchCase: true,
            wholeWord: false,
            useRegex: false,
        })).toBe(true);
        expect(isNativeSearchSupportedOptions({
            query: 'needle',
            matchCase: false,
            wholeWord: true,
            useRegex: false,
        })).toBe(false);
        expect(isNativeSearchSupportedOptions({
            query: 'n.*dle',
            matchCase: false,
            wholeWord: false,
            useRegex: true,
        })).toBe(false);
    });
});
