import {
    mkdtempSync,
    readFileSync,
    rmSync,
} from 'node:fs';
import {rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    atomicReplace: vi.fn(),
    events: [] as string[],
    logger: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    },
    setMainDiagnosticsPreference: vi.fn((preference: unknown) => {
        mocks.events.push(`preference:${String(preference)}`);
    }),
    waitForMainDiagnosticsTransportReady: vi.fn(async () => {
        mocks.events.push('adapter-ready');
    }),
    userDataPath: '',
}));

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>(resolvePromise => {
        resolve = resolvePromise;
    });
    return {
        promise,
        resolve,
    };
}

vi.mock('electron', () => ({app: {getPath: () => mocks.userDataPath}}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => mocks.logger}));
vi.mock('@electron/features/diagnostics/public', () => ({
    setMainDiagnosticsPreference: mocks.setMainDiagnosticsPreference,
    waitForMainDiagnosticsTransportReady: mocks.waitForMainDiagnosticsTransportReady,
}));
vi.mock('@electron/utils/atomicReplace', () => ({
    atomicReplace: mocks.atomicReplace,
    makeSiblingTempPath: (targetPath: string) => `${targetPath}.tmp`,
}));
vi.mock('@electron/menu', () => ({updateRecentFilesMenu: vi.fn()}));
vi.mock('@electron/te', () => ({setElectronLocale: vi.fn(async () => undefined)}));

describe('Electron diagnostics consent persistence ordering', () => {
    afterEach(() => {
        rmSync(mocks.userDataPath, {
            force: true,
            recursive: true,
        });
        mocks.events.length = 0;
        vi.resetModules();
        vi.clearAllMocks();
    });

    it('opens the main reporter only after a granted settings write succeeds', async () => {
        mocks.userDataPath = mkdtempSync(join(tmpdir(), 'evb-settings-consent-grant-'));
        mocks.atomicReplace.mockImplementation(async (source: string, target: string) => {
            mocks.events.push('persist');
            await rename(source, target);
        });
        const {updateSettings} = await import('@electron/settings');

        await updateSettings(() => ({clientDiagnosticsPreference: 'granted'}));

        expect(mocks.events).toEqual([
            'persist',
            'adapter-ready',
            'persist',
            'preference:granted',
        ]);
    });

    it('drops the main reporter before a failed revoke write and does not restore it', async () => {
        mocks.userDataPath = mkdtempSync(join(tmpdir(), 'evb-settings-consent-revoke-'));
        mocks.atomicReplace.mockImplementation(async (source: string, target: string) => {
            mocks.events.push('persist');
            await rename(source, target);
        });
        const {updateSettings} = await import('@electron/settings');
        await updateSettings(() => ({clientDiagnosticsPreference: 'granted'}));
        mocks.events.length = 0;
        mocks.atomicReplace.mockImplementationOnce(async () => {
            mocks.events.push('persist');
            throw new Error('settings disk full');
        });

        await expect(updateSettings(() => ({clientDiagnosticsPreference: 'denied'})))
            .rejects.toThrow('settings disk full');

        expect(mocks.events).toEqual([
            'preference:denied',
            'persist',
        ]);

        mocks.events.length = 0;
        const laterSettings = await updateSettings(() => ({authorName: 'Still private'}));
        expect(laterSettings.clientDiagnosticsPreference).toBe('denied');
        expect(mocks.events).toEqual([
            'persist',
            'preference:denied',
        ]);
    });

    it('keeps an older ordinary save denied when revocation is admitted during its atomic write', async () => {
        vi.useFakeTimers();
        try {
            mocks.userDataPath = mkdtempSync(join(tmpdir(), 'evb-settings-consent-interleave-'));
            mocks.atomicReplace.mockImplementation(async (source: string, target: string) => {
                mocks.events.push('persist');
                await rename(source, target);
            });
            const settings = await import('@electron/settings');
            await settings.updateSettings(() => ({clientDiagnosticsPreference: 'granted'}));
            mocks.events.length = 0;

            const atomicWrite = deferred<undefined>();
            const atomicWriteStarted = deferred<undefined>();
            let atomicWriteCount = 0;
            mocks.atomicReplace.mockImplementation(async (source: string, target: string) => {
                mocks.events.push('persist');
                atomicWriteCount += 1;
                if (atomicWriteCount === 1) {
                    atomicWriteStarted.resolve(undefined);
                    await atomicWrite.promise;
                }
                await rename(source, target);
            });

            const {createSettingsMainBindings} = await import('@electron/features/settings/createSettingsMainBindings');
            const bindings = createSettingsMainBindings(async () => undefined);
            const olderSave = bindings.save({senderId: 21} as never, {authorName: 'Older save'});
            await vi.advanceTimersByTimeAsync(25);
            await atomicWriteStarted.promise;

            const denialSave = bindings.save({senderId: 22} as never, {clientDiagnosticsPreference: 'denied'});
            expect(mocks.events).toContain('preference:denied');

            atomicWrite.resolve(undefined);
            await Promise.all([
                olderSave,
                denialSave,
            ]);

            const persisted = JSON.parse(readFileSync(join(mocks.userDataPath, 'settings.json'), 'utf-8')) as Record<string, unknown>;
            expect(persisted).toMatchObject({
                authorName: 'Older save',
                clientDiagnosticsPreference: 'denied',
            });
            expect(mocks.events).not.toContain('preference:granted');
        } finally {
            vi.useRealTimers();
        }
    });
});
