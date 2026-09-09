import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireEpochMs} from '@contracts/timestamps';

const mocks = vi.hoisted(() => ({
    lstat: vi.fn<(path: string) => Promise<{ isSymbolicLink: () => boolean }>>(),
    readFile: vi.fn<(path: string, encoding: string) => Promise<string>>(),
    realpath: vi.fn<(path: string) => Promise<string>>(),
    rename: vi.fn<(source: string, target: string) => Promise<void>>(),
    rm: vi.fn<(path: string, options: {force: boolean}) => Promise<void>>(),
    stat: vi.fn<(path: string) => Promise<{ mtimeMs: number }>>(),
    unlink: vi.fn<(path: string) => Promise<void>>(),
    writeFile: vi.fn<(path: string, data: string, encoding: string) => Promise<void>>(),
    loadCompactSearchIndex: vi.fn(),
    persistCompactSearchIndex: vi.fn(),
    assertWorkingCopyRevisionCurrent: vi.fn(),
}));

function createStat(isSymlink: boolean) {
    return {isSymbolicLink: () => isSymlink};
}

vi.mock('fs/promises', () => ({
    open: async (path: string) => {
        const raw = await mocks.readFile(path, 'utf8');
        const bytes = Buffer.from(raw, 'utf8');
        return {
            read: async (buffer: Buffer, offset: number, length: number, position: number) => {
                const available = Math.max(0, Math.min(length, bytes.byteLength - position));
                if (available > 0) {
                    bytes.copy(buffer, offset, position, position + available);
                }
                return {bytesRead: available};
            },
            close: async () => {},
        };
    },
    lstat: (path: string) => mocks.lstat(path),
    readFile: (path: string, encoding: string) => mocks.readFile(path, encoding),
    realpath: (path: string) => mocks.realpath(path),
    rename: (source: string, target: string) => mocks.rename(source, target),
    rm: (path: string, options: {force: boolean}) => mocks.rm(path, options),
    stat: (path: string) => mocks.stat(path),
    unlink: (path: string) => mocks.unlink(path),
    mkdir: vi.fn(),
    writeFile: (path: string, data: string, encoding: string) => mocks.writeFile(path, data, encoding),
}));

vi.mock('node:fs/promises', () => ({
    open: async (path: string) => {
        const raw = await mocks.readFile(path, 'utf8');
        const bytes = Buffer.from(raw, 'utf8');
        return {
            read: async (buffer: Buffer, offset: number, length: number, position: number) => {
                const available = Math.max(0, Math.min(length, bytes.byteLength - position));
                if (available > 0) {
                    bytes.copy(buffer, offset, position, position + available);
                }
                return {bytesRead: available};
            },
            close: async () => {},
        };
    },
    lstat: (path: string) => mocks.lstat(path),
    readFile: (path: string, encoding: string) => mocks.readFile(path, encoding),
    realpath: (path: string) => mocks.realpath(path),
    rename: (source: string, target: string) => mocks.rename(source, target),
    rm: (path: string, options: {force: boolean}) => mocks.rm(path, options),
    stat: (path: string) => mocks.stat(path),
    unlink: (path: string) => mocks.unlink(path),
    mkdir: vi.fn(),
    writeFile: (path: string, data: string, encoding: string) => mocks.writeFile(path, data, encoding),
}));

vi.mock('@electron/features/search/publicNative', () => ({
    NATIVE_COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER: 1,
    getNativeCompactSearchIndexPath: (path: string) => `${path}.index.evb-search-v2.bin`,
    loadNativeCompactSearchIndex: mocks.loadCompactSearchIndex,
    persistNativeCompactSearchIndex: mocks.persistCompactSearchIndex,
    classifyXlargeSearchPathFromFile: vi.fn(async (_path: string, pageCount?: number) => ({
        isXlarge: (pageCount ?? 0) > 200,
        pageCount,
        pathSizeBytes: undefined,
        reasons: [],
    })),
}));
vi.mock('@electron/file-access/documentRevisionSidecar', () => ({assertWorkingCopyRevisionSidecarCurrent: mocks.assertWorkingCopyRevisionCurrent}));

const {
    resolveSafeOcrIndexBasePath,
    writeOcrIndexV3,
} = await import('@electron/ocr/worker/indexWriter');

function makeDocumentRevision(documentRef: string) {
    return {
        version: 1 as const,
        documentRef: requireDocumentRef(documentRef),
        authority: 'electron-working-copy' as const,
        token: requireDocumentRevisionToken('revision-token'),
        contentRevision: 1,
        mintedAt: requireEpochMs(1),
    };
}

/** The generation stamped into a freshly written page artifact, as the manifest must mirror it. */
function writtenPageGeneration(pageFile: string) {
    const pageWrite = mocks.writeFile.mock.calls.find(([path]) => path.startsWith(`/tmp/work.pdf.ocr/${pageFile}.`));
    return (JSON.parse(pageWrite?.[1] ?? '{}') as {canonicalText?: {generation?: string}}).canonicalText?.generation;
}

function writeOcrIndexV3ForTest(
    pdfPath: string,
    ocrPageData: Parameters<typeof writeOcrIndexV3>[2],
    pageCount: number,
    languages: string[],
    extractionDpi: number,
    log: Parameters<typeof writeOcrIndexV3>[6],
    signal?: AbortSignal,
) {
    return writeOcrIndexV3(
        pdfPath,
        makeDocumentRevision(pdfPath),
        ocrPageData,
        pageCount,
        languages,
        extractionDpi,
        log,
        signal,
    );
}

describe('resolveSafeOcrIndexBasePath', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.lstat.mockResolvedValue(createStat(false));
        mocks.realpath.mockImplementation(async (path: string) => path);
    });

    it('accepts existing non-symlink targets inside temp dir', async () => {
        await expect(resolveSafeOcrIndexBasePath('/tmp/work.pdf', '/tmp')).resolves.toBe('/tmp/work.pdf');
    });

    it('rejects targets outside temp dir', async () => {
        await expect(resolveSafeOcrIndexBasePath('/Users/alice/work.pdf', '/tmp')).rejects.toThrow(
            'outside the allowed temp directory',
        );
    });

    it('rejects symlink targets', async () => {
        mocks.lstat.mockResolvedValue(createStat(true));

        await expect(resolveSafeOcrIndexBasePath('/tmp/work.pdf', '/tmp')).rejects.toThrow(
            'cannot be a symbolic link',
        );
    });

    it('accepts canonicalized temp paths', async () => {
        mocks.realpath.mockImplementation(async (path: string) => {
            if (path === '/tmp') {
                return '/private/tmp';
            }
            if (path === '/tmp/work.pdf') {
                return '/private/tmp/work.pdf';
            }
            if (path === '/private/tmp') {
                return '/private/tmp';
            }
            if (path === '/private/tmp/work.pdf') {
                return '/private/tmp/work.pdf';
            }
            return path;
        });

        await expect(resolveSafeOcrIndexBasePath('/tmp/work.pdf', '/tmp')).resolves.toBe('/private/tmp/work.pdf');
    });
});

describe('writeOcrIndexV3', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
        mocks.rename.mockResolvedValue();
        mocks.rm.mockResolvedValue();
        mocks.stat.mockResolvedValue({mtimeMs: 1});
        mocks.unlink.mockResolvedValue();
        mocks.writeFile.mockResolvedValue();
        mocks.loadCompactSearchIndex.mockResolvedValue(null);
        mocks.persistCompactSearchIndex.mockResolvedValue(undefined);
        mocks.assertWorkingCopyRevisionCurrent.mockResolvedValue(undefined);
    });

    it('preserves existing page mappings when writing a partial OCR run', async () => {
        mocks.readFile.mockResolvedValue(JSON.stringify({
            version: 3,
            documentRevision: {token: requireDocumentRevisionToken('revision-token')},
            createdAt: 1,
            source: { pdfPath: '/tmp/work.pdf' },
            pageCount: 2,
            pageBox: 'crop',
            ocr: {
                engine: 'tesseract',
                languages: ['eng'],
                renderDpi: 300,
            },
            pages: {1: { path: 'page-0001.json' }},
        }));

        await writeOcrIndexV3ForTest('/tmp/work.pdf', [{
            pageNumber: 2,
            text: 'page two',
            imageWidth: 100,
            imageHeight: 200,
            words: [{
                text: 'page',
                x: 1,
                y: 2,
                width: 3,
                height: 4,
            }],
        }], 2, ['eng'], 300, vi.fn());

        const manifestWrite = mocks.writeFile.mock.calls.find(([path]) => path.startsWith('/tmp/work.pdf.ocr/manifest.json.'));
        expect(manifestWrite).toBeTruthy();
        expect(manifestWrite?.[0]).toMatch(/\/tmp\/work\.pdf\.ocr\/manifest\.json\..+\.tmp$/);
        const manifest = JSON.parse(manifestWrite?.[1] ?? '{}') as { pages: Record<string, { path: string }> };
        expect(manifest).toMatchObject({
            version: 3,
            documentRevision: {token: requireDocumentRevisionToken('revision-token')},
        });
        expect(manifest.pages).toEqual({
            1: { path: 'page-0001.json' },
            2: {
                path: 'page-0002.json',
                generation: writtenPageGeneration('page-0002.json'),
            },
        });
    });

    it('drops preserved page mappings when the existing manifest revision differs', async () => {
        mocks.readFile.mockResolvedValue(JSON.stringify({
            version: 3,
            documentRevision: {token: requireDocumentRevisionToken('previous-token')},
            createdAt: 1,
            source: { pdfPath: '/tmp/work.pdf' },
            pageCount: 2,
            pageBox: 'crop',
            ocr: {
                engine: 'tesseract',
                languages: ['eng'],
                renderDpi: 300,
            },
            pages: {1: { path: 'page-0001.json' }},
        }));

        await writeOcrIndexV3ForTest('/tmp/work.pdf', [{
            pageNumber: 2,
            text: 'page two',
            imageWidth: 100,
            imageHeight: 200,
            words: [],
        }], 2, ['eng'], 300, vi.fn());

        const manifestWrite = mocks.writeFile.mock.calls.find(([path]) => path.startsWith('/tmp/work.pdf.ocr/manifest.json.'));
        const manifest = JSON.parse(manifestWrite?.[1] ?? '{}') as { pages: Record<string, { path: string }> };
        expect(manifest.pages).toEqual({2: {
            path: 'page-0002.json',
            generation: writtenPageGeneration('page-0002.json'),
        }});
    });

    it('drops preserved page mappings from legacy v2 manifests', async () => {
        mocks.readFile.mockResolvedValue(JSON.stringify({
            version: 2,
            createdAt: 1,
            source: { pdfPath: '/tmp/work.pdf' },
            pageCount: 2,
            pageBox: 'crop',
            ocr: {
                engine: 'tesseract',
                languages: ['eng'],
                renderDpi: 300,
            },
            pages: {1: { path: 'page-0001.json' }},
        }));

        await writeOcrIndexV3ForTest('/tmp/work.pdf', [{
            pageNumber: 2,
            text: 'page two',
            imageWidth: 100,
            imageHeight: 200,
            words: [],
        }], 2, ['eng'], 300, vi.fn());

        const manifestWrite = mocks.writeFile.mock.calls.find(([path]) => path.startsWith('/tmp/work.pdf.ocr/manifest.json.'));
        const manifest = JSON.parse(manifestWrite?.[1] ?? '{}') as { pages: Record<string, { path: string }> };
        expect(manifest.pages).toEqual({2: {
            path: 'page-0002.json',
            generation: writtenPageGeneration('page-0002.json'),
        }});
    });

    it('drops preserved page mappings when the existing manifest belongs to a different page set', async () => {
        mocks.readFile.mockResolvedValue(JSON.stringify({
            version: 3,
            documentRevision: {token: requireDocumentRevisionToken('revision-token')},
            createdAt: 1,
            source: { pdfPath: '/tmp/work.pdf' },
            pageCount: 3,
            pageBox: 'crop',
            ocr: {
                engine: 'tesseract',
                languages: ['eng'],
                renderDpi: 300,
            },
            pages: {
                1: { path: 'page-0001.json' },
                3: { path: 'page-0003.json' },
            },
        }));

        await writeOcrIndexV3ForTest('/tmp/work.pdf', [{
            pageNumber: 2,
            text: 'page two',
            imageWidth: 100,
            imageHeight: 200,
            words: [],
        }], 2, ['eng'], 300, vi.fn());

        const manifestWrite = mocks.writeFile.mock.calls.find(([path]) => path.startsWith('/tmp/work.pdf.ocr/manifest.json.'));
        expect(manifestWrite).toBeTruthy();
        expect(manifestWrite?.[0]).toMatch(/\/tmp\/work\.pdf\.ocr\/manifest\.json\..+\.tmp$/);
        const manifest = JSON.parse(manifestWrite?.[1] ?? '{}') as { pages: Record<string, { path: string }> };
        expect(manifest.pages).toEqual({2: {
            path: 'page-0002.json',
            generation: writtenPageGeneration('page-0002.json'),
        }});
    });

    it('rejects duplicate OCR page data before writing v3 page files', async () => {
        await expect(writeOcrIndexV3ForTest('/tmp/work.pdf', [
            {
                pageNumber: 1,
                text: 'first pass',
                imageWidth: 100,
                imageHeight: 200,
                words: [],
            },
            {
                pageNumber: 1,
                text: 'second pass',
                imageWidth: 100,
                imageHeight: 200,
                words: [],
            },
        ], 1, ['eng'], 300, vi.fn())).rejects.toThrow('Duplicate OCR page number 1');

        expect(mocks.writeFile).not.toHaveBeenCalled();
    });

    it('uses a unique temp file for each v3 page and manifest write', async () => {
        await writeOcrIndexV3ForTest('/tmp/work.pdf', [
            {
                pageNumber: 1,
                text: 'first pass',
                imageWidth: 100,
                imageHeight: 200,
                words: [],
            },
            {
                pageNumber: 2,
                text: 'second pass',
                imageWidth: 100,
                imageHeight: 200,
                words: [],
            },
        ], 2, ['eng'], 300, vi.fn());

        const tempPaths = mocks.writeFile.mock.calls.map(([path]) => path);
        expect(tempPaths).toHaveLength(3);
        expect(new Set(tempPaths).size).toBe(tempPaths.length);
        expect(tempPaths).toEqual(expect.arrayContaining([
            expect.stringMatching(/\/tmp\/work\.pdf\.ocr\/page-0001\.json\..+\.tmp$/),
            expect.stringMatching(/\/tmp\/work\.pdf\.ocr\/page-0002\.json\..+\.tmp$/),
            expect.stringMatching(/\/tmp\/work\.pdf\.ocr\/manifest\.json\..+\.tmp$/),
        ]));
    });

    it('drops preserved manifest page paths that escape the OCR sidecar directory', async () => {
        mocks.readFile.mockResolvedValue(JSON.stringify({
            version: 3,
            documentRevision: {token: requireDocumentRevisionToken('revision-token')},
            createdAt: 1,
            source: { pdfPath: '/tmp/work.pdf' },
            pageCount: 2,
            pageBox: 'crop',
            ocr: {
                engine: 'tesseract',
                languages: ['eng'],
                renderDpi: 300,
            },
            pages: {
                1: { path: '../stolen.json' },
                2: { path: 'page-0002.json' },
            },
        }));

        await writeOcrIndexV3ForTest('/tmp/work.pdf', [{
            pageNumber: 1,
            text: 'page one',
            imageWidth: 100,
            imageHeight: 200,
            words: [],
        }], 2, ['eng'], 300, vi.fn());

        const manifestWrite = mocks.writeFile.mock.calls.find(([path]) => path.startsWith('/tmp/work.pdf.ocr/manifest.json.'));
        const manifest = JSON.parse(manifestWrite?.[1] ?? '{}') as { pages: Record<string, { path: string }> };
        expect(manifest.pages).toEqual({
            1: {
                path: 'page-0001.json',
                generation: writtenPageGeneration('page-0001.json'),
            },
            2: { path: 'page-0002.json' },
        });
    });

    it('cleans temp files and restores page backups when manifest rename fails', async () => {
        mocks.rename.mockImplementation(async (source: string, target: string) => {
            if (source.includes('/manifest.json.')) {
                throw new Error('rename failed');
            }
            if (target.includes('/page-0001.json.') && target.endsWith('.tmp')) {
                throw Object.assign(new Error('missing'), { code: 'ENOENT' });
            }
        });

        await expect(writeOcrIndexV3ForTest('/tmp/work.pdf', [{
            pageNumber: 1,
            text: 'page one',
            imageWidth: 100,
            imageHeight: 200,
            words: [],
        }], 1, ['eng'], 300, vi.fn())).rejects.toThrow('rename failed');

        expect(mocks.unlink).toHaveBeenCalledWith('/tmp/work.pdf.ocr/page-0001.json');
        expect(mocks.unlink).toHaveBeenCalledWith(expect.stringMatching(/\/tmp\/work\.pdf\.ocr\/manifest\.json\..+\.tmp$/));
    });

    it('surfaces compact search sidecar write failures', async () => {
        mocks.persistCompactSearchIndex.mockRejectedValueOnce(new Error('compact write failed'));

        await expect(writeOcrIndexV3ForTest('/tmp/work.pdf', [{
            pageNumber: 1,
            text: 'page one',
            imageWidth: 100,
            imageHeight: 200,
            words: [],
        }], 1, ['eng'], 300, vi.fn())).rejects.toThrow('compact write failed');
    });

    it('skips eager compact search loading and persistence for high-page-count direct OCR writes', async () => {
        const log = vi.fn();

        await writeOcrIndexV3ForTest('/tmp/work.pdf', [{
            pageNumber: 1,
            text: 'page one',
            imageWidth: 100,
            imageHeight: 200,
            words: [],
        }], 201, ['eng'], 300, log);

        expect(mocks.loadCompactSearchIndex).not.toHaveBeenCalled();
        expect(mocks.persistCompactSearchIndex).not.toHaveBeenCalled();
        expect(mocks.rm).toHaveBeenCalledWith(
            '/tmp/work.pdf.index.evb-search-v2.bin',
            {force: true},
        );
        expect(log).toHaveBeenCalledWith(
            'debug',
            expect.stringContaining('Skipped eager compact OCR search sidecar for xlarge document'),
        );
    });

    it('rolls back page and manifest writes when the revision turns stale before compact sidecar publish', async () => {
        mocks.rename.mockImplementation(async (_source: string, target: string) => {
            if (target.includes('.bak.')) {
                throw Object.assign(new Error('missing'), { code: 'ENOENT' });
            }
        });
        mocks.assertWorkingCopyRevisionCurrent
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('stale revision'));

        await expect(writeOcrIndexV3ForTest('/tmp/work.pdf', [{
            pageNumber: 1,
            text: 'page one',
            imageWidth: 100,
            imageHeight: 200,
            words: [],
        }], 1, ['eng'], 300, vi.fn())).rejects.toThrow('stale revision');

        expect(mocks.persistCompactSearchIndex).not.toHaveBeenCalled();
        expect(mocks.unlink).toHaveBeenCalledWith('/tmp/work.pdf.ocr/manifest.json');
        expect(mocks.unlink).toHaveBeenCalledWith('/tmp/work.pdf.ocr/page-0001.json');
    });
});
