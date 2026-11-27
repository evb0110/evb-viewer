import {
    NATIVE_ERROR_CODES,
    hasNativeErrorCode,
    isNativeErrorEnvelope,
} from '@contracts/nativeErrors';
import {
    describe,
    expect,
    it,
} from 'vitest';

describe('native error envelopes', () => {
    it.each(NATIVE_ERROR_CODES)('accepts the stable %s code', (code) => {
        const envelope = {
            code,
            message: 'localized detail',
        };
        expect(isNativeErrorEnvelope(envelope)).toBe(true);
        expect(hasNativeErrorCode(envelope)).toBe(true);
    });

    it('rejects unknown and message-only failures', () => {
        expect(isNativeErrorEnvelope({
            code: 'search-failed',
            message: 'detail',
        })).toBe(false);
        expect(hasNativeErrorCode({message: 'encrypted document'})).toBe(false);
    });
});
