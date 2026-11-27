import {describe, expect, it} from 'vitest';
import {inspectAllowedExternalUrl, normalizeAllowedExternalUrl, sanitizeAllowedExternalUrl} from '@contracts/externalUrl';

describe('external URL helpers', () => {
    it('normalizes allowed external URLs', () => {
        expect(normalizeAllowedExternalUrl(' https://example.com/docs ')).toBe('https://example.com/docs');
        expect(normalizeAllowedExternalUrl('mailto:test@example.com')).toBe('mailto:test@example.com');
    });

    it('rejects unsupported external URL protocols', () => {
        expect(normalizeAllowedExternalUrl('javascript:alert(1)')).toBeNull();
        expect(() => sanitizeAllowedExternalUrl('file:///tmp/test.pdf')).toThrow('Unsupported external URL protocol: file:');
    });

    it('returns structured rejection reasons for invalid or blocked URLs', () => {
        expect(inspectAllowedExternalUrl('   ')).toEqual({
            ok: false,
            reason: 'empty',
        });
        expect(inspectAllowedExternalUrl('not a url')).toEqual({
            ok: false,
            reason: 'invalid',
        });
        expect(inspectAllowedExternalUrl('data:text/plain,hello')).toEqual({
            ok: false,
            protocol: 'data:',
            reason: 'unsupported-protocol',
        });
    });
});
