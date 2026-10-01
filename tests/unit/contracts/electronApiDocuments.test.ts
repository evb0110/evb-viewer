import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    OPEN_BATCH_PROGRESS_SCHEMA,
    PDF_OPTIMIZE_PROGRESS_SCHEMA,
    WORKING_COPY_BACKING_STATUS_SCHEMA,
} from '@contracts/electronApiDocuments';
import {PDF_IMAGE_COMBINE_PROGRESS_SCHEMA} from '@contracts/pdfImageCombineProgress';
import * as v from 'valibot';

describe('progress event payload schemas', () => {
    const optimizePayload = {
        requestId: 'optimize-7',
        preset: 'balancedScanned',
        phase: 'rendering',
        processed: 3,
        total: 12,
        percent: 25,
    };
    const openBatchPayload = {
        operation: 'page-insert',
        requestId: 'open-9',
        processed: 2,
        total: 4,
        percent: 50,
        elapsedMs: 120,
        estimatedRemainingMs: null,
    };

    it('round-trips well-formed optimize progress', () => {
        expect(v.parse(PDF_OPTIMIZE_PROGRESS_SCHEMA, optimizePayload)).toEqual(optimizePayload);
    });

    it.each([
        {
            ...optimizePayload,
            percent: Number.NaN,
        },
        {
            ...optimizePayload,
            processed: Number.POSITIVE_INFINITY,
        },
        {
            ...optimizePayload,
            total: -1,
        },
        {
            ...optimizePayload,
            phase: 'exploding',
        },
        {
            ...optimizePayload,
            preset: 'ultra',
        },
        {
            ...optimizePayload,
            requestId: 7,
        },
        'progress',
        null,
    ])('rejects malformed optimize progress %#', (payload) => {
        expect(v.safeParse(PDF_OPTIMIZE_PROGRESS_SCHEMA, payload, {abortEarly: true}).success).toBe(false);
    });

    it('round-trips well-formed open-batch progress', () => {
        expect(v.parse(OPEN_BATCH_PROGRESS_SCHEMA, openBatchPayload)).toEqual(openBatchPayload);
        expect(v.parse(OPEN_BATCH_PROGRESS_SCHEMA, {
            ...openBatchPayload,
            estimatedRemainingMs: 340,
        })).toEqual({
            ...openBatchPayload,
            estimatedRemainingMs: 340,
        });
    });

    it.each([
        {
            ...openBatchPayload,
            total: Number.NaN,
        },
        {
            ...openBatchPayload,
            percent: '50',
        },
        {
            ...openBatchPayload,
            elapsedMs: -5,
        },
        {
            ...openBatchPayload,
            estimatedRemainingMs: Number.NaN,
        },
        {
            ...openBatchPayload,
            operation: 'document-close',
        },
        undefined,
    ])('rejects malformed open-batch progress %#', (payload) => {
        expect(v.safeParse(OPEN_BATCH_PROGRESS_SCHEMA, payload, {abortEarly: true}).success).toBe(false);
    });

    // One `evb-pdf-image-combine --json-progress` line.
    const combineLine = {
        type: 'progress',
        processed: 1,
        total: 4,
        percent: 25,
        elapsedMs: 30,
    };

    it('reads the image combiner estimate, and a missing one as unknown', () => {
        expect(v.parse(PDF_IMAGE_COMBINE_PROGRESS_SCHEMA, {
            ...combineLine,
            estimatedRemainingMs: 90,
        })).toMatchObject({estimatedRemainingMs: 90});
        expect(v.parse(PDF_IMAGE_COMBINE_PROGRESS_SCHEMA, combineLine)).toMatchObject({estimatedRemainingMs: null});
    });

    it.each([
        [{processed: Infinity}],
        [{total: -1}],
        [{percent: 101}],
        [{percent: -1}],
        [{elapsedMs: Infinity}],
        [{estimatedRemainingMs: Infinity}],
    ])('rejects an image combiner progress line with %j', (bad) => {
        expect(v.safeParse(PDF_IMAGE_COMBINE_PROGRESS_SCHEMA, {
            ...combineLine,
            ...bad,
        }).success).toBe(false);
    });

    it.each([
        '90',
        true,
        {ms: 90},
    ])('rejects an image combiner estimate of %j', (estimatedRemainingMs) => {
        expect(v.safeParse(PDF_IMAGE_COMBINE_PROGRESS_SCHEMA, {
            ...combineLine,
            estimatedRemainingMs,
        }, {abortEarly: true}).success).toBe(false);
    });
});

describe('working-copy backing status contract', () => {
    it('decodes and sanitizes renderer-visible backing status', () => {
        expect(v.parse(WORKING_COPY_BACKING_STATUS_SCHEMA, {
            documentRef: '/tmp/managed.pdf',
            failure: {
                code: 'WORKING_COPY_MATERIALIZATION_NO_SPACE',
                retryable: true,
                originalPath: '/private/source.pdf',
            },
            originalPath: '/private/source.pdf',
            progress: 0.75,
            state: 'materializing',
        })).toEqual({
            documentRef: '/tmp/managed.pdf',
            failure: {
                code: 'WORKING_COPY_MATERIALIZATION_NO_SPACE',
                retryable: true,
            },
            progress: 0.75,
            state: 'materializing',
        });
    });

    it.each([
        {
            documentRef: '',
            failure: null,
            progress: 0,
            state: 'lazy-original',
        },
        {
            documentRef: '/tmp/a.pdf',
            failure: null,
            progress: -0.1,
            state: 'materializing',
        },
        {
            documentRef: '/tmp/a.pdf',
            failure: null,
            progress: 1.1,
            state: 'materializing',
        },
        {
            documentRef: '/tmp/a.pdf',
            failure: null,
            progress: 0.5,
            state: 'copied',
        },
        {
            documentRef: '/tmp/a.pdf',
            failure: {
                code: 'ENOSPC',
                retryable: true,
            },
            progress: 0.5,
            state: 'materializing',
        },
    ])('rejects malformed status %#', (status) => {
        expect(v.safeParse(WORKING_COPY_BACKING_STATUS_SCHEMA, status, {abortEarly: true}).success).toBe(false);
    });
});
