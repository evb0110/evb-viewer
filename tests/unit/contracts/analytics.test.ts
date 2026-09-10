import {
    describe,
    expect,
    expectTypeOf,
    it,
} from 'vitest';
import type {
    JsonObject,
    JsonValue,
} from 'type-fest';
import {
    ANALYTICS_GEO_LIMITS,
    isViewerAnalyticsResponse,
    normalizeAnalyticsGeo,
    normalizeAnalyticsScalar,
} from '@contracts/analytics';
import type {
    IAnalyticsEventEnvelope,
    TAnalyticsPayloadValue,
} from '@contracts/analytics';

describe('analytics payload contract types', () => {
    it('models payload roots and nested values as Type-Fest JSON types', () => {
        expectTypeOf<IAnalyticsEventEnvelope['payload']>().toEqualTypeOf<JsonObject>();
        expectTypeOf<TAnalyticsPayloadValue>().toEqualTypeOf<JsonValue>();
    });
});

describe('viewer analytics acknowledgement contract', () => {
    it.each([
        [{
            ok: true,
            persisted: true,
            retryable: false,
            count: 1,
        }],
        [{
            ok: false,
            persisted: false,
            retryable: true,
        }],
        [{
            ok: true,
            persisted: false,
            retryable: false,
        }],
    ])('accepts the complete %s outcome', outcome => {
        expect(isViewerAnalyticsResponse(outcome)).toBe(true);
    });

    it.each([
        [{
            ok: true,
            persisted: true,
            retryable: true,
            count: 1,
        }],
        [{
            ok: true,
            persisted: true,
            retryable: false,
            count: 0,
        }],
        [{
            ok: true,
            persisted: true,
            retryable: false,
        }],
        [{
            ok: true,
            persisted: false,
            retryable: true,
        }],
        [{persisted: true}],
        [null],
    ])('rejects the incomplete or contradictory %s outcome', outcome => {
        expect(isViewerAnalyticsResponse(outcome)).toBe(false);
    });
});

describe('normalizeAnalyticsScalar', () => {
    it('truncates strings to the configured length while preserving empty strings', () => {
        expect(normalizeAnalyticsScalar('abcdef', {
            maxStringLength: 3,
            nonFiniteFallback: undefined,
        })).toBe('abc');
        expect(normalizeAnalyticsScalar('', {
            maxStringLength: 3,
            nonFiniteFallback: undefined,
        })).toBe('');
    });

    it.each([
        [true],
        [false],
        [null],
        [42],
        [-1.5],
    ])('preserves scalar value %s', value => {
        expect(normalizeAnalyticsScalar(value, {
            maxStringLength: 8,
            nonFiniteFallback: null,
        })).toBe(value);
    });

    it.each([
        [Number.NaN],
        [Number.POSITIVE_INFINITY],
        [Number.NEGATIVE_INFINITY],
    ])('uses fallback for non-finite number %s', value => {
        expect(normalizeAnalyticsScalar(value, {
            maxStringLength: 8,
            nonFiniteFallback: null,
        })).toBeNull();
        expect(normalizeAnalyticsScalar(value, {
            maxStringLength: 8,
            nonFiniteFallback: undefined,
        })).toBeUndefined();
    });

    it.each([
        [{}],
        [[]],
        [() => undefined],
        [undefined],
    ])('rejects non-scalar value %s', value => {
        expect(normalizeAnalyticsScalar(value, {
            maxStringLength: 8,
            nonFiniteFallback: null,
        })).toBeUndefined();
    });
});

describe('normalizeAnalyticsGeo', () => {
    it('validates countries and truncates bounded geo headers', () => {
        const geo = normalizeAnalyticsGeo({
            country: ' us ',
            region: `CA-${'x'.repeat(80)}`,
            city: `San Francisco ${'x'.repeat(400)}`,
            timezone: `America/Los_Angeles-${'x'.repeat(100)}`,
        });

        expect(geo.country).toBe('US');
        expect(geo.region).toHaveLength(ANALYTICS_GEO_LIMITS.region);
        expect(geo.city).toHaveLength(ANALYTICS_GEO_LIMITS.city);
        expect(geo.timezone).toHaveLength(ANALYTICS_GEO_LIMITS.timezone);
    });

    it.each([
        [null],
        [''],
        ['u'],
        ['usa'],
        ['1!'],
    ])('drops invalid country header %s without dropping the rest of the geo data', country => {
        expect(normalizeAnalyticsGeo({
            country,
            city: 'Paris',
            region: 'IDF',
        })).toEqual({
            country: null,
            city: 'Paris',
            region: 'IDF',
            timezone: null,
        });
    });
});
