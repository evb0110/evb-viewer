import {
    NATIVE_ERROR_CODES,
    type TNativeErrorCode,
    type TNativeErrorCodeBidirectionalParity,
    getUnprovenNativeTerminationDetail,
    hasNativeErrorCode,
    isNativeErrorEnvelope,
    markUnprovenNativeTermination,
} from '@contracts/nativeErrors';
import type {NativeErrorCode} from '@contracts/scan-cleanup/nativeWire.generated';
import {describe, expect, expectTypeOf, it} from 'vitest';

describe('native error envelopes', () => {
    it('maintains bidirectional compile-time parity with generated NativeErrorCode', () => {
        expectTypeOf<TNativeErrorCode>().toEqualTypeOf<NativeErrorCode>();
        expectTypeOf<TNativeErrorCodeBidirectionalParity>().toEqualTypeOf<true>();
    });
    it.each(NATIVE_ERROR_CODES)('accepts the stable %s code', (code) => {
        const envelope = {
            code,
            message: 'localized detail',
        };
        expect(isNativeErrorEnvelope(envelope)).toBe(true);
        expect(hasNativeErrorCode(envelope)).toBe(true);
    });

    it('rejects unknown and message-only failures', () => {
        expect(
            isNativeErrorEnvelope({
                code: 'search-failed',
                message: 'detail',
            }),
        ).toBe(false);
        expect(hasNativeErrorCode({message: 'encrypted document'})).toBe(false);
    });

    it('unwraps unproven native termination details across SuppressedError, AggregateError, and cycles', () => {
        const markedPrimary = markUnprovenNativeTermination(new Error('primary'), 'primary child alive');
        const markedDisposer = markUnprovenNativeTermination(new Error('disposer'), 'disposer child alive');
        const plain = new Error('plain');

        expect(getUnprovenNativeTerminationDetail(new SuppressedError(plain, markedPrimary))).toBe('primary child alive');
        expect(getUnprovenNativeTerminationDetail(new SuppressedError(markedDisposer, plain))).toBe('disposer child alive');
        expect(getUnprovenNativeTerminationDetail(new SuppressedError(markedDisposer, markedPrimary))).toBe('primary child alive');
        expect(
            getUnprovenNativeTerminationDetail(
                new SuppressedError(plain, new AggregateError([plain, new SuppressedError(markedDisposer, plain)], 'joined')),
            ),
        ).toBe('disposer child alive');

        const cyclicAggregate = new AggregateError([], 'cyclic');
        cyclicAggregate.errors.push(cyclicAggregate);
        expect(getUnprovenNativeTerminationDetail(cyclicAggregate)).toBeUndefined();

        const cyclicSuppressed = new SuppressedError(plain, plain);
        cyclicSuppressed.suppressed = cyclicSuppressed;
        cyclicSuppressed.error = cyclicSuppressed;
        expect(getUnprovenNativeTerminationDetail(cyclicSuppressed)).toBeUndefined();
    });
});
