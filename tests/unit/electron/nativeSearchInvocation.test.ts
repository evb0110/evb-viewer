import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';

const mocks = vi.hoisted(() => ({
    open: vi.fn(),
    runNativeToolCommand: vi.fn(),
    stat: vi.fn(),
    loadSearchIndex: vi.fn(),
    resolveNativeToolPath: vi.fn(),
    tryRunPersistentNativeSearch: vi.fn(),
}));

vi.mock('fs/promises', () => ({
    open: mocks.open,
    stat: mocks.stat,
}));

vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: (...args: unknown[]) => mocks.runNativeToolCommand(...args)}));

vi.mock('@electron/native-tools/resolveNativeToolPath', () => ({resolveNativeToolPath: (...args: unknown[]) => mocks.resolveNativeToolPath(...args)}));

vi.mock('@electron/features/search/indexBuilder', () => ({
    SEARCH_INDEX_SCHEMA_VERSION: 7,
    loadSearchIndex: (...args: unknown[]) => mocks.loadSearchIndex(...args),
}));

vi.mock('@electron/features/search/tryRunPersistentNativeSearch', () => ({tryRunPersistentNativeSearch: (...args: unknown[]) => mocks.tryRunPersistentNativeSearch(...args)}));

const DOCUMENT_REVISION = requireDocumentRevisionToken('revision-token');

function createNativeSearchHeader({
    allocatePageTable = true,
    pageCount = 1,
    pageRecordCount = 1,
} = {}) {
    const revisionTokenLength = Buffer.byteLength(DOCUMENT_REVISION, 'utf8');
    const pageTableOffset = 64 + revisionTokenLength;
    const textDataOffset = pageTableOffset + pageRecordCount * 24;
    const header = Buffer.alloc(allocatePageTable ? textDataOffset : pageTableOffset);
    header.write('EVBSIDX2', 0, 'ascii');
    header.writeUInt32LE(2, 8);
    header.writeUInt32LE(64, 12);
    header.writeUInt32LE(pageCount, 16);
    header.writeUInt32LE(pageRecordCount, 20);
    header.writeUInt32LE(revisionTokenLength, 28);
    header.writeBigUInt64LE(64n, 32);
    header.writeBigUInt64LE(BigInt(pageTableOffset), 40);
    header.writeBigUInt64LE(BigInt(textDataOffset), 48);
    header.write(DOCUMENT_REVISION, 64, 'utf8');
    return header;
}

describe('native search invocation', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.stubEnv('EVB_PDF_SEARCH_ENABLE', '1');
        vi.stubEnv('EVB_PDF_SEARCH_TIMEOUT_MS', '30000');
        vi.stubEnv('EVB_PDF_SEARCH_MAX_STDOUT_BYTES', '4194304');
        mocks.resolveNativeToolPath.mockReturnValue('/native/evb-pdf-search');
        mocks.stat.mockImplementation(async (path: string) => {
            if (path === '/tmp/doc.pdf') {
                return {mtimeMs: 100};
            }
            if (path === '/tmp/doc.pdf.index.evb-search-v2.bin') {
                return {mtimeMs: 200};
            }
            throw new Error(`Unexpected stat path: ${path}`);
        });
        mocks.open.mockResolvedValue({
            read: vi.fn(async (
                buffer: Buffer,
                offset = 0,
                length = buffer.length,
                position = 0,
            ) => {
                const bytesRead = createNativeSearchHeader().copy(buffer, offset, position, position + length);
                return {bytesRead};
            }),
            stat: vi.fn(async () => ({size: 64 + DOCUMENT_REVISION.length + 24})),
            close: vi.fn(async () => undefined),
        });
        mocks.loadSearchIndex.mockResolvedValue({
            schemaVersion: 7,
            documentRevision: {token: DOCUMENT_REVISION},
            pdfPath: '/tmp/doc.pdf',
            createdAt: 1,
            pageCount: 1,
            pages: [{
                pageNumber: 1,
                text: 'needle',
                words: [{
                    text: 'needle',
                    x: 0,
                    y: 0,
                    width: 10,
                    height: 10,
                }],
                pageWidth: 100,
                pageHeight: 100,
            }],
        });
        mocks.runNativeToolCommand.mockResolvedValue({
            exitCode: 0,
            stdout: JSON.stringify({
                pageCount: 1,
                results: [],
                truncated: false,
            }),
            stderr: '',
        });
        mocks.tryRunPersistentNativeSearch.mockResolvedValue(null);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('routes only the two literal non-whole-word option combinations to native', async () => {
        const {isNativeSearchSupportedOptions} = await import('@electron/features/search/nativeSearch');
        const combinations = [
            false,
            true,
        ].flatMap(matchCase => (
            [
                false,
                true,
            ].flatMap(wholeWord => (
                [
                    false,
                    true,
                ].map(useRegex => ({
                    matchCase,
                    wholeWord,
                    useRegex,
                }))
            ))
        ));

        expect(combinations.filter(options => isNativeSearchSupportedOptions({
            ...options,
            query: 'needle',
        }))).toEqual([
            {
                matchCase: false,
                wholeWord: false,
                useRegex: false,
            },
            {
                matchCase: true,
                wholeWord: false,
                useRegex: false,
            },
        ]);
    });

    it.each([
        '/tmp/doc.pdf',
        '/tmp/doc.pdf.ocr/manifest.json',
    ])('rejects a native sidecar older than the %s source', async (freshSourcePath) => {
        mocks.stat.mockImplementation(async (path: string) => {
            if (path === freshSourcePath) {
                return {mtimeMs: 300};
            }
            if (path === '/tmp/doc.pdf') {
                return {mtimeMs: 100};
            }
            if (path === '/tmp/doc.pdf.index.evb-search-v2.bin') {
                return {mtimeMs: 200};
            }
            throw new Error(`Unexpected stat path: ${path}`);
        });
        const {tryRunNativeSearch} = await import('@electron/features/search/nativeSearch');

        await expect(tryRunNativeSearch({
            pdfPath: '/tmp/doc.pdf',
            documentRevision: DOCUMENT_REVISION,
            query: 'needle',
            matchCase: false,
            wholeWord: false,
            useRegex: false,
            pageCount: 1,
        })).resolves.toBeNull();
        expect(mocks.tryRunPersistentNativeSearch).not.toHaveBeenCalled();
        expect(mocks.runNativeToolCommand).not.toHaveBeenCalled();
    });

    it('runs native search with bounded stdout and truncation rejection', async () => {
        const controller = new AbortController();
        const { tryRunNativeSearch } = await import('@electron/features/search/nativeSearch');

        await expect(tryRunNativeSearch({
            pdfPath: '/tmp/doc.pdf',
            documentRevision: DOCUMENT_REVISION,
            query: 'needle',
            matchCase: false,
            wholeWord: false,
            useRegex: false,
            pageCount: 1,
            signal: controller.signal,
        })).resolves.toMatchObject({
            response: {
                results: [],
                truncated: false,
            },
            totalPages: 1,
        });

        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith(
            '/native/evb-pdf-search',
            [
                'search',
                '--index',
                '/tmp/doc.pdf.index.evb-search-v2.bin',
                '--query',
                'needle',
                '--document-revision',
                DOCUMENT_REVISION,
                '--limit',
                '500',
                '--context',
                '56',
                '--page-count',
                '1',
            ],
            {
                timeoutMs: 30000,
                maxStdoutBytes: 4 * 1024 * 1024,
                rejectOnStdoutTruncation: true,
                commandLabel: 'evb-pdf-search(search)',
                signal: controller.signal,
            },
        );
    });

    it('falls back to the one-shot binary when the persistent service fails', async () => {
        mocks.tryRunPersistentNativeSearch.mockRejectedValueOnce(new Error('service crashed'));
        const { tryRunNativeSearch } = await import('@electron/features/search/nativeSearch');

        await expect(tryRunNativeSearch({
            pdfPath: '/tmp/doc.pdf',
            documentRevision: DOCUMENT_REVISION,
            query: 'needle',
            matchCase: false,
            wholeWord: false,
            useRegex: false,
            pageCount: 1,
        })).resolves.toMatchObject({totalPages: 1});

        expect(mocks.runNativeToolCommand).toHaveBeenCalledOnce();
    });

    it('passes the resolved 60-second low-tier idle retention to the persistent service', async () => {
        mocks.tryRunPersistentNativeSearch.mockResolvedValue({
            pageCount: 1,
            results: [],
            truncated: false,
        });
        const { tryRunNativeSearch } = await import('@electron/features/search/nativeSearch');

        await expect(tryRunNativeSearch({
            pdfPath: '/tmp/doc.pdf',
            documentRevision: DOCUMENT_REVISION,
            query: 'needle',
            matchCase: false,
            wholeWord: false,
            useRegex: false,
            pageCount: 1,
            nativeServiceIdleTimeoutMs: 60_000,
        })).resolves.toMatchObject({totalPages: 1});

        expect(mocks.tryRunPersistentNativeSearch).toHaveBeenCalledWith(
            '/native/evb-pdf-search',
            expect.any(Object),
            expect.objectContaining({
                idleTimeoutMs: 60_000,
                timeoutMs: 30_000,
            }),
        );
        expect(mocks.runNativeToolCommand).not.toHaveBeenCalled();
    });

    it('runs native search when the legacy JSON index has text but no word geometry', async () => {
        mocks.loadSearchIndex.mockResolvedValue({
            schemaVersion: 7,
            documentRevision: {token: DOCUMENT_REVISION},
            pdfPath: '/tmp/doc.pdf',
            createdAt: 1,
            pageCount: 1,
            pages: [{
                pageNumber: 1,
                text: 'needle',
            }],
        });
        const { tryRunNativeSearch } = await import('@electron/features/search/nativeSearch');

        await expect(tryRunNativeSearch({
            pdfPath: '/tmp/doc.pdf',
            documentRevision: DOCUMENT_REVISION,
            query: 'needle',
            matchCase: false,
            wholeWord: false,
            useRegex: false,
            pageCount: 1,
        })).resolves.toMatchObject({
            response: {
                results: [],
                truncated: false,
            },
            totalPages: 1,
        });

        expect(mocks.runNativeToolCommand).toHaveBeenCalledOnce();
    });

    it('runs native search for partial OCR sidecars on large documents', async () => {
        const partialHeader = createNativeSearchHeader({
            pageCount: 2136,
            pageRecordCount: 1,
        });
        mocks.open.mockResolvedValue({
            read: vi.fn(async (
                buffer: Buffer,
                offset = 0,
                length = buffer.length,
                position = 0,
            ) => {
                const bytesRead = partialHeader.copy(buffer, offset, position, position + length);
                return {bytesRead};
            }),
            stat: vi.fn(async () => ({size: partialHeader.length})),
            close: vi.fn(async () => undefined),
        });
        mocks.runNativeToolCommand.mockResolvedValue({
            exitCode: 0,
            stdout: JSON.stringify({
                pageCount: 2136,
                results: [],
                truncated: false,
            }),
            stderr: '',
        });
        const { tryRunNativeSearch } = await import('@electron/features/search/nativeSearch');

        await expect(tryRunNativeSearch({
            pdfPath: '/tmp/doc.pdf',
            documentRevision: DOCUMENT_REVISION,
            query: 'needle',
            matchCase: false,
            wholeWord: false,
            useRegex: false,
            pageCount: 2136,
        })).resolves.toMatchObject({
            response: {
                results: [],
                truncated: false,
            },
            totalPages: 2136,
        });

        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith(
            '/native/evb-pdf-search',
            expect.arrayContaining([
                '--page-count',
                '2136',
            ]),
            expect.any(Object),
        );
    });

    it('skips native sidecars beyond record and text admission ceilings', async () => {
        const cases = [
            {
                header: createNativeSearchHeader({
                    allocatePageTable: false,
                    pageRecordCount: 1_000_001,
                }),
                size: 64 + DOCUMENT_REVISION.length + 1_000_001 * 24,
            },
            {
                header: createNativeSearchHeader(),
                size: 64 + DOCUMENT_REVISION.length + 24 + 256 * 1024 * 1024 + 1,
            },
        ];

        for (const testCase of cases) {
            mocks.open.mockResolvedValueOnce({
                read: vi.fn(async (
                    buffer: Buffer,
                    offset = 0,
                    length = buffer.length,
                    position = 0,
                ) => {
                    const bytesRead = testCase.header.copy(buffer, offset, position, position + length);
                    return {bytesRead};
                }),
                stat: vi.fn(async () => ({size: testCase.size})),
                close: vi.fn(async () => undefined),
            });
            const {tryRunNativeSearch} = await import('@electron/features/search/nativeSearch');

            await expect(tryRunNativeSearch({
                pdfPath: '/tmp/doc.pdf',
                documentRevision: DOCUMENT_REVISION,
                query: 'needle',
                matchCase: false,
                wholeWord: false,
                useRegex: false,
                pageCount: 1,
            })).resolves.toBeNull();
        }

        expect(mocks.tryRunPersistentNativeSearch).not.toHaveBeenCalled();
        expect(mocks.runNativeToolCommand).not.toHaveBeenCalled();
    });
});
