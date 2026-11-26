import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({runDjvuEngine: vi.fn()}));

vi.mock('@electron/features/djvu/main/djvuEnginePool', () => ({runDjvuEngine: mocks.runDjvuEngine}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({debug: vi.fn()})}));
vi.mock('@electron/features/djvu/main/getCachedDjvuHasText', () => ({getCachedDjvuHasText: vi.fn()}));

const {
    getDjvuPageCount,
    getDjvuResolution,
    getDjvuOutlineBookmarks,
    getDjvuPageComponentMap,
} = await import('@electron/features/djvu/main/metadata');

describe('DjVu metadata', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('distinguishes an empty source outline from failed outline extraction', async () => {
        mocks.runDjvuEngine.mockResolvedValueOnce({
            raw: [],
            pageComponents: {},
            pageCount: 2,
        });
        await expect(getDjvuOutlineBookmarks('/tmp/no-bookmarks.djvu')).resolves.toEqual([]);
        const failure = new Error('DjVu outline metadata exceeded 262144 bytes');
        mocks.runDjvuEngine.mockRejectedValueOnce(failure);
        await expect(getDjvuOutlineBookmarks('/tmp/failed-outline.djvu')).rejects.toBe(failure);
    });

    it('refuses a failed component map instead of returning empty metadata', async () => {
        const failure = new Error('component map failed');
        mocks.runDjvuEngine.mockRejectedValueOnce(failure);
        await expect(getDjvuPageComponentMap('/tmp/failed-components.djvu')).rejects.toBe(failure);
    });

    it('accepts page counts beyond the former desktop product cap', async () => {
        mocks.runDjvuEngine.mockResolvedValue({
            pageCount: 100_001,
            sourceDpi: 300,
            isIndirect: false,
            files: [],
        });

        await expect(getDjvuPageCount('/tmp/xlarge.djvu')).resolves.toBe(100_001);
    });

    it('rejects page counts outside the JavaScript safe-integer range', async () => {
        mocks.runDjvuEngine.mockResolvedValue({
            pageCount: 9_007_199_254_740_992,
            sourceDpi: 300,
            isIndirect: false,
            files: [],
        });

        await expect(getDjvuPageCount('/tmp/unsafe.djvu'))
            .rejects.toThrow('Invalid DjVu page count');
    });

    it('reads the resolution from the document info', async () => {
        mocks.runDjvuEngine.mockResolvedValue({
            pageCount: 2,
            sourceDpi: 72,
            isIndirect: false,
            files: [],
        });

        await expect(getDjvuResolution('/tmp/document.djvu')).resolves.toBe(72);
    });

    it.each([
        [
            'a zero resolution',
            0,
        ],
        [
            'a negative resolution',
            -10,
        ],
        [
            'an unsafe resolution',
            Number.MAX_SAFE_INTEGER + 1,
        ],
    ])('falls back to 300 DPI when document info has %s', async (_case, sourceDpi) => {
        mocks.runDjvuEngine.mockResolvedValue({
            pageCount: 2,
            sourceDpi,
            isIndirect: false,
            files: [],
        });

        await expect(getDjvuResolution('/tmp/document.djvu')).resolves.toBe(300);
    });
});
