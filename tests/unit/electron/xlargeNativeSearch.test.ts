import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    COMPACT_SEARCH_INDEX_STREAMING_DIRECTORY_ENTRY_SIZE,
    COMPACT_SEARCH_INDEX_STREAMING_FLAG_COMPLETE,
    COMPACT_SEARCH_INDEX_STREAMING_FOOTER_SIZE,
    COMPACT_SEARCH_INDEX_STREAMING_HEADER_SIZE,
    COMPACT_SEARCH_INDEX_STREAMING_MAGIC,
    COMPACT_SEARCH_INDEX_STREAMING_SCHEMA_VERSION,
} from '@contracts/searchIndexSidecar';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';

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

const DOCUMENT_REVISION = requireDocumentRevisionToken('revision-token');
const PDF_PATH = '/tmp/xlarge-native.pdf';
const PAGE_COUNT = 1_000_001;
const REVISION_OFFSET = COMPACT_SEARCH_INDEX_STREAMING_HEADER_SIZE;

function createStreamingIndexFile() {
    const revisionLength = Buffer.byteLength(DOCUMENT_REVISION, 'utf8');
    const directoryOffset = REVISION_OFFSET + revisionLength;
    const directoryLength = PAGE_COUNT * COMPACT_SEARCH_INDEX_STREAMING_DIRECTORY_ENTRY_SIZE;
    const textDataOffset = directoryOffset + directoryLength;
    const footerOffset = textDataOffset;
    const fileSize = footerOffset + COMPACT_SEARCH_INDEX_STREAMING_FOOTER_SIZE;

    const header = Buffer.alloc(COMPACT_SEARCH_INDEX_STREAMING_HEADER_SIZE);
    header.write(COMPACT_SEARCH_INDEX_STREAMING_MAGIC, 0, 'ascii');
    header.writeUInt32LE(COMPACT_SEARCH_INDEX_STREAMING_SCHEMA_VERSION, 8);
    header.writeUInt32LE(COMPACT_SEARCH_INDEX_STREAMING_HEADER_SIZE, 12);
    header.writeUInt32LE(PAGE_COUNT, 16);
    header.writeUInt32LE(1, 20);
    header.writeUInt32LE(COMPACT_SEARCH_INDEX_STREAMING_FLAG_COMPLETE, 24);
    header.writeUInt32LE(revisionLength, 28);
    header.writeBigUInt64LE(BigInt(REVISION_OFFSET), 32);
    header.writeBigUInt64LE(BigInt(directoryOffset), 40);
    header.writeBigUInt64LE(BigInt(textDataOffset), 48);
    header.writeBigUInt64LE(BigInt(footerOffset), 56);

    const footer = Buffer.alloc(COMPACT_SEARCH_INDEX_STREAMING_FOOTER_SIZE);
    footer.write('EVBSFTR3', 0, 'ascii');
    footer.writeUInt32LE(COMPACT_SEARCH_INDEX_STREAMING_SCHEMA_VERSION, 8);
    footer.writeUInt32LE(COMPACT_SEARCH_INDEX_STREAMING_FOOTER_SIZE, 12);
    footer.writeUInt32LE(COMPACT_SEARCH_INDEX_STREAMING_FLAG_COMPLETE, 16);
    footer.writeUInt32LE(1, 24);
    footer.writeBigUInt64LE(BigInt(fileSize), 40);
    footer.writeBigUInt64LE(BigInt(directoryLength), 48);
    footer.writeBigUInt64LE(BigInt(PAGE_COUNT), 56);

    return {
        fileSize,
        footerOffset,
        header,
        footer,
    };
}

describe('xlarge native search', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.stubEnv('EVB_PDF_SEARCH_ENABLE', '1');
        mocks.resolveNativeToolPath.mockReturnValue('/native/evb-pdf-search');
        mocks.stat.mockImplementation(async (path: string) => {
            if (path === PDF_PATH) {
                return {mtimeMs: 100};
            }
            return {mtimeMs: 200};
        });
        mocks.tryRunPersistentNativeSearch.mockResolvedValue({
            pageCount: PAGE_COUNT,
            results: [],
            truncated: false,
        });
        mocks.loadSearchIndex.mockRejectedValue(new Error('legacy index must not be loaded'));
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('accepts a million-page streaming sidecar without legacy caps or geometry hydration', async () => {
        const sidecar = createStreamingIndexFile();
        mocks.open.mockResolvedValue({
            read: vi.fn(async (
                buffer: Buffer,
                offset = 0,
                length = buffer.length,
                position = 0,
            ) => {
                const source = position === 0
                    ? sidecar.header
                    : position === sidecar.footerOffset
                        ? sidecar.footer
                        : Buffer.from(DOCUMENT_REVISION, 'utf8');
                return {bytesRead: source.copy(buffer, offset, 0, Math.min(length, source.length))};
            }),
            stat: vi.fn(async () => ({size: sidecar.fileSize})),
            close: vi.fn(async () => undefined),
        });

        const {tryRunNativeSearch} = await import('@electron/features/search/nativeSearch');
        const result = await tryRunNativeSearch({
            pdfPath: PDF_PATH,
            documentRevision: DOCUMENT_REVISION,
            query: 'needle',
            matchCase: false,
            wholeWord: false,
            useRegex: false,
            pageCount: PAGE_COUNT,
            strictXlarge: true,
            skipLegacyGeometry: true,
        });

        expect(result).toMatchObject({
            totalPages: PAGE_COUNT,
            response: {results: []},
        });
        expect(mocks.tryRunPersistentNativeSearch).toHaveBeenCalledOnce();
        expect(mocks.loadSearchIndex).not.toHaveBeenCalled();
    });

    it('reports a stale xlarge sidecar as a typed index failure', async () => {
        mocks.stat.mockImplementation(async (path: string) => {
            if (path === PDF_PATH) {
                return {mtimeMs: 300};
            }
            return {mtimeMs: 200};
        });
        const {tryRunNativeSearch} = await import('@electron/features/search/nativeSearch');

        await expect(tryRunNativeSearch({
            pdfPath: PDF_PATH,
            documentRevision: DOCUMENT_REVISION,
            query: 'needle',
            matchCase: false,
            wholeWord: false,
            useRegex: false,
            strictXlarge: true,
        })).rejects.toMatchObject({
            name: 'XlargeNativeSearchCapabilityError',
            kind: 'index-missing-or-stale',
        });
    });

    it('reports unsupported xlarge options without attempting a JS fallback', async () => {
        const {tryRunNativeSearch} = await import('@electron/features/search/nativeSearch');

        await expect(tryRunNativeSearch({
            pdfPath: PDF_PATH,
            documentRevision: DOCUMENT_REVISION,
            query: 'needle',
            matchCase: false,
            wholeWord: true,
            useRegex: false,
            strictXlarge: true,
        })).rejects.toMatchObject({
            name: 'XlargeNativeSearchCapabilityError',
            kind: 'unsupported-options',
        });
        expect(mocks.tryRunPersistentNativeSearch).not.toHaveBeenCalled();
        expect(mocks.loadSearchIndex).not.toHaveBeenCalled();
    });
});
