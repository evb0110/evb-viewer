import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

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

const {resolveSafeOcrIndexBasePath} = await import('@electron/features/ocr/pipeline/writeOcrIndexes');

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
