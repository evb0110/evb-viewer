import {
    mkdtemp,
    rm,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    appWindows: [] as unknown[],
    trustedRendererUrl: 'evb-viewer://app/electron',
    userDataPath: '',
}));

vi.mock('electron', () => ({app: {getPath: () => mocks.userDataPath}}));
vi.mock('@electron/config', () => ({config: {renderer: {trustedUrl: mocks.trustedRendererUrl}}}));
vi.mock('@electron/features/diagnostics/public', () => ({setMainDiagnosticsPreference: vi.fn()}));
vi.mock('@electron/menu', () => ({updateRecentFilesMenu: vi.fn()}));
vi.mock('@electron/te', () => ({setElectronLocale: vi.fn(async () => undefined)}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
})}));
vi.mock('@electron/window/registry', () => ({getAllRegisteredAppWindows: () => mocks.appWindows}));

function createAppWindow(url: string) {
    const send = vi.fn();
    return {
        send,
        window: {
            isDestroyed: () => false,
            webContents: {
                getURL: () => url,
                isDestroyed: () => false,
                send,
            },
        },
    };
}

function deferred<T>() {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return {
        promise,
        resolve,
    };
}

describe('Electron settings change broadcast', () => {
    const paths: string[] = [];

    beforeEach(async () => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.appWindows.length = 0;
        mocks.userDataPath = await mkdtemp(join(tmpdir(), 'evb-settings-broadcast-'));
        paths.push(mocks.userDataPath);
    });

    afterEach(async () => {
        await Promise.all(paths.splice(0).map(path => rm(path, {
            force: true,
            recursive: true,
        })));
    });

    it('sends a write made outside the save path to every window that shows the app', async () => {
        const first = createAppWindow(mocks.trustedRendererUrl);
        const second = createAppWindow(mocks.trustedRendererUrl);
        mocks.appWindows.push(first.window, second.window);
        const {updateSettings} = await import('@electron/settings');

        await updateSettings(settings => {
            settings.agentMcpEnabled = true;
            return undefined;
        });

        const expected = expect.objectContaining({agentMcpEnabled: true});
        expect(first.send).toHaveBeenCalledOnce();
        expect(first.send).toHaveBeenCalledWith('settings:changed', expected);
        expect(second.send).toHaveBeenCalledOnce();
        expect(second.send).toHaveBeenCalledWith('settings:changed', expected);
    });

    it('leaves out a window that no longer shows the app', async () => {
        const foreign = createAppWindow('https://example.com/elsewhere');
        const app = createAppWindow(mocks.trustedRendererUrl);
        mocks.appWindows.push(foreign.window, app.window);
        const {updateSettings} = await import('@electron/settings');

        await updateSettings(settings => {
            settings.skippedUpdateVersion = '9.9.9';
            return undefined;
        });

        expect(foreign.send).not.toHaveBeenCalled();
        expect(app.send).toHaveBeenCalledWith('settings:changed', expect.objectContaining({skippedUpdateVersion: '9.9.9'}));
    });

    it('sends one broadcast for a coalesced batch of saves', async () => {
        const window = createAppWindow(mocks.trustedRendererUrl);
        mocks.appWindows.push(window.window);
        const {createSettingsMainBindings} = await import('@electron/features/settings/createSettingsMainBindings');
        const bindings = createSettingsMainBindings(async () => undefined);

        const first = bindings.save({senderId: 9} as never, {authorName: 'First'});
        const second = bindings.save({senderId: 9} as never, {locale: 'ru'});
        await Promise.all([
            first,
            second,
        ]);

        expect(window.send).toHaveBeenCalledOnce();
        expect(window.send).toHaveBeenCalledWith('settings:changed', expect.objectContaining({
            authorName: 'First',
            locale: 'ru',
        }));
    });

    it('broadcasts a diagnostics withdrawal to the window that made it', async () => {
        const window = createAppWindow(mocks.trustedRendererUrl);
        mocks.appWindows.push(window.window);
        const {createSettingsMainBindings} = await import('@electron/features/settings/createSettingsMainBindings');
        const bindings = createSettingsMainBindings(async () => undefined);

        await bindings.save({senderId: 10} as never, {clientDiagnosticsPreference: 'denied'});

        expect(window.send).toHaveBeenCalledWith('settings:changed', expect.objectContaining({clientDiagnosticsPreference: 'denied'}));
    });

    it('does not send a write from a replaced profile to the windows of the new one', async () => {
        const window = createAppWindow(mocks.trustedRendererUrl);
        mocks.appWindows.push(window.window);
        const started = deferred<undefined>();
        const release = deferred<undefined>();
        const settingsModule = await import('@electron/settings');
        const update = settingsModule.updateSettings(async (settings) => {
            started.resolve(undefined);
            await release.promise;
            settings.theme = 'dark';
            return undefined;
        });
        await started.promise;
        mocks.userDataPath = await mkdtemp(join(tmpdir(), 'evb-settings-broadcast-next-'));
        paths.push(mocks.userDataPath);
        settingsModule.resetSettingsCacheAfterUserDataPathChange();
        release.resolve(undefined);

        await update;

        expect(window.send).not.toHaveBeenCalled();
    });
});
