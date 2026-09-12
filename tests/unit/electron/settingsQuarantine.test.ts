import type * as TViMockOriginalModule from '@electron/features/diagnostics/public';

import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    setMainDiagnosticsPreference: vi.fn(),
    waitForMainDiagnosticsTransportReady: vi.fn(async () => undefined),
    userDataPath: '',
    logger: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    },
}));

vi.mock('electron', () => ({app: {getPath: () => mocks.userDataPath}}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => mocks.logger}));
vi.mock('@electron/features/diagnostics/public', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    setMainDiagnosticsPreference: mocks.setMainDiagnosticsPreference,
    waitForMainDiagnosticsTransportReady: mocks.waitForMainDiagnosticsTransportReady,
}));

describe('settings corruption quarantine', () => {
    afterEach(() => {
        rmSync(mocks.userDataPath, {
            force: true,
            recursive: true,
        });
        vi.resetModules();
        vi.clearAllMocks();
    });

    it('quarantines malformed JSON and atomically persists clean defaults', async () => {
        mocks.userDataPath = mkdtempSync(join(tmpdir(), 'evb-settings-quarantine-'));
        const settingsPath = join(mocks.userDataPath, 'settings.json');
        writeFileSync(settingsPath, '{malformed');
        const {loadSettings} = await import('@electron/settings');

        const settings = await loadSettings();

        expect(settings).toBeTypeOf('object');
        expect(JSON.parse(readFileSync(settingsPath, 'utf-8'))).toEqual(settings);
        expect(readdirSync(mocks.userDataPath).some(name => /^settings\.json\.\d+\.corrupt$/u.test(name))).toBe(true);
        expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Quarantined corrupt settings'));
    });

    it('quarantines a valid settings file from a future schema and loads defaults', async () => {
        mocks.userDataPath = mkdtempSync(join(tmpdir(), 'evb-settings-future-schema-'));
        const settingsPath = join(mocks.userDataPath, 'settings.json');
        const futureContent = JSON.stringify({
            version: 99,
            authorName: 'Future user',
            futureSetting: true,
        });
        writeFileSync(settingsPath, futureContent);
        const {
            consumeSettingsRecoveryNotice,
            loadSettings,
        } = await import('@electron/settings');

        await expect(loadSettings()).resolves.toMatchObject({
            version: 2,
            theme: 'light',
        });
        expect(readFileSync(settingsPath, 'utf-8')).not.toBe(futureContent);
        expect(readdirSync(mocks.userDataPath)).toEqual(expect.arrayContaining([
            'settings.json',
            expect.stringMatching(/^settings\.json\.\d+\.corrupt$/u),
        ]));
        expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Quarantined unsupported settings'));
        expect(consumeSettingsRecoveryNotice()).toEqual({reason: 'unsupported'});
        expect(consumeSettingsRecoveryNotice()).toBeNull();
    });

    it('keeps the diagnostics preference through Electron settings persistence', async () => {
        mocks.userDataPath = mkdtempSync(join(tmpdir(), 'evb-settings-diagnostics-preference-'));
        const settingsPath = join(mocks.userDataPath, 'settings.json');
        const {
            loadSettings,
            updateSettings,
        } = await import('@electron/settings');

        await updateSettings(() => ({clientDiagnosticsPreference: 'granted'}));

        expect(JSON.parse(readFileSync(settingsPath, 'utf-8'))).toMatchObject({clientDiagnosticsPreference: 'granted'});
        expect(await loadSettings()).toMatchObject({clientDiagnosticsPreference: 'granted'});
        expect(mocks.setMainDiagnosticsPreference).toHaveBeenCalledOnce();
        expect(mocks.setMainDiagnosticsPreference).toHaveBeenCalledWith('granted');
    });

    it('loads an older settings schema with diagnostics disabled', async () => {
        mocks.userDataPath = mkdtempSync(join(tmpdir(), 'evb-settings-older-schema-'));
        writeFileSync(join(mocks.userDataPath, 'settings.json'), JSON.stringify({
            version: 1,
            authorName: 'Older user',
        }));
        const {loadSettings} = await import('@electron/settings');

        await expect(loadSettings()).resolves.toMatchObject({
            authorName: 'Older user',
            clientDiagnosticsPreference: 'unknown',
        });
    });

    it('preserves the existing target and removes staged data when atomic promotion fails', async () => {
        mocks.userDataPath = mkdtempSync(join(tmpdir(), 'evb-settings-atomic-failure-'));
        const settingsPath = join(mocks.userDataPath, 'settings.json');
        mkdirSync(settingsPath);
        const {updateSettings} = await import('@electron/settings');

        await expect(updateSettings(settings => ({
            ...settings,
            theme: 'dark',
        }))).rejects.toThrow();

        expect(mocks.setMainDiagnosticsPreference).not.toHaveBeenCalled();
        expect(readdirSync(settingsPath)).toEqual([]);
        expect(readdirSync(mocks.userDataPath)).toEqual(['settings.json']);
    });

    it('serializes concurrent updates without losing either mutation', async () => {
        mocks.userDataPath = mkdtempSync(join(tmpdir(), 'evb-settings-concurrent-'));
        const settingsPath = join(mocks.userDataPath, 'settings.json');
        const {updateSettings} = await import('@electron/settings');
        let releaseFirst: () => void = () => {};
        const firstCanFinish = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });

        const first = updateSettings(async (settings) => {
            await firstCanFinish;
            settings.theme = 'dark';
            return undefined;
        });
        const second = updateSettings((settings) => {
            settings.authorName = 'Concurrent Author';
            return undefined;
        });
        releaseFirst();
        await Promise.all([
            first,
            second,
        ]);

        expect(JSON.parse(readFileSync(settingsPath, 'utf-8'))).toMatchObject({
            authorName: 'Concurrent Author',
            theme: 'dark',
        });
    });
});
