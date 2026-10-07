import type * as TDjvuNativeToolPathsModule from '@electron/features/djvu/main/nativeToolPaths';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({runNativeCommand: vi.fn()}));

vi.mock('@electron/features/djvu/main/buildDjvuRuntimeEnv', () => ({buildDjvuRuntimeEnv: () => ({})}));
vi.mock('@electron/features/djvu/main/nativeToolPaths', async importOriginal => ({
    ...await importOriginal<typeof TDjvuNativeToolPathsModule>(),
    getDjvuNativeToolPaths: () => ({djvused: '/tools/djvused'}),
}));
vi.mock('@electron/native-tools/runNativeCommand', () => ({runNativeCommand: mocks.runNativeCommand}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({debug: vi.fn()})}));
vi.mock('@electron/features/djvu/main/getCachedDjvuHasText', () => ({getCachedDjvuHasText: vi.fn()}));

const {
    getDjvuPageCount,
    getDjvuResolution,
    getDjvuOutline,
    getDjvuPageComponentMap,
} = await import('@electron/features/djvu/main/metadata');

describe('DjVu metadata', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('distinguishes an empty source outline from failed outline extraction', async () => {
        mocks.runNativeCommand.mockResolvedValueOnce({
            stdout: '',
            stderr: '',
            exitCode: 0,
        });
        await expect(getDjvuOutline('/tmp/no-bookmarks.djvu')).resolves.toBe('');
        const failure = new Error('outline subprocess failed');
        mocks.runNativeCommand.mockRejectedValueOnce(failure);
        await expect(getDjvuOutline('/tmp/failed-outline.djvu')).rejects.toBe(failure);
    });

    it('refuses a failed component map instead of returning empty metadata', async () => {
        const failure = new Error('component map subprocess failed');
        mocks.runNativeCommand.mockRejectedValueOnce(failure);
        await expect(getDjvuPageComponentMap('/tmp/failed-components.djvu')).rejects.toBe(failure);
    });

    it('accepts page counts beyond the former desktop product cap', async () => {
        mocks.runNativeCommand.mockResolvedValue({
            stdout: '100001\n',
            stderr: '',
            exitCode: 0,
        });

        await expect(getDjvuPageCount('/tmp/xlarge.djvu')).resolves.toBe(100_001);
    });

    it('rejects page counts outside the JavaScript safe-integer range', async () => {
        mocks.runNativeCommand.mockResolvedValue({
            stdout: '9007199254740992\n',
            stderr: '',
            exitCode: 0,
        });

        await expect(getDjvuPageCount('/tmp/unsafe.djvu'))
            .rejects.toThrow('Invalid page count from djvused');
    });

    it('reads the resolution from the selected page\'s INFO chunk', async () => {
        mocks.runNativeCommand.mockResolvedValue({
            stdout: [
                '  FORM:DJVU [815] ',
                '    INFO [10]         DjVu 640x480, v24, 72 dpi, gamma=2.2',
                '    BG44 [785]        IW4 data #1, 90 slices, v1.2 (color), 640x480',
            ].join('\n'),
            stderr: '',
            exitCode: 0,
        });

        await expect(getDjvuResolution('/tmp/document.djvu')).resolves.toBe(72);
    });

    it.each([
        [
            'a zero resolution',
            'DjVu 640x480, v24, 0 dpi, gamma=2.2',
        ],
        [
            'a zero width',
            'DjVu 0x480, v24, 72 dpi, gamma=2.2',
        ],
        [
            'an unsafe resolution',
            'DjVu 640x480, v24, 9007199254740993 dpi, gamma=2.2',
        ],
    ])('falls back to 300 DPI when the INFO chunk has %s', async (_case, info) => {
        mocks.runNativeCommand.mockResolvedValue({
            stdout: `  FORM:DJVU [815] \n    INFO [10]         ${info}\n`,
            stderr: '',
            exitCode: 0,
        });

        await expect(getDjvuResolution('/tmp/document.djvu')).resolves.toBe(300);
    });
});
