import {beforeEach, describe, expect, it, vi} from 'vitest';
import {join} from 'node:path';
import type * as Fs from 'node:fs';
import {DEFAULT_SETTINGS} from '@contracts/settings';

const mocks = vi.hoisted(() => ({
    loadSettings: vi.fn(),
    readFileSync: vi.fn(),
    userDataPath: '/diagnostics-user-data',
}));

vi.mock('electron', () => ({app: {getPath: () => mocks.userDataPath}}));
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof Fs>();
    return {
        ...actual,
        readFileSync: mocks.readFileSync,
    };
});
vi.mock('@electron/settings', () => ({loadSettings: mocks.loadSettings}));

function settingsPayload(preference: unknown = 'granted') {
    return JSON.stringify({
        ...DEFAULT_SETTINGS,
        clientDiagnosticsPreference: preference,
    });
}

describe('synchronous diagnostics preference reader', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.readFileSync.mockReturnValue(settingsPayload());
    });

    it('reads a granted preference directly from the user-data settings file', async () => {
        const {readDiagnosticsPreferenceSync} = await import('@electron/features/diagnostics/readDiagnosticsPreferenceSync');

        expect(readDiagnosticsPreferenceSync()).toBe('granted');
        expect(mocks.readFileSync).toHaveBeenCalledWith(join(mocks.userDataPath, 'settings.json'), 'utf-8');
    });

    it.each([
        [
            'missing file',
            () => {
                throw Object.assign(new Error('missing'), {code: 'ENOENT'});
            },
        ],
        [
            'unreadable file',
            () => {
                throw Object.assign(new Error('unreadable'), {code: 'EACCES'});
            },
        ],
        ['corrupt JSON', () => '{'],
        [
            'partial settings',
            () =>
                JSON.stringify({
                    ...DEFAULT_SETTINGS,
                    clientDiagnosticsPreference: undefined,
                }),
        ],
        ['wrong preference type', () => settingsPayload(false)],
        [
            'newer schema',
            () =>
                JSON.stringify({
                    ...DEFAULT_SETTINGS,
                    version: DEFAULT_SETTINGS.version + 1,
                    clientDiagnosticsPreference: 'granted',
                }),
        ],
    ])('fails closed for %s', async (_caseName, read) => {
        mocks.readFileSync.mockImplementation(read);
        const {readDiagnosticsPreferenceSync} = await import('@electron/features/diagnostics/readDiagnosticsPreferenceSync');

        expect(readDiagnosticsPreferenceSync()).toBe('unknown');
    });

    it('does not call or warm the asynchronous settings cache', async () => {
        const {readDiagnosticsPreferenceSync} = await import('@electron/features/diagnostics/readDiagnosticsPreferenceSync');

        expect(readDiagnosticsPreferenceSync()).toBe('granted');
        expect(mocks.loadSettings).not.toHaveBeenCalled();
    });

    it('returns the validated schema-v2 settings payload from readCompleteSettingsSync and null otherwise', async () => {
        const {readCompleteSettingsSync} = await import('@electron/features/diagnostics/readDiagnosticsPreferenceSync');

        expect(readCompleteSettingsSync()).toEqual({
            ...DEFAULT_SETTINGS,
            clientDiagnosticsPreference: 'granted',
        });

        mocks.readFileSync.mockReturnValueOnce('{');
        expect(readCompleteSettingsSync()).toBeNull();

        mocks.readFileSync.mockImplementationOnce(() => {
            throw Object.assign(new Error('missing'), {code: 'ENOENT'});
        });
        expect(readCompleteSettingsSync()).toBeNull();
        expect(mocks.loadSettings).not.toHaveBeenCalled();
    });

    it('normalizes optional keys while preserving valid extension keys in readCompleteSettingsSync', async () => {
        mocks.readFileSync.mockReturnValueOnce(
            JSON.stringify({
                ...DEFAULT_SETTINGS,
                suppressDefaultViewerPrompt: 'false',
                skippedUpdateVersion: '1.2.3',
                futureExtensionKey: 'kept',
            }),
        );
        const {readCompleteSettingsSync} = await import('@electron/features/diagnostics/readDiagnosticsPreferenceSync');

        const parsed = readCompleteSettingsSync() as Record<string, unknown> | null;
        expect(parsed).not.toBeNull();
        expect(parsed?.suppressDefaultViewerPrompt).toBeUndefined();
        expect(parsed?.skippedUpdateVersion).toBe('1.2.3');
        expect(parsed?.futureExtensionKey).toBe('kept');
    });
});
