import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { join } from 'node:path';
import type * as Fs from 'node:fs';
import { DEFAULT_SETTINGS } from '@contracts/settings';

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
        const { readDiagnosticsPreferenceSync } = await import('@electron/features/diagnostics/readDiagnosticsPreferenceSync');

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
        [
            'corrupt JSON',
            () => '{',
        ],
        [
            'partial settings',
            () => JSON.stringify({
                ...DEFAULT_SETTINGS,
                clientDiagnosticsPreference: undefined,
            }),
        ],
        [
            'wrong preference type',
            () => settingsPayload(false),
        ],
        [
            'newer schema',
            () => JSON.stringify({
                ...DEFAULT_SETTINGS,
                version: DEFAULT_SETTINGS.version + 1,
                clientDiagnosticsPreference: 'granted',
            }),
        ],
    ])('fails closed for %s', async (_caseName, read) => {
        mocks.readFileSync.mockImplementation(read);
        const { readDiagnosticsPreferenceSync } = await import('@electron/features/diagnostics/readDiagnosticsPreferenceSync');

        expect(readDiagnosticsPreferenceSync()).toBe('unknown');
    });

    it('does not call or warm the asynchronous settings cache', async () => {
        const { readDiagnosticsPreferenceSync } = await import('@electron/features/diagnostics/readDiagnosticsPreferenceSync');

        expect(readDiagnosticsPreferenceSync()).toBe('granted');
        expect(mocks.loadSettings).not.toHaveBeenCalled();
    });
});
