import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {encodeHostResourceProfileArgument} from '@electron/resources/hostResourceProfile';
import { encodeDiagnosticsPolicyArgument } from '@electron/platform-ipc/coreContract';
import { readDiagnosticsPolicyArgument } from '@electron/preload/readDiagnosticsPolicyArgument';
import {readHostResourceProfileArgument} from '@electron/preload/readHostResourceProfileArgument';
import { readHostEnvironmentArgument } from '@electron/preload/readHostEnvironmentArgument';
import { HOST_ENVIRONMENT_ARGUMENT_PREFIX } from '@contracts/hostPlatformFeature';
import { readUiScalePreferenceArgument } from '@electron/preload/readUiScalePreferenceArgument';
import { UI_SCALE_PREFERENCE_ARGUMENT_PREFIX } from '@contracts/settings';

function encodeHostEnvironment(value: unknown) {
    return `${HOST_ENVIRONMENT_ARGUMENT_PREFIX}${Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')}`;
}

describe('readHostResourceProfileArgument', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('decodes the profile in a sandboxed preload without Node Buffer', () => {
        const profile = {
            logicalCpus: 8,
            totalRamBytes: 24 * (1024 ** 3),
            safeMode: false,
            detectedTier: 'high',
            performanceMode: 'low',
            tier: 'low',
        } as const;
        const argument = encodeHostResourceProfileArgument(profile);
        const diagnosticsArgument = encodeDiagnosticsPolicyArgument('granted');

        vi.stubGlobal('Buffer', undefined);

        expect(readHostResourceProfileArgument([argument])).toEqual(profile);
        expect(readDiagnosticsPolicyArgument([diagnosticsArgument])).toEqual({mode: 'granted'});
    });

    it('rejects malformed or duplicate profile arguments', () => {
        expect(readHostResourceProfileArgument([])).toBeNull();
        expect(readHostResourceProfileArgument(['--evb-host-resource-profile=not-base64'])).toBeNull();
        expect(readHostResourceProfileArgument([
            '--evb-host-resource-profile=eyJ0aWVyIjoibG93In0',
            '--evb-host-resource-profile=eyJ0aWVyIjoibG93In0',
        ])).toBeNull();
    });
});

describe('readHostEnvironmentArgument', () => {
    it('decodes the host snapshot main passed to the window', () => {
        expect(readHostEnvironmentArgument([
            'electron',
            encodeHostEnvironment({
                platform: 'win32',
                osScaleFactor: 2,
            }),
        ])).toEqual({
            platform: 'win32',
            osScaleFactor: 2,
        });
    });

    it('rejects an absent, duplicate or invalid host snapshot', () => {
        const valid = encodeHostEnvironment({
            platform: 'linux',
            osScaleFactor: 1,
        });

        expect(readHostEnvironmentArgument([])).toBeNull();
        expect(readHostEnvironmentArgument([
            valid,
            valid,
        ])).toBeNull();
        expect(readHostEnvironmentArgument([encodeHostEnvironment({
            platform: 'win32',
            osScaleFactor: 0,
        })])).toBeNull();
        expect(readHostEnvironmentArgument([`${HOST_ENVIRONMENT_ARGUMENT_PREFIX}not-base64!`])).toBeNull();
    });
});

describe('readUiScalePreferenceArgument', () => {
    function encodeUiScale(value: unknown) {
        return `${UI_SCALE_PREFERENCE_ARGUMENT_PREFIX}${Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')}`;
    }

    it('decodes the stored preference and rejects anything else', () => {
        expect(readUiScalePreferenceArgument([encodeUiScale('large')])).toBe('large');
        expect(readUiScalePreferenceArgument([])).toBeNull();
        expect(readUiScalePreferenceArgument([encodeUiScale('huge')])).toBeNull();
        expect(readUiScalePreferenceArgument([
            encodeUiScale('compact'),
            encodeUiScale('compact'),
        ])).toBeNull();
    });
});
