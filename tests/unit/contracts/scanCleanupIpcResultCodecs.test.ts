import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    decodeScanCleanupJobState,
    decodeScanCleanupRawPreviewEvent,
} from '@contracts/scan-cleanup/ipcResultCodecs';

const failedState = {
    jobId: 'job-1',
    status: 'failed',
    error: 'native pipeline failed',
    errorCode: 'native-failure',
    progress: {
        stage: 'rendering',
        completedUnits: 1,
        totalUnits: 2,
        percent: 50,
    },
    updatedAtMs: 1,
    failure: {
        eventId: '0123456789abcdef0123456789abcdef',
        code: 'UNCLASSIFIED_MAIN_ERROR',
        occurredAt: 1,
        severity: 'error',
    },
};

describe('scan cleanup job state diagnostics', () => {
    it('preserves the closed main failure receipt on a failed projection', () => {
        expect(decodeScanCleanupJobState(failedState)).toEqual(failedState);
    });

    it('keeps legacy failed projections compatible while rejecting an invalid receipt', () => {
        const {
            failure: _failure,
            ...legacy
        } = failedState;
        expect(decodeScanCleanupJobState(legacy)).toEqual(legacy);
        expect(() => decodeScanCleanupJobState({
            ...failedState,
            failure: {
                ...failedState.failure,
                eventId: 'not-an-event-id',
            },
        })).toThrow('invalid failure receipt');
    });
});

describe('scan cleanup raw preview result', () => {
    const rawPreview = {
        ownerId: 'preview-owner',
        documentRevision: 'revision-1',
        requestId: 'preview-request-1',
        pageNumber: 1,
        totalPages: 1,
        rawImageData: new Uint8Array([1]),
        rawWidthPx: 1,
        rawHeightPx: 1,
    };

    it('bounds the owner identity fields at the result boundary', () => {
        expect(decodeScanCleanupRawPreviewEvent(rawPreview)).toMatchObject(rawPreview);
        expect(decodeScanCleanupRawPreviewEvent({
            ...rawPreview,
            ownerId: 'o'.repeat(128),
            documentRevision: 'r'.repeat(128),
        })).toMatchObject({
            ownerId: 'o'.repeat(128),
            documentRevision: 'r'.repeat(128),
        });
        expect(() => decodeScanCleanupRawPreviewEvent({
            ...rawPreview,
            ownerId: 'x'.repeat(129),
        })).toThrow('raw preview owner id');
        expect(() => decodeScanCleanupRawPreviewEvent({
            ...rawPreview,
            documentRevision: 'x'.repeat(129),
        })).toThrow('raw preview document revision');
    });
});
