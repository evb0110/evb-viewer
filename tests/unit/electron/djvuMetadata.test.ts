import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({runNativeCommand: vi.fn()}));

vi.mock('@electron/features/djvu/main/buildDjvuRuntimeEnv', () => ({buildDjvuRuntimeEnv: () => ({})}));
vi.mock('@electron/features/djvu/main/nativeToolPaths', () => ({getDjvuNativeToolPaths: () => ({djvused: '/tools/djvused'})}));
vi.mock('@electron/native-tools/runNativeCommand', () => ({runNativeCommand: mocks.runNativeCommand}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({debug: vi.fn()})}));
vi.mock('@electron/features/djvu/main/getCachedDjvuHasText', () => ({getCachedDjvuHasText: vi.fn()}));

const {
    getDjvuPageCount,
    getDjvuResolution,
} = await import('@electron/features/djvu/main/metadata');

describe('DjVu metadata', () => {
    beforeEach(() => {
        vi.clearAllMocks();
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

    it('reads the first page\'s resolution from its INFO chunk', async () => {
        mocks.runNativeCommand.mockResolvedValue({
            stdout: [
                '  FORM:DJVU [815] ',
                '    INFO [10]         DjVu 640x480, v24, 72 dpi, gamma=2.2',
                '    BG44 [785]        IW4 data #1, 90 slices, v1.2 (color), 640x480',
            ].join('\n'),
            stderr: '',
            exitCode: 0,
        });

        await expect(getDjvuResolution('/tmp/mixed-dpi.djvu')).resolves.toBe(72);
    });
});
