import { join } from 'node:path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    appTempDir: '/tmp/evb-viewer',
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
    },
    lstat: vi.fn(),
    readdir: vi.fn(),
    rm: vi.fn(async () => undefined),
}));

vi.mock('fs/promises', () => ({
    lstat: mocks.lstat,
    readdir: mocks.readdir,
    rm: mocks.rm,
}));
vi.mock('@electron/utils/appTempDir', () => ({getAppTempDir: () => mocks.appTempDir}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => mocks.logger}));

describe('sweepStaleOcrTempArtifacts', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('removes only stale OCR/searchable artifacts from the managed app temp directory', async () => {
        mocks.readdir.mockResolvedValue([
            'ocr-stale-merged.pdf',
            'ocr-fresh-page.png',
            'ocr-stale-dir',
            'searchable-stale.pdf',
            'other-stale.pdf',
        ]);
        mocks.lstat.mockImplementation(async (path: string) => ({
            ctimeMs: path.includes('fresh') ? 9_900 : 0,
            isDirectory: () => path.includes('dir'),
            isFile: () => !path.includes('dir'),
            mtimeMs: path.includes('fresh') ? 9_900 : 0,
        }));
        const { sweepStaleOcrTempArtifacts } = await import('@electron/features/documents/main/sweepStaleOcrTempArtifacts');

        await expect(sweepStaleOcrTempArtifacts(5_000)).resolves.toBe(3);

        expect(mocks.lstat).toHaveBeenCalledTimes(4);
        expect(mocks.rm).toHaveBeenCalledWith(join(mocks.appTempDir, 'ocr-stale-merged.pdf'), {
            force: true,
            recursive: false,
        });
        expect(mocks.rm).toHaveBeenCalledWith(join(mocks.appTempDir, 'searchable-stale.pdf'), {
            force: true,
            recursive: false,
        });
        expect(mocks.rm).not.toHaveBeenCalledWith(join(mocks.appTempDir, 'ocr-fresh-page.png'), expect.anything());
        expect(mocks.rm).toHaveBeenCalledWith(join(mocks.appTempDir, 'ocr-stale-dir'), {
            force: true,
            recursive: true,
        });
        expect(mocks.logger.info).toHaveBeenCalledWith('Cleaned up 3 stale OCR temp artifact(s)');
    });
});
