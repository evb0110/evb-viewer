import {
    describe,
    expect,
    it,
} from 'vitest';
import {decodeScanCleanupJobState} from '@contracts/scan-cleanup/ipcResultCodecs';

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

    it('preserves typed scratch figures on a failed run projection', () => {
        const runState = {
            ...failedState,
            errorCode: 'insufficient-scratch',
            scratchShortfall: {
                availableBytes: 520 * 1024 * 1024,
                requiredBytes: 1_100 * 1024 * 1024,
            },
        };
        expect(decodeScanCleanupJobState(runState)).toEqual(runState);
    });
});
