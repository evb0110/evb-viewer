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
