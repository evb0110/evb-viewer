import {
    describe,
    expect,
    it,
} from 'vitest';
import { decodeWorkingCopyBackingStatus } from '@contracts/electronApiDocuments';
import {
    DOCUMENT_MENU_PLATFORM_FEATURE,
    DOCUMENT_OPEN_PLATFORM_FEATURE,
} from '@contracts/documentsPlatformFeature';

describe('progress event payload codecs', () => {
    const decodeOptimize = DOCUMENT_MENU_PLATFORM_FEATURE
        .events.onPdfOptimizeProgress.payload.decode;
    const decodeOpenBatch = DOCUMENT_OPEN_PLATFORM_FEATURE
        .events.onOpenDocumentDirectBatchProgress.payload.decode;
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
        expect(decodeOptimize(optimizePayload)).toEqual(optimizePayload);
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
        expect(() => decodeOptimize(payload)).toThrow(/invalid PDF optimize/);
    });

    it('round-trips well-formed open-batch progress', () => {
        expect(decodeOpenBatch(openBatchPayload)).toEqual(openBatchPayload);
        expect(decodeOpenBatch({
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
        expect(() => decodeOpenBatch(payload)).toThrow(/invalid open-batch progress/);
    });
});

describe('working-copy backing status contract', () => {
    it('decodes and sanitizes renderer-visible backing status', () => {
        expect(decodeWorkingCopyBackingStatus({
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
        expect(decodeWorkingCopyBackingStatus(status)).toBeNull();
    });
});
