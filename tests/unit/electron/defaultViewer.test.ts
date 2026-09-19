import {
    afterAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    app: {getPath: vi.fn(() => '/tmp/app-data')},
    dialog: {showMessageBox: vi.fn()},
    execFile: vi.fn(),
    loadSettings: vi.fn(async () => ({})),
    logger: {
        error: vi.fn(),
        warn: vi.fn(),
    },
    readFile: vi.fn(),
    shell: {openExternal: vi.fn()},
    te: vi.fn((key: string) => key),
    updateSettings: vi.fn(async (updater: (settings: Record<string, unknown>) => unknown) => {
        await updater({});
    }),
}));

vi.mock('electron', () => ({
    app: mocks.app,
    dialog: mocks.dialog,
    shell: mocks.shell,
}));

vi.mock('fs/promises', () => ({readFile: mocks.readFile}));
vi.mock('node:child_process', () => ({execFile: mocks.execFile}));

vi.mock('@electron/settings', () => ({
    loadSettings: mocks.loadSettings,
    updateSettings: mocks.updateSettings,
}));

vi.mock('@electron/te', () => ({te: mocks.te}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => mocks.logger}));

const originalPlatform = process.platform;

async function loadDefaultViewerModule() {
    vi.resetModules();
    return import('@electron/promptSetDefaultViewer');
}

describe('default viewer prompt', () => {
    beforeEach(() => {
        Object.defineProperty(process, 'platform', {
            configurable: true,
            value: 'win32',
        });
        vi.clearAllMocks();
        mocks.loadSettings.mockResolvedValue({});
        mocks.readFile.mockRejectedValue(new Error('missing'));
        mocks.shell.openExternal.mockRejectedValue(new Error('unsupported protocol'));
        mocks.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
        mocks.dialog.showMessageBox.mockResolvedValue({ response: 0 });
        mocks.updateSettings.mockImplementation(async (updater: (settings: Record<string, unknown>) => unknown) => {
            await updater({});
        });
    });

    it.each([
        'success',
        'success via GLib',
        'command failure',
        'unchanged PDF',
        'unchanged DjVu',
    ])(
        'automatically registers Linux defaults and falls back only when needed: %s',
        async (outcome) => {
            Object.defineProperty(process, 'platform', {
                configurable: true,
                value: 'linux',
            });
            // Model the external command boundary, including tools which exit successfully
            // without actually changing the user's default application.
            mocks.execFile.mockImplementation((
                file: string,
                args: string[],
                _options: unknown,
                callback: (error: Error | null, result: { stdout: string }) => void,
            ) => {
                const unchangedType = outcome === 'unchanged PDF' ? 'application/pdf' : 'image/vnd.djvu';
                if (outcome === 'success via GLib') {
                    callback(null, { stdout: file === 'gio'
                        ? `Default application for “${args[1]}”: evb-viewer.desktop\n`
                        : 'other.desktop\n' });
                    return;
                }
                callback(outcome === 'command failure' ? new Error('xdg-mime unavailable') : null, {stdout: outcome.startsWith('unchanged') && args[2] === unchangedType
                    ? 'other.desktop\n'
                    : 'evb-viewer.desktop\n'});
            });
            const { promptSetDefaultViewer } = await loadDefaultViewerModule();

            await promptSetDefaultViewer({} as never);

            expect(mocks.execFile).toHaveBeenCalledWith('xdg-mime', [
                'default',
                'evb-viewer.desktop',
                'application/pdf',
                'image/vnd.djvu',
            ], { timeout: 10_000 }, expect.any(Function));
            const instructions = mocks.dialog.showMessageBox.mock.calls.filter(
                call => call[1]?.detail === 'dialogs.defaultViewer.instructionsLinux',
            );
            expect(instructions).toHaveLength(outcome.startsWith('success') ? 0 : 1);
        },
    );

    it('shows fallback instructions when Windows default-app settings cannot be opened', async () => {
        const { promptSetDefaultViewer } = await loadDefaultViewerModule();

        await promptSetDefaultViewer({} as never);

        expect(mocks.shell.openExternal).toHaveBeenCalledWith('ms-settings:defaultapps');
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            'Failed to open Windows default apps settings: unsupported protocol',
        );
        expect(mocks.dialog.showMessageBox).toHaveBeenCalledTimes(2);
        expect(mocks.dialog.showMessageBox).toHaveBeenLastCalledWith({}, {
            buttons: ['OK'],
            message: 'dialogs.defaultViewer.message',
            title: 'dialogs.defaultViewer.instructionsTitle',
            type: 'info',
        });
    });

    it('honors prompt suppression from known settings files only when explicitly true', async () => {
        mocks.readFile.mockResolvedValueOnce(JSON.stringify({suppressDefaultViewerPrompt: true}));
        const { promptSetDefaultViewer } = await loadDefaultViewerModule();

        await promptSetDefaultViewer({} as never);

        expect(mocks.dialog.showMessageBox).not.toHaveBeenCalled();
        expect(mocks.updateSettings).toHaveBeenCalledOnce();
        const updater = mocks.updateSettings.mock.calls[0]?.[0] as (settings: Record<string, unknown>) => unknown;
        expect(updater({})).toEqual({suppressDefaultViewerPrompt: true});
        expect(updater({suppressDefaultViewerPrompt: true})).toBeUndefined();
    });

    it('persists prompt suppression as a partial patch after dialog latency', async () => {
        mocks.loadSettings.mockResolvedValueOnce({
            locale: 'en',
            suppressDefaultViewerPrompt: false,
        });
        let patch: unknown;
        mocks.updateSettings.mockImplementationOnce(async (updater: (settings: Record<string, unknown>) => unknown) => {
            const latestSettings = {
                locale: 'ru',
                suppressDefaultViewerPrompt: false,
                tabMemoryPolicy: 'keep-active',
            };
            patch = await updater(latestSettings);
        });
        const { promptSetDefaultViewer } = await loadDefaultViewerModule();

        await promptSetDefaultViewer({} as never);

        expect(mocks.updateSettings).toHaveBeenCalledOnce();
        expect(patch).toEqual({suppressDefaultViewerPrompt: true});
    });

    it.each([
        [
            'false',
            { suppressDefaultViewerPrompt: false },
        ],
        [
            'string true',
            { suppressDefaultViewerPrompt: 'true' },
        ],
        [
            'missing key',
            {},
        ],
    ])('ignores non-true suppression value from settings file: %s', async (_label, settings) => {
        mocks.readFile.mockResolvedValueOnce(JSON.stringify(settings));
        const { promptSetDefaultViewer } = await loadDefaultViewerModule();

        await promptSetDefaultViewer({} as never);

        expect(mocks.dialog.showMessageBox).toHaveBeenCalled();
        expect(mocks.dialog.showMessageBox.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.updateSettings.mock.invocationCallOrder[0]!,
        );
        expect(mocks.updateSettings).toHaveBeenCalledOnce();
    });

    it('ignores invalid JSON while checking known settings files', async () => {
        mocks.readFile.mockResolvedValueOnce('{');
        const { promptSetDefaultViewer } = await loadDefaultViewerModule();

        await promptSetDefaultViewer({} as never);

        expect(mocks.dialog.showMessageBox).toHaveBeenCalled();
        expect(mocks.dialog.showMessageBox.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.updateSettings.mock.invocationCallOrder[0]!,
        );
        expect(mocks.updateSettings).toHaveBeenCalledOnce();
    });
});

afterAll(() => {
    Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform,
    });
});
