import {describe, expect, it} from 'vitest';
import {parseClientDiagnosticsPreference} from '@contracts/diagnostics/diagnosticsPreference';

describe('client diagnostics preference', () => {
    it.each([undefined, null, '', false, {}, 'enabled'])('maps %j to unknown', (value) => {
        expect(parseClientDiagnosticsPreference(value)).toBe('unknown');
    });

    it.each(['unknown', 'granted', 'denied'] as const)('keeps the supported %s state', (value) => {
        expect(parseClientDiagnosticsPreference(value)).toBe(value);
    });
});
