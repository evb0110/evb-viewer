import {
    NATIVE_ERROR_CODES,
    hasNativeErrorCode,
    isNativeErrorEnvelope,
    isPdfStructurePreservationRefusal,
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


describe('PDF structure preservation refusals', () => {
    const refusal = {
        code: 'invalid-request',
        message: 'ERR_PDF_STRUCTURE_PRESERVATION: accessibility tags cannot be preserved',
    };
    it.each([
        refusal,
        {errorEnvelope: refusal},
        {message: `EVB_SERIALIZABLE_ERROR:${JSON.stringify(refusal)}`},
        {
            code: 'native-failure',
            message: 'Capability failed',
            cause: {errorEnvelope: refusal},
        },
    ])('finds the native refusal through worker and capability envelopes: %j', value => {
        expect(isPdfStructurePreservationRefusal(value)).toBe(true);
    });
    it('rejects unrelated invalid requests and terminates cyclic cause chains', () => {
        expect(isPdfStructurePreservationRefusal({
            code: 'invalid-request',
            message: 'Bad page',
        })).toBe(false);
        const cyclic: {cause?: unknown} = {};
        cyclic.cause = cyclic;
        expect(isPdfStructurePreservationRefusal(cyclic)).toBe(false);
        expect(isPdfStructurePreservationRefusal({
            code: 'io',
            message: refusal.message,
        })).toBe(false);
    });
});
