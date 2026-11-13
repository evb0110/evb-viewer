import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    normalizeBoundedString,
    truncateForIpc,
} from '@electron/utils/ipcLimits';

describe('ipcLimits', () => {
    it('normalizes non-empty bounded strings', () => {
        expect(normalizeBoundedString('  request-1  ', 'requestId', 16)).toBe('request-1');
    });

    it('rejects missing, empty, and oversized strings', () => {
        expect(() => normalizeBoundedString(12, 'requestId')).toThrow('requestId must be a string');
        expect(() => normalizeBoundedString('   ', 'requestId')).toThrow('requestId must not be empty');
        expect(() => normalizeBoundedString('abcdef', 'requestId', 5)).toThrow('requestId exceeds maximum length (5)');
    });

    it('truncates strings to an explicit IPC length', () => {
        expect(truncateForIpc('abcdef', 3)).toBe('abc');
    });
});
